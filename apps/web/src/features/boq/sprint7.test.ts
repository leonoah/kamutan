import { ApiError, DESCRIPTION_MAX, type BoqLine } from "@/api/types";
import { buildBoqDocument, upsertLibraryWording, validateDescriptionPatch } from "@/api/mockSprint7";
import { normalizeLineDto } from "@/api/http";
import { mapError } from "@/features/upload/uploadStore";
import { describeChange } from "@/features/history/LineHistoryDialog";
import type { TFunction } from "i18next";
import { DEFAULT_TEMPLATE, libraryItems } from "@/test/fixtures/boq";
import {
  applyRename,
  canRenameLine,
  chapterSubtotal,
  checkRename,
  documentApiQuery,
  documentQueryFromSearch,
  documentQueryToSearch,
  formatMoney,
  formatStorage,
  isDescriptionOverridden,
  isPublicDescriptionManual,
  lineDescription,
  lineRows,
  normalizeColumns,
  normalizeDocument,
  quotaPct,
  warningCounts,
} from "./sprint7";

const line = (p: Partial<BoqLine> = {}): BoqLine => ({
  id: p.id ?? "l1",
  chapter: "04",
  code: "4.01",
  description: "שקע כפול",
  qty: 6,
  unit: "יחידה",
  level: "green",
  status: "approved",
  byFloor: { ground: 4, first: 2 },
  evidenceCount: 6,
  ruleId: null,
  sourceVersions: [],
  computedAt: null,
  ...p,
});

describe("Sprint 7: line wording (descriptionOverride)", () => {
  it("shows the override, else the original; blank overrides do not count", () => {
    expect(lineDescription(line())).toBe("שקע כפול");
    expect(lineDescription(line({ descriptionOverride: "שקע כפול לבן" }))).toBe("שקע כפול לבן");
    expect(lineDescription(line({ descriptionOverride: "   " }))).toBe("שקע כפול");
    expect(isDescriptionOverridden(line({ descriptionOverride: "x" }))).toBe(true);
    expect(isDescriptionOverridden(line({ descriptionOverride: null }))).toBe(false);
    expect(isPublicDescriptionManual({ descriptionManual: true })).toBe(true);
    expect(isPublicDescriptionManual({})).toBe(false);
  });

  it("editor+ renames (reviewers and viewers do not)", () => {
    expect(["admin", "editor", "reviewer", "viewer", null].map((r) => canRenameLine(r as never))).toEqual([true, true, false, false, false]);
  });

  it("checkRename: cleans whitespace, rejects empty / too long / unchanged, original wording = restore", () => {
    const l = line({ descriptionOverride: "שקע כפול לבן" });
    expect(checkRename(l, "  שקע   כפול\nשחור ")).toEqual({ ok: true, description: "שקע כפול שחור" });
    expect(checkRename(l, "   ")).toEqual({ ok: false, error: "empty" });
    expect(checkRename(l, "א".repeat(DESCRIPTION_MAX + 1))).toEqual({ ok: false, error: "too_long" });
    expect(checkRename(l, "א".repeat(DESCRIPTION_MAX))).toEqual({ ok: true, description: "א".repeat(DESCRIPTION_MAX) });
    expect(checkRename(l, "שקע כפול לבן ")).toEqual({ ok: false, error: "unchanged" });
    // typing the original wording back = restore
    expect(checkRename(l, "שקע כפול")).toEqual({ ok: true, description: null });
  });

  it("applyRename (optimistic) sets / clears the override fields", () => {
    const r = applyRename(line(), "חדש", "לקוח", "u1", "2026-11-04T10:00:00.000Z");
    expect(r).toMatchObject({ descriptionOverride: "חדש", descriptionOverrideReason: "לקוח", descriptionOverrideBy: "u1", descriptionOverrideAt: "2026-11-04T10:00:00.000Z", description: "שקע כפול" });
    expect(applyRename(r, null, null, null)).toMatchObject({ descriptionOverride: null, descriptionOverrideReason: null, descriptionOverrideBy: null });
  });

  it("the HTTP adapter keeps the override fields", () => {
    const l = normalizeLineDto({ ...line(), descriptionOverride: "ידני", descriptionOverrideReason: "x" });
    expect(l.descriptionOverride).toBe("ידני");
  });

  it("mock PATCH validation: ≤ 500 after clean-up, not empty, null restores", () => {
    expect(validateDescriptionPatch(null)).toBeNull();
    expect(validateDescriptionPatch("  a  b ")).toBe("a b");
    expect(() => validateDescriptionPatch(" ")).toThrow(ApiError);
    expect(() => validateDescriptionPatch("x".repeat(501))).toThrow(/longer than 500/);
    expect(() => validateDescriptionPatch(5)).toThrow(ApiError);
  });

  it("'עדכן גם בספרייה' updates the org item of the code (source → manual) or adds a manual one", () => {
    const lib = new Map(libraryItems().map((i) => [i.id, i]));
    const hit = upsertLibraryWording(lib, line(), "שקע כפול לבן", "2026-11-04T10:00:00.000Z");
    expect(hit).toMatchObject({ code: "4.01", description: "שקע כפול לבן", source: "manual" });
    expect([...lib.values()].filter((i) => i.code === "4.01")).toHaveLength(1);
    const added = upsertLibraryWording(lib, line({ code: "4.99", chapter: "04" }), "חדש", "2026-11-04T10:00:00.000Z");
    expect(added).toMatchObject({ code: "4.99", source: "manual", active: true });
  });
});

