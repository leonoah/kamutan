import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { DrawingViewer, type DrawingViewerHandle, type OverlayFeature, type TileSource } from "@kamutan/viewer";
import type { Detection, PublicShareOverlay, PublicShareSheet, Room } from "@/api/types";
import { useBackend } from "@/api/client";
import { boundsOf, detectionMarkers, roomPolygons } from "@/features/understanding/model";

const NEUTRAL: [number, number, number, number] = [15, 76, 129, 255];

/**
 * Read-only drawing of the share viewer: API-proxied tiles (watermarked + title block masked by the server), the
 * locked version's markers (level colour + shape only when the owner shows confidence, else neutral), rooms, focus of
 * the selected line's evidence, and the watermark layer. Select tool only — no tool rail, no correction callbacks.
 * Default export → its own lazy chunk (Deck.gl).
 */
export default function SharedDrawing({
  token,
  sheet,
  overlay,
  focusIds,
  showConfidence,
  watermark,
  onPickLine,
  evidenceIndex,
}: {
  token: string;
  sheet: PublicShareSheet;
  overlay: PublicShareOverlay | undefined;
  focusIds: readonly string[];
  showConfidence: boolean;
  watermark: string;
  onPickLine: (lineId: string) => void;
  /** detection id → line ids (drawing → row). */
  evidenceIndex: ReadonlyMap<string, string[]>;
}) {
  const { t } = useTranslation();
  const { publicShare } = useBackend();
  const ref = useRef<DrawingViewerHandle>(null);

  const tiles = useMemo<TileSource | null>(
    () =>
      sheet.tiles
        ? {
            ...sheet.tiles,
            tileUrl: (z, x, y) => publicShare.tileUrl(token, sheet.id, z, x, y) || null,
            thumbnailUrl: null,
            cacheKey: `share/${sheet.id}/${sheet.versionId}`,
          }
        : null,
    [publicShare, token, sheet],
  );
  const size = sheet.page ?? (sheet.tiles ? { widthMm: (sheet.tiles.widthPx / sheet.tiles.dpi) * 25.4, heightMm: (sheet.tiles.heightPx / sheet.tiles.dpi) * 25.4 } : { widthMm: 420, heightMm: 297 });

  const features = useMemo<OverlayFeature[]>(() => {
    if (!overlay) return [];
    const dets = overlay.detections as Detection[];
    const markers = detectionMarkers(dets, { new: true, existing: true, demolish: true }).map((m) =>
      showConfidence ? m : { ...m, shape: "circle" as const, color: NEUTRAL, dashed: false },
    );
    const rooms = roomPolygons(overlay.rooms as Room[], { unnamed: t("understanding.unnamedRoom"), areaUnit: "מ״ר" });
    return [...rooms, ...markers];
  }, [overlay, showConfidence, t]);

  // Row → drawing: zoom to the selected line's items on this sheet.
  const focusKey = focusIds.join(",");
  useEffect(() => {
    if (!overlay || focusIds.length === 0) return;
    const set = new Set(focusIds);
    const b = boundsOf(overlay.detections.filter((d) => set.has(d.id)), 25);
    if (b) ref.current?.zoomToMm(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, overlay]);

  return (
    <DrawingViewer
      ref={ref}
      sheet={size}
      tiles={tiles}
      overlays={features}
      focusIds={focusIds}
      tool="select"
      onSelect={(ids) => {
        const lines = ids.flatMap((id) => evidenceIndex.get(id) ?? []);
        if (lines[0]) onPickLine(lines[0]);
      }}
      ariaLabel={t("shareViewer.canvasLabel", { sheet: sheet.title ?? sheet.id })}
      watermark={watermark}
      sheetKey={`${sheet.id}/${sheet.versionId}`}
      className="h-full w-full"
      fallback={<p className="p-4 text-dense text-muted-foreground" dir="rtl">{t("viewer.noWebgl", { defaultValue: "השרטוט דורש דפדפן עם WebGL." })}</p>}
    />
  );
}
