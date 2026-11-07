import { createMockBackend } from "@/api/mock";
import type { BoqLine, LibraryItem } from "@/api/types";
import { filterLines } from "@/features/boq/model";
import { compareQueryOf, fmtDeltaQty } from "@/features/compare/ComparePage";
import { createLazyRealtime, createLazyUploads } from "@/api/lazyBackend";
import { UploadCanceledError } from "@/api/types";
import { compareSnapshots, demoPriceFile, runPriceImport, seedPreviousSnapshot, snapshotOf } from "@/api/mockSprint8";
import { reviewRows } from "./LibraryPrices";
import {
  applyPriceOverride,
  bulkPlanPrices,
  effectivePrice,
  formatMoney,
  formatMoneyDelta,
  importApplyCounts,
  lineTotal,
  parseMoney,
  parsePct,
  totalsOf,
} from "./model";

const line = (over: Partial<BoqLine> = {}): BoqLine => ({
  id: "l1",
  chapter: "04",
  code: "4.01",
  description: "שקע כפול",
  qty: 10,
  unit: "יחידה",
  level: "green",
  status: "draft",
  byFloor: {},
  evidenceCount: 0,
  ruleId: null,
  sourceVersions: [],
  computedAt: null,
  ...over,
});
const ORG = "org-demo";
async function built() {
  const b = createMockBackend({ latencyMs: 0, jobTickMs: 1, boqTickMs: 1, devIndex: false, boqPrebuilt: true });
  for (let i = 0; i < 400 && !(await b.api.listBoqLines("p-noah")).items.length; i++) await new Promise((r) => setTimeout(r, 5));
  return b;
}