describe("Sprint 7: BOQ document (preview) query + normalisation", () => {
  it("URL ↔ query: defaults left out; chapters list; split aliases", () => {
    expect(documentQueryFromSearch(new URLSearchParams(""))).toEqual({ split: "none", confidence: true, chapters: null });
    const q = documentQueryFromSearch(new URLSearchParams("split=floor&confidence=0&chapters=04,05"));
    expect(q).toEqual({ split: "floor", confidence: false, chapters: ["04", "05"] });
    expect(documentQueryToSearch(q).toString()).toBe("split=floor&confidence=0&chapters=04%2C05");
    expect(documentQueryToSearch({ split: "none", confidence: true, chapters: null }).toString()).toBe("");
    expect(documentQueryFromSearch(new URLSearchParams("split=byFloor")).split).toBe("floor");
    expect(documentApiQuery({ split: "floor", confidence: true, chapters: ["04"] })).toBe("split=floor&confidence=1&chapters=04");
    expect(documentApiQuery({ split: "none", confidence: false, chapters: null })).toBe("split=none&confidence=0");
  });

  it("columns: plain titles map to keys; objects pass", () => {
    expect(normalizeColumns(["סעיף", "תאור העבודה", "יחידה", 'כמות סה"כ', "מחיר יח'", 'סה"כ ₪', "רמת ביטחון", "סטטוס"]).map((c) => c.key)).toEqual([
      "code",
      "description",
      "unit",
      "qty",
      "unitPrice",
      "total",
      "confidence",
      "status",
    ]);
    expect(normalizeColumns([{ key: "qty", title: "כמות" }])).toEqual([{ key: "qty", title: "כמות" }]);
  });

  it("normalizeDocument fills defaults, keeps the layout; subtotal row wins; warnings in banner order", () => {
    const d = normalizeDocument({
      columns: ["סעיף", "תאור העבודה"],
      chapters: [
        {
          code: "04",
          title: "פרק 04",
          notes: ["א", ""],
          subtotal: 10,
          rows: [
            { lineId: "l1", code: "4.01", description: "x", unit: "יחידה", qty: null, price: null, total: null, kind: "line" },
            { lineId: null, code: "", description: 'סה"כ', unit: "", qty: null, price: null, total: 12, kind: "subtotal" },
          ],
        },
      ],
      warnings: [
        { kind: "needsInput", count: 2 },
        { kind: "red", count: 0 },
        { kind: "unapproved", count: 3 },
      ],
    });
    expect(d.titleRows).toEqual([]);
    expect(d.chapters[0]!.notes).toEqual(["א"]);
    expect(lineRows(d.chapters[0]!)).toHaveLength(1);
    expect(chapterSubtotal(d.chapters[0]!)).toBe(12);
    expect(d.totals).toEqual({ beforeVat: 0, vat: 0, afterVat: 0 });
    expect(warningCounts(d.warnings)).toEqual([
      { kind: "unapproved", count: 3 },
      { kind: "needsInput", count: 2 },
    ]);
  });

  it("the published contract shape: title rows {kind,text}, null code / unit, cellNote, totals.vatRate, exportBlocked", () => {
    const d = normalizeDocument({
      titleRows: [{ kind: "warning", text: "יש פריטים" }, { kind: "title", text: "כתב כמויות" }, { kind: "title", text: " " }],
      columns: [{ key: "code", title: "סעיף" }],
      chapters: [
        {
          code: "04",
          title: "פרק 04",
          notes: ["א"],
          subtotal: 0,
          rows: [
            { kind: "note", lineId: null, code: null, unit: null, description: "הערות:", qty: null, price: null, total: null },
            { kind: "line", lineId: "l1", code: "4.01", unit: "יח'", description: "x", qty: null, price: null, total: null, cellNote: "להשלמה ידנית" },
          ],
        },
      ],
      totals: { beforeVat: 10, vat: 1.8, afterVat: 11.8, vatRate: 0.18 },
      warnings: [{ kind: "reapproval", count: 2 }],
      exportBlocked: true,
      generatedAt: "2026-11-04T10:00:00.000Z",
    });
    expect(d.titleRows).toEqual([
      { kind: "warning", text: "יש פריטים" },
      { kind: "title", text: "כתב כמויות" },
    ]);
    expect(d.chapters[0]!.rows[0]).toMatchObject({ code: "", unit: "" });
    expect(d.chapters[0]!.rows[1]!.cellNote).toBe("להשלמה ידנית");
    expect(d.vatRate).toBe(0.18);
    expect(d.blocked).toBe(true);
    expect(warningCounts(d.warnings)).toEqual([{ kind: "reapproval", count: 2 }]);
  });

  it("money like the Excel's currency format; empty stays empty", () => {
    expect(formatMoney(1234.4)).toBe("₪ 1,234");
    expect(formatMoney(0)).toBe("₪ 0");
    expect(formatMoney(null)).toBe("");
  });
});

