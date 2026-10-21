import { createMockBackend } from "./mock";
import { mockPdfBytes } from "./mockSprint5";
import { ApiError, CONSERVATIVE_REASON } from "./types";

const PID = "p-noah";
const ORG = "org-demo";

async function built(opts: Parameters<typeof createMockBackend>[0] = {}) {
  const b = createMockBackend({ latencyMs: 0, jobTickMs: 5, uploadTickMs: 5, devIndex: false, boqPrebuilt: true, ...opts });
  for (let i = 0; i < 200 && (await b.api.listBoqLines(PID)).items.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  return b;
}
const until = async <T>(fn: () => Promise<T>, ok: (v: T) => boolean) => {
  for (let i = 0; i < 300; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
};

describe("Sprint 5 mock: calibration", () => {
  it("lines report the conservative calibration and yellow lines carry its reason", async () => {
    const b = await built();
    const res = await b.api.listBoqLines(PID);
    expect(res.calibration).toEqual({ mode: "conservative", version: expect.any(String) });
    const yellow = res.items.filter((l) => l.level === "yellow");
    expect(yellow.length).toBeGreaterThan(0);
    for (const l of yellow) expect(l.reasons).toContain(CONSERVATIVE_REASON);
    for (const l of res.items.filter((x) => x.level !== "yellow")) expect(l.reasons ?? []).not.toContain(CONSERVATIVE_REASON);
  });
});

describe("Sprint 5 mock: line history + audit (E2E-11)", () => {
  it("an override on an approved line re-opens it as 'נבדק'; history shows before/after, who, when, newest first", async () => {
    const b = await built();
    const line = (await b.api.listBoqLines(PID)).items.find((l) => l.code === "4.02")!;
    await b.api.patchBoqLine(PID, line.id, { status: "reviewed" });
    await b.api.patchBoqLine(PID, line.id, { status: "approved" });
    const after = await b.api.patchBoqLine(PID, line.id, { qtyOverride: line.qty + 3, reason: "2 שקעים נוספים לפי שיחה עם הלקוח" });
    expect(after.status).toBe("reviewed");
    const h = (await b.api.getLineHistory(PID, line.id)).items;
    expect(h.map((x) => x.action).slice(0, 4)).toEqual(expect.arrayContaining(["qtyOverride", "status"]));
    const over = h.find((x) => x.action === "qtyOverride")!;
    expect(over).toMatchObject({ by: { uid: "mock-user", displayName: "דנה כהן" }, reason: "2 שקעים נוספים לפי שיחה עם הלקוח", before: { qty: line.qty }, after: { qty: line.qty + 3 } });
    const reopened = h.find((x) => x.action === "status" && (x.after as { status: string }).status === "reviewed" && (x.before as { status: string }).status === "approved")!;
    expect(reopened.reason).toBe("override_reopened");
    expect(h.at(-1)!.action).toBe("rebuild"); // oldest: computed from the drawings
    const ats = h.map((x) => x.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    // the admin sees the same change in the org log
    const audit = await b.api.listAudit(ORG, { entity: "boqLines" });
    expect(audit.items[0]).toMatchObject({ entityId: line.id, actor: { uid: "mock-user" } });
  });

  it("corrections on a line's evidence appear in its history", async () => {
    const b = await built();
    const line = (await b.api.listBoqLines(PID)).items.find((l) => l.evidenceCount > 0)!;
    const ev = (await b.api.getBoqLineEvidence(PID, line.id)).items[0]!;
    await b.api.createCorrection(PID, {
      kind: "reject", sheetId: ev.sheetId, versionId: ev.versionId, anchorMm: { x: 1, y: 1 }, radiusMm: 3, detectionId: ev.detectionId,
      signature: null, class: null, itemCode: null, linkGroupId: null, geometry: null, quantity: null, unit: null, roomId: null, floor: null, reason: null,
    });
    const h = (await b.api.getLineHistory(PID, line.id)).items;
    expect(h.find((x) => x.action === "correction")).toMatchObject({ after: { kind: "reject" } });
  });

  it("audit: admin only, newest first, cursor paging, entity / action filters, hash chain verifies (and detects a break)", async () => {
    const b = await built();
    const p1 = await b.api.listAudit(ORG, { limit: 20 });
    expect(p1.items).toHaveLength(20);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = await b.api.listAudit(ORG, { limit: 20, cursor: p1.nextCursor });
    expect(new Set([...p1.items, ...p2.items].map((e) => e.id)).size).toBe(40);
    expect(p1.items[0]!.at >= p2.items[0]!.at).toBe(true);
    expect((await b.api.listAudit(ORG, { action: "login" })).items.every((e) => e.action === "login")).toBe(true);
    await expect(b.api.verifyAudit(ORG)).resolves.toMatchObject({ ok: true, brokenAt: null });
    const broken = await built({ auditBroken: true });
    await expect(broken.api.verifyAudit(ORG)).resolves.toMatchObject({ ok: false, brokenAt: expect.any(String) });
    const editor = await built({ orgs: [{ id: ORG, name: "x", role: "editor" }] });
    await expect(editor.api.listAudit(ORG)).rejects.toMatchObject({ status: 403 });
  });
});

describe("Sprint 5 mock: marked PDF (E2E-13)", () => {
  it("job → running → succeeded with a signed URL to a real PDF; options validated; viewers refused", async () => {
    const b = await built();
    const rows = await new Promise<{ sheet: { id: string } }[]>((r) => b.realtime.sheets(ORG, PID, (x) => r(x), () => {}));
    const { exportId } = await b.api.exportMarkedPdf(PID, { sheetIds: [rows[0]!.sheet.id], floorSplit: true, hideTitleBlock: true });
    const doc = await until(() => b.api.getExport(PID, exportId), (d) => d.status === "succeeded");
    expect(doc).toMatchObject({ kind: "marked_pdf", pageCount: 3, filename: expect.stringMatching(/\.pdf$/), url: expect.any(String) });
    await expect(b.api.exportMarkedPdf(PID, { sheetIds: [], floorSplit: false, hideTitleBlock: false })).rejects.toMatchObject({ status: 400 });
    const viewer = await built({ orgs: [{ id: ORG, name: "x", role: "viewer" }] });
    await expect(viewer.api.exportMarkedPdf(PID, { sheetIds: null, floorSplit: false, hideTitleBlock: false })).rejects.toMatchObject({ status: 403 });
  });

  it("mockPdfBytes is a parseable PDF (header, xref, trailer)", () => {
    const s = new TextDecoder().decode(mockPdfBytes("x", 2));
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s).toContain("/Count 2");
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe("xref");
  });
});

describe("Sprint 5 mock: share links + public API (E2E-09)", () => {
  it("create (1..90 days, label required) returns the raw URL once; list never contains the token", async () => {
    const b = await built();
    await expect(b.api.createShareLink(PID, { days: 0, label: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(b.api.createShareLink(PID, { days: 91, label: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(b.api.createShareLink(PID, { days: 7, label: "  " })).rejects.toMatchObject({ status: 400 });
    const r = await b.api.createShareLink(PID, { days: 7, label: "קבלן", recipient: "יוסי" });
    const token = r.url.split("/s/")[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256-bit base64url
    expect(r.link).toMatchObject({ hideTitleBlock: true, allowPdfDownload: false, viewCount: 0, revokedAt: null });
    expect(Date.parse(r.link.expiresAt) - Date.parse(r.link.createdAt)).toBe(7 * 86_400_000);
    const list = await b.api.listShareLinks(PID);
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.map((l) => l.id)).toContain(r.link.id);
  });

  it("public: meta counts views + audits share.view; revoked → 410 share_revoked; expired → 410; unknown → 404", async () => {
    const b = await built();
    const r = await b.api.createShareLink(PID, { days: 7, label: "קבלן", recipient: "יוסי", allowPdfDownload: true });
    const token = r.url.split("/s/")[1]!;
    const meta = await b.publicShare.getMeta(token);
    expect(meta).toMatchObject({ projectName: "בית משפחת נח", allowPdfDownload: true, hideTitleBlock: true, watermark: expect.stringMatching(/^שותף עם יוסי • \d\d\.\d\d\.\d{4} • /) });
    expect(meta.sheets.length).toBeGreaterThan(0);
    expect(JSON.stringify(meta)).not.toContain("רחוב הדקל"); // no address
    const boq = await b.publicShare.getBoq(token);
    expect(boq.lines.length).toBeGreaterThan(5);
    expect(Object.keys(boq.lines[0]!)).not.toEqual(expect.arrayContaining(["reasons", "qtyOverrideReason", "reviewedBy", "note"]));
    expect((await b.api.listShareLinks(PID)).find((l) => l.id === r.link.id)!.viewCount).toBe(1);
    expect((await b.api.listAudit(ORG, { entity: "shareLinks", action: "view" })).items[0]).toMatchObject({ actor: null, actorKind: "share_link", entityId: r.link.id, meta: { ipPrefix: expect.any(String) } });

    await b.api.revokeShareLink(PID, r.link.id);
    const revoked = await b.publicShare.getMeta(token).catch((e: ApiError) => e);
    expect(revoked).toMatchObject({ status: 410, code: "share_revoked" });
    await expect(b.publicShare.getMeta("demo-expired")).rejects.toMatchObject({ status: 410, code: "share_expired" });
    const unknown = await b.publicShare.getMeta("nope").catch((e: ApiError) => e);
    expect(unknown).toMatchObject({ status: 404 });
    expect((unknown as ApiError).message).toBe((revoked as ApiError).message); // same body except status
  });

  it("public overlay: locked sheet's detections + line evidence, no text layer", async () => {
    const b = await built();
    const meta = await b.publicShare.getMeta("demo-noah");
    const withDet = meta.sheets.find((s) => s.id === "noah-eb8be8a3-p0")!;
    const o = await b.publicShare.getOverlay("demo-noah", withDet.id);
    expect(o.detections.length).toBeGreaterThan(20);
    expect(Object.keys(o.evidence).length).toBeGreaterThan(0);
    expect(Object.keys(o.detections[0]!).sort()).toEqual(["bboxMm", "centerMm", "class", "floor", "id", "level", "lifecycle", "roomId"]);
  });
});

describe("Sprint 5 mock: org settings + offboarding", () => {
  it("PATCH settings: validated, only known fields, each change audited, reflected in /me", async () => {
    const b = await built();
    await expect(b.api.patchOrgSettings(ORG, { greenThreshold: 0.5 })).rejects.toMatchObject({ status: 400 });
    await expect(b.api.patchOrgSettings(ORG, { vatRate: 0.2 } as never)).rejects.toMatchObject({ status: 400 });
    const s = await b.api.patchOrgSettings(ORG, { greenThreshold: 0.99, llmEnabled: true });
    expect(s).toMatchObject({ greenThreshold: 0.99, llmEnabled: true });
    expect((await b.api.getMe()).orgs[0]!.settings).toMatchObject({ greenThreshold: 0.99, llmEnabled: true });
    expect((await b.api.listAudit(ORG, { action: "update_settings" })).items).toHaveLength(2);
    const editor = await built({ orgs: [{ id: ORG, name: "x", role: "editor" }] });
    await expect(editor.api.patchOrgSettings(ORG, { llmEnabled: true })).rejects.toMatchObject({ status: 403 });
  });

  it("blockExportOnRed from settings blocks the Excel export", async () => {
    const b = await built();
    await b.api.patchOrgSettings(ORG, { blockExportOnRed: true });
    const hasRed = (await b.api.listBoqLines(PID)).items.some((l) => l.level === "red");
    if (hasRed) await expect(b.api.exportBoq(PID, { templateId: null, split: "summed", draftNote: false })).rejects.toMatchObject({ code: "export_blocked" });
    expect((await b.api.listBoqLines(PID)).blockExportOnRed).toBe(true);
  });

  it("offboarding: export ZIP → slug confirmation → status offboarding, share links revoked, writes refused", async () => {
    const b = await built();
    const x = await b.api.startOffboardingExport(ORG);
    const done = await until(() => b.api.getOffboardingExport(ORG, x.id), (d) => d.status === "succeeded");
    expect(done.url).toBeTruthy();
    expect(Date.parse(done.expiresAt!) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    await expect(b.api.offboardOrg(ORG, { confirm: "studio-noah" })).rejects.toMatchObject({ status: 400, code: "confirmation_mismatch" });
    const r = await b.api.offboardOrg(ORG, { confirm: "  סטודיו נח לעיצוב פנים " });
    expect(r.status).toBe("offboarding");
    expect(Date.parse(r.deleteAfter) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect((await b.api.getMe()).orgs[0]).toMatchObject({ status: "offboarding", slug: "studio-noah" });
    await expect(b.publicShare.getMeta("demo-noah")).rejects.toMatchObject({ status: 410 });
    await expect(b.api.createShareLink(PID, { days: 7, label: "x" })).rejects.toMatchObject({ status: 403 });
  });
});
