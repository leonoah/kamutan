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

  it("Sprint 4: corrections / batch / revert / queue / room settings / similar-searches follow the API contracts", async () => {
    const correction = { id: "c1", kind: "accept", batchId: null };
    const responses: Record<string, unknown> = {
      "POST /api/v1/projects/p1/corrections": { correction, rebuild: { stale: true, autoRebuild: "scheduled", buildId: "b9", notBefore: null } },
      "POST /api/v1/projects/p1/corrections/batch": { batch: { id: "bt_7" }, items: [correction, { ...correction, id: "c2" }], rebuild: {} },
      "POST /api/v1/projects/p1/corrections/c1/revert": { correction: { ...correction, revertedAt: "t" }, rebuild: {} },
      "POST /api/v1/projects/p1/correction-batches/bt_7/revert": { batch: { id: "bt_7" }, reverted: 2, rebuild: {} },
      "GET /api/v1/projects/p1/corrections?limit=500&sheetId=s1": { items: [correction], nextCursor: null },
      "GET /api/v1/projects/p1/review-queue?limit=200": {
        items: [
          {
            id: "cl:abc",
            kind: "cluster",
            level: "yellow",
            risk: 2.5,
            score: 0.6,
            qtyImpact: 3,
            title: "שקע כפול (4.01) · 3 מופעים",
            reasons: ["התאמה חלקית"],
            suggestedAction: "accept",
            sheetId: "s1",
            versionId: "v1",
            floor: "ground",
            bboxMm: { x: 1, y: 2, w: 3, h: 4 },
            thumbUrl: null,
            class: "socket_double",
            itemCode: "4.01",
            lineIds: ["ln_4_01"],
            detectionIds: ["d_1", "d_2", "d_3"],
            memberBboxesMm: [{ x: 1, y: 2, w: 1, h: 1 }, { x: 2, y: 2, w: 1, h: 1 }, { x: 3, y: 2, w: 1, h: 1 }],
            count: 3,
            ref: { signature: "sigsigsig" },
          },
          { id: "uc:s1:v1:u_1", kind: "unknown_cluster", level: "red", risk: 1, score: null, qtyImpact: 2, title: "סמל לא מוכר", reasons: [], suggestedAction: "resolve_unknown", sheetId: "s1", versionId: "v1", floor: null, bboxMm: null, thumbUrl: "https://x/u.webp", class: null, itemCode: null, lineIds: [], detectionIds: ["d_9"], count: 1, ref: { clusterId: "u_1" } },
        ],
        nextCursor: null,
        total: 2,
        counts: { byKind: {}, byLevel: { yellow: 1, red: 1 } },
        buildId: "b1",
        stale: false,
        generatedAt: "t",
        expiresAt: null,
      },
      "GET /api/v1/projects/p1/rooms/s1/r_1/settings": { settings: { sheetId: "s1", roomId: "r_1", claddingHeightM: 2.6, by: null, at: null }, isDefault: true, room: null },
      "PUT /api/v1/projects/p1/rooms/s1/r_1/settings": { settings: { sheetId: "s1", roomId: "r_1", claddingHeightM: 2.4, by: "u", at: "t" }, isDefault: false, room: null },
      "POST /api/v1/projects/p1/similar-searches": { search: { id: "sim1", status: "queued", exemplar: {}, candidates: [], error: null }, jobId: "j1" },
      "GET /api/v1/projects/p1/similar-searches/sim1": {
        search: { id: "sim1", status: "succeeded", exemplar: {}, candidates: [{ id: "c_1", sheetId: "s1", versionId: "v1", centerMm: { x: 1, y: 1 }, bboxMm: { x: 0, y: 0, w: 2, h: 2 }, score: 0.9, alreadyDetected: "d_1", currentClass: "socket_single", thumb: "c_1.webp" }], error: null },
        thumbUrls: { c_1: "https://x/c_1.webp" },
        expiresAt: null,
      },
    };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => json(responses[`${init.method ?? "GET"} ${url}`] ?? {}));
    const api = createHttpClient(async () => "t", "/api/v1", fetchImpl as unknown as typeof fetch);
    const req = {
      id: "corr_local",
      batchId: "batch_local",
      kind: "accept" as const,
      sheetId: "s1",
      versionId: "v1",
      anchorMm: { x: 1, y: 2 },
      radiusMm: 3,
      detectionId: "d_1",
      signature: null,
      class: "socket_double",
      itemCode: null,
      linkGroupId: null,
      geometry: null,
      quantity: null,
      unit: null,
      roomId: null,
      floor: null,
      reason: null,
    };
    expect(await api.createCorrection("p1", req)).toEqual(correction);
    expect(await api.createCorrectionsBatch("p1", { batchId: "batch_local", corrections: [req, req], source: "cluster" })).toEqual({ items: [correction, { ...correction, id: "c2" }], batchId: "bt_7" });
    expect((await api.revertCorrection("p1", "c1")).revertedAt).toBe("t");
    expect(await api.revertCorrectionsBatch("p1", "bt_7")).toEqual({ reverted: 2 });
    expect((await api.listCorrections("p1", { sheetId: "s1" })).items).toHaveLength(1);
    const q = await api.getReviewQueue("p1");
    expect(q.total).toBe(2);
    expect(q.items[0]).toMatchObject({ kind: "cluster", lineId: "ln_4_01", itemCode: "4.01", members: [{ detectionId: "d_1", bboxMm: { x: 1, y: 2, w: 1, h: 1 } }, {}, {}] });
    expect(q.items[1]).toMatchObject({ kind: "unknown_cluster", level: "unknown", clusterId: "u_1", suggestedAction: "resolve", bboxMm: { x: 0, y: 0, w: 0, h: 0 } });
    expect(await api.getRoomSettings("p1", "s1", "r_1")).toMatchObject({ isDefault: true, settings: { id: "s1__r_1" } });
    await api.putRoomSettings("p1", "s1", "r_1", {
      claddingHeightM: 2.4,
      floorTiled: true,
      floorMaterialItemCode: null,
      wallMaterialItemCode: null,
      partialCladding: [{ wallId: "w_1", fromM: 0, toM: 1, heightM: 0.6 }],
      wasteFactor: 0.07,
      includeInWaterproofing: true,
      keepOpenings: [],
    });
    const s = await api.findSimilar("p1", { exemplar: { sheetId: "s1", versionId: "v1", bboxMm: { x: 0, y: 0, w: 2, h: 2 }, class: "socket_power", detectionId: "d_1" }, scope: "project" });
    expect(s.status).toBe("queued");
    const done = await api.getSimilarSearch("p1", "sim1");
    expect(done.thumbs).toEqual({ c_1: "https://x/c_1.webp" });
    expect(done.candidates[0]!.alreadyDetected).toBe("d_1");

    const calls = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).map(([u, i]) => [u, i.method ?? "GET", i.body ? JSON.parse(i.body as string) : null]);
    const { id: _id, batchId: _b, ...strict } = req;
    expect(calls[0]).toEqual(["/api/v1/projects/p1/corrections", "POST", strict]); // client-only id / batchId stripped (strict schema)
    expect(calls[1]).toEqual(["/api/v1/projects/p1/corrections/batch", "POST", { items: [strict, strict], source: "cluster", similarSearchId: null }]);
    expect(calls[7]).toEqual([
      "/api/v1/projects/p1/rooms/s1/r_1/settings",
      "PUT",
      { claddingHeightM: 2.4, floorTiled: true, floorMaterialItemCode: null, wallMaterialItemCode: null, partialCladding: [{ wallId: "w_1", fromM: 0, toM: 1, heightM: 0.6 }], wasteFactor: 0.07, includeInWaterproofing: true },
    ]);
    expect(calls[8]).toEqual([
      "/api/v1/projects/p1/similar-searches",
      "POST",
      { exemplar: { sheetId: "s1", versionId: "v1", bboxMm: { x: 0, y: 0, w: 2, h: 2 }, class: "socket_power" }, scope: "project", correctionId: null },
    ]);
  });

  it("Sprint 6: quick-measure and batch-status routes; null qty → needsInput; ids in `updated` tolerated", async () => {
    const ln = { id: "l1", code: "7.01", qty: null, unit: 'מ"ר', level: "red", status: "draft", chapter: "06", description: "x" };
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/quick-measure")
        ? json({ line: { ...ln, qty: 4.2 }, correction: { id: "c1" } })
        : json({ updated: [{ ...ln, qty: 1, status: "approved" }, "l2"], skipped: [{ lineId: "l3", reason: "red" }] }),
    );
    const api = createHttpClient(async () => "t", "/api/v1", fetchImpl as unknown as typeof fetch);
    const req = { kind: "measure_area" as const, quantity: 4.2, unit: "m2" as const, sheetId: "s1", versionId: "v1", geometry: { type: "polygon" as const, mm: [{ x: 0, y: 0 }] }, floor: "ground" };
    const q = await api.quickMeasureBoqLine("p1", "l 1", req);
    expect(q.line.qty).toBe(4.2);
    expect(q.correction?.id).toBe("c1");
    const b = await api.batchBoqLineStatus("p1", { lineIds: ["l1", "l2", "l3"], to: "approved", includeRed: false });
    expect(b.updated.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(b.updated[0]!.status).toBe("approved");
    expect(b.skipped).toEqual([{ lineId: "l3", reason: "red" }]);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([u, i]) => [u, i.method, JSON.parse(i.body as string)])).toEqual([
      ["/api/v1/projects/p1/boq/lines/l%201/quick-measure", "POST", req],
      ["/api/v1/projects/p1/boq/lines/batch-status", "POST", { lineIds: ["l1", "l2", "l3"], to: "approved", includeRed: false }],
    ]);
  });

  it("Sprint 7: GET boq/document (query + normalisation), PATCH a line's description (+ library), share line marker", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("/boq/document")
        ? json({
            titleRows: ["כתב כמויות"],
            columns: ["סעיף", { key: "description", title: "תאור העבודה" }],
            chapters: [{ code: "04", title: "חשמל", notes: ["א"], subtotal: 0, rows: [{ lineId: "l1", code: "4.01", description: "x", unit: "יח'", qty: null, price: null, total: null, kind: "line" }] }],
            totals: { beforeVat: 0, vat: 0, afterVat: 0 },
            warnings: [{ kind: "needsInput", count: 1 }],
            generatedAt: "2026-11-04T10:00:00.000Z",
          })
        : json({ line: { id: "l1", code: "4.01", qty: 2, unit: "יח'", level: "green", status: "draft", chapter: "04", description: "x", descriptionOverride: "y" } }),
    );
    const api = createHttpClient(async () => "t", "/api/v1", fetchImpl as unknown as typeof fetch);
    const d = await api.getBoqDocument("p1", { split: "floor", confidence: true, chapters: ["04", "05"] });
    expect(d.columns).toEqual([
      { key: "code", title: "סעיף" },
      { key: "description", title: "תאור העבודה" },
    ]);
    expect(d.chapters[0]!.rows[0]!.qty).toBeNull();
    const l = await api.patchBoqLine("p1", "l1", { description: "y", reason: "לקוח", alsoUpdateLibrary: true });
    expect(l.descriptionOverride).toBe("y");
    await api.patchBoqLine("p1", "l1", { description: null });
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("/api/v1/projects/p1/boq/document?split=floor&confidence=1&chapters=04%2C05");
    expect(calls.slice(1).map(([u, i]) => [u, i.method, JSON.parse(i.body as string)])).toEqual([
      ["/api/v1/projects/p1/boq/lines/l1", "PATCH", { description: "y", reason: "לקוח", alsoUpdateLibrary: true }],
      ["/api/v1/projects/p1/boq/lines/l1", "PATCH", { description: null }],
    ]);
  });
});

