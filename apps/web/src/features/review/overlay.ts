import type { OverlayFeature, PathFeature, PointFeature, PolygonFeature, Rgba, Vec2 } from "@kamutan/viewer";
import type { BBoxMm, Room, RoomSettings, RoomWall, SimilarCandidate } from "@/api/types";
import type { ManualItem } from "@/features/corrections/model";
import { OVERLAY_RGB } from "@/features/understanding/model";
import { candidateKey } from "./LearnPanel";

/** Sprint-4 overlay layers: manual counts / measures, the selected room + its walls, learn-from-correction preview. */

const MANUAL: Rgba = [...OVERLAY_RGB.manual, 255] as Rgba;
const fmt = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2 });

export function manualItemFeatures(items: readonly ManualItem[]): OverlayFeature[] {
  const out: OverlayFeature[] = [];
  for (const m of items) {
    const pts = m.points.map((p) => [p.x, p.y] as Vec2);
    if (m.kind === "count")
      pts.forEach((p, i) =>
        out.push({
          kind: "point",
          id: `mc-${m.id}-${i}`,
          position: p,
          radiusPx: 7,
          color: MANUAL,
          passive: true,
          label: String(i + 1),
        } satisfies PointFeature),
      );
    else if (m.kind === "area")
      out.push({
        kind: "polygon",
        id: `ma-${m.id}`,
        polygon: pts,
        passive: true,
        color: [...OVERLAY_RGB.manual, 220] as Rgba,
        fillColor: [...OVERLAY_RGB.manual, 26] as Rgba,
        lineWidthPx: 2,
        label: m.itemCode ?? "",
        labelLtr: fmt.format(m.quantity),
        labelSuffix: m.unit,
      } satisfies PolygonFeature);
    else {
      out.push({ kind: "path", id: `ml-${m.id}`, path: pts, passive: true, color: MANUAL, widthPx: 2.5 } satisfies PathFeature);
      const end = pts[pts.length - 1];
      if (end)
        out.push({
          kind: "point",
          id: `ml-end-${m.id}`,
          position: end,
          passive: true,
          radiusPx: 3,
          color: MANUAL,
          label: `${fmt.format(m.quantity)} ${m.unit}`,
        });
    }
  }
  return out;
}

/** The selected room (bold outline) and, while picking, its walls as pickable segments; partial-cladding walls in blue. */
export function roomFeatures(room: Room, walls: readonly RoomWall[], draft: RoomSettings | null, picking: boolean): OverlayFeature[] {
  const out: OverlayFeature[] = [
    {
      kind: "polygon",
      id: `room-sel-${room.id}`,
      polygon: room.polygonMm.map((p) => [p.x, p.y] as Vec2),
      passive: true,
      color: MANUAL,
      fillColor: [...OVERLAY_RGB.manual, 22] as Rgba,
      lineWidthPx: 3,
    },
  ];
  const partial = new Set((draft?.partialCladding ?? []).map((p) => p.wallId));
  walls.forEach((w, i) => {
    const on = partial.has(w.id);
    if (!picking && !on) return;
    out.push({
      kind: "path",
      id: `wall:${w.id}`,
      path: [
        [w.aMm.x, w.aMm.y],
        [w.bMm.x, w.bMm.y],
      ],
      color: on ? MANUAL : ([194, 65, 12, 230] as Rgba),
      widthPx: on ? 6 : 5,
      passive: !picking,
    });
    if (picking)
      out.push({
        kind: "point",
        id: `wall-n-${w.id}`,
        position: [(w.aMm.x + w.bMm.x) / 2, (w.aMm.y + w.bMm.y) / 2],
        passive: true,
        radiusPx: 2,
        color: [194, 65, 12, 255],
        label: String(i + 1),
      });
  });
  return out;
}

/** Learn-from-correction preview on the current sheet: the candidates that "apply" would change. */
export function candidateFeatures(cands: readonly SimilarCandidate[], sheetId: string): OverlayFeature[] {
  return cands
    .filter((c) => c.sheetId === sheetId)
    .map((c) => ({
      kind: "polygon" as const,
      id: `cand-${candidateKey(c)}`,
      polygon: bboxRing(c.bboxMm, 1.2),
      passive: true,
      dashed: true,
      color: MANUAL,
      fillColor: [...OVERLAY_RGB.manual, 40] as Rgba,
      lineWidthPx: 2,
    }));
}

const bboxRing = (b: BBoxMm, pad: number): Vec2[] => [
  [b.x - pad, b.y - pad],
  [b.x + b.w + pad, b.y - pad],
  [b.x + b.w + pad, b.y + b.h + pad],
  [b.x - pad, b.y + b.h + pad],
];

export const bboxCenter = (b: BBoxMm) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
export const padBBox = (b: BBoxMm, px = 25, py = 18): [number, number, number, number] => [b.x - px, b.y - py, b.x + b.w + px, b.y + b.h + py];

/** The wall nearest to a paper-mm point (segment distance), within `maxMm`. */
export function nearestWall(walls: readonly RoomWall[], p: [number, number], maxMm: number): RoomWall | null {
  let best: RoomWall | null = null;
  let bestD = maxMm;
  for (const w of walls) {
    const ax = w.aMm.x;
    const ay = w.aMm.y;
    const dx = w.bMm.x - ax;
    const dy = w.bMm.y - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2));
    const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
    if (d <= bestD) {
      best = w;
      bestD = d;
    }
  }
  return best;
}

/** Room under a paper-mm point (smallest first: a WC inside an outline wins). */
export function roomAt(rooms: Iterable<Room>, mm: [number, number]): Room | null {
  const hits = [...rooms].filter((r) => inside(mm, r.polygonMm));
  return hits.sort((a, b) => a.areaM2 - b.areaM2)[0] ?? null;
}
function inside(p: [number, number], poly: readonly { x: number; y: number }[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p[1] !== b.y > p[1] && p[0] < ((b.x - a.x) * (p[1] - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
