import { useQuery } from "@tanstack/react-query";
import type { TileSource } from "@kamutan/viewer";
import { useApi } from "@/api/client";
import type { SheetRow, TileLevel, TilesManifest, TilesManifestQuery } from "@/api/types";

/** Signed URLs live 15 min (brief) → refresh the meta/thumbnail manifest well before they expire. */
const REFRESH_MS = 12 * 60_000;
/** Re-sign a tile URL when it has less than this left. */
const EXPIRY_MARGIN_MS = 60_000;

/** Tiles meta + thumbnail (manifest without a window) of a sheet's current version; disabled until ready. */
export function useTilesManifest(projectId: string, row: SheetRow | null | undefined) {
  const api = useApi();
  const sheetId = row?.sheet.id ?? "";
  const versionId = row?.version?.id ?? "";
  const ready = row?.version?.status === "ready" && Boolean(row.version.artifacts?.tiles);
  return useQuery({
    queryKey: ["tiles-manifest", projectId, sheetId, versionId],
    queryFn: () => api.getTilesManifest(projectId, sheetId, versionId),
    enabled: ready,
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
}

type FetchWindow = (q: TilesManifestQuery) => Promise<Pick<TilesManifest, "urls" | "expiresAt">>;

/**
 * On-demand signed tile URLs: a tile request fetches the signed URLs of its whole block
 * (block × block tiles, ≤ maxBatch) in one tiles-manifest call; concurrent requests for the same block
 * share the call; URLs are cached until shortly before `expiresAt`.
 */
export function createSignedTileResolver(fetchWindow: FetchWindow, levelGrid: readonly TileLevel[], maxBatch = 256, now = () => Date.now()) {
  const block = Math.max(1, Math.floor(Math.sqrt(maxBatch)));
  const cache = new Map<string, { url: string; exp: number }>();
  const inflight = new Map<string, Promise<void>>();

  const loadBlock = (z: number, bx: number, by: number): Promise<void> => {
    const key = `${z}/${bx}/${by}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const g = levelGrid.find((l) => l.z === z);
    const x0 = bx * block;
    const y0 = by * block;
    const q: TilesManifestQuery = {
      z,
      x0,
      y0,
      x1: Math.min(x0 + block - 1, (g?.cols ?? x0 + block) - 1),
      y1: Math.min(y0 + block - 1, (g?.rows ?? y0 + block) - 1),
    };
    const p = fetchWindow(q)
      .then((m) => {
        const exp = Date.parse(m.expiresAt) || now() + 10 * 60_000;
        for (const [k, url] of Object.entries(m.urls)) cache.set(k, { url, exp });
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  return async function tileUrl(z: number, x: number, y: number): Promise<string | null> {
    const k = `${z}/${x}_${y}`;
    const hit = cache.get(k);
    if (hit && hit.exp - now() > EXPIRY_MARGIN_MS) return hit.url;
    const g = levelGrid.find((l) => l.z === z);
    if (g && (x >= g.cols || y >= g.rows || x < 0 || y < 0)) return null;
    await loadBlock(z, Math.floor(x / block), Math.floor(y / block));
    return cache.get(k)?.url ?? null;
  };
}

/** Manifest meta → viewer TileSource whose tile URLs are fetched (signed) on demand. */
export function toTileSource(meta: TilesManifest, fetchWindow: FetchWindow, cacheKey: string): TileSource {
  const { tiles } = meta;
  return {
    tileSize: tiles.tileSize,
    dpi: tiles.dpi,
    levels: tiles.levels,
    widthPx: tiles.widthPx,
    heightPx: tiles.heightPx,
    tileUrl: createSignedTileResolver(fetchWindow, meta.levelGrid, meta.maxBatch),
    thumbnailUrl: meta.thumbnailUrl,
    // Stable across URL re-signing: already-loaded tiles stay, new ones get fresh URLs.
    cacheKey,
  };
}

/** Paper size of a version (page doc, else derived from the tile pyramid). */
export function paperSize(row: SheetRow | null | undefined): { widthMm: number; heightMm: number } | null {
  const v = row?.version;
  if (v?.page) return { widthMm: v.page.widthMm, heightMm: v.page.heightMm };
  const t = v?.artifacts?.tiles;
  if (t) return { widthMm: (t.widthPx / t.dpi) * 25.4, heightMm: (t.heightPx / t.dpi) * 25.4 };
  return null;
}
