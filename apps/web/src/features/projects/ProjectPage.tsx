import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookOpenCheck, ChevronRight, ClipboardCheck, Layers, MapPin, Pencil, UploadCloud } from "lucide-react";
import type { SheetRow } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Dropzone } from "@/features/upload/Dropzone";
import { useLiveJobs, useLiveSheets, isActiveJob } from "@/features/realtime/hooks";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { cn } from "@/lib/utils";
import { useProject, projectPhase, verifiedPct, activeProgress } from "./queries";
import { ProcessingPanel } from "./ProcessingPanel";
import { SheetGallery, sheetState } from "./SheetGallery";
import { ProjectBoqSummary } from "./ProjectBoqSummary";
import { EditProjectDialog } from "./EditProjectDialog";

const phaseTone = {
  draft: "bg-state-existing/15 text-muted-foreground",
  processing: "bg-primary/10 text-primary",
  review: "bg-conf-mid/15 text-conf-mid",
  ready: "bg-conf-high/15 text-conf-high",
  archived: "bg-state-existing/15 text-muted-foreground",
} as const;

/**
 * Project hub (level 2 of the IA): header → setup strip → drawings gallery (start) + project BOQ (end).
 * Upload is a secondary action once the project has sheets; the sheet analysis screen is one level down.
 */
