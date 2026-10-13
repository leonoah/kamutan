import type { MarkerFeature, MarkerShape } from "./types";

/**
 * GPU marker icons for detected symbols. One small atlas, drawn once on a 2D canvas, used as a MASK by
 * deck.gl's IconLayer: the RGB comes from the marker colour, the atlas alpha shapes it:
 *   - outline at full alpha (the "frame around the symbol", spec §השרטוט),
 *   - a faint tint inside (the drawn symbol stays readable underneath, and the whole shape is pickable),
 *   - a small SOLID copy of the shape in the top-right corner, so ● ▲ ◆ ◇ read at a glance even when the
 *     frame is small.
 * Variants: dashed outline (existing / demolish / unknown) and a diagonal strike (demolish).
 */
export const MARKER_CELL = 64;
const SHAPES: MarkerShape[] = ["circle", "triangle", "diamond", "diamond-open"];
const INTERIOR_ALPHA = 0.16;

export interface IconDef {
  x: number;
  y: number;
  width: number;
  height: number;
  mask: true;
  anchorX: number;
  anchorY: number;
}

export const markerIconKey = (f: Pick<MarkerFeature, "shape" | "dashed" | "strike">): string =>
  `${f.shape}${f.dashed ? "-d" : ""}${f.strike ? "-x" : ""}`;

/** Icon mapping for every shape × dashed × strike (4 × 2 × 2 = 16 cells, 4 per row). */
export function markerIconMapping(): Record<string, IconDef> {
  const out: Record<string, IconDef> = {};
  let i = 0;
  for (const shape of SHAPES)
    for (const dashed of [false, true])
      for (const strike of [false, true]) {
        const x = (i % 4) * MARKER_CELL;
        const y = Math.floor(i / 4) * MARKER_CELL;
        out[markerIconKey({ shape, dashed, strike })] = {
          x,
          y,
          width: MARKER_CELL,
          height: MARKER_CELL,
          mask: true,
          anchorX: MARKER_CELL / 2,
          anchorY: MARKER_CELL / 2,
        };
        i++;
      }
  return out;
}

/** Outline path of a shape inside a cell (cx, cy, radius r). */
function shapePath(ctx: CanvasRenderingContext2D, shape: MarkerShape, cx: number, cy: number, r: number) {
  ctx.beginPath();
  if (shape === "circle") ctx.arc(cx, cy, r, 0, Math.PI * 2);
  else if (shape === "triangle") {
    // Equilateral-ish, centred on the symbol (slightly larger so the symbol fits inside).
    const h = r * 1.15;
    ctx.moveTo(cx, cy - h);
    ctx.lineTo(cx + h * 1.0, cy + h * 0.75);
    ctx.lineTo(cx - h * 1.0, cy + h * 0.75);
    ctx.closePath();
  } else {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
  }
}

let cached: HTMLCanvasElement | null | undefined;

/**
 * The atlas canvas (256 × 256), or null where no 2D canvas exists (jsdom). Built once per page.
 * White pixels with alpha; IconLayer tints them (mask: true).
 */
export function markerAtlas(): HTMLCanvasElement | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (typeof document === "undefined") return null;
  // jsdom has no 2D canvas (and logs "not implemented" when asked) — tests stub deck anyway.
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return null;
  let ctx: CanvasRenderingContext2D | null = null;
  const canvas = document.createElement("canvas");
  try {
    canvas.width = MARKER_CELL * 4;
    canvas.height = MARKER_CELL * 4;
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  const mapping = markerIconMapping();
  const C = MARKER_CELL;
  for (const shape of SHAPES)
    for (const dashed of [false, true])
      for (const strike of [false, true]) {
        const d = mapping[markerIconKey({ shape, dashed, strike })]!;
        const cx = d.x + C / 2;
        const cy = d.y + C / 2 + (shape === "triangle" ? 3 : 0);
        const r = C * 0.36;
        const lw = shape === "diamond" ? 5 : shape === "circle" ? 3.5 : 4.5;
        ctx.save();
        // faint interior
        shapePath(ctx, shape, cx, cy, r);
        ctx.fillStyle = `rgba(255,255,255,${INTERIOR_ALPHA})`;
        ctx.fill();
        // outline
        ctx.setLineDash(dashed || shape === "diamond-open" ? [7, 5] : []);
        ctx.lineWidth = lw;
        ctx.strokeStyle = "rgba(255,255,255,1)";
        shapePath(ctx, shape, cx, cy, r);
        ctx.stroke();
        ctx.setLineDash([]);
        if (strike) {
          ctx.beginPath();
          ctx.moveTo(d.x + C * 0.2, d.y + C * 0.8);
          ctx.lineTo(d.x + C * 0.8, d.y + C * 0.2);
          ctx.lineWidth = 3.5;
          ctx.stroke();
        }
        // solid corner badge
        const bx = d.x + C - 9;
        const by = d.y + 9;
        ctx.fillStyle = "rgba(255,255,255,1)";
        ctx.lineWidth = 2.5;
        shapePath(ctx, shape, bx, by + (shape === "triangle" ? 1 : 0), shape === "triangle" ? 6 : 7);
        if (shape === "diamond-open") ctx.stroke();
        else ctx.fill();
        ctx.restore();
      }
  cached = canvas;
  return canvas;
}

/** Test hook: forget the cached atlas. */
export function resetMarkerAtlasForTests() {
  cached = undefined;
}
