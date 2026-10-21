import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { createHttpClient, createPublicShareClient, normalizeShareMeta, normalizeShareOverlay, shareErrorKind, toAuditEvent, toExportDoc, toOffboardingExport } from "./http";
import { describeChange } from "@/features/history/LineHistoryDialog";
import { createPublicOnlyBackend, isShareViewerPath } from "./client";
import { ApiError } from "./types";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = [string, RequestInit];

describe("Sprint 5 REST routes", () => {
  it("history, audit (+filters, cursor), verify, marked PDF, exports, share links, settings, offboarding", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/share-links") && !url.includes("DELETE")) return json({ items: [{ id: "l1", expiresAt: "2026-11-01T00:00:00Z", createdAt: "2026-10-15T00:00:00Z" }] });
      if (url.includes("/marked-pdf")) return json({ exportId: "x1" }, 202);
      if (url.includes("/exports/")) return json({ export: { id: "x1", kind: "marked_pdf", status: "ready", pageCount: 4, createdAt: "2026-10-15T00:00:00Z", error: null }, url: "https://signed/x.pdf", fileName: "m.pdf", expiresAt: "2026-10-15T00:15:00Z" });
      if (url.includes("/settings")) return json({ settings: { greenThreshold: 0.99, blockExportOnRed: true, llmEnabled: false, trainingOptIn: false } });
      return json({ items: [], nextCursor: null });
    });
    const api = createHttpClient(async () => "tok", "/api/v1", fetchImpl as unknown as typeof fetch);
    await api.getLineHistory("p 1", "l/1");
    await api.listAudit("o1", { cursor: "c1", entity: "boqLines", action: "share.view", limit: 20 });
    await api.verifyAudit("o1");
    expect(await api.exportMarkedPdf("p1", { sheetIds: ["s1"], floorSplit: true, hideTitleBlock: true })).toEqual({ exportId: "x1" });
    expect(await api.getExport("p1", "x1")).toMatchObject({ id: "x1", status: "succeeded", url: "https://signed/x.pdf", filename: "m.pdf", pageCount: 4 });
    expect((await api.listShareLinks("p1"))[0]).toMatchObject({ id: "l1", hideTitleBlock: true, allowPdfDownload: false, viewCount: 0, label: "" });
    await api.revokeShareLink("p1", "l1");
    expect(await api.patchOrgSettings("o1", { greenThreshold: 0.99 })).toMatchObject({ greenThreshold: 0.99 });
    await api.offboardOrg("o1", { confirm: "studio" });
    const calls = (fetchImpl.mock.calls as unknown as Call[]).map(([u, i]) => [u, i.method ?? "GET", i.body ? JSON.parse(i.body as string) : undefined]);
    expect(calls).toEqual([
      ["/api/v1/projects/p%201/boq/lines/l%2F1/history", "GET", undefined],
      ["/api/v1/orgs/o1/audit?cursor=c1&entity=boqLines&action=share.view&limit=20", "GET", undefined],
      ["/api/v1/orgs/o1/audit/verify", "GET", undefined],
      ["/api/v1/projects/p1/boq/export/marked-pdf", "POST", { sheetIds: ["s1"], options: { floorSplit: true, hideTitleBlock: true } }],
      ["/api/v1/projects/p1/exports/x1", "GET", undefined],
      ["/api/v1/projects/p1/share-links", "GET", undefined],
      ["/api/v1/projects/p1/share-links/l1", "DELETE", undefined],
      ["/api/v1/orgs/o1/settings", "PATCH", { greenThreshold: 0.99 }],
      ["/api/v1/orgs/o1/offboarding", "POST", { confirm: "studio" }],
    ]);
  });

  it("export doc adapter accepts the doc alone", () => {
    expect(toExportDoc({ id: "x", kind: "marked_pdf", status: "running", createdAt: "t" })).toMatchObject({ id: "x", status: "running", url: null });
  });
});

