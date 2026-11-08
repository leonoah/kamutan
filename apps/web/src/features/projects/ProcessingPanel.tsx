import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { isSupersededSet, type Job, type SheetRow, type SheetSet } from "@/api/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Ltr } from "@/components/Ltr";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isActiveJob, useLiveJobs, useLiveSheetSets, useLiveSheets } from "@/features/realtime/hooks";
import { ReuploadButton } from "@/features/upload/ReuploadButton";
import { Link } from "react-router-dom";
import { qualityFlag, qualityOf } from "@/features/quality/model";
import { QualityBadge, QualityIssueList } from "@/features/quality/QualityNotice";

const KNOWN_STAGES = new Set([
  "ingest",
  "render",
  "ocr",
  "classify",
  "scale",
  "done",
  "split",
  "titleblock",
  "legend",
  "detect",
  "rooms",
  "links",
  "quantities",
]);

/**
 * Live processing view (S09-lite): Firestore listeners on jobs (orgId == X, projectId == Y),
 * the project's sheetSets and sheets/{id}/versions/{currentVersionId}.
 */
export function ProcessingPanel({
  orgId,
  projectId,
  onDeleteSet,
  canUpload = false,
}: {
  orgId: string;
  projectId: string;
  onDeleteSet?: ((setId: string) => void) | undefined;
  /** Sprint 9: editors may upload the original file for a low-quality sheet. */
  canUpload?: boolean;
}) {
  const { t } = useTranslation();
  const jobs = useLiveJobs(orgId, projectId);
  const sets = useLiveSheetSets(orgId, projectId);
  const sheets = useLiveSheets(orgId, projectId);
  const liveError = jobs.error ?? sets.error ?? sheets.error;

  const activeJobs = (jobs.data ?? []).filter(isActiveJob);
  // A failed job whose set was replaced (re-upload / revision) is history, not a problem to show.
  const supersededSets = new Set((sets.data ?? []).filter(isSupersededSet).map((x) => x.id));
  const failedJobs = (jobs.data ?? []).filter((j) => j.status === "failed" && !(j.sheetSetId && supersededSets.has(j.sheetSetId)));
  // job.versionId → sheet → sheetSet name, so each progress row says which file it is.
  const nameOf = (j: Job) => {
    // Sprint 1 jobs carry sheetSetId; version ids are only unique per sheet, so that lookup is a fallback.
    const setId = j.sheetSetId ?? sheets.data?.find((r) => r.sheet.currentVersionId === j.versionId)?.sheet.sheetSetId;
    return sets.data?.find((s) => s.id === setId)?.name ?? null;
  };
  // Per-sheet (per-version) stages: everything not yet ready, plus failures with a Hebrew reason.
  const sheetRows = (sheets.data ?? []).filter((r) => r.version && r.version.status !== "ready");
  const setOf = (r: SheetRow) => sets.data?.find((s) => s.id === r.sheet.sheetSetId);
  // Sprint 9: ready sheets whose raster input failed / weakly passed the quality gate.
  const qualityRows = (sheets.data ?? []).filter((r) => r.version?.status === "ready" && qualityFlag(r.version) !== null);

  return (
    <Card className="mt-8">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{t("project.sheetSets")}</CardTitle>
        {sheets.data && sheets.data.length > 0 ? (
          <span className="text-meta text-muted-foreground">
            {t("projects.sheetsCount", { count: sheets.data.length })} ·{" "}
            {t("project.versionStatus.ready")}: <Ltr>{sheets.data.filter((r) => r.version?.status === "ready").length}</Ltr>
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {liveError ? (
          <p role="alert" className="rounded border border-destructive/30 bg-destructive/[0.05] px-3 py-2 text-dense text-destructive">
            {t("project.liveError")}
          </p>
        ) : null}

        {activeJobs.length + failedJobs.length > 0 ? (
          <section aria-label={t("project.processing")} className="flex flex-col gap-3">
            {[...activeJobs, ...failedJobs].map((j) => (
              <JobRow key={j.id} job={j} name={nameOf(j)} projectId={projectId} />
            ))}
          </section>
        ) : null}

        {sheetRows.length > 0 ? (
          <section aria-label={t("project.sheetsProgress")} className="flex flex-col gap-2">
            <h3 className="text-dense font-medium text-muted-foreground">{t("project.sheetsProgress")}</h3>
            <ul className="flex flex-col gap-2">
              {sheetRows.map((r) => (
                <SheetProgressRow key={r.sheet.id} row={r} setName={setOf(r)?.name ?? null} />
              ))}
            </ul>
          </section>
        ) : null}

        {qualityRows.length > 0 ? (
          <section aria-labelledby={`quality-${projectId}`} className="flex flex-col gap-2" data-quality-section>
            <h3 id={`quality-${projectId}`} className="text-dense font-medium text-muted-foreground">
              {t("quality.panelTitle")} · <span className="font-normal">{t("quality.panelSummary", { count: qualityRows.length })}</span>
            </h3>
            <ul className="flex flex-col gap-2">
              {qualityRows.map((r) => (
                <QualityRow key={r.sheet.id} row={r} projectId={projectId} setName={setOf(r)?.name ?? null} canUpload={canUpload} />
              ))}
            </ul>
          </section>
        ) : null}

        {sets.data && sets.data.length > 0 ? (
          <ul className="divide-y divide-border" aria-label={t("project.sheetSets")}>
            {sets.data.map((s) => (
              <SetRow key={s.id} set={s} replacesName={s.replacesSheetSetId ? (sets.data?.find((x) => x.id === s.replacesSheetSetId)?.name ?? null) : null} onDelete={onDeleteSet} />
            ))}
          </ul>
        ) : sets.isLoading ? (
          <p className="text-dense text-muted-foreground" role="status">
            {t("common.loading")}
          </p>
        ) : (
          <p className="text-dense text-muted-foreground">{t("project.noSets")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function JobRow({ job, name, projectId }: { job: Job; name: string | null; projectId: string }) {
  const { t } = useTranslation();
  const failed = job.status === "failed";
  const stage = job.stage && KNOWN_STAGES.has(job.stage) ? t(`project.stage.${job.stage}`) : t(`project.jobStatus.${job.status}`);
  return (
    <div className="flex flex-col gap-1.5" data-job={job.id} data-status={job.status}>
      <div className="flex items-center justify-between gap-3 text-dense">
        <span className={cn("inline-flex items-center gap-2", failed ? "text-destructive" : "text-foreground")}>
          {failed ? (
            <AlertCircle className="size-4" aria-hidden />
          ) : (
            <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
          )}
          {name ? <bdi className="font-medium">{name}</bdi> : null}
          <span className={name ? "text-muted-foreground" : undefined}>{failed ? t("project.jobStatus.failed") : stage}</span>
        </span>
        {!failed ? <Ltr className="text-meta text-muted-foreground">{`${Math.round(job.progress)}%`}</Ltr> : null}
      </div>
      {!failed ? (
        <Progress value={job.progress} aria-label={`${t("project.processing")}: ${stage}`} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 ps-6">
          {job.error ? (
            <p role="alert" className="flex-1 text-meta text-destructive">
              {t(`project.errors.${job.error.code}`, { defaultValue: t("project.errors.internal") })}
            </p>
          ) : null}
          {/* A-UI-05 / E2E-14: the fix for a damaged file is to upload it again (as a replacement of this set). */}
          <ReuploadButton projectId={projectId} sheetSetId={job.sheetSetId ?? null} name={name} />
        </div>
      )}
    </div>
  );
}

function SetRow({ set, replacesName, onDelete }: { set: SheetSet; replacesName: string | null; onDelete?: ((setId: string) => void) | undefined }) {
  const { t } = useTranslation();
  const superseded = isSupersededSet(set);
  const icon = superseded ? (
    <CheckCircle2 className="size-4 text-muted-foreground" aria-hidden />
  ) : set.status === "ready" ? (
      <CheckCircle2 className="size-4 text-conf-high" aria-hidden />
    ) : set.status === "failed" ? (
      <AlertCircle className="size-4 text-destructive" aria-hidden />
    ) : (
      <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
    );
  return (
    <li className="flex items-center justify-between gap-3 py-2.5 text-dense" data-set-status={set.status}>
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <bdi className={cn("truncate", superseded ? "text-muted-foreground line-through" : "text-foreground")}>{set.name ?? set.id}</bdi>
        <Ltr className="text-meta uppercase text-muted-foreground">{set.fileKind}</Ltr>
        {replacesName ? (
          <span className="truncate text-meta text-muted-foreground" data-replaces>
            · {t("project.setReplaces", { name: replacesName })}
          </span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        {t(`project.setStatus.${superseded ? "superseded" : set.status}`, { defaultValue: set.status })} · <Ltr>{formatDate(set.createdAt)}</Ltr>
        {onDelete ? (
          <button
            type="button"
            data-delete-set={set.id}
            onClick={() => onDelete(set.id)}
            aria-label={t("deletes.deleteSetFor", { name: set.name ?? set.id })}
            title={t("deletes.deleteSet")}
            className="ms-1 inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-4" aria-hidden />
          </button>
        ) : null}
      </span>
    </li>
  );
}

function SheetProgressRow({ row, setName }: { row: SheetRow; setName: string | null }) {
  const { t } = useTranslation();
  const v = row.version!;
  const failed = v.status === "failed";
  const stage = v.progress?.stage;
  const pct = v.progress?.pct ?? 0;
  const page = t("project.pageN", { n: (row.sheet.pageIndex ?? 0) + 1 });
  const name = row.sheet.title ?? (setName ? `${setName} · ${page}` : page);
  const stageText = stage && KNOWN_STAGES.has(stage) ? t(`project.stage.${stage}`) : t(`project.versionStatus.${v.status}`);
  const errCode = v.error?.code ?? "internal";
  return (
    <li className="flex flex-col gap-1.5" data-sheet-progress={row.sheet.id} data-status={v.status} data-stage={stage}>
      <div className="flex items-center justify-between gap-3 text-dense">
        <span className={cn("inline-flex min-w-0 items-center gap-2", failed ? "text-destructive" : "text-foreground")}>
          {failed ? (
            <AlertCircle className="size-4 shrink-0" aria-hidden />
          ) : (
            <Loader2 className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
          )}
          <bdi className="truncate font-medium">{name}</bdi>
          {!failed ? <span className="text-muted-foreground">{stageText}</span> : null}
        </span>
        {!failed ? <Ltr className="text-meta text-muted-foreground">{`${Math.round(pct)}%`}</Ltr> : null}
      </div>
      {failed ? (
        <p role="alert" className="ps-6 text-meta text-destructive">
          {t(`project.errors.${errCode}`, { defaultValue: t("project.errors.internal") })}
        </p>
      ) : (
        <Progress value={pct} aria-label={t("project.sheetProgressLabel", { name, stage: stageText })} />
      )}
    </li>
  );
}

/** Sprint 9: one sheet with a quality notice — badge, issues with what to do, open the sheet, upload the original. */
function QualityRow({ row, projectId, setName, canUpload }: { row: SheetRow; projectId: string; setName: string | null; canUpload: boolean }) {
  const { t } = useTranslation();
  const q = qualityOf(row.version)!;
  const flag = q.status === "reject" ? "reject" : "warn";
  const page = t("project.pageN", { n: (row.sheet.pageIndex ?? 0) + 1 });
  const name = row.sheet.title ?? (setName ? `${setName} · ${page}` : page);
  return (
    <li
      data-quality-row={row.sheet.id}
      data-quality={flag}
      className={cn("flex flex-col gap-1.5 rounded-md border-s-4 px-3 py-2", flag === "reject" ? "border-destructive bg-destructive/[0.04]" : "border-conf-mid bg-conf-mid/[0.06]")}
    >
      <div className="flex flex-wrap items-center gap-2 text-dense">
        <QualityBadge status={flag} />
        <Link to={`/projects/${projectId}/sheets/${row.sheet.id}`} className="min-w-0 truncate font-medium text-foreground hover:text-primary hover:underline">
          <bdi>{name}</bdi>
        </Link>
        <span className="text-meta text-muted-foreground">{t(`quality.status.${flag}`)}</span>
      </div>
      <QualityIssueList quality={q} className="ps-1" />
      {canUpload ? (
        <div className="flex justify-end">
          <ReuploadButton
            projectId={projectId}
            sheetSetId={row.sheet.sheetSetId}
            name={setName ?? name}
            label={t("quality.reuploadOriginal")}
            labelFor={t("quality.reuploadOriginalFor", { name: setName ?? name })}
          />
        </div>
      ) : null}
    </li>
  );
}
