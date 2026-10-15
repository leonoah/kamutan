import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookMarked, Check, CheckCheck, ChevronRight, EyeOff, PanelsTopLeft, Pencil, ScanSearch } from "lucide-react";
import type { LegendEntry, PatchLegendEntryRequest, SheetRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { ConfidenceBadge, levelFromDb } from "@/components/ConfidenceBadge";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";
import { useProject } from "@/features/projects/queries";
import { useLiveSheets } from "@/features/realtime/hooks";
import { sheetName } from "@/features/sheets/model";
import { ClassSelect, levelOfConfidence } from "@/features/understanding/ClassSelect";
import { useLegendEntries, usePatchLegendEntry } from "@/features/understanding/queries";
import { className as classHe, isSymbolClass } from "@/features/understanding/taxonomy";

/** Suggested class confidence (falls back to the OCR confidence when the list DTO has no classConfidence). */
const confOf = (e: LegendEntry) => (isSymbolClass(e.suggestedClass) ? (e.classConfidence ?? e.labelConfidence) : Math.min(0.3, e.classConfidence ?? 0.3));
const levelOf = (e: LegendEntry) => levelOfConfidence(confOf(e));
const isGreenPending = (e: LegendEntry) => e.status === "suggested" && isSymbolClass(e.suggestedClass) && levelOf(e) === "green";

/**
 * S08 "אישור מקרא ומיפוי" (spec flow 4). Per sheet: the legend rows — symbol crop, OCR label (editable), suggested
 * class (Hebrew, from the taxonomy), confidence, and אשר / התעלם. Confirmations are org memory ("learn once").
 */
export function LegendPage() {
  const { projectId = "" } = useParams();
  const { t } = useTranslation();
  const project = useProject(projectId);
  const sheets = useLiveSheets(project.data?.orgId ?? null, projectId);
  const entries = useLegendEntries(projectId);
  const patch = usePatchLegendEntry(projectId);
  const [busy, setBusy] = useState(false);

  const all = entries.data ?? [];
  const decided = all.filter((e) => e.status !== "suggested").length;
  const greens = all.filter(isGreenPending);

  const groups = useMemo(() => {
    const rows = sheets.data ?? [];
    const bySheet = new Map<string, LegendEntry[]>();
    for (const e of all) bySheet.set(e.sheetId, [...(bySheet.get(e.sheetId) ?? []), e]);
    const order = (id: string) => {
      const i = rows.findIndex((r) => r.sheet.id === id);
      return i < 0 ? 1e6 : i;
    };
    return [...bySheet.entries()]
      .sort((a, b) => order(a[0]) - order(b[0]))
      .map(([sheetId, list]) => ({
        sheetId,
        row: rows.find((r) => r.sheet.id === sheetId) ?? null,
        list: [...list].sort((a, b) => entryOrder(a.id) - entryOrder(b.id)),
      }));
  }, [all, sheets.data]);

  const send = (e: LegendEntry, req: PatchLegendEntryRequest) =>
    patch.mutateAsync({ id: e.id, req }).catch((err) => {
      toast({ title: t("legend.error"), tone: "error" });
      throw err;
    });

  const confirmGreens = async () => {
    if (greens.length === 0) return toast({ title: t("legend.noGreens") });
    setBusy(true);
    const results = await Promise.allSettled(greens.map((e) => patch.mutateAsync({ id: e.id, req: { action: "confirm" } })));
    setBusy(false);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    if (ok) toast({ title: t("legend.confirmGreensDone", { count: ok }), tone: "success" });
    if (ok < results.length) toast({ title: t("legend.error"), tone: "error" });
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <nav aria-label={t("app.breadcrumbs")} className="mb-4">
        <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-1 rounded text-dense text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
          {project.data?.name ?? t("project.back")}
        </Link>
      </nav>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-screen text-foreground">{t("legend.title")}</h1>
          <p className="mt-1.5 text-dense text-muted-foreground">{t("legend.subtitle")}</p>
          <p className="mt-1 flex items-center gap-1.5 text-meta text-muted-foreground">
            <BookMarked className="size-3.5" aria-hidden />
            {t("legend.learnedNote")}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <Button variant="secondary" asChild>
              <Link to={`/projects/${projectId}/review`}>
                <PanelsTopLeft aria-hidden />
                {t("legend.toReview")}
              </Link>
            </Button>
            <Button onClick={() => void confirmGreens()} disabled={busy || greens.length === 0}>
              <CheckCheck aria-hidden />
              {t("legend.confirmGreens")}
            </Button>
          </div>
          {all.length > 0 ? (
            <div className="flex w-64 flex-col gap-1">
              <span className="text-meta font-medium text-foreground" aria-live="polite">
                {t("legend.progress", { confirmed: decided, total: all.length })}
              </span>
              <Progress value={(decided / all.length) * 100} aria-label={t("legend.progressLabel")} indicatorClassName="bg-conf-high" />
            </div>
          ) : null}
        </div>
      </div>

      {entries.isError ? (
        <p role="alert" className="rounded border border-destructive/30 bg-surface px-4 py-3 text-dense text-destructive">
          {t("legend.loadError")}
        </p>
      ) : entries.isLoading ? (
        <p role="status" className="text-dense text-muted-foreground">
          {t("common.loading")}
        </p>
      ) : all.length === 0 ? (
        <EmptyState title={t("legend.title")} body={t("legend.empty")} />
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <SheetLegend key={g.sheetId} projectId={projectId} row={g.row} sheetId={g.sheetId} list={g.list} send={send} />
          ))}
        </div>
      )}
    </div>
  );
}

