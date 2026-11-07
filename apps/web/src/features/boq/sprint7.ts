import {
  DESCRIPTION_MAX,
  type BoqDocumentChapter,
  type BoqDocumentColumn,
  type BoqDocumentModel,
  type BoqDocumentQuery,
  type BoqDocumentRow,
  type BoqDocumentTitleRow,
  type BoqDocumentWarningKind,
  type BoqLine,
  type PublicBoqLine,
  type Role,
} from "@/api/types";

/* ---------------- rename a line (descriptionOverride) ---------------- */

type Described = Pick<BoqLine, "description"> & { descriptionOverride?: string | null };

/** The wording shown everywhere (panel, hub, preview, share): the project's override, else the original. */
export const lineDescription = (l: Described): string => (l.descriptionOverride?.trim() ? l.descriptionOverride : l.description);

/** The line was renamed in this project ("✎ ידני"). */
export const isDescriptionOverridden = (l: Described): boolean => Boolean(l.descriptionOverride?.trim());

/** Public (share snapshot) line renamed → marker. */
export const isPublicDescriptionManual = (l: Pick<PublicBoqLine, "descriptionManual"> & { descriptionOverride?: string | null }): boolean =>
  Boolean(l.descriptionManual) || Boolean(l.descriptionOverride?.trim());

/** Editor+ (contracts ROLE_RANK: editor 30 > reviewer 20) may rename a line and update the library. */
export const canRenameLine = (role: Role | null | undefined): boolean => role === "admin" || role === "editor";

export type RenameCheck =
  | { ok: true; description: string | null }
  | { ok: false; error: "empty" | "too_long" | "unchanged" };

/** Collapse whitespace runs (incl. newlines) to one space and trim. */
export const cleanDescription = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * What a save sends: the cleaned text, or `null` (restore) when it equals the original wording. Unchanged against the
 * current wording → nothing to send.
 */
export function checkRename(l: Described, input: string): RenameCheck {
  const v = cleanDescription(input);
  if (!v) return { ok: false, error: "empty" };
  if (v.length > DESCRIPTION_MAX) return { ok: false, error: "too_long" };
  if (v === cleanDescription(lineDescription(l))) return { ok: false, error: "unchanged" };
  return { ok: true, description: v === cleanDescription(l.description) ? null : v };
}

/** Optimistic line after a rename / restore (the server's line replaces it). */
export function applyRename(l: BoqLine, description: string | null, reason: string | null, uid: string | null, at = new Date().toISOString()): BoqLine {
  if (description === null) return { ...l, descriptionOverride: null, descriptionOverrideBy: null, descriptionOverrideAt: null, descriptionOverrideReason: null };
  return { ...l, descriptionOverride: description, descriptionOverrideBy: uid, descriptionOverrideAt: at, descriptionOverrideReason: reason };
}

/* ---------------- BOQ document (preview) ---------------- */

export const PREVIEW_DEFAULT_QUERY: BoqDocumentQuery = { split: "none", confidence: true, chapters: null };

/** `?split=floor&confidence=0&chapters=04,05` → query (unknown values fall back to the defaults). */
export function documentQueryFromSearch(sp: URLSearchParams): BoqDocumentQuery {
  const split = sp.get("split") === "floor" || sp.get("split") === "byFloor" ? "floor" : "none";
  const c = sp.get("confidence");
  const ch = sp.get("chapters");
  const chapters = ch === null ? null : ch.split(",").map((x) => x.trim()).filter(Boolean);
  return { split, confidence: c === null ? PREVIEW_DEFAULT_QUERY.confidence : c === "1" || c === "true", chapters };
}

/** Query → search params (defaults left out, so the plain URL is the default preview). */
export function documentQueryToSearch(q: BoqDocumentQuery): URLSearchParams {
  const sp = new URLSearchParams();
  if (q.split === "floor") sp.set("split", "floor");
  if (q.confidence !== PREVIEW_DEFAULT_QUERY.confidence) sp.set("confidence", q.confidence ? "1" : "0");
  if (q.chapters) sp.set("chapters", q.chapters.join(","));
  return sp;
}