describe("Sprint 8: price model", () => {
  it("effective price = API unitPrice (override wins); total = effective qty × price; needsInput counts qty 0", () => {
    expect(effectivePrice(line({ unitPrice: 100 }))).toBe(100);
    expect(effectivePrice(line({ unitPrice: 0, priceOverride: 0 }))).toBe(0); // a free line is priced, not "ללא מחיר"
    expect(effectivePrice(line({ priceOverride: 80 }))).toBe(80); // not yet priced by the API → the override
    expect(effectivePrice(line())).toBeNull();
    expect(lineTotal(line({ unitPrice: 12.5, qtyOverride: 3 }))).toBe(37.5);
    expect(lineTotal(line())).toBeNull();
    expect(lineTotal(line({ unitPrice: 50, needsInput: true }))).toBe(0);
    expect(lineTotal(line({ unitPrice: 50, needsInput: true, qtyOverride: 2 }))).toBe(100);
    expect(lineTotal(line({ unitPrice: 50, lineTotal: 499 }))).toBe(499); // the API's lineTotal wins
  });

  it("totals (contracts BoqTotals): lines → adjustment → before VAT → VAT → after VAT; unpriced lines counted", () => {
    const ls = [line({ id: "a", unitPrice: 100 }), line({ id: "b", code: "4.02", qty: 3, unitPrice: 33.33 }), line({ id: "c", code: "4.17", unitPrice: null })];
    const plain = totalsOf(ls, { vatRate: 0.18 });
    expect(plain).toMatchObject({ currency: "ILS", linesTotal: 1099.99, adjustmentPct: 0, adjustment: 0, beforeVat: 1099.99, unpricedLines: 1, pricedLines: 2 });
    expect(plain.vat).toBeCloseTo(197.9982, 6);
    const disc = totalsOf(ls, { vatRate: 0.17, adjustmentPct: -5 });
    expect(disc.adjustmentPct).toBe(-5);
    expect(disc.adjustment).toBeCloseTo(-54.9995, 6);
    expect(totalsOf(ls, { adjustmentPct: 10 }).beforeVat).toBeCloseTo(1209.989, 6);
  });

  it("formats ₪ with he-IL grouping and 2 decimals; parses typed prices and percents (−90…200)", () => {
    expect(formatMoney(1234.5)).toBe("₪ 1,234.50");
    expect(formatMoney(null)).toBe("");
    expect(formatMoneyDelta(-45.5)).toBe("−₪ 45.50");
    expect(formatMoneyDelta(120)).toBe("+₪ 120.00");
    expect(parseMoney("₪ 1,234.5")).toBe(1234.5);
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("-3")).toBeNaN();
    expect(parseMoney("1.234")).toBeNaN();
    expect(parseMoney("100000001")).toBeNaN();
    expect(parsePct("-5")).toBe(-5);
    expect(parsePct("−7.5%")).toBe(-7.5);
    expect(parsePct("150")).toBe(150);
    expect(parsePct("250")).toBeNaN();
    expect(parsePct("-95")).toBeNaN();
    expect(parsePct("18", 0, 50)).toBe(18);
  });

  it("bulk plan (set / % / clear), import review counts, optimistic override, the ללא מחיר filter", () => {
    const items = [
      { id: "i1", price: { amount: 100, currency: "ILS", updatedAt: "", by: null, source: "import" } },
      { id: "i2", price: null },
    ] as Pick<LibraryItem, "id" | "price">[];
    expect(bulkPlanPrices(items, { kind: "set", amount: 9.5 })).toEqual([{ itemId: "i1", amount: 9.5 }, { itemId: "i2", amount: 9.5 }]);
    expect(bulkPlanPrices(items, { kind: "pct", pct: 10 })).toEqual([{ itemId: "i1", amount: 110 }]);
    expect(bulkPlanPrices(items, { kind: "clear" })).toEqual([{ itemId: "i1", amount: null }]);
    const report = {
      rows: 5, matched: 4, applied: 0, unchanged: 0, unmatched: 1, conflicts: 3, skippedManual: 2, overwriteManualPrices: false, dryRun: true,
      planned: [{ itemId: "a", code: "1", amount: 1, current: null, currentSource: null }],
      unmatchedRows: [{ row: 9, code: "9.9", description: "x", amount: 5 }],
      conflictRows: [
        { row: 2, code: "2", itemId: "b", reason: "manual_price" as const, current: 3, incoming: 2 },
        { row: 3, code: "3", itemId: "c", reason: "manual_price" as const, current: 4, incoming: 3 },
        { row: 4, code: "4", itemId: null, reason: "duplicate_in_file" as const, current: null, incoming: 7 },
      ],
    };
    expect(importApplyCounts(report, new Set(["b"]))).toEqual({ fill: 1, overwrite: 1, keep: 1, unmatched: 1, other: 1 });
    const rows = reviewRows(report, (id) => (id === "a" ? "שקע" : null));
    expect(rows.matched[0]).toMatchObject({ code: "1", description: "שקע", incoming: 1 });
    expect(rows.conflicts.map((r) => r.reason)).toEqual(["manual_price", "manual_price", "duplicate_in_file"]);
    expect(rows.unmatched[0]).toMatchObject({ code: "9.9", description: "x", itemId: null });
    const o = applyPriceOverride(line({ unitPrice: 100 }), 80, "קבלן", "u1", "2026-11-07T00:00:00Z");
    expect(o).toMatchObject({ priceOverride: 80, priceOverrideBy: "u1", priceOverrideReason: "קבלן", unitPrice: 80, unitPriceSource: "override", lineTotal: 800 });
    expect(applyPriceOverride(o, null, null, "u1").priceOverride).toBeNull();
    const all = { domains: [], floor: null, room: null, levels: ["green", "yellow", "red"] } as unknown as Parameters<typeof filterLines>[1];
    expect(filterLines([line({ unitPrice: 1 }), line({ id: "x", unitPrice: null }), line({ id: "y", unitPrice: 5, priceOverride: 5 })], all, "unpriced").map((l) => l.id)).toEqual(["x"]);
  });
});