export function ProjectPage() {
  const { projectId = "" } = useParams();
  const { t } = useTranslation();
  const project = useProject(projectId);
  const { org } = useCurrentOrg();
  const orgId = project.data?.orgId ?? null;
  const sheets = useLiveSheets(orgId, projectId);
  const jobs = useLiveJobs(orgId, projectId);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [filterSheetId, setFilterSheetId] = useState<string | null>(null);
  // A project opened with no drawings keeps its inline dropzone for the whole visit, so an upload in progress
  // does not jump into a dialog the moment the first sheet appears.
  const [inlineUpload, setInlineUpload] = useState<boolean | null>(null);

  const rows = useMemo(
    () =>
      [...(sheets.data ?? [])].sort(
        (a, b) => a.sheet.sheetSetId.localeCompare(b.sheet.sheetSetId) || (a.sheet.pageIndex ?? 0) - (b.sheet.pageIndex ?? 0),
      ),
    [sheets.data],
  );
  const ready = rows.filter((r) => sheetState(r) === "ready");
  const toConfirm = rows.filter((r) => sheetState(r) === "toConfirm");
  const withLegend = rows.filter((r) => r.version?.status === "ready" && (Boolean(r.version.artifacts?.legend) || (r.version.stats?.legendEntries ?? 0) > 0));
  const activeJobs = (jobs.data ?? []).filter(isActiveJob);
  const hasActivity = activeJobs.length > 0 || (jobs.data ?? []).some((j) => j.status === "failed") || rows.some((r) => sheetState(r) === "processing" || sheetState(r) === "failed");
  const filterSheet: SheetRow | null = rows.find((r) => r.sheet.id === filterSheetId) ?? null;
  const loaded = Boolean(sheets.data) && Boolean(jobs.data);
  useEffect(() => {
    if (inlineUpload === null && loaded) setInlineUpload(rows.length === 0 && activeJobs.length === 0);
  }, [inlineUpload, loaded, rows.length, activeJobs.length]);

  if (project.isLoading) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-10 text-muted-foreground" role="status">
        {t("common.loading")}
      </div>
    );
  }
  if (project.isError || !project.data) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-10">
        <p role="alert" className="text-body text-foreground">
          {t("project.notFound")}
        </p>
        <Link to="/projects" className="mt-3 inline-block text-primary hover:underline">
          {t("project.back")}
        </Link>
      </div>
    );
  }

  const p = project.data;
  const phase = projectPhase(p, jobs.data ?? []);
  const live = activeProgress(p.id, jobs.data ?? []);
  const pct = verifiedPct(p);
  const empty = inlineUpload === true;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <nav aria-label={t("app.breadcrumbs")} className="mb-3">
        <Link to="/projects" className="inline-flex items-center gap-1 rounded text-dense text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
          {t("project.back")}
        </Link>
      </nav>

      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-screen text-foreground">{p.name}</h1>
            <span className={cn("rounded-full px-2 py-0.5 text-meta font-medium", phaseTone[phase])}>
              {live !== null ? t("projects.processingPct", { pct: live }) : t(`projects.status.${phase}`)}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-dense text-muted-foreground">
            {p.address ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" aria-hidden />
                {p.address}
              </span>
            ) : null}
            {rows.length ? (
              <span className="inline-flex items-center gap-1">
                <Layers className="size-3.5" aria-hidden />
                {t("projects.sheetsCount", { count: rows.length })}
              </span>
            ) : null}
            {pct !== null ? <span>{t("review.verifiedTotal", { pct })}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setEditOpen(true)}>
            <Pencil aria-hidden />
            {t("hub.edit")}
          </Button>
          {!empty ? (
            <Button variant="secondary" onClick={() => setUploadOpen(true)}>
              <UploadCloud aria-hidden />
              {t("hub.upload")}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Setup strip: what still blocks a full BOQ */}
      {toConfirm.length > 0 || withLegend.length > 0 ? (
        <ol className="mb-5 flex flex-wrap gap-2" aria-label={t("hub.setup")}>
          {toConfirm.length > 0 ? (
            <li className="flex flex-1 items-center gap-3 rounded-lg border border-conf-mid/40 bg-conf-mid/[0.06] px-3 py-2">
              <ClipboardCheck className="size-4 shrink-0 text-conf-mid" aria-hidden />
              <span className="flex-1 text-dense text-foreground">{t("project.confirmSheetsCta", { count: toConfirm.length })}</span>
              <Button size="sm" asChild>
                <Link to={`/projects/${p.id}/sheets`}>{t("project.confirmSheets")}</Link>
              </Button>
            </li>
          ) : null}
          {withLegend.length > 0 ? (
            <li className="flex flex-1 items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
              <BookOpenCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1 text-dense text-foreground">{t("legend.cta", { count: withLegend.length })}</span>
              <Button size="sm" variant="secondary" asChild>
                <Link to={`/projects/${p.id}/legend`}>{t("legend.title")}</Link>
              </Button>
            </li>
          ) : null}
        </ol>
      ) : null}

      {empty ? (
        <div className="mb-6">
          <h2 className="mb-2 text-panel text-foreground">{t("hub.uploadFirst")}</h2>
          <p className="mb-4 text-dense text-muted-foreground">{t("hub.uploadFirstBody")}</p>
          <Dropzone projectId={p.id} />
        </div>
      ) : null}
      {inlineUpload === null ? null : empty && rows.length === 0 ? (
        orgId ? <ProcessingPanel orgId={orgId} projectId={p.id} /> : null
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]">
          {/* Drawings (start side = right in RTL) */}
          <section aria-labelledby="hub-sheets-title" className="flex min-w-0 flex-col gap-3">
            <div className="flex items-end justify-between gap-3">
              <h2 id="hub-sheets-title" className="text-panel text-foreground">
                {t("hub.sheets")}
                {rows.length ? <span className="ms-2 text-dense font-normal text-muted-foreground">{rows.length}</span> : null}
              </h2>
              {filterSheet ? (
                <p className="text-meta text-muted-foreground">{t("hub.filterHint")}</p>
              ) : rows.length ? (
                <p className="text-meta text-muted-foreground">{t("hub.galleryHint")}</p>
              ) : null}
            </div>
            {rows.length === 0 ? (
              <p role="status" className="rounded-lg border border-dashed border-border p-6 text-center text-dense text-muted-foreground">
                {sheets.isLoading ? t("common.loading") : t("hub.sheetsIncoming")}
              </p>
            ) : (
              <SheetGallery projectId={p.id} rows={rows} selectedId={filterSheetId} onSelect={setFilterSheetId} />
            )}
            {orgId ? (
              <details open={hasActivity} className="group">
                <summary className="cursor-pointer list-none text-dense font-medium text-muted-foreground hover:text-foreground">
                  {t("hub.activity")}
                  {hasActivity ? <span className="ms-2 inline-block size-2 animate-pulse rounded-full bg-primary align-middle" aria-hidden /> : null}
                </summary>
                <ProcessingPanel orgId={orgId} projectId={p.id} />
              </details>
            ) : null}
          </section>

          {/* BOQ (end side = left in RTL) */}
          <div className="lg:sticky lg:top-[72px] lg:max-h-[calc(100dvh-88px)] lg:flex lg:flex-col">
            <ProjectBoqSummary
              orgId={orgId}
              projectId={p.id}
              canBuild={org?.role !== "viewer"}
              readySheets={ready.length}
              filterSheet={filterSheet}
              onClearFilter={() => setFilterSheetId(null)}
            />
          </div>
        </div>
      )}

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("hub.upload")}</DialogTitle>
            <DialogDescription>{t("hub.uploadBody")}</DialogDescription>
          </DialogHeader>
          <Dropzone projectId={p.id} />
        </DialogContent>
      </Dialog>

      <EditProjectDialog open={editOpen} onOpenChange={setEditOpen} project={p} />
    </div>
  );
}
