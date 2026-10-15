import type { OverlayFeature, PathFeature, PolygonFeature, Rgba, Vec2 } from "@kamutan/viewer";
import {
  BOQ_LINE_TRANSITIONS,
  type BoqChapter,
  type BoqEvidenceItem,
  type BoqLine,
  type BoqLineStatus,
  type DbLevel,
  type Detection,
  type LinkArc,
  type LinkGroup,
  type Role,
} from "@/api/types";
import { OVERLAY_RGB, type OverlayFilters } from "@/features/understanding/model";

/**
 * Pure model of the Sprint-3 BOQ panel: chapters, per-floor columns, receipts ("16 = 14 שזוהו + 2 ידני"),
 * status transitions per role, "next line needing review", shared filters, and link-group geometry on the drawing.
 */

/* ---------------- codes, chapters, floors ---------------- */

/** Item codes are TEXT: compare "4.9" < "4.10" segment-wise (numeric when both segments are numbers). */
export function compareCodes(a: string, b: string): number {
  const as = a.split(/[.\-/]/);
  const bs = b.split(/[.\-/]/);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny || x.length - y.length : x.localeCompare(y);
    if (c) return c;
  }
  return 0;
}

export const effectiveQty = (l: Pick<BoqLine, "qty" | "qtyOverride">): number => l.qtyOverride ?? l.qty;
export const isOverridden = (l: Pick<BoqLine, "qty" | "qtyOverride">): boolean => l.qtyOverride !== null && l.qtyOverride !== undefined;

/** Floors in building order (unknown codes after, alphabetically). */
const FLOOR_ORDER = ["basement", "ground", "first", "second", "third", "roof"];
export function sortFloors(floors: Iterable<string>): string[] {
  const rank = (f: string) => {
    const i = FLOOR_ORDER.indexOf(f);
    return i < 0 ? 100 : i;
  };
  return [...new Set(floors)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
export const floorsOf = (lines: readonly BoqLine[]): string[] => sortFloors(lines.flatMap((l) => Object.keys(l.byFloor ?? {})));

export interface ChapterStats {
  green: number;
  yellow: number;
  red: number;
  /** % of LINES that are green (spec: "אחוז מחושב לפי שורות ולא לפי פריטים"). */
  pct: number;
}
export interface ChapterGroup {
  code: string;
  title: string;
  notes: string[];
  lines: BoqLine[];
  stats: ChapterStats;
}

export function statsOf(lines: readonly Pick<BoqLine, "level">[]): ChapterStats {
  const s = { green: 0, yellow: 0, red: 0 };
  for (const l of lines) s[l.level]++;
  const n = lines.length;
  return { ...s, pct: n ? Math.round((s.green / n) * 100) : 0 };
}

/** Lines grouped by chapter (template order when known, then by code), lines sorted by code. */
export function groupByChapter(lines: readonly BoqLine[], chapters: readonly BoqChapter[] = []): ChapterGroup[] {
  const meta = new Map(chapters.map((c) => [c.code, c]));
  const by = new Map<string, BoqLine[]>();
  for (const l of lines) by.set(l.chapter, [...(by.get(l.chapter) ?? []), l]);
  return [...by.entries()]
    .sort(([a], [b]) => compareCodes(a, b))
    .map(([code, ls]) => {
      const sorted = [...ls].sort((x, y) => (x.order ?? 0) - (y.order ?? 0) || compareCodes(x.code, y.code));
      const m = meta.get(code);
      return {
        code,
        title: m?.title ?? sorted.find((l) => l.chapterTitle)?.chapterTitle ?? `פרק ${code}`,
        notes: m?.notes ?? [],
        lines: sorted,
        stats: statsOf(sorted),
      };
    });
}

/* ---------------- receipts ---------------- */

export interface Receipt {
  total: number;
  detected: number;
  /** Manual part: corrections (manual add / count / measure) + override delta. */
  manual: number;
  evidenceCount: number;
  sheets: number;
  byFloor: [string, number][];
  overridden: boolean;
  note: string | null;
}
export function receiptOf(l: BoqLine): Receipt {
  const total = effectiveQty(l);
  const manualRows = (l.breakdown ?? []).filter((b) => b.manual);
  const fromCorrections = manualRows.length ? manualRows.reduce((s, b) => s + b.qty, 0) : (l.manualCount ?? 0);
  const detected = Math.round((l.qty - fromCorrections) * 100) / 100;
  return {
    total,
    detected,
    manual: Math.round((total - detected) * 100) / 100,
    evidenceCount: l.evidenceCount,
    sheets: new Set(l.sourceVersions.map((s) => s.sheetId)).size,
    byFloor: sortFloors(Object.keys(l.byFloor ?? {})).map((f) => [f, l.byFloor[f] ?? 0]),
    overridden: isOverridden(l),
    note: l.qtyOverrideReason ?? l.note ?? null,
  };
}

/** Number formatting: integers plain, decimals up to 2 places (quantities like 12.4 מ"ר). */
export const fmtQty = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ""));