describe("public share client (external viewer)", () => {
  it("GET only, no Authorization, no cookies, no referrer; unauthenticated paths under /public/share/:token", async () => {
    const fetchImpl = vi.fn(async () => json({ linkId: "l1", projectName: "נח", sheets: [], expiresAt: "2026-11-01T00:00:00Z" }));
    const pub = createPublicShareClient("/api/v1", fetchImpl as unknown as typeof fetch);
    const meta = await pub.getMeta("tok/en");
    expect(meta).toMatchObject({ hideTitleBlock: true, allowPdfDownload: false, showConfidence: true, sheets: [] });
    await pub.getBoq("t");
    await pub.getOverlay("t", "s1");
    for (const [url, init] of fetchImpl.mock.calls as unknown as Call[]) {
      expect(url.startsWith("/api/v1/public/share/")).toBe(true);
      expect(init.method).toBe("GET");
      expect(init.credentials).toBe("omit");
      expect(init.referrerPolicy).toBe("no-referrer");
      expect(init.body).toBeUndefined();
      expect(JSON.stringify(init.headers)).not.toMatch(/Authorization/i);
    }
    expect((fetchImpl.mock.calls[0] as unknown as Call)[0]).toBe("/api/v1/public/share/tok%2Fen/meta");
    expect(pub.tileUrl("t", "s1", 3, 1, 2)).toBe("/api/v1/public/share/t/sheets/s1/tiles/3/1/2");
    expect(pub.pdfUrl("t")).toBe("/api/v1/public/share/t/pdf");
    // the client has no write method at all
    expect(Object.keys(pub).sort()).toEqual(["getBoq", "getMeta", "getOverlay", "pdfUrl", "tileUrl"]);
  });

  it("maps 404 / 410 (expired, revoked) / 429 to the viewer's screens", async () => {
    const pub = (status: number, code?: string) =>
      createPublicShareClient("/api/v1", (async () => json(code ? { error: { code, message: "Link is not active" } } : {}, status)) as unknown as typeof fetch);
    expect(shareErrorKind(await pub(404, "share_not_found").getMeta("x").catch((e) => e))).toBe("not_found");
    expect(shareErrorKind(await pub(410, "share_revoked").getMeta("x").catch((e) => e))).toBe("revoked");
    expect(shareErrorKind(await pub(410, "share_expired").getMeta("x").catch((e) => e))).toBe("expired");
    expect(shareErrorKind(await pub(410).getMeta("x").catch((e) => e))).toBe("expired");
    expect(shareErrorKind(await pub(429, "rate_limited").getMeta("x").catch((e) => e))).toBe("rate_limited");
    expect(shareErrorKind(new Error("x"))).toBe("error");
    expect(shareErrorKind(new ApiError(500, "x", "y"))).toBe("error");
  });

  it("overlay: evidence from `evidence` or per-detection lineIds", () => {
    const d = { id: "d1", class: "socket", centerMm: { x: 0, y: 0 }, bboxMm: { x: 0, y: 0, w: 1, h: 1 }, level: "green" as const, lifecycle: "new" as const, floor: null, roomId: null };
    expect(normalizeShareOverlay({ detections: [{ ...d, lineIds: ["L1"] }] }, "s1")).toMatchObject({ sheetId: "s1", evidence: { L1: ["d1"] }, rooms: [], linkGroups: [] });
    expect(normalizeShareOverlay({ detections: [d], evidence: { L2: ["d1"] } }, "s1").evidence).toEqual({ L2: ["d1"] });
  });

  it("the share-viewer backend refuses every member API / upload / realtime call", () => {
    expect(isShareViewerPath("/s/abc_DEF-123")).toBe(true);
    expect(isShareViewerPath("/s/")).toBe(false);
    expect(isShareViewerPath("/settings")).toBe(false);
    const b = createPublicOnlyBackend(createPublicShareClient("/api/v1", vi.fn() as unknown as typeof fetch));
    expect(() => b.api.patchBoqLine("p", "l", { status: "approved" })).toThrow(/not available in the share viewer/);
    expect(() => b.api.createShareLink("p", { days: 1, label: "x" })).toThrow();
    expect(() => b.uploads.start("x", new Blob(), "x", () => {})).toThrow();
    expect(() => b.realtime.jobs("o", null, () => {}, () => {})).toThrow();
  });
});

