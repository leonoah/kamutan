import { useTranslation } from "react-i18next";
import { Hash, Lasso, MousePointer2, Plus, Ruler, Scaling, SquareDashed, Undo2 } from "lucide-react";
import { Kbd } from "@/components/Kbd";
import { cn } from "@/lib/utils";

/**
 * Static stand-in for DrawingCanvas (deck.gl arrives in Sprint 2).
 * Everything in here is LTR and never mirrored (spec §כללי RTL): the drawing is an engineering document.
 * Physical left/right utilities are allowed ONLY inside this subtree.
 */
export function DrawingPlaceholder({ sheetName }: { sheetName: string }) {
  const { t } = useTranslation();
  const tools = [
    { key: "V", icon: MousePointer2, label: "בחירה" },
    { key: "A", icon: Plus, label: "הוספה בלחיצה" },
    { key: "L", icon: Lasso, label: "לאסו" },
    { key: "#", icon: Hash, label: "ספירה ידנית" },
    { key: "M", icon: SquareDashed, label: "מדידת שטח" },
    { key: "D", icon: Ruler, label: "מדידת אורך" },
    { key: "S", icon: Scaling, label: "כיול קנה מידה" },
  ];

  return (
    <div dir="ltr" className="relative flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          role="img"
          aria-label={t("review.drawingRegion", { sheet: sheetName })}
          className="paper-grid absolute inset-0"
        >
          <SampleSheetSvg />
        </div>

        {/* Tool rail — left edge of the canvas, not mirrored */}
        <div
          dir="rtl"
          role="toolbar"
          aria-label={t("review.tools")}
          aria-orientation="vertical"
          className="absolute left-3 top-3 flex flex-col gap-0.5 rounded border border-border bg-surface p-1 shadow-float"
        >
          {tools.map(({ key, icon: Icon, label }, i) => (
            <button
              key={key}
              type="button"
              aria-label={`${label} (${key})`}
              title={`${label} · ${key}`}
              aria-pressed={i === 0}
              className={cn(
                "flex size-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                i === 0 && "bg-primary/10 text-primary",
              )}
            >
              <Icon className="size-4" aria-hidden />
            </button>
          ))}
          <span aria-hidden className="my-0.5 h-px bg-border" />
          <button
            type="button"
            aria-label="ביטול (Ctrl+Z)"
            title="ביטול · ⌘Z"
            className="flex size-8 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Undo2 className="size-4" aria-hidden />
          </button>
        </div>

        {/* Minimap — bottom-left, 180×130 */}
        <div
          aria-hidden
          className="absolute bottom-3 left-3 h-[130px] w-[180px] overflow-hidden rounded border border-border bg-canvas shadow-float"
        >
          <svg viewBox="0 0 180 130" className="size-full">
            <rect x="12" y="14" width="70" height="100" fill="none" stroke="#1C1917" strokeWidth=".8" opacity=".5" />
            <rect x="96" y="14" width="70" height="100" fill="none" stroke="#1C1917" strokeWidth=".8" opacity=".5" />
            <rect x="18" y="30" width="54" height="40" fill="rgb(37 99 235 / .12)" stroke="#2563EB" strokeWidth="1.2" />
            <circle cx="40" cy="48" r="2.4" fill="#C2410C" />
            <circle cx="120" cy="60" r="2.4" fill="#C2410C" />
            <circle cx="140" cy="90" r="2.4" fill="#B26B00" />
            <circle cx="60" cy="96" r="2.4" fill="#B26B00" />
          </svg>
        </div>

        <p
          dir="rtl"
          className="absolute bottom-3 right-3 max-w-[240px] rounded border border-dashed border-input bg-surface/90 px-3 py-2 text-meta text-muted-foreground"
        >
          {t("review.drawingPlaceholder")}
        </p>
      </div>

      {/* Bottom strip: scale/zoom + lifecycle state toggle (labels Hebrew, layout LTR like the canvas) */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-t border-border bg-surface px-3 text-meta text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="tabular">1:50</span>
          <span className="tabular">120%</span>
          <span className="hidden items-center gap-1 lg:inline-flex">
            <Kbd>0</Kbd>
            <span dir="rtl">התאם</span>
          </span>
        </div>
        <fieldset dir="rtl" className="flex items-center gap-3">
          <legend className="sr-only">מצב פריטים</legend>
          {[
            { id: "new", label: t("review.stateNew"), checked: true },
            { id: "existing", label: t("review.stateExisting"), checked: false },
            { id: "demolish", label: t("review.stateDemolish"), checked: false },
          ].map((s) => (
            <label key={s.id} className="inline-flex cursor-pointer items-center gap-1.5 text-foreground">
              <input type="checkbox" defaultChecked={s.checked} className="size-3.5 accent-[rgb(var(--primary))]" />
              {s.label}
            </label>
          ))}
        </fieldset>
      </div>
    </div>
  );
}

/** A schematic slice of a 1:50 lighting plan: walls, symbols, red dashed switch arcs, confidence markers. */
function SampleSheetSvg() {
  const ink = "#1C1917";
  const arc = "#D11F1F";
  const marker = (x: number, y: number, level: "high" | "mid" | "low" | "unknown", selected = false) => {
    const color = { high: "#1B7F5A", mid: "#B26B00", low: "#C2410C", unknown: "#6D28D9" }[level];
    const w = { high: 1, mid: 2, low: 2.5, unknown: 2 }[level];
    const dash = level === "low" || level === "unknown" ? "4 3" : undefined;
    return (
      <g>
        {selected ? <rect x={x - 17} y={y - 17} width="34" height="34" rx="4" fill="none" stroke="#2563EB" strokeWidth="6" opacity=".25" /> : null}
        <rect x={x - 14} y={y - 14} width="28" height="28" rx="3" fill="none" stroke={color} strokeWidth={w} strokeDasharray={dash} opacity={level === "high" ? 0.6 : 1} />
      </g>
    );
  };
  const light = (x: number, y: number) => (
    <g stroke={ink} strokeWidth="1.2" fill="none">
      <circle cx={x} cy={y} r="8" />
      <path d={`M${x - 5.6} ${y - 5.6}l11.2 11.2M${x + 5.6} ${y - 5.6}l-11.2 11.2`} />
    </g>
  );
  const socket = (x: number, y: number) => (
    <g stroke={ink} strokeWidth="1.2" fill="none">
      <path d={`M${x - 8} ${y}a8 8 0 0 1 16 0`} />
      <path d={`M${x - 8} ${y}h16M${x} ${y}v6`} />
    </g>
  );
  const sw = (x: number, y: number) => (
    <g stroke={ink} strokeWidth="1.2" fill="none">
      <circle cx={x} cy={y} r="4" />
      <path d={`M${x + 3} ${y - 3}l8 -8`} />
    </g>
  );
  return (
    <svg viewBox="0 0 900 560" preserveAspectRatio="xMidYMid meet" className="size-full">
      <g stroke={ink} strokeWidth="5" fill="none" strokeLinecap="square">
        <path d="M120 80H520V300H360M300 300H120Z" />
        <path d="M520 80H800V480H520V360" />
        <path d="M120 300V480H460" />
      </g>
      <g stroke={ink} strokeWidth="1" fill="none" opacity=".55">
        <path d="M360 300a60 60 0 0 0 -60 -60" />
        <path d="M520 360a60 60 0 0 1 60 -60" />
      </g>
      <g fontFamily="Heebo, Arial" fontSize="15" fill={ink} textAnchor="middle">
        <text x="320" y="200">סלון</text>
        <text x="660" y="280">מטבח</text>
        <text x="290" y="400">חדר שינה</text>
      </g>
      <g stroke={arc} strokeWidth="1.3" fill="none" strokeDasharray="7 5">
        <path d="M150 120Q220 70 260 150" />
        <path d="M260 150Q330 120 380 150" />
        <path d="M560 110Q620 80 660 170" />
      </g>
      {sw(150, 120)}
      {light(260, 150)}
      {light(380, 150)}
      {sw(560, 110)}
      {light(660, 170)}
      {light(700, 400)}
      {socket(170, 270)}
      {socket(470, 270)}
      {socket(760, 330)}
      {socket(200, 450)}
      {marker(260, 150, "high")}
      {marker(380, 150, "mid", true)}
      {marker(150, 120, "low", true)}
      {marker(660, 170, "high")}
      {marker(700, 400, "unknown")}
      {marker(170, 270, "high")}
      {marker(470, 270, "low")}
      {marker(760, 330, "mid")}
      {marker(200, 450, "high")}
      <g fontFamily="Heebo, Arial" fontSize="11" fill={ink}>
        <circle cx="402" cy="128" r="9" fill="#fff" stroke={ink} />
        <text x="402" y="132" textAnchor="middle">22</text>
      </g>
    </svg>
  );
}