/* ---------------- statuses per role ---------------- */

/**
 * contracts BOQ_LINE_TRANSITIONS apply to reviewer/admin. Editors may mark a line "נבדק" (and back to טיוטה),
 * but only a reviewer/admin approves or un-approves. Viewers change nothing.
 */
export function allowedTransitions(role: Role | null | undefined, from: BoqLineStatus): BoqLineStatus[] {
  if (!role || role === "viewer") return [];
  const all = BOQ_LINE_TRANSITIONS[from];
  if (role === "admin" || role === "reviewer") return [...all];
  return all.filter((to) => (from === "draft" && to === "reviewed") || (from === "reviewed" && to === "draft"));
}
/** Key `A`: one step forward (draft → reviewed → approved) when the role allows it. */
export function forwardStatus(role: Role | null | undefined, from: BoqLineStatus): BoqLineStatus | null {
  const next: BoqLineStatus | null = from === "draft" ? "reviewed" : from === "reviewed" ? "approved" : null;
  return next && allowedTransitions(role, from).includes(next) ? next : null;
}
export const canEditQty = (role: Role | null | undefined) => role === "admin" || role === "editor" || role === "reviewer";

/** Lines that still need a look: not approved and not green, or still a draft. */
export const needsReview = (l: BoqLine): boolean => l.status !== "approved" && (l.level !== "green" || l.status === "draft");

/** Key `N`: the next line needing review after `currentId` in display order (wraps; risk first: red, then yellow). */
export function nextNeedingReview(ordered: readonly BoqLine[], currentId: string | null): BoqLine | null {
  const pool = ordered.filter((l) => l.status === "draft" && l.level !== "green");
  const list = pool.length ? pool : ordered.filter(needsReview);
  if (!list.length) return null;
  const at = currentId ? ordered.findIndex((l) => l.id === currentId) : -1;
  const after = list.find((l) => ordered.indexOf(l) > at);
  return after ?? list[0]!;
}

/* ---------------- shared filters ---------------- */

/** Domain of a line (for the shared תחום filter): composite / install lines are lighting; chapter 04 electrical. */
export function lineDomain(l: Pick<BoqLine, "ruleId" | "chapter" | "code">): string {
  const r = l.ruleId ?? "";
  if (l.chapter === "03") return "plumbing";
  if (l.chapter === "05") return "tiling";
  if (/comp|light|install/i.test(r)) return "lighting";
  if (["4.09", "4.10", "4.11", "4.12", "4.14", "4.15", "4.16", "9.01"].includes(l.code)) return "lighting";
  if (l.chapter === "04") return "electrical";
  return "other";
}