describe("Sprint 8: comparison (mock Worker-BOQ snapshots, contracts kamutan.boq-compare/1)", () => {
  it("added / removed / changed with Δqty, Δ₪, changed fields and the sheet versions that caused it", () => {
    const rows = [{ sheet: { id: "s1", sheetSetId: "x", title: "ת. חשמל", currentVersionId: "v2", confirmed: true }, version: { id: "v2", status: "ready" } }] as never;
    const cur = snapshotOf(
      "p",
      "b1",
      "2026-11-07T00:00:00Z",
      [
        line({ id: "a", code: "4.00", unitPrice: 10, sourceVersions: [{ sheetId: "s1", versionId: "v2" }] as never }),
        line({ id: "b", code: "4.01", unitPrice: 20, sourceVersions: [{ sheetId: "s1", versionId: "v2" }] as never }),
        line({ id: "c", code: "4.02", unitPrice: 30, sourceVersions: [{ sheetId: "s1", versionId: "v2" }] as never }),
      ],
      rows,
    );
    const prev = seedPreviousSnapshot(cur, "b0", "2026-11-01T00:00:00Z");
    const c = compareSnapshots(prev, cur, "previous", { fromAt: prev.createdAt, toAt: cur.createdAt });
    expect(c.schema).toBe("kamutan.boq-compare/1");
    expect(c.items.find((l) => l.code === "4.01")?.kind).toBe("added");
    expect(c.items.find((l) => l.code === "4.99")).toMatchObject({ kind: "removed", deltaQty: -3, deltaTotal: -630, toQty: null });
    const ch = c.items.find((l) => l.code === "4.00")!;
    expect(ch).toMatchObject({ kind: "changed", deltaQty: 2, deltaTotal: 20, lineId: "a" });
    expect(ch.changes).toContain("qty");
    expect(ch.causes[0]).toMatchObject({ kind: "sheet", sheetId: "s1", title: "ת. חשמל", fromVersionId: "v0", toVersionId: "v2" });
    expect(c.sheetChanges[0]).toMatchObject({ sheetId: "s1", kind: "revised" });
    expect(c.summary).toMatchObject({ added: 1, removed: 1, changed: 1 });
    expect(fmtDeltaQty(-2)).toBe("−2");
    expect(compareQueryOf(new URLSearchParams("base=export"))).toEqual({ mode: "export", query: { base: "export" } });
    expect(compareQueryOf(new URLSearchParams(""))).toEqual({ mode: "previous", query: { base: "previous" } });
    expect(compareQueryOf(new URLSearchParams("from=b0&to=b1"))).toEqual({ mode: "pick", query: { from: "b0", to: "b1" } });
  });

  it("mock API: builds list, previous / export, the live side, export file", async () => {
    const b = await built();
    const builds = await b.api.listBoqBuilds("p-noah");
    expect(builds.length).toBe(2);
    expect(builds[0]!.latest).toBe(true);
    expect(builds[1]!.exportedAt).toBeTruthy();
    const c = await b.api.compareBoqBuilds("p-noah", {});
    expect(c.base).toBe("previous");
    expect(c.to.live).toBe(true);
    expect(c.summary.added).toBeGreaterThan(0);
    expect(c.items.some((l) => l.code === "4.99" && l.kind === "removed")).toBe(true);
    // a price override shows up at once on the live side
    const l401 = (await b.api.listBoqLines("p-noah")).items.find((l) => l.code === "4.01")!;
    await b.api.patchBoqLine("p-noah", l401.id, { priceOverride: 1 });
    const c2 = await b.api.compareBoqBuilds("p-noah", {});
    const i401 = c2.items.find((l) => l.code === "4.01")!;
    expect(i401.toPrice).toBe(1);
    expect(i401.causes.some((x) => x.kind === "price_override")).toBe(true);
    // explicit builds: the "to" side is that build (not live)
    const fixed = await b.api.compareBoqBuilds("p-noah", { from: "b0-history", to: builds[0]!.buildId });
    expect(fixed.base).toBe("explicit");
    expect(fixed.to.live).toBeFalsy();
    // export → "since last export" now starts at this build
    await b.api.exportBoq("p-noah", { templateId: null, split: "summed", draftNote: false });
    await expect(b.api.compareBoqBuilds("p-noah", { base: "export" })).resolves.toMatchObject({ base: "export", from: { buildId: builds[0]!.buildId } });
    const x = await b.api.exportBoqComparison("p-noah", {});
    expect(x.fileName).toMatch(/\.xls$/);
  });

  it("no previous build → 409 not_ready with the Hebrew text", async () => {
    const b = createMockBackend({ latencyMs: 0, jobTickMs: 1, boqTickMs: 1, devIndex: false, boqPrebuilt: false });
    await expect(b.api.compareBoqBuilds("p-noah", {})).rejects.toMatchObject({ status: 409, code: "not_ready" });
  });
});

