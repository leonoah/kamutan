import { useRef, useState, type DragEvent } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronLeft, FolderPlus, Plus } from "lucide-react";
import type { Project, ProjectStatus } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { EmptyState } from "@/components/EmptyState";
import { ConfidenceShape } from "@/components/ConfidenceBadge";
import { Ltr } from "@/components/Ltr";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { useProjects } from "./queries";

const statusDot: Record<ProjectStatus, string> = {
  draft: "bg-state-existing",
  uploading: "bg-primary",
  processing: "bg-primary",
  review: "bg-conf-mid",
  approved: "bg-conf-high",
};

export function ProjectsPage() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useProjects();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<File[] | undefined>();

  const openCreate = (files?: File[]) => {
    setPending(files);
    setOpen(true);
  };

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
        <ProjectsTable projects={data} />
      )}

      <CreateProjectDialog open={open} onOpenChange={setOpen} pendingFiles={pending} />
    </div>
  );
}

function ProjectsTable({ projects }: { projects: Project[] }) {
  const { t } = useTranslation();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <Table>
        <TableCaption>{t("projects.title")}</TableCaption>
        <TableHeader>
          <TableRow className="h-9">
            <TableHead scope="col" className="ps-5">{t("projects.columns.name")}</TableHead>
            <TableHead scope="col">{t("projects.columns.status")}</TableHead>
            <TableHead scope="col" className="w-44">{t("projects.columns.verified")}</TableHead>
            <TableHead scope="col" className="text-end">{t("projects.columns.sheets")}</TableHead>
            <TableHead scope="col">{t("projects.columns.updated")}</TableHead>
            <TableHead scope="col" className="pe-5 text-end">{t("projects.columns.next")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {projects.map((p) => (
            <TableRow key={p.id} className="h-16 hover:bg-surface-sunken/60">
              <TableCell className="ps-5">
                <Link to={`/projects/${p.id}`} className="font-medium text-foreground hover:text-primary hover:underline">
                  {p.name}
                </Link>
                {p.address ? <p className="mt-0.5 text-meta text-muted-foreground">{p.address}</p> : null}
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-2 text-dense text-foreground">
                  <span aria-hidden className={cn("size-2 rounded-full", statusDot[p.status])} />
                  {t(`projects.status.${p.status}`)}
                </span>
              </TableCell>
              <TableCell>
                {p.sheetsCount > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between gap-2 text-dense">
                      <Ltr className="font-medium text-foreground">{`${p.verifiedPct}%`}</Ltr>
                      {p.toReviewCount > 0 ? (
                        <span className="inline-flex items-center gap-1 text-meta text-muted-foreground">
                          <ConfidenceShape level="low" className="size-2.5" />
                          {t("projects.toReview", { count: p.toReviewCount })}
                        </span>
                      ) : null}
                    </div>
                    <Progress
                      value={p.verifiedPct}
                      aria-label={`${t("projects.columns.verified")}: ${p.verifiedPct}%`}
                      indicatorClassName="bg-conf-high"
                    />
                  </div>
                ) : (
                  <span className="text-meta text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-end text-dense text-foreground">
                <Ltr>{p.sheetsCount}</Ltr>
              </TableCell>
              <TableCell className="text-dense text-muted-foreground">
                <Ltr>{formatDate(p.updatedAt)}</Ltr>
              </TableCell>
              <TableCell className="pe-5 text-end">
                <Link
                  to={p.status === "review" || p.status === "approved" ? `/projects/${p.id}/review` : `/projects/${p.id}`}
                  className="inline-flex items-center gap-1 rounded text-dense font-medium text-primary hover:underline"
                >
                  {t(`projects.next.${p.status}`)}
                  {/* "next" chevrons point left in RTL */}
                  <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
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
    <div className="rounded-lg border border-border bg-surface p-5" role="status" aria-label={t("common.loading")}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 border-b border-border py-4 last:border-0">
          <div className="h-3 w-48 animate-pulse rounded bg-muted" />
          <div className="h-3 w-20 animate-pulse rounded bg-muted" />
          <div className="h-1.5 flex-1 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
