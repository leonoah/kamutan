import {
  ApiError,
  DESCRIPTION_MAX,
  needsReapproval,
  type BoqDocumentColumn,
  type BoqDocumentModel,
  type BoqDocumentQuery,
  type BoqDocumentRow,
  type BoqLine,
  type BoqTemplate,
  type LibraryItem,
} from "./types";
import { chapterLabel, effectiveQty, groupByChapter } from "@/features/boq/model";
import { cleanDescription, normalizeColumns } from "@/features/boq/sprint7";

/**
 * Sprint 7 mock — stand-in for the API's `BoqDocumentModel` (GET …/boq/document): the SAME layout rules as the API's
 * Excel writer (apps/api/src/boq/excel.ts): template title rows (+ address / date), template columns + "רמת ביטחון" +
 * "סטטוס", chapters in template order with numbered notes, lines sorted by code, split by floor = one row per floor
 * "<description> – <floor>" (an overridden qty stays one row), "להשלמה ידנית" = empty qty + note, empty unit price,
 * total = qty × price (0 while prices are empty), "סה"כ" per chapter, grand totals before / after VAT.
 */

export const CONFIDENCE_TITLE = "רמת ביטחון";
export const STATUS_TITLE = "סטטוס";
export const NEEDS_INPUT_NOTE = "להשלמה ידנית";
const FLOOR_NAMES: Readonly<Record<string, string>> = {
  basement: "מרתף",
  "-1": "מרתף",
  ground: "קומת קרקע",
  "0": "קומת קרקע",
  first: "קומה א'",
  "1": "קומה א'",
  second: "קומה ב'",
  "2": "קומה ב'",
  roof: "גג",
};
const dateHe = (d: Date) => `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;

/** The template's columns as `{key, title}`, the brief's set when the template has none. */
function templateColumns(t: BoqTemplate): BoqDocumentColumn[] {
  const cols = normalizeColumns(t.columns.length ? t.columns : ["סעיף", "תאור העבודה", "יחידה", "כמות", "מחיר יח'", 'סה"כ']);
  return cols.filter((c) => c.key !== "confidence" && c.key !== "status");
}

/** Excel `floorRows`: one row per floor with a quantity; an overridden line stays one row. */
function floorRows(l: BoqLine): { floor: string | null; qty: number }[] {
  const entries = Object.entries(l.byFloor ?? {}).filter(([, q]) => q !== 0);
  if (l.qtyOverride !== null && l.qtyOverride !== undefined) return [{ floor: null, qty: l.qtyOverride }];
  if (entries.length <= 1) return [{ floor: null, qty: l.qty }];
  return entries.map(([f, q]) => ({ floor: f, qty: q }));
}

export interface DocumentInput {
  projectName: string;
  address?: string | null;
  orgName?: string | null;
  template: BoqTemplate;
  lines: readonly BoqLine[];
  q: BoqDocumentQuery;
  vatRate?: number;
  blockOnRed?: boolean;
  /** Unit prices by code (none in the product yet: the Excel's price column is empty). */
  prices?: Readonly<Record<string, number>>;
  now?: Date;
}

export function buildBoqDocument(input: DocumentInput): BoqDocumentModel {
  const now = input.now ?? new Date();
  const vatRate = input.vatRate ?? 0.18;
  const vars: Record<string, string> = { projectName: input.projectName, date: dateHe(now), orgName: input.orgName ?? "" };
  const fill = (s: string) => s.replace(/\{\{?(projectName|date|orgName)\}?\}/g, (_, k: string) => vars[k] ?? "");
  const titles = input.template.titleRows.map(fill).filter((s) => s.trim());
  if (!input.template.titleRows.some((r) => /\{\{?projectName/.test(r))) titles.push(input.projectName);
  if (input.address?.trim()) titles.push(input.address.trim());
  if (!input.template.titleRows.some((r) => /\{\{?date/.test(r))) titles.push(`תאריך: ${dateHe(now)}`);

  const columns = [...templateColumns(input.template)];
  if (input.q.confidence) columns.push({ key: "confidence", title: CONFIDENCE_TITLE }, { key: "status", title: STATUS_TITLE });

  const want = input.q.chapters ? new Set(input.q.chapters) : null;
  const groups = groupByChapter(input.lines, input.template.chapters).filter((g) => !want || want.has(g.code));
  const chapters = groups.map((g) => {
    const rows: BoqDocumentRow[] = [];
    for (const l of g.lines) {
      const description = l.descriptionOverride?.trim() ? l.descriptionOverride : l.description;
      const awaiting = Boolean(l.needsInput) && (l.qtyOverride === null || l.qtyOverride === undefined);
      const parts = input.q.split === "floor" && !awaiting ? floorRows(l) : [{ floor: null, qty: effectiveQty(l) }];
      for (const part of parts) {
        const price = input.prices?.[l.code] ?? null;
        const qty = awaiting ? null : part.qty;
        rows.push({
          lineId: l.id,
          code: l.code,
          description: part.floor ? `${description} – ${FLOOR_NAMES[part.floor] ?? part.floor}` : description,
          unit: l.unit,
          qty,
          price,
          // Excel formula qty × price (an empty price counts 0); an empty qty leaves the total empty too.
          total: qty === null ? null : qty * (price ?? 0),
          kind: "line",
          ...(input.q.confidence ? { level: l.level, status: needsReapproval(l) ? "reviewed" : l.status } : {}),
          floor: part.floor,
          ...(awaiting ? { needsInput: true, cellNote: NEEDS_INPUT_NOTE } : {}),
          ...(l.descriptionOverride?.trim() ? { descriptionOverridden: true } : {}),
        });
      }
    }
    const subtotal = rows.reduce((s, r) => s + (r.total ?? 0), 0);
    const notes = g.notes.map((n) => n.replace(/^\s*\d+[.)]\s*/, ""));
    // contracts row order: note rows ("הערות:" + one per note) → line rows → one subtotal row
    const note = (description: string): BoqDocumentRow => ({ kind: "note", lineId: null, code: "", description, unit: "", qty: null, price: null, total: null });
    const noteRows = notes.length ? [note("הערות:"), ...notes.map((n, i) => note(`${i + 1}. ${n}`))] : [];
    const sub: BoqDocumentRow = { kind: "subtotal", lineId: null, code: "", description: 'סה"כ', unit: "", qty: null, price: null, total: subtotal };
    return { code: g.code, title: chapterLabel(g.code, g.title), notes, rows: [...noteRows, ...rows, sub], subtotal };
  });
  const beforeVat = chapters.reduce((s, c) => s + (c.subtotal ?? 0), 0);
  const vat = Math.round(beforeVat * vatRate * 100) / 100;

  // Same rules as the export gate (contracts exportBlockingLines) over the lines in the document.
  const inDoc = groups.flatMap((g) => g.lines);
  const red = inDoc.filter((l) => l.level === "red" && l.status !== "approved").length;
  const reapproval = inDoc.filter((l) => needsReapproval(l)).length;
  const unapproved = inDoc.filter((l) => l.status !== "approved" || needsReapproval(l)).length;
  const needsInput = inDoc.filter((l) => l.needsInput && (l.qtyOverride === null || l.qtyOverride === undefined)).length;
  return {
    titleRows: [
      // the xlsx warning row (red / yellow lines in the document)
      ...(inDoc.some((l) => l.level !== "green")
        ? [{ kind: "warning" as const, text: `יש פריטים שלא נבדקו: בכתב הכמויות יש ${inDoc.filter((l) => l.level === "red").length} שורות "לבדיקה" ו-${inDoc.filter((l) => l.level === "yellow").length} שורות "סביר". הכמויות בהן עלולות להיות שגויות.` }]
        : []),
      ...titles.map((text) => ({ kind: "title" as const, text })),
    ],
    columns,
    chapters,
    totals: { beforeVat, vat, afterVat: beforeVat + vat },
    warnings: [
      { kind: "red" as const, count: red },
      { kind: "reapproval" as const, count: reapproval },
      { kind: "unapproved" as const, count: unapproved },
      { kind: "needsInput" as const, count: needsInput },
    ].filter((w) => w.count > 0),
    generatedAt: now.toISOString(),
    vatRate,
    blocked: Boolean(input.blockOnRed) && red + reapproval > 0,
  };
}

/**
 * PATCH { description } validation (mirrors the API brief): ≤ 500 chars after whitespace clean-up, not empty;
 * `null` restores. Returns the stored value.
 */
export function validateDescriptionPatch(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw new ApiError(400, "validation_failed", "description must be a string or null");
  const s = cleanDescription(v);
  if (!s) throw new ApiError(400, "validation_failed", "description must not be empty");
  if (s.length > DESCRIPTION_MAX) throw new ApiError(400, "validation_failed", `description is longer than ${DESCRIPTION_MAX}`);
  return s;
}

/** "עדכן גם בספריית הסעיפים": the org's item of that code takes the wording (`source` → manual), or a new manual item. */
export function upsertLibraryWording(library: Map<string, LibraryItem>, line: BoqLine, description: string, at: string): LibraryItem {
  const hit = [...library.values()].find((i) => i.code === line.code);
  if (hit) {
    Object.assign(hit, { description, source: "manual" as const, updatedAt: at });
    return { ...hit };
  }
  const item: LibraryItem = {
    id: `item-manual-${line.code}`,
    code: line.code,
    chapter: line.chapter,
    chapterTitle: line.chapterTitle ?? null,
    description,
    unit: line.unit,
    tags: [],
    source: "manual",
    active: true,
    updatedAt: at,
  };
  library.set(item.id, item);
  return { ...item };
}