/** le_<sheet>_<n> → n (keeps legend row order); cluster-made entries go last. */
function entryOrder(id: string): number {
  const n = Number(id.slice(id.lastIndexOf("_") + 1));
  return Number.isFinite(n) ? n : 1e6;
}

function SheetLegend({
  projectId,
  row,
  sheetId,
  list,
  send,
}: {
  projectId: string;
  row: SheetRow | null;
  sheetId: string;
  list: LegendEntry[];
  send: (e: LegendEntry, req: PatchLegendEntryRequest) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const name = row ? sheetName(row) : sheetId;
  const headingId = `legend-${sheetId}`;
  const done = list.filter((e) => e.status !== "suggested").length;
  return (
    <section aria-labelledby={headingId} className="overflow-hidden rounded border border-border bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-sunken px-4 py-3">
        <div className="flex min-w-0 flex-col">
          <h2 id={headingId} className="text-panel text-foreground">
            <bdi>{name}</bdi>
          </h2>
          <span className="text-meta text-muted-foreground">
            {row?.sheet.discipline ? `${t(`disciplines.${row.sheet.discipline}`, { defaultValue: row.sheet.discipline })} · ` : ""}
            {t("legend.sheetEntries", { count: list.length })} · {t("legend.progress", { confirmed: done, total: list.length })}
          </span>
        </div>
        <Button size="sm" variant="ghost" className="text-primary" asChild>
          <Link to={`/projects/${projectId}/review?sheet=${encodeURIComponent(sheetId)}`}>
            <ScanSearch aria-hidden />
            {t("legend.openInReview")}
          </Link>
        </Button>
      </header>
      <table className="w-full table-fixed border-collapse text-dense">
        <caption className="sr-only">
          {t("legend.title")} — {name}
        </caption>
        <thead>
          <tr className="h-9 border-b border-border text-meta text-muted-foreground">
            <th scope="col" className="w-40 ps-4 text-start font-medium">{t("legend.columns.symbol")}</th>
            <th scope="col" className="text-start font-medium">{t("legend.columns.label")}</th>
            <th scope="col" className="w-56 text-start font-medium">{t("legend.columns.class")}</th>
            <th scope="col" className="w-28 text-start font-medium">{t("legend.columns.confidence")}</th>
            <th scope="col" className="w-48 pe-4 text-end font-medium">{t("legend.columns.actions")}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((e, i) => (
            <LegendRow key={e.id} entry={e} n={i + 1} send={send} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function LegendRow({ entry: e, n, send }: { entry: LegendEntry; n: number; send: (e: LegendEntry, req: PatchLegendEntryRequest) => Promise<unknown> }) {
  const { t } = useTranslation();
  const suggested = isSymbolClass(e.suggestedClass) ? e.suggestedClass : "";
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(e.label);
  const [cls, setCls] = useState<string>(e.class ?? suggested);
  const decided = e.status !== "suggested" && !editing;
  const level = levelOf(e);
  const uiLevel = e.status === "confirmed" ? "manual" : levelFromDb(level);
  const display = e.label || "—";

  const confirm = async () => {
    if (!cls) return;
    const labelChanged = label.trim() !== e.label;
    const base = labelChanged ? { label: label.trim() } : {};
    const req: PatchLegendEntryRequest =
      cls === suggested && e.status === "suggested" ? { action: "confirm", ...base } : { action: "reassign", class: cls, ...base };
    await send(e, req).then(() => setEditing(false), () => undefined);
  };
  const ignore = async () => {
    await send(e, { action: "ignore" }).then(() => setEditing(false), () => undefined);
  };

  return (
    <tr
      data-entry={e.id}
      data-status={e.status}
      className={cn("border-b border-border last:border-0", e.status === "ignored" && !editing && "bg-surface-sunken/60 text-muted-foreground")}
    >
      <td className="py-2 ps-4">
        {e.thumbUrl ? (
          <img
            src={e.thumbUrl}
            alt={t("legend.thumbAlt", { label: display })}
            className={cn("h-11 w-32 rounded-sm border border-border bg-white object-contain p-0.5", e.status === "ignored" && !editing && "opacity-50")}
            loading="lazy"
          />
        ) : (
          <span className="paper-grid flex h-11 w-32 items-center justify-center rounded-sm border border-dashed border-border text-meta text-muted-foreground">
            {t("legend.noThumb")}
          </span>
        )}
      </td>
      <td className="py-2 pe-3">
        {decided ? (
          <span className={cn("block truncate", e.status === "ignored" && "line-through")} title={display}>
            {display}
          </span>
        ) : (
          <input
            dir="auto"
            value={label}
            onChange={(ev) => setLabel(ev.target.value)}
            aria-label={t("legend.labelInput", { n })}
            maxLength={300}
            className={cn(
              "h-9 w-full rounded border bg-surface px-2 text-dense text-foreground",
              e.labelConfidence < 0.85 ? "border-dashed border-conf-mid" : "border-input",
            )}
          />
        )}
      </td>
      <td className="py-2 pe-3">
        {decided ? (
          <span className={cn("block truncate", e.status === "ignored" ? "text-muted-foreground line-through" : "text-foreground")}>
            {classHe(e.class ?? e.suggestedClass)}
          </span>
        ) : (
          <ClassSelect
            value={cls}
            onValueChange={setCls}
            placeholder={t("legend.chooseClass")}
            aria-label={t("legend.classSelect", { n })}
            className={cn(!cls && "border-dashed border-conf-low")}
          />
        )}
      </td>
      <td className="py-2">
        {e.status === "confirmed" && !editing ? (
          <ConfidenceBadge level="manual" size="sm" />
        ) : (
          <ConfidenceBadge level={uiLevel} size="sm" score={confOf(e)} />
        )}
      </td>
      <td className="py-2 pe-4">
        <div className="flex items-center justify-end gap-1.5">
          {decided ? (
            <>
              <span className="inline-flex items-center gap-1 text-meta text-muted-foreground">
                {e.status === "confirmed" ? <Check className="size-3.5 text-conf-high" aria-hidden /> : <EyeOff className="size-3.5" aria-hidden />}
                {t(`legend.status.${e.status}`)}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={`${t("sheets.edit")} — ${display}`}>
                <Pencil aria-hidden />
                {t("sheets.edit")}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => void confirm()} disabled={!cls} aria-label={t("legend.confirmRow", { label: display })}>
                <Check aria-hidden />
                {t("legend.confirm")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void ignore()} aria-label={t("legend.ignoreRow", { label: display })}>
                {t("legend.ignore")}
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}