describe("Sprint 7: mock BoqDocumentModel (same rules as the API's Excel writer)", () => {
  const lines: BoqLine[] = [
    line(),
    line({ id: "l2", code: "4.10", description: "נק' מאור", qty: 3, byFloor: { ground: 3 }, level: "red", status: "draft", descriptionOverride: "נק' מאור מחליף" }),
    line({ id: "l3", chapter: "03", code: "3.01", description: "ניקוז למזגן", qty: 0, needsInput: true, byFloor: {}, level: "yellow", status: "draft" }),
    line({ id: "l4", code: "4.02", description: "שלישייה", qty: 5, qtyOverride: 7, byFloor: { ground: 2, first: 3 }, level: "yellow", status: "reviewed" }),
  ];
  const base = { projectName: "בית נח", address: "הדקל 12", template: DEFAULT_TEMPLATE, lines, now: new Date("2026-11-04T10:00:00Z") };

  it("title rows, columns (+ confidence / status), chapters in template order with notes, sorted lines, override wording", () => {
    const d = buildBoqDocument({ ...base, q: { split: "none", confidence: true, chapters: null } });
    expect(d.titleRows[0]).toMatchObject({ kind: "warning", text: expect.stringContaining("יש פריטים שלא נבדקו") });
    expect(d.titleRows.slice(1)).toEqual(["כתב כמויות", "בית נח", "הדקל 12", "תאריך: 04.11.2026"].map((text) => ({ kind: "title", text })));
    expect(d.columns.map((c) => c.key)).toEqual(["code", "description", "unit", "qty", "unitPrice", "total", "confidence", "status"]);
    expect(d.chapters.map((c) => c.code)).toEqual(["03", "04"]);
    const ch4 = d.chapters[1]!;
    expect(ch4.notes.length).toBeGreaterThan(0);
    expect(lineRows(ch4).map((r) => r.code)).toEqual(["4.01", "4.02", "4.10"]);
    // contracts row order: "הערות:" + numbered notes → lines → one subtotal row
    expect(ch4.rows[0]).toMatchObject({ kind: "note", description: "הערות:" });
    expect(ch4.rows[1]!.description).toMatch(/^1\. /);
    expect(ch4.rows.at(-1)).toMatchObject({ kind: "subtotal", total: 0 });
    const r410 = ch4.rows.find((r) => r.code === "4.10")!;
    expect(r410).toMatchObject({ description: "נק' מאור מחליף", descriptionOverridden: true, level: "red", status: "draft" });
    // overridden qty
    expect(ch4.rows.find((r) => r.code === "4.02")!.qty).toBe(7);
    // "להשלמה ידנית": empty qty + note, empty total
    expect(lineRows(d.chapters[0]!)[0]).toMatchObject({ qty: null, total: null, cellNote: "להשלמה ידנית", needsInput: true });
    // prices are empty → totals 0 (the Excel formula's result)
    expect(ch4.subtotal).toBe(0);
    expect(d.totals).toEqual({ beforeVat: 0, vat: 0, afterVat: 0 });
    expect(warningCounts(d.warnings)).toEqual([
      { kind: "red", count: 1 },
      { kind: "unapproved", count: 3 },
      { kind: "needsInput", count: 1 },
    ]);
  });

  it("without confidence: no confidence / status columns or row fields; chapter filter", () => {
    const d = buildBoqDocument({ ...base, q: { split: "none", confidence: false, chapters: ["04"] } });
    expect(d.columns.map((c) => c.key)).not.toContain("confidence");
    expect(d.chapters.map((c) => c.code)).toEqual(["04"]);
    expect(lineRows(d.chapters[0]!)[0]!.level).toBeUndefined();
    expect(d.warnings.find((w) => w.kind === "needsInput")).toBeUndefined();
  });

  it("split by floor: one row per floor '<description> – <floor>', an override stays one row, a single floor one row", () => {
    const d = buildBoqDocument({ ...base, q: { split: "floor", confidence: false, chapters: ["04"] } });
    const rows = lineRows(d.chapters[0]!);
    expect(rows.filter((r) => r.code === "4.01").map((r) => [r.description, r.qty])).toEqual([
      ["שקע כפול – קומת קרקע", 4],
      ["שקע כפול – קומה א'", 2],
    ]);
    expect(rows.filter((r) => r.code === "4.02")).toHaveLength(1);
    expect(rows.filter((r) => r.code === "4.10")).toHaveLength(1);
  });

  it("prices (when the API has them): total = qty × price, subtotal, VAT", () => {
    const d = buildBoqDocument({ ...base, q: { split: "none", confidence: false, chapters: ["04"] }, prices: { "4.01": 100 }, vatRate: 0.18 });
    expect(lineRows(d.chapters[0]!)[0]!.total).toBe(600);
    expect(d.totals).toEqual({ beforeVat: 600, vat: 108, afterVat: 708 });
  });
});

