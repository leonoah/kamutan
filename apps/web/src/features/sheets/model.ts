import type { OverlayFeature, Rgba } from "@kamutan/viewer";
import type { ConfirmSheetRequest, SheetRegion, SheetRow } from "@/api/types";

/** Discipline codes written by the worker (SHEET_CLASSIFICATION.md) → i18n `disciplines.*`. */
export const DISCIPLINES = [
  "electrical",
  "lighting",
  "plumbing",
  "tiling",
  "demolition",
  "construction",
  "architecture_master",
  "sections",
  "elevations",
  "other",
] as const;
/** Reference-only sheets (spec S07 #6: "לעיון — לא נספר"): need a discipline but no floor/scale. */
export const REFERENCE_DISCIPLINES = new Set(["sections", "elevations"]);

export const FLOORS = ["basement", "ground", "first", "second", "roof"] as const;

export interface SheetDraft {
  discipline: string;
  floors: string[];
  scale: string; // text input; parsed on confirm
}

export const draftOf = (row: SheetRow): SheetDraft => ({
  discipline: row.sheet.discipline ?? row.sheet.classification?.discipline ?? "",
  floors: [...(row.sheet.floors ?? row.sheet.classification?.floors ?? [])],
  scale: row.sheet.scaleDenominator ? String(row.sheet.scaleDenominator) : scaleFromText(row.sheet.classification?.scaleText) ?? "",
});

/** "1:50" → "50". */
export function scaleFromText(text: string | null | undefined): string | null {
  const m = text?.match(/1\s*:\s*(\d+(?:\.\d+)?)/);
  return m?.[1] ?? null;
}

export const parseScale = (s: string): number | null => {
  const n = Number(s.trim().replace(/^1\s*:\s*/, "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** What is still missing before a sheet can be confirmed (spec S07 #7). */
export function missingFields(d: SheetDraft): ("discipline" | "floors" | "scale")[] {
  const out: ("discipline" | "floors" | "scale")[] = [];
  if (!d.discipline) out.push("discipline");
  if (REFERENCE_DISCIPLINES.has(d.discipline)) return out;
  if (d.floors.length === 0) out.push("floors");
  if (parseScale(d.scale) === null) out.push("scale");
  return out;
}

export function toConfirmRequest(d: SheetDraft): ConfirmSheetRequest {
  const n = parseScale(d.scale);
  // contracts: integer 1..10000, or null for reference sheets without a scale.
  return { discipline: d.discipline, floors: d.floors, scaleDenominator: n === null ? null : Math.min(10_000, Math.max(1, Math.round(n))) };
}

/** Fields the system is unsure about → dashed border + ◆ (spec S07 #2). */
export function uncertainFields(row: SheetRow): Set<"discipline" | "floors" | "scale"> {
  const c = row.sheet.classification;
  const out = new Set<"discipline" | "floors" | "scale">();
  if (!c) return out;
  const r = new Set(c.reasons);
  if (!c.discipline || r.has("NO_DISCIPLINE") || c.level === "red") out.add("discipline");
  if (!c.floors.length || r.has("NO_FLOOR") || r.has("MULTI_FLOOR") || c.level === "red") out.add("floors");
  if (!c.scaleText || r.has("NO_DIM_CHECK") || r.has("SCALE_CONFLICT") || c.level === "red") out.add("scale");
  return out;
}

export const isMultiFloor = (row: SheetRow, d?: SheetDraft) =>
  (d?.floors.length ?? row.sheet.floors?.length ?? 0) > 1 || Boolean(row.sheet.classification?.reasons.includes("MULTI_FLOOR"));

export const sheetName = (row: SheetRow): string =>
  row.sheet.title ?? row.sheet.classification?.sheetTitle ?? row.sheet.titleBlock?.sheetTitle ?? row.sheet.logicalKey ?? row.sheet.id;

/** Distinct colours per floor region (colour + label, never colour alone). */
const REGION_COLORS: Rgba[] = [
  [15, 76, 129, 255],
  [178, 107, 0, 255],
  [109, 40, 217, 255],
  [27, 127, 90, 255],
  [159, 18, 57, 255],
];

export function regionOverlays(regions: readonly SheetRegion[], floorLabel: (floor: string) => string): OverlayFeature[] {
  return regions.map((r, i) => {
    const color = REGION_COLORS[i % REGION_COLORS.length]!;
    return {
      id: `region:${r.id}`,
      kind: "polygon" as const,
      polygon: r.polygonMm.map((p) => [p.x, p.y] as const),
      color,
      fillColor: [color[0], color[1], color[2], 22] as Rgba,
      lineWidthPx: 2,
      label: floorLabel(r.floor),
      passive: true,
    };
  });
}

export const regionColor = (i: number): string => {
  const c = REGION_COLORS[i % REGION_COLORS.length]!;
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
};

/** Max points per region polygon (contracts MAX_REGION_POINTS). */
export const MAX_REGION_POINTS = 256;

/** Lasso polygon ([x, y] mm) → contract region points ({x, y}), decimated to ≤ 256 points, 0.1 mm precision. */
export function toRegionPolygon(poly: readonly (readonly [number, number])[]): { x: number; y: number }[] {
  const step = Math.ceil(poly.length / MAX_REGION_POINTS) || 1;
  return poly.filter((_, i) => i % step === 0).map(([x, y]) => ({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }));
}