describe("Sprint 8: mock prices, share, deletes, limit", () => {
  it("library prices: lines carry the effective price; override survives a rebuild; history + validation", async () => {
    const b = await built();
    const lines = (await b.api.listBoqLines("p-noah")).items;
    expect(lines.some((l) => typeof l.unitPrice === "number" && l.unitPriceSource === "library")).toBe(true);
    expect(lines.some((l) => l.code === "4.17" && l.unitPrice === null && l.lineTotal === null)).toBe(true);
    const items = (await b.api.listLibraryItems(ORG)).items;
    const it402 = items.find((i) => i.code === "4.02")!;
    await b.api.patchLibraryItem(ORG, it402.id, { price: 77.7 });
    expect((await b.api.listBoqLines("p-noah")).items.find((l) => l.code === "4.02")?.unitPrice).toBe(77.7);
    await expect(b.api.patchLibraryItem(ORG, it402.id, { price: -1 })).rejects.toMatchObject({ status: 400 });
    const l = lines.find((x) => x.code === "4.01")!;
    await expect(b.api.patchBoqLine("p-noah", l.id, { priceOverride: -1 })).rejects.toMatchObject({ status: 400 });
    await b.api.patchBoqLine("p-noah", l.id, { priceOverride: 42, reason: "קבלן" });
    await b.api.buildBoq("p-noah");
    for (let i = 0; i < 400; i++) {
      const st = (await b.api.listBoqLines("p-noah")).boq;
      if (st && !st.stale && (await b.api.listBoqBuilds("p-noah")).length === 3) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const after = (await b.api.listBoqLines("p-noah")).items.find((x) => x.id === l.id)!;
    expect(after).toMatchObject({ priceOverride: 42, unitPrice: 42, unitPriceSource: "override" });
    const h = await b.api.getLineHistory("p-noah", l.id);
    expect(h.items.find((x) => x.action === "price")).toMatchObject({ reason: "קבלן", before: null, after: 42 });
    expect((await b.api.listAudit(ORG, { entity: "itemLibrary" })).items[0]).toMatchObject({ action: "update", after: { price: { from: expect.any(Number), to: 77.7, source: "manual" } } });
    const bulk = await b.api.bulkPatchPrices(ORG, { items: [{ itemId: it402.id, amount: 77.7 }, { itemId: "nope", amount: 1 }, { itemId: items.find((i) => i.code === "4.03")!.id, amount: 5 }] });
    expect(bulk.batchId).toMatch(/^bp_/);
    expect(bulk.updated.map((u) => u.to)).toEqual([5]);
    expect(bulk.skipped.map((s) => s.reason).sort()).toEqual(["not_found", "unchanged"]);
  });

  it("price import: dry run first (nothing written), a manual price is replaced only when chosen", async () => {
    const b = await built();
    const slot = await b.api.createLibraryImport(ORG, { filename: "priced.xlsx", sizeBytes: 10, mode: "prices", dryRun: true });
    await b.uploads.start(slot.storagePath, new Blob(["x"]), slot.contentType, () => undefined).done;
    await b.api.startLibraryImport(ORG, slot.importId, slot.uploadToken);
    let im = await b.api.getLibraryImport(ORG, slot.importId);
    for (let i = 0; i < 400 && im.status !== "succeeded"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      im = await b.api.getLibraryImport(ORG, slot.importId);
    }
    const r = im.result!.prices!;
    expect(r.dryRun).toBe(true);
    expect(r.conflictRows.filter((x) => x.reason === "manual_price").map((x) => x.code)).toEqual(["4.01"]);
    expect(r.unmatchedRows.map((x) => x.code)).toEqual(["4.40", "11.02"]);
    const planned = r.planned!;
    const first = (await b.api.listLibraryItems(ORG)).items.find((i) => i.id === planned[0]!.itemId)!;
    expect(first.price?.amount).toBe(planned[0]!.current); // nothing written yet
    const before = (await b.api.listLibraryItems(ORG)).items.find((i) => i.code === "4.01")!.price!;
    const res = await b.api.applyPriceImport(ORG, slot.importId, { overwriteItemIds: [] });
    expect(res).toMatchObject({ applied: planned.length, overwritten: 0, kept: 1 });
    expect((await b.api.listLibraryItems(ORG)).items.find((i) => i.code === "4.01")!.price).toMatchObject({ amount: before.amount, source: "manual" });
    await expect(b.api.applyPriceImport(ORG, slot.importId, { overwriteItemIds: [] })).rejects.toMatchObject({ status: 409 });
    // pure helper (contracts planPriceImport): the same price again is "unchanged"
    const lib = (await b.api.listLibraryItems(ORG)).items;
    const again = runPriceImport(lib, demoPriceFile(lib), false).report;
    expect(again.unchanged).toBeGreaterThan(0);
  });

  it("share: prices only with showPrices; project discount + VAT setting flow into the totals", async () => {
    const b = await built();
    await b.api.patchProjectPricing("p-noah", -10);
    await b.api.patchOrgSettings(ORG, { vatRate: 0.17 });
    const plain = await b.publicShare.getBoq("demo-noah");
    expect(plain.totals ?? null).toBeNull();
    expect(plain.lines.every((l) => l.unitPrice === undefined)).toBe(true);
    const priced = await b.publicShare.getBoq("demo-noah-prices");
    expect(priced.showPrices).toBe(true);
    expect(priced.totals).toMatchObject({ adjustmentPct: -10, vatRate: 0.17 });
    expect((await b.publicShare.getMeta("demo-noah-prices")).showPrices).toBe(true);
    const doc = await b.api.getBoqDocument("p-noah", { split: "none", confidence: true, chapters: null });
    expect(doc.totals.adjustmentPct).toBe(-10);
    expect(doc.vatRate).toBe(0.17);
    expect(doc.warnings.find((w) => w.kind === "unpriced")?.count).toBeGreaterThan(0);
    await expect(b.api.patchProjectPricing("p-noah", -95)).rejects.toMatchObject({ status: 400 });
    expect((await b.api.patchProjectPricing("p-noah", 150)).pricing.adjustmentPct).toBe(150);
    expect((await b.api.getProject("p-noah")).pricing?.adjustmentPct).toBe(150);
  });

  it("deletes: a set frees storage + revokes links holding its sheets; a project needs the typed name; the sheet limit", async () => {
    const b = await built();
    const sets: { id: string }[] = await new Promise((res) => {
      const u = b.realtime.sheetSets(ORG, "p-noah", (s) => (s.length ? (u(), res(s)) : undefined), () => undefined);
    });
    const p0 = await b.api.getProject("p-noah");
    const r = await b.api.deleteSheetSet("p-noah", sets[0]!.id);
    expect(r.releasedBytes).toBeGreaterThan(0);
    expect(r.storageBytes).toBe((p0.storageBytes ?? 0) - r.releasedBytes);
    expect(r.storageQuotaBytes).toBeGreaterThan(0);
    expect((await b.api.getProject("p-noah")).sheetCount).toBe((p0.sheetCount ?? 0) - r.deleted.sheets);
    expect((await b.api.listAudit(ORG, { entity: "sheetSets", action: "delete" })).items).toHaveLength(1);

    const lim = createMockBackend({ latencyMs: 0, devIndex: false, sheetLimit: 1 });
    expect((await lim.api.getProject("p-noah")).sheetLimit).toBe(1);
    const up = await lim.api.createUpload("p-noah", { filename: "a.pdf", sizeBytes: 10, contentType: "application/pdf" } as never);
    await lim.uploads.start(up.storagePath, new Blob(["x"]), up.contentType, () => undefined).done;
    await expect(lim.api.finalizeUpload("p-noah", { uploadToken: up.uploadToken, name: "a.pdf" })).rejects.toMatchObject({ status: 409, code: "sheet_limit", message: expect.stringContaining("המגבלה היא 1") });

    await expect(b.api.deleteProject("p-levi", { confirmName: "לוי" })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/[֐-׿]/) });
    const d = await b.api.deleteProject("p-noah", { confirmName: "  בית משפחת נח " });
    expect(d).toMatchObject({ projectId: "p-noah" });
    expect(d.releasedBytes).toBeGreaterThan(0);
    // the set delete already revoked the links that held its sheets; the project delete revokes the rest
    expect(r.revokedShareLinks + d.revokedShareLinks).toBeGreaterThan(0);
    await expect(b.api.getProject("p-noah")).rejects.toMatchObject({ status: 404 });
    await expect(b.publicShare.getMeta("demo-noah")).rejects.toMatchObject({ status: 410 });
  });
});

