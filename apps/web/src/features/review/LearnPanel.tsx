import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles, X } from "lucide-react";
import type { SheetRow, SimilarCandidate, SimilarSearch } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { sheetName } from "@/features/sheets/model";
import { className } from "@/features/understanding/taxonomy";
import { TileCrop } from "./TileCrop";

export const DEFAULT_THRESHOLD = 0.7;
export const candidateKey = (c: Pick<SimilarCandidate, "sheetId" | "alreadyDetected" | "centerMm">) =>
  `${c.sheetId}/${c.alreadyDetected ?? `${c.centerMm.x},${c.centerMm.y}`}`;

/** Candidates the apply would touch: above the threshold, not excluded by hand. */
export function selectedCandidates(cands: readonly SimilarCandidate[], threshold: number, excluded: ReadonlySet<string>): SimilarCandidate[] {
  return cands.filter((c) => c.score >= threshold && !excluded.has(candidateKey(c)));
}

/**
 * "למד מהתיקון" preview (spec): after the search, "נמצאו 9 דומים ב-3 גיליונות", a thumbnail grid sorted by
 * similarity with a draggable threshold that updates the grid (and the drawing preview) live; a thumbnail click
 * excludes / re-includes it; "החל על N" posts one batch of corrections.
 */
export function LearnPanel({
  projectId,
  search,
  cls,
  rows,
  loading,
  failed,
  onSelectionChange,
  onApply,
  onCancel,
}: {
  projectId: string;
  search: SimilarSearch | null;
  cls: string;
  rows: ReadonlyMap<string, SheetRow>;
  loading: boolean;
  failed: boolean;
  onSelectionChange: (selected: SimilarCandidate[]) => void;
  onApply: (selected: SimilarCandidate[], remember: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [remember, setRemember] = useState(true);
  const cands = useMemo(() => [...(search?.candidates ?? [])].sort((a, b) => b.score - a.score), [search]);
  const above = useMemo(() => cands.filter((c) => c.score >= threshold), [cands, threshold]);
  const selected = useMemo(() => selectedCandidates(cands, threshold, excluded), [cands, threshold, excluded]);
  useEffect(() => onSelectionChange(selected), [selected]); // eslint-disable-line react-hooks/exhaustive-deps
  const sheets = new Set(above.map((c) => c.sheetId)).size;
  const already = selected.filter((c) => c.currentClass === cls).length;
  const name = className(cls);
  const done = search?.status === "succeeded";

  // The wrapper inherits the canvas' LTR (→ right edge, away from the tool rail); the card itself is RTL.
  return (
    <div className="absolute end-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(340px,calc(100%-4.5rem))]">
      <section
        dir="rtl"
        aria-labelledby="learn-title"
        data-learn-panel
        onPointerDown={(e) => e.stopPropagation()}
        className="flex min-h-0 w-full flex-col rounded-lg border border-border bg-surface shadow-float"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Sparkles className="size-4 text-manual" aria-hidden />
          <h2 id="learn-title" className="min-w-0 flex-1 truncate text-dense font-bold text-foreground">
            {t("learn.title", { name })}
          </h2>
          <Button size="icon-sm" variant="ghost" onClick={onCancel} aria-label={t("learn.cancel")}>
            <X aria-hidden />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3 text-dense">
          {loading || (search && !done && !failed) ? (
            <p role="status" className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t("learn.searching")}
            </p>
          ) : failed ? (
            <p role="alert" className="text-destructive">
              {t("learn.failed")}
            </p>
          ) : (
            <>
              <p role="status" className="font-medium text-foreground">
                {above.length ? t("learn.found", { count: above.length, sheets }) : t("learn.foundNone")}
              </p>
              <label className="flex flex-col gap-1">
                <span className="flex items-center justify-between text-meta text-muted-foreground">
                  {t("learn.threshold")}
                  <Ltr className="font-medium text-foreground">{threshold.toFixed(2)}</Ltr>
                </span>
                <input
                  type="range"
                  min={0.3}
                  max={0.99}
                  step={0.01}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  aria-valuetext={threshold.toFixed(2)}
                  className="w-full accent-[rgb(var(--manual))]"
                />
              </label>
              <p className="text-meta text-muted-foreground" data-testid="learn-counts">
                {[
                  t("learn.aboveThreshold", { count: above.length }),
                  t("learn.willChange", { count: selected.length - already }),
                  already ? t("learn.already", { count: already, name }) : null,
                  excluded.size ? t("learn.excluded", { count: above.filter((c) => excluded.has(candidateKey(c))).length }) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <ul
                className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5"
                aria-label={t("learn.found", { count: above.length, sheets })}
              >
                {above.map((c) => {
                  const k = candidateKey(c);
                  const off = excluded.has(k);
                  const row = rows.get(c.sheetId) ?? null;
                  return (
                    <li key={k}>
                      <button
                        type="button"
                        aria-pressed={!off}
                        aria-label={`${t("learn.candidate", { score: c.score.toFixed(2), sheet: row ? sheetName(row) : c.sheetId, cls: className(c.currentClass) })} · ${t("learn.toggle")}`}
                        onClick={() =>
                          setExcluded((s) => {
                            const n = new Set(s);
                            if (n.has(k)) n.delete(k);
                            else n.add(k);
                            return n;
                          })
                        }
                        className={cn(
                          "relative flex w-full flex-col items-center gap-0.5 rounded-sm p-0.5",
                          off ? "opacity-45" : "ring-1 ring-manual/50",
                        )}
                      >
                        <TileCrop projectId={projectId} row={row} bboxMm={c.bboxMm} alt="" size={56} />
                        <span className="text-[11px] text-muted-foreground">
                          <Ltr>{c.score.toFixed(2)}</Ltr>
                        </span>
                        {off ? <X className="absolute top-4 size-6 text-destructive" aria-hidden /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <label className="me-auto flex items-center gap-1.5 text-meta text-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="size-3.5 accent-[rgb(var(--primary))]"
            />
            {t("learn.remember")}
          </label>
          <Button size="sm" variant="secondary" onClick={onCancel}>
            {t("learn.cancel")}
          </Button>
          <Button size="sm" disabled={!done || selected.length === 0} onClick={() => onApply(selected, remember)}>
            {t("learn.apply", { count: selected.length })}
          </Button>
        </div>
      </section>
    </div>
  );
}