describe("contracts adapters (packages/contracts share.ts / audit.ts / exports.ts / offboarding.ts)", () => {
  it("PublicShareMeta {link, project, sheets[sheetId], pdf} → viewer meta; PDF offered only when ready", () => {
    const dto = {
      link: { shortId: "ab12cd", label: "קבלן", recipient: "יוסי", expiresAt: "2026-11-01T00:00:00Z", createdAt: "2026-10-15T00:00:00Z", hideTitleBlock: true, allowPdfDownload: true, watermark: "שותף עם יוסי • 15.10.2026 • ab12cd" },
      project: { name: "בית משפחת נח", address: null },
      sheets: [{ sheetId: "s1", versionId: "v1", title: "ת. חשמל", discipline: "electrical", floors: ["ground"], page: { widthMm: 420, heightMm: 297 }, tiles: null }],
      pdf: { status: "running" as const },
    };
    const m = normalizeShareMeta(dto);
    expect(m).toMatchObject({ linkId: "ab12cd", projectName: "בית משפחת נח", watermark: dto.link.watermark, versionDate: dto.link.createdAt, allowPdfDownload: false, sheets: [{ id: "s1", versionId: "v1" }] });
    expect(normalizeShareMeta({ ...dto, pdf: { status: "ready" } }).allowPdfDownload).toBe(true);
    expect(normalizeShareMeta({ ...dto, pdf: null }).allowPdfDownload).toBe(false);
    expect(normalizeShareMeta({ ...dto, pdf: { status: "failed", errorCode: "title_block_not_found" } }).pdf).toEqual({ status: "failed", errorCode: "title_block_not_found" });
  });

  it("410 + x-share-state header → expired / revoked screens; public BOQ snapshot", async () => {
    const res = (state: string) => new Response(JSON.stringify({ error: { code: "share_unavailable", message: "share link not available" } }), { status: 410, headers: { "x-share-state": state } });
    const pub = (state: string) => createPublicShareClient("/api/v1", (async () => res(state)) as unknown as typeof fetch);
    expect(shareErrorKind(await pub("revoked").getMeta("x").catch((e) => e))).toBe("revoked");
    expect(shareErrorKind(await pub("expired").getMeta("x").catch((e) => e))).toBe("expired");
    const boq = createPublicShareClient("/api/v1", (async () => json({ snapshotAt: "2026-10-15T10:00:00Z", lines: [{ id: "l", chapter: "04", code: "4.01", description: "x", unit: "יח'", qty: 3, level: "yellow", status: "draft", floor: null, byFloor: {} }], floors: [], counts: {} })) as unknown as typeof fetch);
    const got = await boq.getBoq("t");
    expect(got.snapshotAt).toBe("2026-10-15T10:00:00Z");
    const l = got.lines[0]!;
    expect(l).toMatchObject({ code: "4.01", qty: 3, level: "yellow" });
  });

  it("overlay: `links` → linkGroups, rooms drawn from bboxMm, lifecycle defaults to new", () => {
    const o = normalizeShareOverlay(
      {
        sheetId: "s1",
        versionId: "v1",
        detections: [{ id: "d1", class: "socket", centerMm: { x: 1, y: 1 }, bboxMm: { x: 0, y: 0, w: 2, h: 2 }, level: "green", floor: null, lineIds: ["L"] }],
        links: [{ id: "g1", switchIds: ["d1"], luminaireIds: [], level: "yellow", pointIds: [] }],
        rooms: [{ id: "r1", name: "סלון", areaM2: 20, bboxMm: { x: 0, y: 0, w: 10, h: 5 } }],
        maskMm: null,
      },
      "s1",
    );
    expect(o.detections[0]).toMatchObject({ lifecycle: "new", roomId: null });
    expect(o.evidence).toEqual({ L: ["d1"] });
    expect(o.linkGroups[0]!.id).toBe("g1");
    expect(o.rooms[0]!.polygonMm).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }]);
  });

  it("audit {actorId, actorKind, actorName, after}; export / offboarding `ready`; history primitives", () => {
    const base = { id: "e", entity: "shareLinks", entityId: "l1", action: "view", after: { ipPrefix: "1.2.3.0/24" }, at: "t", prevHash: null, hash: "h" };
    expect(toAuditEvent({ ...base, actorId: null, actorKind: "share_link", actorName: null })).toMatchObject({ actor: null, actorKind: "share_link" });
    expect(toAuditEvent({ ...base, actorId: "u1", actorKind: "user", actorName: "דנה" }).actor).toEqual({ uid: "u1", displayName: "דנה" });
    expect(toExportDoc({ export: { id: "x", kind: "marked_pdf", status: "ready", createdAt: "t" }, url: "https://u", fileName: "a.pdf", expiresAt: "t" }).status).toBe("succeeded");
    expect(toExportDoc({ export: { id: "x", kind: "marked_pdf", status: "failed", createdAt: "t", titleBlockMasked: false, titleBlockBySheet: { s1: false } }, message: "לא נמצאה טבלת כותרת", url: null })).toMatchObject({ status: "failed", titleBlockMasked: false, titleBlockBySheet: { s1: false }, message: "לא נמצאה טבלת כותרת" });
    expect(toOffboardingExport({ export: { id: "o", status: "ready", createdAt: "t" }, url: "https://z", expiresAt: "t" })).toMatchObject({ id: "o", status: "succeeded", url: "https://z" });
    const t = i18n.t.bind(i18n);
    const h = { at: "t", by: null, reason: null };
    expect(describeChange({ ...h, action: "status", before: "approved", after: "reviewed" }, t)).toMatchObject({ before: "אושר", after: "נבדק" });
    expect(describeChange({ ...h, action: "qtyOverride", before: 5, after: 7 }, t)).toMatchObject({ before: "5", after: "7" });
    expect(describeChange({ ...h, action: "qtyOverride", before: 7, after: null }, t).after).toBe("חזרה לכמות המחושבת");
  });
});