describe("Sprint 8: lazy Firestore / Storage wrappers", () => {
  it("realtime attaches after the load and an early unsubscribe never subscribes", async () => {
    const sub = vi.fn(() => () => undefined);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rt = createLazyRealtime(async () => {
      await gate;
      return { jobs: sub, sheetSets: sub, sheets: sub, boqState: sub, boqBuild: sub } as never;
    });
    const off = rt.jobs("o", null, () => undefined, () => undefined);
    rt.sheets("o", "p", () => undefined, () => undefined)();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(sub).toHaveBeenCalledTimes(1);
    off();
    const err = vi.fn();
    createLazyRealtime(async () => Promise.reject(new Error("offline"))).boqState("o", "p", () => undefined, err);
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }));
  });

  it("an upload cancelled before Storage loaded never starts; pause is replayed", async () => {
    const start = vi.fn(() => ({ pause: vi.fn(() => true), resume: vi.fn(() => true), cancel: vi.fn(() => true), done: Promise.resolve() }));
    const up = createLazyUploads(async () => ({ start }));
    const h = up.start("p", new Blob(), "x", () => undefined);
    h.cancel();
    await expect(h.done).rejects.toBeInstanceOf(UploadCanceledError);
    expect(start).not.toHaveBeenCalled();
    const h2 = up.start("p", new Blob(), "x", () => undefined);
    h2.pause();
    await h2.done;
    expect(start.mock.results[0]!.value.pause).toHaveBeenCalled();
  });
});