export type StatusFilter = BoqLineStatus | "all";
/** The drawing's filters applied to lines: תחום → line domain, קומה → line has qty on that floor, ביטחון → level. */
export function filterLines(lines: readonly BoqLine[], f: OverlayFilters, status: StatusFilter = "all"): BoqLine[] {
  const dom = new Set(f.domains);
  const lv = new Set(f.levels);
  return lines.filter(
    (l) =>
      lv.has(l.level) &&
      (dom.size === 0 || dom.has(lineDomain(l))) &&
      (f.floor === null || (l.byFloor?.[f.floor] ?? 0) > 0) &&
      (status === "all" || l.status === status),
  );
}

/* ---------------- evidence ---------------- */

const COMPOSITE_CODES = new Set(["4.09", "4.10", "4.11", "4.12", "4.14", "4.15", "4.16"]);
/** Composite lighting line: its quantity counts switch groups, not items. */
export const isCompositeLine = (l: Pick<BoqLine, "code" | "ruleId">): boolean => COMPOSITE_CODES.has(l.code) || /comp/i.test(l.ruleId ?? "");

/**
 * Units per sheet (sheet switcher badges): one per distinct link group for composite evidence (qty = groups),
 * one per item otherwise — so the per-sheet counts sum to the line quantity (like the API's `bySheet`).
 */
export function evidenceBySheet(items: readonly BoqEvidenceItem[]): Map<string, number> {
  const m = new Map<string, number>();
  const seen = new Set<string>();
  for (const e of items) {
    if (e.linkGroupId) {
      const k = `${e.sheetId}/${e.versionId}/${e.linkGroupId}`;
      if (seen.has(k)) continue;
      seen.add(k);
    }
    m.set(e.sheetId, (m.get(e.sheetId) ?? 0) + 1);
  }
  return m;
}
/** Distinct link groups of a line's evidence, in order (sheetId + group id). */
export function groupsOf(items: readonly BoqEvidenceItem[]): { sheetId: string; linkGroupId: string }[] {
  const out: { sheetId: string; linkGroupId: string }[] = [];
  const seen = new Set<string>();
  for (const e of items)
    if (e.linkGroupId && !seen.has(`${e.sheetId}/${e.linkGroupId}`)) {
      seen.add(`${e.sheetId}/${e.linkGroupId}`);
      out.push({ sheetId: e.sheetId, linkGroupId: e.linkGroupId });
    }
  return out;
}
/** "lk_12" / "g_12" → 12 (the "ק-12" chip). */
export const groupNo = (id: string): string => /(\d+)$/.exec(id)?.[1] ?? id;

/** Bulk sheet map (detectionId → lineIds) inverted: lineId → detection ids on that sheet. */
export function detectionsByLine(detections: Readonly<Record<string, readonly string[]>>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [det, lines] of Object.entries(detections)) for (const l of lines) m.set(l, [...(m.get(l) ?? []), det]);
  return m;
}
/** detectionId → line ids, from all lines' evidence (drawing → row). Key: `${sheetId}/${detectionId}`. */
export function linesByDetection(all: ReadonlyMap<string, readonly BoqEvidenceItem[]>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const [lineId, items] of all)
    for (const e of items) {
      const k = `${e.sheetId}/${e.detectionId}`;
      const cur = m.get(k);
      if (!cur) m.set(k, [lineId]);
      else if (!cur.includes(lineId)) cur.push(lineId);
    }
  return m;
}

/* ---------------- link groups on the drawing ---------------- */

const rgba = (c: readonly [number, number, number], a = 255): Rgba => [c[0], c[1], c[2], a];
export const levelRgb = (l: DbLevel) => OVERLAY_RGB[l];

/** Convex hull (monotone chain), CCW. */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const p = [...points].map((q) => [q[0], q[1]] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Hull of a set of points padded by `pad` mm (octagon around each point, then hull) — never degenerate. */
export function paddedHull(points: readonly Vec2[], pad: number): Vec2[] {
  const ring: Vec2[] = [];
  for (const [x, y] of points)
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      ring.push([x + pad * Math.cos(a), y + pad * Math.sin(a)]);
    }
  return convexHull(ring);
}

