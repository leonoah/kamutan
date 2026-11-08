import {
  ApplyImportPricesResponseSchema,
  BoqBuildListSchema,
  BoqCompareExportResponseSchema,
  BoqComparisonSchema,
  BoqTotalsSchema,
  BulkLibraryPriceResponseSchema,
  DeleteProjectResponseSchema,
  DeleteSheetSetResponseSchema,
  ItemPriceSchema,
  PatchProjectPricingResponseSchema,
  PriceImportReportSchema,
  PublicShareBoqSchema,
  API_ERROR_CODES,
  DetectionsArtifactSchema,
  InputQualitySchema,
  isQualityRejected,
  qualityReasonHe,
  RoomsArtifactSchema,
  SheetSummarySchema,
  SheetVersionSchema,
} from "@kamutan/contracts";
import { createMockBackend } from "./mock";
import type { SheetRow } from "./types";

/**
 * The mock backend answers with the API's exact Sprint 8 shapes: every response is parsed with the contracts' Zod
 * schemas (strict parse — a missing / misnamed field fails here, not in a Playwright run against the real API).
 */
const ORG = "org-demo";
type Schema<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } } };
const ok = <T,>(schema: Schema<T>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues.slice(0, 5), null, 1));
  return r.data;
};

async function built() {
  const b = createMockBackend({ latencyMs: 0, jobTickMs: 1, boqTickMs: 1, devIndex: false, boqPrebuilt: true });
  for (let i = 0; i < 400 && !(await b.api.listBoqLines("p-noah")).items.length; i++) await new Promise((r) => setTimeout(r, 5));
  return b;
}

describe("Sprint 8: mock responses parse with the contracts schemas", () => {
  it("prices: library ItemPrice, bulk, pricing, BOQ totals, line effective-price fields", async () => {
    const b = await built();
    const items = (await b.api.listLibraryItems(ORG)).items;
    for (const i of items) if (i.price) ok(ItemPriceSchema, i.price);
    const bulk = await b.api.bulkPatchPrices(ORG, { items: [{ itemId: items[0]!.id, amount: 12.5 }, { itemId: "missing", amount: 1 }] });
    ok(BulkLibraryPriceResponseSchema, bulk);
    ok(PatchProjectPricingResponseSchema, await b.api.patchProjectPricing("p-noah", -7.5));
    const lines = await b.api.listBoqLines("p-noah");
    ok(BoqTotalsSchema, lines.totals);
    for (const l of lines.items) {
      expect(l.unitPrice === null || typeof l.unitPrice === "number").toBe(true);
      expect([null, "library", "override"]).toContain(l.unitPriceSource);
      expect(l.lineTotal === null || typeof l.lineTotal === "number").toBe(true);
    }
  });

  it("price import: dry-run report and apply-prices", async () => {
    const b = await built();
    const slot = await b.api.createLibraryImport(ORG, { filename: "priced.xlsx", sizeBytes: 10, mode: "prices", dryRun: true });
    await b.uploads.start(slot.storagePath, new Blob(["x"]), slot.contentType, () => undefined).done;
    await b.api.startLibraryImport(ORG, slot.importId, slot.uploadToken);
    let im = await b.api.getLibraryImport(ORG, slot.importId);
    for (let i = 0; i < 400 && im.status !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      im = await b.api.getLibraryImport(ORG, slot.importId);
    }
    const report = ok(PriceImportReportSchema, im.result?.prices);
    expect(report.dryRun).toBe(true);
    ok(ApplyImportPricesResponseSchema, await b.api.applyPriceImport(ORG, slot.importId, { overwriteItemIds: [] }));
  });

  it("comparison: builds list, previous / export / explicit, export response", async () => {
    const b = await built();
    const builds = await b.api.listBoqBuilds("p-noah");
    ok(BoqBuildListSchema, { items: builds });
    ok(BoqComparisonSchema, await b.api.compareBoqBuilds("p-noah", {}));
    ok(BoqComparisonSchema, await b.api.compareBoqBuilds("p-noah", { base: "export" }));
    ok(BoqComparisonSchema, await b.api.compareBoqBuilds("p-noah", { from: builds[1]!.buildId, to: builds[0]!.buildId }));
    ok(BoqCompareExportResponseSchema, await b.api.exportBoqComparison("p-noah", {}));
  });

  it("share with prices: public BOQ snapshot", async () => {
    const b = await built();
    ok(PublicShareBoqSchema, await b.publicShare.getBoq("demo-noah-prices"));
    ok(PublicShareBoqSchema, await b.publicShare.getBoq("demo-noah"));
  });

  it("deletes: sheet set and project", async () => {
    const b = await built();
    const sets: { id: string }[] = await new Promise((res) => {
      const u = b.realtime.sheetSets(ORG, "p-noah", (s) => (s.length ? (u(), res(s)) : undefined), () => undefined);
    });
    ok(DeleteSheetSetResponseSchema, await b.api.deleteSheetSet("p-noah", sets[0]!.id));
    ok(DeleteProjectResponseSchema, await b.api.deleteProject("p-noah", { confirmName: "בית משפחת נח" }));
  });
});

