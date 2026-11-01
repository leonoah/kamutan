import type { OverlayFeature, PathFeature, PolygonFeature, Rgba, Vec2, ViewerTool } from "@kamutan/viewer";
import type { BBoxMm, BoqEvidenceItem, BoqLine, BoqLineOrigin, BoqQuickAction, BoqQuickActionKind, CorrectionUnit, DbLevel, PointMm } from "@/api/types";
import { OVERLAY_RGB } from "@/features/understanding/model";
import { isOverridden } from "./model";

/**
 * Sprint 6 (SPRINT6_BRIEF): every line of the client's BOQ is present — computed from the drawings (symbols, text,
 * geometry) or offered as a *suggested* line "להשלמה ידנית" with a one-click measure / count / confirm action.
 * Pure helpers shared by the BOQ panel, the hub card, the review workspace and the mock.
 */

/* ---------------- origin / needs input / quick action ---------------- */

/** Origin of a line; older docs (before Sprint 6) carry none → inferred (manual rule, room-derived, else detected). */
export function originOf(l: Pick<BoqLine, "origin" | "ruleId" | "breakdown">): BoqLineOrigin {
  if (l.origin) return l.origin;
  if (l.ruleId === "r_manual") return "manual";
  if (l.breakdown?.some((b) => b.roomId && !b.manual)) return "geometry";
  return "detected";
}

/** Computed from the drawing (symbols, text or geometry) — the coverage numerator. */
export const isFromDrawing = (o: BoqLineOrigin): boolean => o === "detected" || o === "text" || o === "geometry";

/** The line still waits for a person ("להשלמה ידנית"). A manual override answers it too. */
export const lineNeedsInput = (l: Pick<BoqLine, "needsInput" | "qty" | "qtyOverride">): boolean => Boolean(l.needsInput) && !isOverridden(l);

const AREA = /מ"ר|מ״ר|m2|m²/i;
const LENGTH = /מ"א|מ״א|מ'|^m$/i;
const LUMP = /קומפלט|קומ'/;
export const unitKind = (unit: string): "area" | "length" | "lump" | "count" =>
  AREA.test(unit) ? "area" : LENGTH.test(unit) ? "length" : LUMP.test(unit) ? "lump" : "count";

/** The line's quick action: the server's, else (suggested / needs input) one derived from the unit. */
export function quickActionOf(l: Pick<BoqLine, "quickAction" | "needsInput" | "qty" | "qtyOverride" | "unit" | "origin" | "ruleId" | "breakdown">): BoqQuickAction | null {
  if (l.quickAction !== undefined) return l.quickAction;
  if (!lineNeedsInput(l) && originOf(l) !== "suggested") return null;
  const u = unitKind(l.unit);
  return { kind: u === "area" ? "measure_area" : u === "length" ? "measure_length" : u === "lump" ? "confirm" : "count", sheetId: null };
}

/** Viewer tool of a quick action (`confirm` opens a dialog instead). */
export const QUICK_TOOL: Record<BoqQuickActionKind, ViewerTool | null> = {
  measure_area: "area",
  measure_length: "length",
  count: "count",
  confirm: null,
};
export const QUICK_UNIT: Record<BoqQuickActionKind, CorrectionUnit> = { measure_area: "m2", measure_length: "m", count: "unit", confirm: "unit" };

/* ---------------- coverage ---------------- */

export interface Coverage {
  total: number;
  /** Computed from the drawing (detected / text / geometry) and not waiting for input. */
  computed: number;
  /** "להשלמה ידנית". */
  needsInput: number;
}
export function coverageOf(lines: readonly BoqLine[]): Coverage {
  let computed = 0;
  let needsInput = 0;
  for (const l of lines) {
    if (lineNeedsInput(l)) needsInput++;
    else if (isFromDrawing(originOf(l))) computed++;
  }
  return { total: lines.length, computed, needsInput };
}

/* ---------------- optimistic quick measure ---------------- */

const r2 = (n: number) => Math.round(n * 100) / 100;
/**
 * The line right after a quick measure (before the server answers): a waiting line takes the measured quantity
 * (its estimate, if any, is replaced), a computed line adds it; `confirm` sets it. The line no longer needs input.
 */
export function applyQuickMeasure(l: BoqLine, kind: BoqQuickActionKind, qty: number, label: string, sheetId: string | null): BoqLine {
  const waiting = lineNeedsInput(l);
  const next = kind === "confirm" || waiting ? r2(qty) : r2(l.qty + qty);
  return {
    ...l,
    qty: next,
    needsInput: false,
    origin: waiting || originOf(l) === "suggested" ? "manual" : originOf(l),
    manualCount: r2((l.manualCount ?? 0) + (kind === "count" ? qty : 1)),
    breakdown: [...(waiting ? (l.breakdown ?? []).filter((b) => b.manual) : (l.breakdown ?? [])), { label, qty: r2(qty), sheetId, manual: true }],
  };
}

