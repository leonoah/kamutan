import { useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Archive, ArchiveRestore, ChevronLeft, Ellipsis, FolderPlus, Layers, Pencil, Plus } from "lucide-react";
import type { Job, Project } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { EmptyState } from "@/components/EmptyState";
import { ConfidenceShape } from "@/components/ConfidenceBadge";
import { Ltr } from "@/components/Ltr";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { EditProjectDialog } from "./EditProjectDialog";
import { activeProgress, projectPhase, useProjects, useUpdateProject, verifiedPct, type ProjectPhase } from "./queries";
import { useOrgId } from "@/features/org/useCurrentOrg";
import { useLiveJobs } from "@/features/realtime/hooks";

const statusDot: Record<ProjectPhase, string> = {
  draft: "bg-state-existing",
  processing: "bg-primary",
  review: "bg-conf-mid",
  ready: "bg-conf-high",
  archived: "bg-state-existing",
};

export function ProjectsPage() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { data, isLoading, isError, refetch } = useProjects(orgId);
  // One org-wide listener: projects with running ingest jobs show live progress.
  const jobs = useLiveJobs(orgId).data;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<File[] | undefined>();
  const [editing, setEditing] = useState<Project | null>(null);

  const openCreate = (files?: File[]) => {
    setPending(files);
    setOpen(true);
  };

  // Keep the dialog's project fresh after a save (the list refetches and the object identity changes).
  const editingLive = useMemo(() => (editing ? data?.find((p) => p.id === editing.id) ?? editing : null), [editing, data]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-screen text-foreground">{t("projects.title")}</h1>
          {data && data.length > 0 ? (
            <p className="mt-1 text-dense text-muted-foreground">{t("projects.count", { count: data.length })}</p>
          ) : null}
        </div>
        <Button onClick={() => openCreate()}>
          <Plus aria-hidden />
          {t("projects.newProject")}
        </Button>
      </div>

      {isLoading ? (
        <ProjectsSkeleton />
      ) : isError ? (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/[0.05] p-6 text-body">
          <p className="text-foreground">{t("projects.loadError")}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => void refetch()}>
            {t("projects.retry")}
          </Button>
        </div>
      ) : !data || data.length === 0 ? (
        <EmptyDrop onFiles={(files) => openCreate(files)} onCreate={() => openCreate()} />
      ) : (
        <ProjectsGrid projects={data} jobs={jobs ?? []} onEdit={setEditing} />
      )}

      <CreateProjectDialog open={open} onOpenChange={setOpen} pendingFiles={pending} />
      <EditProjectDialog project={editingLive} open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} />
    </div>
  );
}