describe("REST client: Sprint 8 routes (contracts prices / compare / housekeeping)", () => {
  it("calls the published routes with bodies the contracts' request schemas accept", async () => {
    const { ApplyImportPricesRequestSchema, BoqCompareExportRequestSchema, BoqCompareQuerySchema, BulkLibraryPriceRequestSchema, DeleteProjectRequestSchema, PatchProjectPricingRequestSchema } = await import("@kamutan/contracts");
    const fetchImpl = vi.fn(async () => json({ items: [] }));
    const api = createHttpClient(async () => "t", "/api/v1", fetchImpl as unknown as typeof fetch);
    await api.bulkPatchPrices("org1", { items: [{ itemId: "it1", amount: 12.5 }, { itemId: "it2", amount: null }] });
    await api.applyPriceImport("org1", "imp1", { overwriteItemIds: ["it1"] });
    await api.patchProjectPricing("p1", -5);
    await api.listBoqBuilds("p1");
    await api.compareBoqBuilds("p1", {});
    await api.compareBoqBuilds("p1", { from: "b1", to: "b2" });
    await api.compareBoqBuilds("p1", { base: "export" });
    await api.exportBoqComparison("p1", { base: "export" });
    await api.deleteSheetSet("p1", "set1");
    await api.deleteProject("p1", { confirmName: "בית" });
    const calls = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).map(([u, i]) => ({ url: u, method: i.method ?? "GET", body: i.body ? JSON.parse(i.body as string) : undefined }));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/v1/library/prices",
      "POST /api/v1/library/imports/imp1/apply-prices",
      "PATCH /api/v1/projects/p1/boq/pricing",
      "GET /api/v1/projects/p1/boq/builds?limit=20",
      "GET /api/v1/projects/p1/boq/compare?base=previous",
      "GET /api/v1/projects/p1/boq/compare?from=b1&to=b2&base=previous",
      "GET /api/v1/projects/p1/boq/compare?base=export",
      "POST /api/v1/projects/p1/boq/compare/export",
      "DELETE /api/v1/projects/p1/sheet-sets/set1",
      "DELETE /api/v1/projects/p1",
    ]);
    expect(BulkLibraryPriceRequestSchema.parse(calls[0]!.body)).toMatchObject({ orgId: "org1" });
    expect(ApplyImportPricesRequestSchema.parse(calls[1]!.body).overwriteItemIds).toEqual(["it1"]);
    expect(PatchProjectPricingRequestSchema.parse(calls[2]!.body)).toEqual({ adjustmentPct: -5 });
    for (const c of calls.slice(4, 7)) BoqCompareQuerySchema.parse(Object.fromEntries(new URL(c.url, "http://x").searchParams));
    expect(BoqCompareExportRequestSchema.parse(calls[7]!.body)).toEqual({ base: "export" });
    expect(DeleteProjectRequestSchema.parse(calls[9]!.body)).toEqual({ confirmName: "בית" });
  });
});