/** A gentle arc a→b (quadratic Bézier sampled), like the hand-drawn dashed switch arcs. */
export function arcPath(a: Vec2, b: Vec2, bend = 0.18, steps = 16): Vec2[] {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const cx = mx - dy * bend;
  const cy = my + dx * bend;
  const out: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * cx + t * t * b[0], u * u * a[1] + 2 * u * t * cy + t * t * b[1]]);
  }
  return out;
}

export interface GroupLabel {
  /** "ק-12" */
  short: string;
  /** Item code (LTR-isolated), e.g. "4.11". */
  code: string;
  /** Hebrew detail after the code, e.g. "· 2 גופים / מפסק 1". */
  detail: string;
}

/**
 * Link-group visualisation (spec §סעיפים מורכבים): arcs switch → luminaire 2px in the group's level colour
 * (dashed as drawn; dotted where the worker closed a gap), an 8% convex hull around all members with a chip
 * "ק-12 · 4.11". Groups whose members are not on this sheet are skipped.
 */
export function linkGroupFeatures(
  groups: readonly LinkGroup[],
  detById: ReadonlyMap<string, Pick<Detection, "centerMm">>,
  label: (g: LinkGroup, index: number) => GroupLabel,
  arcsById: ReadonlyMap<string, LinkArc> = new Map(),
): OverlayFeature[] {
  const hulls: PolygonFeature[] = [];
  const arcs: PathFeature[] = [];
  groups.forEach((g, gi) => {
    const pos = (id: string): Vec2 | null => {
      const d = detById.get(id);
      return d ? [d.centerMm.x, d.centerMm.y] : null;
    };
    const sw = g.switchIds.map(pos).filter((p): p is Vec2 => p !== null);
    const lum = g.luminaireIds.map(pos).filter((p): p is Vec2 => p !== null);
    const members = [...sw, ...lum];
    if (!members.length) return;
    const c = levelRgb(g.level);
    const traced = (g.arcIds ?? []).map((id) => arcsById.get(id)).filter((a): a is LinkArc => Boolean(a && a.polylineMm.length > 1));
    if (traced.length) {
      // Worker-A's arcs as traced on the sheet; inferred / ambiguous ones dotted.
      traced.forEach((a) =>
        arcs.push({
          kind: "path",
          id: `lg-arc-${g.id}-${a.id}`,
          path: a.polylineMm.map((p) => [p.x, p.y] as Vec2),
          color: rgba(c, 235),
          widthPx: 2,
          dash: a.inferredSwitch || a.ambiguous ? "dotted" : "dashed",
          passive: true,
        }),
      );
    } else if (g.arcs?.length) {
      g.arcs.forEach((a, i) =>
        arcs.push({
          kind: "path",
          id: `lg-arc-${g.id}-${i}`,
          path: a.pathMm.map((p) => [p.x, p.y] as Vec2),
          color: rgba(c, 235),
          widthPx: 2,
          dash: a.completed ? "dotted" : "dashed",
          passive: true,
        }),
      );
    } else {
      // No traced arcs in the artifact: draw switch → each luminaire (two-way: both switches → the point).
      sw.forEach((s, si) =>
        lum.forEach((l, li) =>
          arcs.push({
            kind: "path",
            id: `lg-arc-${g.id}-${si}-${li}`,
            path: arcPath(s, l),
            color: rgba(c, 235),
            widthPx: 2,
            dash: "dashed",
            passive: true,
          }),
        ),
      );
    }
    const lb = label(g, gi);
    hulls.push({
      kind: "polygon",
      id: `lg-hull-${g.id}`,
      polygon: paddedHull(members, 4.5),
      color: rgba(c, 160),
      fillColor: rgba(c, 20), // ≈ 8%
      lineWidthPx: 1,
      label: lb.short,
      labelLtr: lb.code,
      labelSuffix: lb.detail,
      passive: true,
    });
  });
  return [...hulls, ...arcs];
}