describe("Sprint 9: mock input-quality data parses with the contracts schemas", () => {
  const rowsOf = (b: ReturnType<typeof createMockBackend>, projectId: string) =>
    new Promise<SheetRow[]>((resolve, reject) => {
      const unsub = b.realtime.sheets(ORG, projectId, (rows) => {
        queueMicrotask(() => unsub());
        resolve(rows);
      }, reject);
    });

  it("p-web: one warn + one reject sheet; versions, quality and sheet summaries are contract-valid", async () => {
    const b = createMockBackend({ latencyMs: 0, devIndex: false });
    const rows = await rowsOf(b, "p-web");
    const byStatus = Object.fromEntries(rows.map((r) => [r.version?.quality?.status ?? "none", r]));
    expect(Object.keys(byStatus).sort()).toEqual(["reject", "warn"]);
    for (const r of rows) {
      const v = r.version!;
      ok(InputQualitySchema, v.quality);
      // the full version doc as the API returns it (DTO: createdAt / artifacts tiles in the contracts' shape)
      const { tiles, ...artifacts } = v.artifacts ?? {};
      ok(SheetVersionSchema, {
        ...v,
        artifacts: { ...artifacts, ...(tiles ? { tiles: { ...tiles, format: "webp" } } : {}) },
        page: v.page ?? null,
        regions: v.regions ?? [],
        stats: v.stats ?? null,
        workerVersion: v.workerVersion ?? null,
        updatedAt: v.updatedAt ?? null,
      });
      ok(SheetSummarySchema.shape.currentVersion, { id: v.id, status: v.status, progress: v.progress, ...(v.error ? { error: v.error } : {}), quality: v.quality });
      expect(v.status).toBe("ready"); // a rejected sheet stays viewable
      expect(v.artifacts?.tiles).toBeTruthy();
    }
    const reject = byStatus.reject!.version!;
    expect(isQualityRejected(reject)).toBe(true);
    expect(reject.error?.code).toBe("input_quality_rejected");
    expect(API_ERROR_CODES).toContain(reject.error!.code);
    expect(reject.artifacts?.detections).toBeUndefined();
    expect(reject.stats?.detections).toBeUndefined();
  });

  it("warn sheet: detections artifact is contract-valid, nothing green, every item carries qualityReasonHe first", async () => {
    const b = createMockBackend({ latencyMs: 0, devIndex: false });
    const warn = (await rowsOf(b, "p-web")).find((r) => r.version?.quality?.status === "warn")!;
    const m = await b.api.getOverlay("p-web", warn.sheet.id, warn.version!.id);
    const det = ok(DetectionsArtifactSchema, await (await fetch(m.detections!.url)).json());
    const rooms = ok(RoomsArtifactSchema, await (await fetch(m.rooms!.url)).json());
    const reason = qualityReasonHe(warn.version!.quality!);
    expect(reason).toBe("איכות קובץ ירודה: צילום מסך ולא קובץ שרטוט");
    expect(det.detections.length).toBeGreaterThan(0);
    for (const d of [...det.detections, ...rooms.rooms]) {
      expect(d.level).not.toBe("green");
      expect(d.reasons[0]).toBe(reason);
    }
    // the reject sheet: no understanding at all
    const reject = (await rowsOf(b, "p-web")).find((r) => r.version?.quality?.status === "reject")!;
    const mr = await b.api.getOverlay("p-web", reject.sheet.id, reject.version!.id);
    expect(mr.detections).toBeNull();
  });
});