function ProjectsGrid({ projects, jobs, onEdit }: { projects: Project[]; jobs: Job[]; onEdit: (p: Project) => void }) {
  const { t } = useTranslation();
  const [showArchived, setShowArchived] = useState(false);
  const active = projects.filter((p) => p.status !== "archived");
  const archived = projects.filter((p) => p.status === "archived");
  const visible = showArchived ? [...active, ...archived] : active;

  return (
    <div className="flex flex-col gap-4">
      {archived.length > 0 ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
            <Archive aria-hidden />
            {t(showArchived ? "projects.hideArchived" : "projects.showArchived", { count: archived.length })}
          </Button>
        </div>
      ) : null}
      <ul aria-label={t("projects.title")} className="grid list-none grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4 p-0">
        {visible.map((p) => (
          <li key={p.id} className="min-w-0">
            <ProjectCard project={p} jobs={jobs} onEdit={() => onEdit(p)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProjectCard({ project: p, jobs, onEdit }: { project: Project; jobs: Job[]; onEdit: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateProject();
  const phase = projectPhase(p, jobs);
  const pct = verifiedPct(p);
  const live = activeProgress(p.id, jobs);
  const sheets = p.stats?.sheets ?? 0;
  const toReview = p.stats?.reviewOpen ?? 0;
  const isArchived = p.status === "archived";
  const href = `/projects/${p.id}`;

  async function toggleArchive() {
    try {
      const saved = await update.mutateAsync({ id: p.id, patch: { status: isArchived ? "active" : "archived" } });
      toast({ title: t(isArchived ? "editProject.restored" : "editProject.archived", { name: saved.name }), tone: "success" });
    } catch {
      toast({ title: t("editProject.errorGeneric"), tone: "error" });
    }
  }

  return (
    <article
      aria-labelledby={`project-${p.id}-name`}
      className={cn(
        // `relative` anchors the title link's ::after overlay, which makes the whole card clickable.
        "group relative flex h-full flex-col gap-4 rounded-lg border border-border bg-surface p-5 transition-colors",
        "hover:border-primary/40 hover:shadow-sm focus-within:border-primary/60",
        isArchived && "opacity-70 hover:opacity-100",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={`project-${p.id}-name`} className="truncate text-panel text-foreground">
            <Link
              to={href}
              className="rounded font-semibold outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] group-hover:text-primary focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2"
            >
              {p.name}
            </Link>
          </h2>
          <p className="mt-0.5 truncate text-meta text-muted-foreground">{p.address ?? " "}</p>
        </div>
        {/* Above the overlay (z-10); stop propagation so menu clicks never reach the card. */}
        <div className="relative z-10 -me-2 -mt-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t("projects.actions")} className="text-muted-foreground hover:text-foreground">
                <Ellipsis aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil aria-hidden />
                {t("projects.edit")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={update.isPending}
                onSelect={() => void toggleArchive()}
                className={isArchived ? undefined : "text-destructive data-[highlighted]:bg-destructive/[0.06]"}
              >
                {isArchived ? <ArchiveRestore aria-hidden /> : <Archive aria-hidden />}
                {t(isArchived ? "projects.restore" : "projects.archive")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-meta font-medium text-foreground",
            isArchived ? "border-dashed border-input bg-surface-sunken text-muted-foreground" : "border-border bg-surface-sunken",
          )}
        >
          <span aria-hidden className={cn("size-2 rounded-full", statusDot[phase], phase === "processing" && "animate-pulse")} />
          {live !== null ? t("projects.processingPct", { pct: live }) : t(`projects.status.${phase}`)}
        </span>
        {toReview > 0 && !isArchived ? (
          <span className="inline-flex items-center gap-1 text-meta text-muted-foreground">
            <ConfidenceShape level="low" className="size-2.5" />
            {t("projects.toReview", { count: toReview })}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 text-dense">
          <span className="text-muted-foreground">{t("projects.columns.verified")}</span>
          {pct !== null ? (
            <Ltr className="font-medium text-foreground">{`${pct}%`}</Ltr>
          ) : (
            <span className="text-meta text-muted-foreground" title={t("projects.noBoq")}>
              —
            </span>
          )}
        </div>
        <Progress
          value={pct ?? 0}
          aria-label={pct !== null ? `${t("projects.columns.verified")}: ${pct}%` : t("projects.noBoq")}
          indicatorClassName={pct !== null ? "bg-conf-high" : "bg-transparent"}
        />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-3 text-meta text-muted-foreground">
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="inline-flex items-center gap-1">
            <Layers className="size-3.5" aria-hidden />
            {t("projects.sheetsCount", { count: sheets })}
          </span>
          <span aria-hidden>·</span>
          <Ltr>{formatDate(p.createdAt)}</Ltr>
        </span>
        {/* Always the project hub — the hub decides where to continue. */}
        <Link to={href} className="relative z-10 inline-flex shrink-0 items-center gap-1 rounded text-dense font-medium text-primary hover:underline">
          {t(`projects.next.${phase}`)}
          {/* "next" chevrons point left in RTL */}
          <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
        </Link>
      </div>
    </article>
  );
}

function EmptyDrop({ onFiles, onCreate }: { onFiles: (f: File[]) => void; onCreate: () => void }) {
  const { t } = useTranslation();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return (
    <div
      data-testid="projects-empty"
      onDragEnter={(e: DragEvent) => {
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e: DragEvent) => e.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      }}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (e.dataTransfer.files.length) onFiles(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "paper-grid rounded-lg border-2 border-dashed transition-colors",
        over ? "border-primary bg-primary/5" : "border-input",
      )}
    >
      <EmptyState
        illustration={
          <span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <FolderPlus className="size-7" aria-hidden />
          </span>
        }
        title={t("projects.emptyTitle")}
        body={t("projects.emptyBody")}
        action={
          <Button onClick={onCreate}>
            <Plus aria-hidden />
            {t("projects.newProject")}
          </Button>
        }
      />
    </div>
  );
}

function ProjectsSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4" role="status" aria-label={t("common.loading")}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-6 w-24 animate-pulse rounded-full bg-muted" />
          <div className="h-1.5 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
