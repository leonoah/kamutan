import { useTranslation } from "react-i18next";
import { AlertTriangle, Ban } from "lucide-react";
import type { InputQuality } from "@/api/types";
import { cn } from "@/lib/utils";
import { ReuploadButton } from "@/features/upload/ReuploadButton";
import { displayIssues, issueAction, issueTitle, type QualityFlag } from "./model";

/** Shape + word + colour (never colour alone): ▲-like triangle for "איכות ירודה", ⊘ for "לא נספר". */
export function QualityBadge({ status, className }: { status: QualityFlag; className?: string }) {
  const { t } = useTranslation();
  const Icon = status === "reject" ? Ban : AlertTriangle;
  return (
    <span
      data-quality-badge={status}
      title={t(`quality.badgeHint.${status}`)}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-meta font-medium",
        status === "reject" ? "bg-destructive/10 text-destructive" : "bg-conf-mid/15 text-foreground",
        className,
      )}
    >
      <Icon className={cn("size-3", status === "warn" && "text-conf-mid")} aria-hidden />
      {t(`quality.badge.${status}`)}
      <span className="sr-only">: {t(`quality.badgeHint.${status}`)}</span>
    </span>
  );
}

/** "רזולוציה נמוכה מדי (כ-30 dpi) — העלה את קובץ ה-PDF המקורי…" per issue. */
export function QualityIssueList({ quality, className, compact = false }: { quality: InputQuality; className?: string; compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <ul aria-label={t("quality.issuesLabel")} className={cn("flex flex-col gap-1", className)}>
      {displayIssues(quality).map((i) => (
        <li key={i.kind} data-quality-issue={i.kind} className="text-dense" title={i.detail}>
          <span className="font-medium text-foreground">{issueTitle(t, i, quality.effectiveDpi)}</span>
          {compact ? null : (
            <>
              <span aria-hidden className="text-muted-foreground"> — </span>
              <span className="sr-only">. {t("quality.whatToDo")}: </span>
              <span className="text-muted-foreground">{issueAction(t, i)}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Banner of a warn / reject sheet (sheet analysis header, processing panel): what is wrong, what it means for the counts,
 * and what to do (each issue's action + "העלה קובץ מקורי" for editors, which uploads a replacement of the set).
 */
export function QualityBanner({
  quality,
  projectId,
  sheetSetId,
  name,
  canUpload,
  className,
}: {
  quality: InputQuality;
  projectId: string;
  sheetSetId: string | null;
  name: string | null;
  canUpload: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  if (quality.status === "ok") return null;
  const reject = quality.status === "reject";
  const Icon = reject ? Ban : AlertTriangle;
  return (
    <div
      role="status"
      data-quality-banner={quality.status}
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 border-s-4 px-4 py-2.5",
        reject ? "border-destructive bg-destructive/[0.06]" : "border-conf-mid bg-conf-mid/[0.08]",
        className,
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", reject ? "text-destructive" : "text-conf-mid")} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-dense text-foreground">
          <strong className="font-semibold">{t(`quality.status.${quality.status}`)}.</strong>{" "}
          {reject ? t("quality.rejectBanner") : t("quality.warnBanner")}
        </p>
        <QualityIssueList quality={quality} />
      </div>
      {canUpload && sheetSetId ? (
        <ReuploadButton
          projectId={projectId}
          sheetSetId={sheetSetId}
          name={name}
          label={t("quality.reuploadOriginal")}
          {...(name ? { labelFor: t("quality.reuploadOriginalFor", { name }) } : {})}
        />
      ) : null}
    </div>
  );
}
