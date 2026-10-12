import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import type { Job, SheetSet } from "@/api/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Ltr } from "@/components/Ltr";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isActiveJob, useLiveJobs, useLiveSheetSets, useLiveSheets } from "@/features/realtime/hooks";

const KNOWN_STAGES = new Set(["split", "titleblock", "legend", "rooms", "links", "quantities"]);

/**
 * Live processing view (S09-lite): Firestore listeners on jobs (orgId == X, projectId == Y),
 * the project's sheetSets and sheets/{id}/versions/{currentVersionId}.
 */
export function ProcessingPanel({ orgId, projectId }: { orgId: string; projectId: string }) {
  const { t } = useTranslation();
  const jobs = useLiveJobs(orgId, projectId);
  const sets = useLiveSheetSets(orgId, projectId);
  const sheets = useLiveSheets(orgId, projectId);
  const liveError = jobs.error ?? sets.error ?? sheets.error;

  const activeJobs = (jobs.data ?? []).filter(isActiveJob);
  const failedJobs = (jobs.data ?? []).filter((j) => j.status === "failed");
  // job.versionId → sheet → sheetSet name, so each progress row says which file it is.
  const nameOf = (j: Job) => {
    const row = sheets.data?.find((r) => r.sheet.currentVersionId === j.versionId);
    const set = row && sets.data?.find((s) => s.id === row.sheet.sheetSetId);
    return set?.name ?? null;
  };

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
              <JobRow key={j.id} job={j} name={nameOf(j)} />
            ))}
          </section>
        ) : null}

        {sets.data && sets.data.length > 0 ? (
          <ul className="divide-y divide-border" aria-label={t("project.sheetSets")}>
            {sets.data.map((s) => (
              <SetRow key={s.id} set={s} />
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

function JobRow({ job, name }: { job: Job; name: string | null }) {
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
      ) : null}
    </div>
  );
}

function SetRow({ set }: { set: SheetSet }) {
  const { t } = useTranslation();
  const icon =
    set.status === "ready" ? (
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
        <bdi className="truncate text-foreground">{set.name ?? set.id}</bdi>
        <Ltr className="text-meta uppercase text-muted-foreground">{set.fileKind}</Ltr>
      </span>
      <span className="shrink-0 text-muted-foreground">
        {t(`project.setStatus.${set.status}`)} · <Ltr>{formatDate(set.createdAt)}</Ltr>
      </span>
    </li>
  );
}
