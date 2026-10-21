import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

/** sharp ≥0.35 ships ESM typings without the `sharp` namespace; derive the overlay type from the API. */
type OverlayOptions = Parameters<ReturnType<typeof sharp>['composite']>[0][number];

/**
 * Burned-in watermark + title-block mask for share-link tiles (SEC-28), with sharp (Apache-2.0; its prebuilt libvips
 * is LGPL-3.0, dynamically linked and unmodified — see NOTES.md). The text is rendered by Pango from a bundled font
 * file (no system fonts, no runtime download), rotated −30°, and laid out on a PATTERN in level-pixel space so the
 * marks continue seamlessly across neighbouring tiles.
 */

/** Spacing of the repeated watermark (level pixels). */
export const WATERMARK_PERIOD_PX = 384;

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** First existing candidate: env override, bundled asset (dist/../assets or src/../../assets), system DejaVu. */
export function resolveFontFile(override?: string): string | null {
  const candidates = [
    override,
    join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf'),
    join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf'),
    join(process.cwd(), 'assets', 'fonts', 'DejaVuSans.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

const escapeMarkup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Strip control / bidi-override characters from user text before it is rendered. */
export function cleanWatermarkText(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** "שותף עם {recipient|label} • {dd.mm.yyyy} • {shortId}" (brief §4). */
export function watermarkText(who: string, createdAt: Date, shortId: string): string {
  const d = `${String(createdAt.getUTCDate()).padStart(2, '0')}.${String(createdAt.getUTCMonth() + 1).padStart(2, '0')}.${createdAt.getUTCFullYear()}`;
  return cleanWatermarkText(`שותף עם ${cleanWatermarkText(who)} • ${d} • ${shortId}`);
}

export class TileWatermarker {
  /** text → 2×2 repeated pattern (raw RGBA, 2·PERIOD square). */
  private readonly patterns = new Map<string, Promise<{ data: Buffer; size: number }>>();
  private static readonly MAX_PATTERNS = 64;

  constructor(private readonly fontFile: string | null) {}

  private pattern(text: string): Promise<{ data: Buffer; size: number }> {
    const hit = this.patterns.get(text);
    if (hit) return hit;
    const p = this.buildPattern(text);
    this.patterns.set(text, p);
    p.catch(() => this.patterns.delete(text));
    while (this.patterns.size > TileWatermarker.MAX_PATTERNS) this.patterns.delete(this.patterns.keys().next().value as string);
    return p;
  }

  private async buildPattern(text: string): Promise<{ data: Buffer; size: number }> {
    const P = WATERMARK_PERIOD_PX;
    const layers: OverlayOptions[] = [];
    // Faint diagonal hatch: a mark even if text rendering were unavailable.
    const hatch = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${P}" height="${P}"><path d="M0 ${P} L${P} 0" stroke="#7a0019" stroke-opacity="0.10" stroke-width="2"/></svg>`,
    );
    layers.push({ input: hatch, left: 0, top: 0 });
    try {
      const txt = await sharp({
        text: {
          text: `<span foreground="#7a0019">${escapeMarkup(text)}</span>`,
          font: 'DejaVu Sans 13',
          ...(this.fontFile ? { fontfile: this.fontFile } : {}),
          rgba: true,
          dpi: 96,
          width: Math.floor(P * 0.95),
          wrap: 'word-char',
        },
      })
        .rotate(-30, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      const meta = await sharp(txt).metadata();
      const w = Math.min(P, meta.width ?? P);
      const h = Math.min(P, meta.height ?? P);
      const fitted = w === meta.width && h === meta.height ? txt : await sharp(txt).resize(w, h, { fit: 'inside' }).png().toBuffer();
      const fm = await sharp(fitted).metadata();
      // Semi-transparent text (≈ 35 % alpha).
      const faded = await sharp(fitted).ensureAlpha().linear([1, 1, 1, 0.35], [0, 0, 0, 0]).png().toBuffer();
      layers.push({ input: faded, left: Math.max(0, Math.floor((P - (fm.width ?? 0)) / 2)), top: Math.max(0, Math.floor((P - (fm.height ?? 0)) / 2)) });
    } catch {
      // Pango/font unavailable: the hatch alone still marks every tile (NOTES.md).
    }
    const cell = await sharp({ create: { width: P, height: P, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(layers)
      .png()
      .toBuffer();
    const size = 2 * P;
    const data = await sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        { input: cell, left: 0, top: 0 },
        { input: cell, left: P, top: 0 },
        { input: cell, left: 0, top: P },
        { input: cell, left: P, top: P },
      ])
      .raw()
      .toBuffer();
    return { data, size };
  }

  /**
   * Returns a WebP tile with the watermark burned in and `masks` (tile-local px rects) filled opaque.
   * `origin` = the tile's top-left in level pixels (pattern phase).
   */
  async apply(tile: Buffer, opts: { text: string; origin: { x: number; y: number }; masks: TileRect[] }): Promise<Buffer> {
    const base = sharp(tile, { limitInputPixels: 4096 * 4096 });
    const meta = await base.metadata();
    const w = meta.width ?? 256;
    const h = meta.height ?? 256;
    const P = WATERMARK_PERIOD_PX;
    const pat = await this.pattern(opts.text);
    const left = ((opts.origin.x % P) + P) % P;
    const top = ((opts.origin.y % P) + P) % P;
    const overlay = await sharp(pat.data, { raw: { width: pat.size, height: pat.size, channels: 4 } })
      .extract({ left, top, width: Math.min(w, pat.size - left), height: Math.min(h, pat.size - top) })
      .png()
      .toBuffer();
    const layers: OverlayOptions[] = [];
    for (const m of opts.masks) {
      const x = Math.max(0, Math.floor(m.x));
      const y = Math.max(0, Math.floor(m.y));
      const mw = Math.min(w, Math.ceil(m.x + m.w)) - x;
      const mh = Math.min(h, Math.ceil(m.y + m.h)) - y;
      if (mw <= 0 || mh <= 0) continue;
      layers.push({ input: { create: { width: mw, height: mh, channels: 4, background: { r: 236, g: 236, b: 236, alpha: 1 } } }, left: x, top: y });
    }
    layers.push({ input: overlay, left: 0, top: 0 });
    return base.composite(layers).webp({ quality: 80 }).toBuffer();
  }
}

/** Title-block rectangle (paper mm) → tile-local pixel rect for tile (x, y) of a level with `mmPerPx`. */
export function maskToTile(maskMm: TileRect, mmPerPx: number, tileX: number, tileY: number, tileSize: number): TileRect {
  return { x: maskMm.x / mmPerPx - tileX * tileSize, y: maskMm.y / mmPerPx - tileY * tileSize, w: maskMm.w / mmPerPx, h: maskMm.h / mmPerPx };
}
