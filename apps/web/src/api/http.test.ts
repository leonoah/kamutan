import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http";
import { ApiError } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("REST client", () => {
  it("calls same-origin /api/v1 with the Firebase ID token as Bearer", async () => {
    const fetchImpl = vi.fn(async () => json({ items: [], nextCursor: null }));
    const api = createHttpClient(async () => "id-token", "/api/v1", fetchImpl as unknown as typeof fetch);
    await api.listProjects("org 1");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/projects?orgId=org%201&limit=100");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer id-token");
  });

  it("posts upload + finalize to the contract endpoints", async () => {
    const fetchImpl = vi.fn(async () => json({}, 201));
    const api = createHttpClient(async () => "t", "/api/v1", fetchImpl as unknown as typeof fetch);
    await api.createUpload("p1", { filename: "a.pdf", sizeBytes: 10 });
    await api.finalizeUpload("p1", { uploadToken: "tok-tok-tok-tok-tok", name: "a.pdf" });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => [u, i.method, JSON.parse(i.body as string)])).toEqual([
      ["/api/v1/projects/p1/uploads", "POST", { filename: "a.pdf", sizeBytes: 10 }],
      ["/api/v1/projects/p1/sheet-sets", "POST", { uploadToken: "tok-tok-tok-tok-tok", name: "a.pdf" }],
    ]);
  });

  it("omits Authorization when signed out and maps the contract error body", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ error: { code: "upload_expired", message: "expired", requestId: "r-1" } }, 410),
    );
    const api = createHttpClient(async () => null, "/api/v1", fetchImpl as unknown as typeof fetch);
    const err = await api.getMe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 410, code: "upload_expired", requestId: "r-1" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("Sprint 2: overlay, legend entries (list/patch) and unknown-cluster resolve hit the contract endpoints", async () => {
    const fetchImpl = vi.fn(async () => json({ items: [], nextCursor: null, expiresAt: null }));
    const api = createHttpClient(async () => "t", "/api/v1", fetchImpl as unknown as typeof fetch);
    await api.getOverlay("p1", "s 1", "v1");
    await api.listLegendEntries("p1", { sheetId: "s1", limit: 200 });
    await api.patchLegendEntry("p1", "le_s1_1", { action: "reassign", class: "socket_power" });
    await api.resolveUnknownCluster("p1", "u_1", { sheetId: "s1", versionId: "v1", class: "data_point", createLegendEntry: true });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => [u, i.method ?? "GET", i.body ? JSON.parse(i.body as string) : null])).toEqual([
      ["/api/v1/projects/p1/sheets/s%201/versions/v1/overlay", "GET", null],
      ["/api/v1/projects/p1/legend-entries?sheetId=s1&limit=200", "GET", null],
      ["/api/v1/projects/p1/legend-entries/le_s1_1", "PATCH", { action: "reassign", class: "socket_power" }],
      ["/api/v1/projects/p1/unknown-clusters/u_1/resolve", "POST", { sheetId: "s1", versionId: "v1", class: "data_point", createLegendEntry: true }],
    ]);
  });

  it("Sprint 3: BOQ + library/templates/rules hit the API agent's routes and adapt the DTOs", async () => {
    const view = {
      summary: { latestBuildId: "b1", builtAt: "2026-10-14T08:00:00.000Z", stale: true, build: { id: "b1", status: "succeeded" }, blockExportOnRed: true },
      items: [{ id: "ln_4_01", chapter: "04", code: "4.01", description: "שקע כפול", qty: 3, unit: "יחידה", level: "green", status: "draft" }],
      nextCursor: null,
    };
    const responses: unknown[] = [
      { build: { id: "b2" }, deduplicated: false, jobId: "j2" },
      view,
      { line: { ...view.items[0], qtyOverride: 5, qtyOverrideReason: "r" } },
      { lineId: "ln_4_01", items: [] },
      { sheetId: "s 1", versionId: "v1", buildId: "b1", detections: {}, linkGroups: {} },
      { url: "https://x/y.xlsx", fileName: "בית.xlsx", expiresAt: "2026-10-14T08:02:00.000Z" },
      { items: [], nextCursor: null },
      { id: "it" },
      { import: { id: "imp-uuid" }, storagePath: "orgs/o1/imports/imp-uuid.xlsx", contentType: "application/vnd.ms-excel" },
      { id: "imp-uuid", originalName: "a.xlsx", status: "running", jobId: "j", stats: null, error: null, job: { progress: 40 } },
      { id: "imp-uuid", originalName: "a.xlsx", status: "succeeded", jobId: "j", stats: { created: 7, updated: 1, templates: 1 }, error: null },
      { items: [] },
      { id: "tpl" },
      { items: [] },
      { id: "r1" },
    ];
    const fetchImpl = vi.fn(async () => json(responses.shift()));
    const api = createHttpClient(async () => "t", "/api/v1", fetchImpl as unknown as typeof fetch);
    expect(await api.buildBoq("p1")).toEqual({ buildId: "b2", jobId: "j2" });
    const lines = await api.listBoqLines("p1");
    expect(lines.boq).toEqual({ latestBuildId: "b1", builtAt: "2026-10-14T08:00:00.000Z", stale: true });
    expect(lines.blockExportOnRed).toBe(true);
    expect(lines.items[0]).toMatchObject({ code: "4.01", byFloor: {}, evidenceCount: 0, sourceVersions: [] });
    expect(await api.patchBoqLine("p1", "ln_4_01", { qtyOverride: 5, reason: "r" })).toMatchObject({ qtyOverride: 5, qtyOverrideReason: "r" });
    await api.getBoqLineEvidence("p1", "ln_4_01");
    await api.getBoqSheetEvidence("p1", "s 1", "v1");
    expect(await api.exportBoq("p1", { templateId: null, split: "byFloor", draftNote: true })).toEqual({
      url: "https://x/y.xlsx",
      filename: "בית.xlsx",
      expiresAt: "2026-10-14T08:02:00.000Z",
    });
    await api.listLibraryItems("o1", { q: "שקע", chapter: "04", limit: 500 });
    await api.patchLibraryItem("o1", "it_4_01", { active: false });
    const slot = await api.createLibraryImport("o1", { filename: "a.xlsx", sizeBytes: 9 });
    expect(slot).toMatchObject({ importId: "imp-uuid", storagePath: "orgs/o1/imports/imp-uuid.xlsx" });
    expect(await api.startLibraryImport("o1", "imp-uuid", slot.uploadToken)).toMatchObject({ status: "running", progress: 40 });
    expect((await api.getLibraryImport("o1", "imp-uuid")).result).toMatchObject({ itemsAdded: 7, itemsUpdated: 1, ambiguousCodes: [] });
    await api.listBoqTemplates("o1");
    await api.setDefaultBoqTemplate("o1", "tpl");
    await api.listBoqRules("o1");
    await api.patchBoqRule("o1", "r1", { enabled: false });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => [u, i.method ?? "GET", i.body ? JSON.parse(i.body as string) : null])).toEqual([
      ["/api/v1/projects/p1/boq/build", "POST", {}],
      ["/api/v1/projects/p1/boq?limit=500", "GET", null],
      ["/api/v1/projects/p1/boq/lines/ln_4_01", "PATCH", { qtyOverride: 5, reason: "r" }],
      ["/api/v1/projects/p1/boq/lines/ln_4_01/evidence", "GET", null],
      ["/api/v1/projects/p1/boq/evidence?sheetId=s%201&versionId=v1", "GET", null],
      ["/api/v1/projects/p1/boq/export", "POST", { split: "byFloor", markDraft: true }],
      ["/api/v1/library/items?orgId=o1&q=%D7%A9%D7%A7%D7%A2&chapter=04&limit=500", "GET", null],
      ["/api/v1/library/items/it_4_01?orgId=o1", "PATCH", { active: false }],
      ["/api/v1/library/imports", "POST", { orgId: "o1", filename: "a.xlsx", sizeBytes: 9 }],
      ["/api/v1/library/imports/imp-uuid/finalize", "POST", { orgId: "o1" }],
      ["/api/v1/library/imports/imp-uuid?orgId=o1", "GET", null],
      ["/api/v1/boq-templates?orgId=o1", "GET", null],
      ["/api/v1/boq-templates/tpl?orgId=o1", "PATCH", { default: true }],
      ["/api/v1/boq-rules?orgId=o1", "GET", null],
      ["/api/v1/boq-rules/r1?orgId=o1", "PATCH", { enabled: false }],
    ]);
  });
});
