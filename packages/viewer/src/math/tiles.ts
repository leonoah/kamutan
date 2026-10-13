/**
 * Tile pyramid of a sheet version (docs/agents/SPRINT1_BRIEF.md):
 * `tiles/{z}/{x}_{y}.webp`, z = 0 is the most zoomed-out level that fits in one tile,
 * level `levels - 1` is rendered at `dpi`. Each lower level halves the pixel size (ceil).
 * Edge tiles may be smaller than `tileSize` (unpadded) or padded — the viewer sizes each
 * bitmap from the decoded image, so both work.
 */
export interface TilePyramid {
  tileSize: number;
  dpi: number;
  levels: number;
  widthPx: number;
  heightPx: number;
}

export const levelsFor = (widthPx: number, heightPx: number, tileSize = 256): number =>
  Math.max(0, Math.ceil(Math.log2(Math.max(widthPx, heightPx, 1) / tileSize))) + 1;

/** Pixel size of level `z`. */
export function levelSize(p: TilePyramid, z: number): [number, number] {
  const down = 2 ** (p.levels - 1 - z);
  return [Math.ceil(p.widthPx / down), Math.ceil(p.heightPx / down)];
}

/** Tile grid (cols, rows) of level `z`. */
export function levelGrid(p: TilePyramid, z: number): [number, number] {
  const [w, h] = levelSize(p, z);
  return [Math.ceil(w / p.tileSize), Math.ceil(h / p.tileSize)];
}

/** Deck.gl TileLayer zoom index for pyramid level `z` (world units = max-level px). */
export const deckZoomForLevel = (p: TilePyramid, z: number): number => z - (p.levels - 1);
export const levelForDeckZoom = (p: TilePyramid, deckZ: number): number => deckZ + (p.levels - 1);

/**
 * World-px bounds of tile (x, y) at pyramid level `z`, given the decoded image size
 * (handles unpadded edge tiles). Returns [left, top, right, bottom].
 */
export function tileWorldBounds(
  p: TilePyramid,
  z: number,
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number,
): [number, number, number, number] {
  const f = 2 ** (p.levels - 1 - z);
  const left = x * p.tileSize * f;
  const top = y * p.tileSize * f;
  return [left, top, Math.min(left + imageWidth * f, p.widthPx), Math.min(top + imageHeight * f, p.heightPx)];
}

/** Total tile count of the pyramid (for budgeting / tests). */
export function tileCount(p: TilePyramid): number {
  let n = 0;
  for (let z = 0; z < p.levels; z++) {
    const [c, r] = levelGrid(p, z);
    n += c * r;
  }
  return n;
}
