import {
  BOQ_DOCUMENT_SCHEMA,
  BOQ_STATUS_HE,
  chapterKey,
  compareItemCodes,
  CONFIDENCE_HE,
  displayDescription,
  effectiveQty,
  effectiveStatus,
  exportBlockingLines,
  isDescriptionOverridden,
  needsReapproval,
  NEEDS_INPUT_HE,
  type BoqDocumentColumn,
  type BoqDocumentModel,
  type BoqDocumentRow,
  type BoqDocumentWarning,
  type BoqLine,
  type BoqTemplate,
  type BoqTemplateColumnKey,
} from '@kamutan/contracts';
import { countLines } from '../db/boq-docs';

/**
 * Sprint 7 (owner request 1, "fidelity by construction"): THE layout of the main Excel sheet "כמויות". Built once per
 * request; `GET …/boq/document` returns it and `buildBoqWorkbook` writes the xlsx main sheet from it (excel.ts), so the
 * preview and the file cannot drift. Text stays raw here; the xlsx writer formula-escapes every text cell.
 */

export const CONFIDENCE_TITLE = 'רמת ביטחון';
export const STATUS_TITLE = 'סטטוס';
export const NOTES_TITLE = 'הערות:';
export const CHAPTER_TOTAL = 'סה"כ';
export const DRAFT_NOTE = 'טיוטה – כולל פריטים שלא אומתו';

/** Hebrew display names of the worker's floor codes; project FloorMeta names win (`floorNames`). */
export const DEFAULT_FLOOR_NAMES: Readonly<Record<string, string>> = Object.freeze({
  basement: 'מרתף',
  '-1': 'מרתף',
  ground: 'קומת קרקע',
  '0': 'קומת קרקע',
  first: "קומה א'",
  '1': "קומה א'",
  second: "קומה ב'",
  '2': "קומה ב'",
  third: "קומה ג'",
  '3': "קומה ג'",
  roof: 'גג',
  gallery: 'גלריה',
});

export const warningText = (red: number, yellow: number): string =>
  `יש פריטים שלא נבדקו: בכתב הכמויות יש ${red} שורות "לבדיקה" ו-${yellow} שורות "סביר". הכמויות בהן עלולות להיות שגויות.`;

export interface BoqDocumentInput {
  projectId: string;
  projectName: string;
  orgName?: string;
  date: Date;
  template: BoqTemplate;
  /** ALL lines of the project (the chapter filter is applied here; the gate warnings look at every line). */
  lines: readonly BoqLine[];
  split: 'summed' | 'byFloor';
  markDraft: boolean;
  /** "רמת ביטחון" + "סטטוס" columns (default true). */
  includeConfidence?: boolean;
  /** Chapter codes to include (chapterKey match); undefined / null = all. */
  chapters?: readonly string[] | null;
  /** VAT of the grand total (org setting, else the template's). */
  vatRate?: number;
  floorNames?: Readonly<Record<string, string>>;
  buildId?: string | null;
  /** Org `blockExportOnRed` (default true) → `exportBlocked`. */
  blockExportOnRed?: boolean;
}

export const floorNameOf = (floorNames: Readonly<Record<string, string>> | undefined, f: string): string => floorNames?.[f] ?? DEFAULT_FLOOR_NAMES[f] ?? f;

