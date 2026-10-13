import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Mutable2, OrthoViewState, Size } from "./math/coords";
import { pointMmToPx } from "./math/coords";
import { minimapTransform, visibleWorldRect } from "./math/view";
import type { PointFeature } from "./types";

const W = 180;
const H = 130;

export interface MinimapProps {
  worldW: number;
  worldH: number;
  view: OrthoViewState;
  box: Size;
  imageUrl: string | null;
  markers: readonly PointFeature[];
  dpi: number;
  label: string;
  toggleLabel: string;
  onCenter: (world: Mutable2) => void;
}

/**
 * Bottom-left overview (spec §השרטוט: 180×130, never mirrored). Shows the whole sheet, the visible
 * viewport rectangle and open-item dots; click or drag to move the view. Uses the z=0 tile or the
 * thumbnail — no extra WebGL context.
 */
export function Minimap({ worldW, worldH, view, box, imageUrl, markers, dpi, label, toggleLabel, onCenter }: MinimapProps) {
  const [open, setOpen] = useState(true);
  const dragging = useRef(false);
  const t = minimapTransform({ width: W, height: H }, worldW, worldH);
  const r = visibleWorldRect(view, box);
  const [x0, y0] = t.toMini([Math.max(0, r.minX), Math.max(0, r.minY)]);
  const [x1, y1] = t.toMini([Math.min(worldW, r.maxX), Math.min(worldH, r.maxY)]);

  // Dots depend on the markers only — not re-diffed on every pan/zoom frame (2,000+ markers).
  const dots = useMemo(
    () =>
      markers.slice(0, 600).map((m) => {
        const [mx, my] = t.toMini(pointMmToPx(m.position, dpi));
        const c = m.color ?? [194, 65, 12, 255];
        return <circle key={m.id} cx={mx} cy={my} r={2.2} fill={`rgb(${c[0]} ${c[1]} ${c[2]})`} />;
      }),
    // t depends only on worldW/worldH
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [markers, dpi, worldW, worldH],
  );
  const center = (e: ReactPointerEvent<HTMLDivElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    onCenter(t.toWorld([e.clientX - b.left, e.clientY - b.top]));
  };

  return (
    <div
      data-viewer-ui
      data-testid="viewer-minimap"
      style={{ position: "absolute", left: 12, bottom: 12, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, zIndex: 1 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={() => setOpen((o) => !o)}
        style={{
          font: "500 11px/1 Heebo, system-ui, sans-serif",
          padding: "3px 6px",
          borderRadius: 4,
          border: "1px solid rgb(var(--border, 231 229 228))",
          background: "rgb(var(--surface, 255 255 255))",
          color: "rgb(var(--muted-foreground, 87 83 78))",
          cursor: "pointer",
        }}
      >
        {open ? "▾" : "▸"} <span dir="rtl">{label}</span>
      </button>
      {open ? (
        <div
          role="img"
          aria-label={label}
          style={{
            position: "relative",
            width: W,
            height: H,
            overflow: "hidden",
            borderRadius: 6,
            border: "1px solid rgb(var(--border, 231 229 228))",
            background: "rgb(var(--canvas-bg, 255 255 255))",
            boxShadow: "0 4px 16px rgb(0 0 0 / 0.10)",
            cursor: "pointer",
            touchAction: "none",
          }}
          onPointerDown={(e) => {
            dragging.current = true;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              /* synthetic event */
            }
            center(e);
          }}
          onPointerMove={(e) => dragging.current && center(e)}
          onPointerUp={() => (dragging.current = false)}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              draggable={false}
              style={{ position: "absolute", left: t.offset[0], top: t.offset[1], width: worldW * t.scale, height: worldH * t.scale }}
            />
          ) : (
            <div
              style={{
                position: "absolute",
                left: t.offset[0],
                top: t.offset[1],
                width: worldW * t.scale,
                height: worldH * t.scale,
                border: "1px solid rgb(120 113 108)",
                background: "white",
              }}
            />
          )}
          <svg width={W} height={H} style={{ position: "absolute", inset: 0 }} aria-hidden>
            {dots}
            <rect
              data-testid="viewer-minimap-viewport"
              x={x0}
              y={y0}
              width={Math.max(2, x1 - x0)}
              height={Math.max(2, y1 - y0)}
              fill="rgb(37 99 235 / 0.12)"
              stroke="#2563EB"
              strokeWidth={1.2}
            />
          </svg>
        </div>
      ) : null}
    </div>
  );
}
