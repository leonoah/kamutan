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
} from "@kamutan/contracts";
import { createMockBackend } from "./mock";

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
