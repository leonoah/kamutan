import { useEffect, useRef, useState } from "react";
import { useApi } from "@/api/client";
import type { BBoxMm, SheetRow, TilesManifest } from "@/api/types";
import { cn } from "@/lib/utils";
import { createSignedTileResolver, useTilesManifest } from "@/features/viewer/tiles";

/**
 * A 64×64 crop of the drawing around a symbol (spec: "תמונות ממוזערות של 64×64 עם 20% שוליים סביב הסמל"), cut from
 * the sheet's own tile pyramid when the API gives no `thumbUrl`: the tiles covering the box at full resolution are
 * fetched (signed URLs, shared resolver per sheet) and drawn into a canvas. Tile images are cached per URL.
 */
type Resolver = ReturnType<typeof createSignedTileResolver>;
const resolvers = new Map<string, Resolver>();
const images = new Map<string, Promise<HTMLImageElement | null>>();

function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = images.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    images.set(url, p);
    if (images.size > 400) images.delete(images.keys().next().value!);
  }
  return p;
}

export interface TileCropProps {
  projectId: string;
  row: SheetRow | null;
  bboxMm: BBoxMm;
  size?: number;
  alt: string;
  className?: string;
  /** Pre-made crop (worker / API thumb); used instead of cutting from tiles. */
  src?: string | null;
}

export function TileCrop({ projectId, row, bboxMm, size = 64, alt, className, src }: TileCropProps) {
  const api = useApi();
  const ref = useRef<HTMLCanvasElement>(null);
  const manifest = useTilesManifest(projectId, src ? null : row);
  const [ok, setOk] = useState(false);
  const meta: TilesManifest | undefined = manifest.data;
  const sheetId = row?.sheet.id ?? "";
  const versionId = row?.version?.id ?? "";

  useEffect(() => {
    if (src || !meta || !ref.current) return;
    const ctx = ref.current.getContext("2d");
    if (!ctx) return;
    let alive = true;
    const key = `${projectId}/${sheetId}/${versionId}`;
    let resolve = resolvers.get(key);
    if (!resolve) {
      resolve = createSignedTileResolver((q) => api.getTilesManifest(projectId, sheetId, versionId, q), meta.levelGrid, meta.maxBatch);
      resolvers.set(key, resolve);
    }
    const t = meta.tiles;
    const z = t.levels - 1; // full resolution
    const pxPerMm = t.dpi / 25.4;
    // square crop around the symbol with 20% margins
    const side = Math.max(bboxMm.w, bboxMm.h, 2) * 1.4;
    const cx = bboxMm.x + bboxMm.w / 2;
    const cy = bboxMm.y + bboxMm.h / 2;
    const x0 = (cx - side / 2) * pxPerMm;
    const y0 = (cy - side / 2) * pxPerMm;
    const s = side * pxPerMm;
    const ts = t.tileSize;
    const tx0 = Math.max(0, Math.floor(x0 / ts));
    const ty0 = Math.max(0, Math.floor(y0 / ts));
    const tx1 = Math.floor((x0 + s) / ts);
    const ty1 = Math.floor((y0 + s) / ts);
    void (async () => {
      const jobs: Promise<void>[] = [];
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, size, size);
      const k = size / s;
      let drawn = 0;
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++)
          jobs.push(
            (async () => {
              const url = await resolve!(z, tx, ty);
              const img = url ? await loadImage(url) : null;
              if (!img || !alive) return;
              ctx.drawImage(img, (tx * ts - x0) * k, (ty * ts - y0) * k, img.width * k, img.height * k);
              drawn++;
            })(),
          );
      await Promise.all(jobs);
      if (alive && drawn) setOk(true);
    })();
    return () => {
      alive = false;
    };
  }, [src, meta, api, projectId, sheetId, versionId, bboxMm.x, bboxMm.y, bboxMm.w, bboxMm.h, size]);

  if (src)
    return (
      <img src={src} alt={alt} width={size} height={size} className={cn("rounded-sm border border-border bg-white object-contain", className)} />
    );
  return (
    <canvas
      ref={ref}
      width={size}
      height={size}
      {...(alt ? { role: "img", "aria-label": alt } : { "aria-hidden": true })}
      data-crop-ready={ok || undefined}
      className={cn("rounded-sm border border-border bg-white", !ok && "paper-grid", className)}
      style={{ width: size, height: size }}
    />
  );
}