/* ---------------- evidence on the drawing (text / geometry / stair) ---------------- */

/** Kind of an evidence item (older items: detection, or room when `roomId` is set). */
export const evidenceKind = (e: BoqEvidenceItem) => e.kind ?? (e.roomId ? "room" : "detection");
export const isShapeEvidence = (e: BoqEvidenceItem) => {
  const k = evidenceKind(e);
  return k === "text" || k === "geometry" || k === "stair";
};

const bboxOfPoints = (pts: readonly PointMm[]): BBoxMm => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
};

/** Paper-mm bbox of one text / geometry / stair item (null when it carries no shape). */
export function evidenceBox(e: BoqEvidenceItem): BBoxMm | null {
  switch (evidenceKind(e)) {
    case "text":
      return e.bboxMm ?? null;
    case "geometry":
      return e.geometry?.mm.length ? bboxOfPoints(e.geometry.mm) : null;
    case "stair": {
      const pts = (e.treads ?? []).flat();
      return pts.length ? bboxOfPoints(pts) : null;
    }
    default:
      return null;
  }
}

/** Items to zoom to: the shape evidence of a line on one sheet, as bboxes (merged with markers / rooms by the caller). */
export const shapeBoxesOn = (items: readonly BoqEvidenceItem[], sheetId: string): { bboxMm: BBoxMm }[] =>
  items.flatMap((e) => {
    if (e.sheetId !== sheetId || !isShapeEvidence(e)) return [];
    const b = evidenceBox(e);
    return b ? [{ bboxMm: b }] : [];
  });

const rgba = (c: readonly number[], a: number): Rgba => [c[0]!, c[1]!, c[2]!, a];
const vec = (p: PointMm): Vec2 => [p.x, p.y];

/**
 * Highlight of a line's non-symbol evidence on the drawing (spec: "לכל מספר יש קבלה"): `text` → the bbox of the
 * matched text (outline + soft fill, the text as a chip), `geometry` → the measured polygon / polyline, `stair` →
 * every tread outlined and numbered. Coloured by the line's level; never pickable (the markers stay clickable).
 */
export function evidenceShapeFeatures(items: readonly BoqEvidenceItem[], sheetId: string, level: DbLevel, opts: { label?: string; unit?: string; tread?: string } = {}): OverlayFeature[] {
  const c = OVERLAY_RGB[level];
  const out: OverlayFeature[] = [];
  items.forEach((e, i) => {
    if (e.sheetId !== sheetId) return;
    const id = `ev-${i}-${e.detectionId}`;
    switch (evidenceKind(e)) {
      case "text": {
        const b = e.bboxMm;
        if (!b) return;
        // a little air around the glyphs so the outline does not cut through them
        const p = Math.max(0.8, Math.min(b.w, b.h) * 0.15);
        out.push({
          kind: "polygon",
          id,
          polygon: [
            [b.x - p, b.y - p],
            [b.x + b.w + p, b.y - p],
            [b.x + b.w + p, b.y + b.h + p],
            [b.x - p, b.y + b.h + p],
          ],
          color: rgba(c, 235),
          fillColor: rgba(c, 38),
          lineWidthPx: 2,
          ...(e.text ? { label: e.text, labelMinPx: 24 } : {}),
          passive: true,
        } satisfies PolygonFeature);
        return;
      }
      case "geometry": {
        const g = e.geometry;
        if (!g || g.mm.length < 2) return;
        if (g.type === "polygon")
          out.push({
            kind: "polygon",
            id,
            polygon: g.mm.map(vec),
            color: rgba(c, 235),
            fillColor: rgba(c, 46),
            lineWidthPx: 2.5,
            ...(opts.label ? { label: opts.label, labelMinPx: 40, ...(e.quantity != null ? { labelLtr: String(e.quantity), labelSuffix: opts.unit ?? "" } : {}) } : {}),
            passive: true,
          } satisfies PolygonFeature);
        else out.push({ kind: "path", id, path: g.mm.map(vec), color: rgba(c, 240), widthPx: 4, passive: true } satisfies PathFeature);
        return;
      }
      case "stair":
        (e.treads ?? []).forEach((t, k) => {
          if (t.length < 3) return;
          out.push({
            kind: "polygon",
            id: `${id}-t${k}`,
            polygon: t.map(vec),
            color: rgba(c, 235),
            fillColor: rgba(c, k % 2 ? 30 : 60),
            lineWidthPx: 1.5,
            ...(opts.tread ? { label: opts.tread, labelLtr: String(k + 1), labelMinPx: 60 } : {}),
            passive: true,
          } satisfies PolygonFeature);
        });
        return;
      default:
        return;
    }
  });
  return out;
}