/** API query string of GET …/boq/document (brief: `split=floor|none&confidence=1&chapters=…`). */
export function documentApiQuery(q: BoqDocumentQuery): string {
  // the API defaults `confidence` to 1: always send it
  const sp = new URLSearchParams({ split: q.split, confidence: q.confidence ? "1" : "0" });
  if (q.chapters) sp.set("chapters", q.chapters.join(","));
  return sp.toString();
}

const COLUMN_KEY_BY_TITLE: [RegExp, BoqDocumentColumn["key"]][] = [
  [/^סעיף/, "code"],
  [/^תא?ו?ר/, "description"],
  [/^יחיד/, "unit"],
  [/^כמות/, "qty"],
  [/^מחיר/, "unitPrice"],
  [/^סה"?״?כ/, "total"],
  [/ביטחון/, "confidence"],
  [/^סטטוס/, "status"],
];

/** Columns as `{key, title}` (older templates / mocks send plain titles). */
export function normalizeColumns(cols: readonly (string | Partial<BoqDocumentColumn>)[]): BoqDocumentColumn[] {
  return cols.map((c, i) => {
    if (typeof c !== "string") return { key: c.key ?? `col${i}`, title: c.title ?? String(c.key ?? "") };
    const hit = COLUMN_KEY_BY_TITLE.find(([re]) => re.test(c.trim()));
    return { key: hit?.[1] ?? `col${i}`, title: c };
  });
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Defensive normalisation of the API model (missing optional fields, plain-title columns). Layout is NOT changed. */
/** The API's raw document (contracts `BoqDocumentModel`) — older / mock shapes tolerated. */
export type RawBoqDocument = Omit<Partial<BoqDocumentModel>, "columns" | "titleRows" | "totals" | "chapters"> & {
  columns?: (string | Partial<BoqDocumentColumn>)[];
  titleRows?: (string | Partial<BoqDocumentTitleRow>)[];
  totals?: Partial<BoqDocumentModel["totals"]> & { vatRate?: number };
  chapters?: (Omit<Partial<BoqDocumentChapter>, "rows"> & { rows?: (Omit<Partial<BoqDocumentRow>, "code" | "unit"> & { code?: string | null; unit?: string | null; note?: string | null })[] })[];
  exportBlocked?: boolean;
};

/**
 * Defensive normalisation of the API model (contracts `kamutan.boq-document/1`): title rows as `{kind, text}`, columns
 * as `{key, title}`, `code` / `unit` null → "", `cellNote` (or a mock `note`), `totals.vatRate` and `exportBlocked`
 * lifted. The layout (row order, texts, numbers) is NOT changed.
 */
export function normalizeDocument(raw: RawBoqDocument): BoqDocumentModel {
  const chapters: BoqDocumentChapter[] = (raw.chapters ?? []).map((c) => ({
    code: String(c.code ?? ""),
    title: c.title ?? "",
    notes: (c.notes ?? []).filter((n) => typeof n === "string" && n.trim()),
    subtotal: num(c.subtotal),
    rows: (c.rows ?? []).map((r): BoqDocumentRow => {
      const { note, ...rest } = r;
      const cellNote = r.cellNote ?? note ?? null;
      return {
        ...rest,
        lineId: r.lineId ?? null,
        code: r.code ?? "",
        description: r.description ?? "",
        unit: r.unit ?? "",
        qty: num(r.qty),
        price: num(r.price),
        total: num(r.total),
        kind: r.kind ?? (r.lineId ? "line" : "note"),
        ...(cellNote ? { cellNote } : {}),
      };
    }),
  }));
  const totals = raw.totals ?? {};
  const vatRate = num(totals.vatRate) ?? num(raw.vatRate);
  const blocked = raw.exportBlocked ?? raw.blocked;
  return {
    titleRows: (raw.titleRows ?? [])
      .map((t): BoqDocumentTitleRow | null =>
        typeof t === "string" ? { kind: "title", text: t } : t && typeof t.text === "string" ? { kind: t.kind ?? "title", text: t.text } : null,
      )
      .filter((t): t is BoqDocumentTitleRow => t !== null && Boolean(t.text.trim())),
    columns: normalizeColumns(raw.columns ?? []),
    chapters,
    totals: {
      beforeVat: num(totals.beforeVat) ?? 0,
      vat: num(totals.vat) ?? 0,
      afterVat: num(totals.afterVat) ?? 0,
      // Sprint 8 (contracts BoqTotals; older documents have only the three VAT totals)
      ...(num(totals.linesTotal) !== null ? { linesTotal: num(totals.linesTotal)! } : {}),
      adjustmentPct: num(totals.adjustmentPct) ?? 0,
      adjustment: num(totals.adjustment) ?? 0,
      ...(num(totals.pricedLines) !== null ? { pricedLines: num(totals.pricedLines)! } : {}),
      ...(num(totals.unpricedLines) !== null ? { unpricedLines: num(totals.unpricedLines)! } : {}),
    },
    warnings: (raw.warnings ?? []).filter((w) => w && w.count > 0),
    generatedAt: raw.generatedAt ?? new Date().toISOString(),
    ...(vatRate !== null ? { vatRate } : {}),
    ...(blocked !== undefined ? { blocked } : {}),
  };
}

/** Note rows of a chapter (contracts: "הערות:" then one per note); none → render `chapter.notes`. */
export const noteRows = (c: BoqDocumentChapter): BoqDocumentRow[] => c.rows.filter((r) => r.kind === "note");
/** "הערות:" heading row (vs the note texts). */
export const isNotesHeading = (r: BoqDocumentRow): boolean => /^\s*הערות\s*:?\s*$/.test(r.description);

/** Line rows of a chapter (subtotal / note rows are rendered separately, as in the Excel). */
export const lineRows = (c: BoqDocumentChapter): BoqDocumentRow[] => c.rows.filter((r) => r.kind === "line");
/** The chapter's "סה"כ": an explicit subtotal row wins over `chapter.subtotal`. */
export const chapterSubtotal = (c: BoqDocumentChapter): number | null => {
  const row = c.rows.find((r) => r.kind === "subtotal");
  return row ? (row.total ?? null) : c.subtotal;
};

/** Warning counts by kind (zeros dropped), in banner order. */
export function warningCounts(w: BoqDocumentModel["warnings"]): { kind: BoqDocumentWarningKind; count: number }[] {
  const order: BoqDocumentWarningKind[] = ["red", "reapproval", "unapproved", "needsInput"];
  const by = new Map<BoqDocumentWarningKind, number>();
  for (const x of w) if (x.count > 0) by.set(x.kind, (by.get(x.kind) ?? 0) + x.count);
  return order.filter((k) => by.has(k)).map((kind) => ({ kind, count: by.get(kind)! }));
}

/** Sprint 8: currency is "₪ 1,234.50" (he-IL, 2 decimals) everywhere — one formatter in features/prices. */
export { formatMoney } from "@/features/prices/model";

/** Total number of line rows (per-floor rows count separately). */
export const documentLineCount = (d: BoqDocumentModel): number => d.chapters.reduce((s, c) => s + lineRows(c).length, 0);

/* ---------------- storage quota ---------------- */

/** "1.2 GB" / "340 MB" (decimal-looking units over binary bytes, like the rest of the app's formatBytes), wrapped in a
 * first-strong isolate so "46.3 MB" keeps its order inside Hebrew text. */
export const formatStorage = (bytes: number): string => `\u2068${storageText(bytes)}\u2069`;

export function storageText(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1).replace(/\.0$/, "")} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(mb >= 100 ? 0 : 1).replace(/\.0$/, "")} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

/** Share of the quota in use (0..100, rounded down; never 100 unless full). */
export const quotaPct = (used: number, quota: number): number => (quota > 0 ? Math.min(100, Math.floor((used / quota) * 100)) : 0);