describe("Sprint 7: storage quota + upload errors", () => {
  it("formats usage and the share of the quota", () => {
    expect(formatStorage(48_600_000)).toBe("⁨46.3 MB⁩");
    expect(formatStorage(2 * 1024 ** 3)).toBe("⁨2 GB⁩");
    expect(formatStorage(1.5 * 1024 ** 3)).toBe("⁨1.5 GB⁩");
    expect(quotaPct(48_600_000, 50 * 1024 ** 2)).toBe(92);
    expect(quotaPct(5, 0)).toBe(0);
    expect(quotaPct(10, 5)).toBe(100);
  });

  it("maps 413 quota_exceeded and file_infected (other codes unchanged)", () => {
    expect(mapError(new ApiError(413, "quota_exceeded", "x"))).toBe("quota");
    expect(mapError(new ApiError(422, "file_infected", "x"))).toBe("infected");
    expect(mapError(new ApiError(413, "payload_too_large", "x"))).toBe("too_large");
    expect(mapError(new ApiError(500, "boom", "x"))).toBe("server");
  });
});

describe("Sprint 7: history entry of a rename", () => {
  const t = ((k: string) => k) as unknown as TFunction;
  const at = "2026-11-04T10:00:00.000Z";
  it("contract strings and mock objects: before → after, restore and library notes", () => {
    expect(describeChange({ at, by: null, action: "description", before: "a", after: "b", reason: null }, t)).toEqual({ before: "a", after: "b", note: null });
    expect(describeChange({ at, by: null, action: "description", before: "b", after: null, reason: null }, t)).toMatchObject({ before: "b", after: "history.descriptionRestored" });
    expect(
      describeChange({ at, by: null, action: "description", before: { description: "a", override: null }, after: { description: "b", override: "b", library: true }, reason: "x" }, t),
    ).toEqual({ before: "a", after: "b", note: "history.descriptionLibrary" });
    expect(describeChange({ at, by: null, action: "description", before: { description: "b", override: "b" }, after: { description: "a", override: null }, reason: null }, t)).toEqual({
      before: "b",
      after: "a",
      note: "history.descriptionRestored",
    });
  });
});
