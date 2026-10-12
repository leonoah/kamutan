import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight, Layers, MapPin, PanelsTopLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dropzone } from "@/features/upload/Dropzone";
import { useProject, projectPhase } from "./queries";
import { ProcessingPanel } from "./ProcessingPanel";

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const { t } = useTranslation();
  const project = useProject(projectId);

  if (project.isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10 text-muted-foreground" role="status">
        {t("common.loading")}
      </div>
    );
  }
  if (project.isError || !project.data) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
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
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <nav aria-label={t("app.breadcrumbs")} className="mb-4">
        <Link to="/projects" className="inline-flex items-center gap-1 rounded text-dense text-muted-foreground hover:text-foreground">
          {/* "back" points right in RTL */}
          <ChevronRight className="size-4 ltr:rotate-180" aria-hidden />
          {t("project.back")}
        </Link>
      </nav>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-screen text-foreground">{p.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-dense text-muted-foreground">
            {p.address ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" aria-hidden />
                {p.address}
              </span>
            ) : null}
            <span>{t(`projects.status.${projectPhase(p)}`)}</span>
            {p.stats && p.stats.sheets > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Layers className="size-3.5" aria-hidden />
                {t("projects.sheetsCount", { count: p.stats.sheets })}
              </span>
            ) : null}
          </div>
        </div>
        <Button variant="secondary" asChild>
          <Link to={`/projects/${p.id}/review`}>
            <PanelsTopLeft aria-hidden />
            {t("project.openReview")}
          </Link>
        </Button>
      </div>

      <h2 className="sr-only">{t("upload.title")}</h2>
      <Dropzone projectId={p.id} />

      <ProcessingPanel orgId={p.orgId} projectId={p.id} />
    </div>
  );
}