const dateHe = (d: Date) => `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

/** Lines sorted by natural code order, then id. */
export const byCode = (a: BoqLine, b: BoqLine): number => compareItemCodes(a.code, b.code) || a.id.localeCompare(b.id);

export interface ChapterGroup {
  /** Template chapter code, or the line chapter / code major for chapters missing from the template. */
  code: string;
  title: string;
  notes: readonly string[];
  lines: BoqLine[];
}

/** Template chapter order; lines matched by chapter code, then by code major (`codePrefixes`); leftovers appended. */
export function groupByChapter(template: BoqTemplate, lines: readonly BoqLine[]): ChapterGroup[] {
  const groups: ChapterGroup[] = template.chapters.map((c) => ({ code: c.code, title: c.title, notes: c.notes, lines: [] }));
  const byKey = new Map(template.chapters.map((c, i) => [chapterKey(c.code), i]));
  const byPrefix = new Map<string, number>();
  template.chapters.forEach((c, i) => c.codePrefixes?.forEach((p) => byPrefix.has(p) || byPrefix.set(p, i)));
  const extra = new Map<string, ChapterGroup>();
  for (const l of lines) {
    const major = l.code.split(/[.\-/]/)[0] ?? '';
    const idx = byKey.get(chapterKey(l.chapter)) ?? byPrefix.get(major) ?? byPrefix.get(major.replace(/^0+(?=\d)/, ''));
    if (idx !== undefined) {
      (groups[idx] as ChapterGroup).lines.push(l);
    } else {
      const k = chapterKey(l.chapter) || major;
      if (!extra.has(k)) extra.set(k, { code: l.chapter || major, title: `פרק ${l.chapter || major}`, notes: [], lines: [] });
      (extra.get(k) as ChapterGroup).lines.push(l);
    }
  }
  return [...groups, ...[...extra.values()]].filter((g) => g.lines.length > 0).map((g) => ({ ...g, lines: g.lines.sort(byCode) }));
}

/** Area / length units (m², m') of the sample and the correction units. */
const MEASURED_UNIT_RE = /^(מ"ר|מ''ר|מ״ר|מ"א|מ''א|מ״א|מ'|מטר|m2|m²|m|sqm)$/i;
/** Sprint 4: area / length quantities are DISPLAYED with 2 decimals; counts stay "General". */
export function qtyFormat(unit: string | null | undefined): string {
  return unit && MEASURED_UNIT_RE.test(unit.trim()) ? '0.00' : 'General';
}
const qtyFormatKind = (unit: string | null | undefined): 'general' | 'decimal2' => (qtyFormat(unit) === '0.00' ? 'decimal2' : 'general');

/** byFloor split rows; an overridden line stays one row (the override is not distributed over floors). */
export function floorRows(l: BoqLine): Array<{ suffix: string | null; qty: number }> {
  const entries = Object.entries(l.byFloor ?? {}).filter(([, q]) => q !== 0);
  if (l.qtyOverride !== null && l.qtyOverride !== undefined) return [{ suffix: null, qty: l.qtyOverride }];
  if (entries.length <= 1) return [{ suffix: entries[0]?.[0] ?? l.floor ?? null, qty: l.qty }];
  return entries.map(([f, q]) => ({ suffix: f, qty: q }));
}

function defaultWidth(k: BoqTemplateColumnKey): number {
  return k === 'description' ? 60 : k === 'code' ? 8 : 12;
}

/** Lines of the requested chapters (all when no filter). */
export function linesInChapters(template: BoqTemplate, lines: readonly BoqLine[], chapters: readonly string[] | null | undefined): BoqLine[] {
  if (!chapters || chapters.length === 0) return [...lines];
  const want = new Set(chapters.map(chapterKey));
  return groupByChapter(template, lines)
    .filter((g) => want.has(chapterKey(g.code)))
    .flatMap((g) => g.lines);
}

/** Gate warnings over ALL lines (same rules as `assertExportAllowed`). */
export function documentWarnings(lines: readonly BoqLine[]): BoqDocumentWarning[] {
  const n = {
    red: lines.filter((l) => l.level === 'red' && l.status !== 'approved').length,
    reapproval: lines.filter((l) => needsReapproval(l)).length,
    unapproved: lines.filter((l) => effectiveStatus(l) !== 'approved').length,
    needsInput: lines.filter((l) => l.needsInput === true && (l.qtyOverride === null || l.qtyOverride === undefined)).length,
  };
  return (Object.entries(n) as Array<[BoqDocumentWarning['kind'], number]>).filter(([, c]) => c > 0).map(([kind, count]) => ({ kind, count }));
}

const r2 = (x: number) => Math.round(x * 1e6) / 1e6;

export function buildBoqDocument(input: BoqDocumentInput): BoqDocumentModel {
  const includeConfidence = input.includeConfidence ?? true;
  const chapters = input.chapters && input.chapters.length ? [...input.chapters] : null;
  const docLines = linesInChapters(input.template, input.lines, chapters);
  const vatRate = input.vatRate ?? input.template.vatRate;

  const counts = { red: 0, yellow: 0 };
  for (const l of docLines) if (l.level !== 'green') counts[l.level]++;

  const titleRows: BoqDocumentModel['titleRows'] = [];
  if (counts.red + counts.yellow > 0) titleRows.push({ kind: 'warning', text: warningText(counts.red, counts.yellow) });
  const vars: Record<string, string> = { projectName: input.projectName, date: dateHe(input.date), orgName: input.orgName ?? '' };
  for (const t of input.template.titleRows) titleRows.push({ kind: 'title', text: t.replace(/\{(projectName|date|orgName)\}/g, (_, k: string) => vars[k] ?? '') });
  if (input.markDraft) titleRows.push({ kind: 'draft', text: DRAFT_NOTE });

  const columns: BoqDocumentColumn[] = [
    ...input.template.columns.map((c) => ({ key: c.key, title: c.title, width: c.width ?? defaultWidth(c.key) })),
    ...(includeConfidence
      ? [
          { key: 'confidence' as const, title: CONFIDENCE_TITLE, width: 12 },
          { key: 'status' as const, title: STATUS_TITLE, width: 10 },
        ]
      : []),
  ];

  const outChapters: BoqDocumentModel['chapters'] = [];
  for (const ch of groupByChapter(input.template, docLines)) {
    const rows: BoqDocumentRow[] = [];
    const empty = { lineId: null, code: null, unit: null, qty: null, price: null, total: null } as const;
    if (ch.notes.length) {
      rows.push({ kind: 'note', ...empty, description: NOTES_TITLE });
      for (const n of ch.notes) rows.push({ kind: 'note', ...empty, description: n });
    }
    let subtotal = 0;
    for (const l of ch.lines) {
      const parts =
        input.split === 'byFloor'
          ? floorRows(l).map((x) => ({ floor: x.suffix, suffix: x.suffix === null ? null : floorNameOf(input.floorNames, x.suffix), qty: x.qty }))
          : [{ floor: null as string | null, suffix: null as string | null, qty: effectiveQty(l) }];
      const overridden = l.qtyOverride !== null && l.qtyOverride !== undefined;
      // Sprint 6: a line still waiting for a manual quantity keeps its row with an EMPTY quantity cell + a note.
      const awaiting = l.needsInput === true && !overridden;
      const cellNote = overridden ? `כמות שונתה ידנית (מחושב: ${l.qty})${l.qtyOverrideReason ? `: ${l.qtyOverrideReason}` : ''}` : awaiting ? NEEDS_INPUT_HE : null;
      const desc = displayDescription(l);
      for (const p of parts) {
        const qty = awaiting ? null : p.qty;
        const price: number | null = null; // the client prices the BOQ; every export leaves the unit price empty
        const total = r2((qty ?? 0) * (price ?? 0));
        subtotal += total;
        rows.push({
          kind: 'line',
          lineId: l.id,
          code: l.code,
          description: p.suffix ? `${desc} – ${p.suffix}` : desc,
          unit: l.unit,
          qty,
          qtyFormat: qtyFormatKind(l.unit),
          price,
          total,
          ...(includeConfidence ? { level: l.level, status: effectiveStatus(l) } : {}),
          ...(input.split === 'byFloor' ? { floor: p.floor } : {}),
          ...(l.needsInput ? { needsInput: true } : {}),
          ...(overridden ? { qtyOverridden: true } : {}),
          ...(isDescriptionOverridden(l) ? { descriptionOverridden: true } : {}),
          cellNote,
        });
      }
    }
    subtotal = r2(subtotal);
    rows.push({ kind: 'subtotal', ...empty, description: CHAPTER_TOTAL, total: subtotal });
    outChapters.push({ code: ch.code, title: ch.title, notes: [...ch.notes], rows, subtotal });
  }
  const beforeVat = r2(outChapters.reduce((a, c) => a + c.subtotal, 0));
  return {
    schema: BOQ_DOCUMENT_SCHEMA,
    projectId: input.projectId,
    templateId: input.template.id ?? null,
    buildId: input.buildId ?? null,
    options: { split: input.split, includeConfidence, chapters, markDraft: input.markDraft },
    titleRows,
    columns,
    chapters: outChapters,
    totals: { beforeVat, vat: r2(beforeVat * vatRate), afterVat: r2(beforeVat * (1 + vatRate)), vatRate },
    warnings: documentWarnings(input.lines),
    exportBlocked: (input.blockExportOnRed ?? true) && exportBlockingLines(input.lines).length > 0,
    counts: countLines(docLines),
    generatedAt: input.date.toISOString(),
  };
}

/** Display labels of the confidence / status cells (shared by the xlsx writer and the tests). */
export const confidenceLabel = (r: Pick<BoqDocumentRow, 'level'>): string | null => (r.level ? CONFIDENCE_HE[r.level] : null);
export const statusLabel = (r: Pick<BoqDocumentRow, 'status'>): string | null => (r.status ? BOQ_STATUS_HE[r.status] : null);
