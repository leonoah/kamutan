import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CheckCheck, ChevronRight, PanelsTopLeft } from "lucide-react";
import type { SheetRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { useProject } from "@/features/projects/queries";
import { useLiveSheets } from "@/features/realtime/hooks";
import { draftOf, missingFields, toConfirmRequest, type SheetDraft } from "./model";
import { useConfirmSheets } from "./queries";
import { SheetCard } from "./SheetCard";
import { SheetToolsDialog, type SheetToolsMode } from "./SheetToolsDialog";

/**
 * S07 "אישור גיליונות" (05_ux flow 3): one card per sheet with discipline / floors / scale,
 * confidence + reasons, inline edit, per-sheet confirm and "אשר הכל"; multi-floor sheets get
 * "פיצול לקומות" (lasso regions in the viewer). Live per-version progress from the sheets listener.
 */
export function SheetsPage() {
  const { projectId = "" } = useParams();
  const { t } = useTranslation();
  const project = useProject(projectId);
  const sheets = useLiveSheets(project.data?.orgId ?? null, projectId);
  const confirm = useConfirmSheets(projectId);
  const [drafts, setDrafts] = useState<Record<string, SheetDraft>>({});
  const [tools, setTools] = useState<{ sheetId: string; mode: SheetToolsMode } | null>(null);

  const rows = useMemo(
    () =>
      [...(sheets.data ?? [])].sort(
        (a, b) => a.sheet.sheetSetId.localeCompare(b.sheet.sheetSetId) || (a.sheet.pageIndex ?? 0) - (b.sheet.pageIndex ?? 0),
      ),
    [sheets.data],
  );
  const ready = rows.filter((r) => r.version?.status === "ready");
  const draftFor = (r: SheetRow) => drafts[r.sheet.id] ?? draftOf(r);
  const isDirty = (r: SheetRow) => Boolean(drafts[r.sheet.id]);
  const confirmedCount = ready.filter((r) => r.sheet.confirmed && !isDirty(r)).length;
  const pending = ready.filter((r) => !r.sheet.confirmed || isDirty(r));
  const allComplete = pending.every((r) => missingFields(draftFor(r)).length === 0);

  const doConfirm = async (list: SheetRow[]) => {
    const n = await confirm.mutateAsync(list.map((r) => ({ sheetId: r.sheet.id, req: toConfirmRequest(draftFor(r)) })));
    setDrafts((d) => {
      const next = { ...d };
      for (const r of list) delete next[r.sheet.id];
      return next;
    });
    toast({ title: t("sheets.confirmedAll", { count: n }), tone: "success" });
  };

  const toolsRow = tools ? rows.find((r) => r.sheet.id === tools.sheetId) : undefined;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <nav aria-label={t("app.breadcrumbs")} className="mb-4">
        <Link to={`/projects/${projectId}`} className="inline-flex items-center gap-1 rounded text-dense text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
          {project.data?.name ?? t("project.back")}
        </Link>
      </nav>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-screen text-foreground">{t("sheets.title")}</h1>
          <p className="mt-1.5 text-dense text-muted-foreground">{t("sheets.subtitle")}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <Button variant="secondary" asChild>
              <Link to={`/projects/${projectId}/review`}>
                <PanelsTopLeft aria-hidden />
                {t("sheets.reviewLink")}
              </Link>
            </Button>
            <Button
              onClick={() => void doConfirm(pending)}
              disabled={pending.length === 0 || !allComplete || confirm.isPending}
              aria-describedby={!allComplete ? "confirm-all-locked" : undefined}
            >
              <CheckCheck aria-hidden />
              {t("sheets.confirmAll")}
            </Button>
          </div>
          {!allComplete ? (
            <p id="confirm-all-locked" className="text-meta text-muted-foreground">
              {t("sheets.confirmAllLocked")}
            </p>
          ) : null}
        </div>
      </div>

      {ready.length > 0 ? (
        <div className="mb-5 flex max-w-sm flex-col gap-1">
          <span className="text-meta text-muted-foreground" data-testid="confirm-progress">
            {t("sheets.progress", { confirmed: confirmedCount, total: ready.length })}
          </span>
          <Progress
            value={(confirmedCount / Math.max(1, ready.length)) * 100}
            aria-label={t("sheets.progress", { confirmed: confirmedCount, total: ready.length })}
            indicatorClassName="bg-conf-high"
          />
        </div>
      ) : null}

      {sheets.error ? (
        <p role="alert" className="mb-4 rounded border border-destructive/30 bg-destructive/[0.05] px-3 py-2 text-dense text-destructive">
          {t("project.liveError")}
        </p>
      ) : null}

      {rows.length === 0 ? (
        sheets.isLoading || project.isLoading ? (
          <p role="status" className="text-muted-foreground">
            {t("common.loading")}
          </p>
        ) : (
          <p className="text-body text-muted-foreground">
            {t("sheets.empty")}{" "}
            <Link to={`/projects/${projectId}`} className="text-primary hover:underline">
              {t("upload.title")}
            </Link>
          </p>
        )
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4" aria-label={t("sheets.title")}>
          {rows.map((r) => (
            <li key={r.sheet.id} className="flex">
              <SheetCard
                projectId={projectId}
                row={r}
                draft={draftFor(r)}
                dirty={isDirty(r)}
                busy={confirm.isPending}
                onChange={(d) => setDrafts((all) => ({ ...all, [r.sheet.id]: d }))}
                onConfirm={() => void doConfirm([r])}
                onSplit={() => setTools({ sheetId: r.sheet.id, mode: "split" })}
                onCalibrate={() => setTools({ sheetId: r.sheet.id, mode: "calibrate" })}
              />
            </li>
          ))}
        </ul>
      )}

      {tools && toolsRow ? (
        <SheetToolsDialog
          projectId={projectId}
          row={toolsRow}
          mode={tools.mode}
          draft={draftFor(toolsRow)}
          onClose={() => setTools(null)}
          onScale={(den) => setDrafts((all) => ({ ...all, [toolsRow.sheet.id]: { ...draftFor(toolsRow), scale: String(den) } }))}
        />
      ) : null}
    </div>
  );
}
