import { useCallback, useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, Check, FileImage, FileText, FileX2, Pause, Play, RotateCcw, UploadCloud, X } from "lucide-react";
import { useBackend } from "@/api/client";
import type { Backend, FileKind } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { ACCEPT_ATTR } from "./validation";
import { useUploadStore, type UploadEntry } from "./uploadStore";

export function Dropzone({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const backend = useBackend();
  const qc = useQueryClient();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const allEntries = useUploadStore((s) => s.entries);
  const entries = allEntries.filter((e) => e.projectId === projectId);
  const { addFiles, clearFinished } = useUploadStore.getState();

  const valid = entries.filter((e) => e.status !== "rejected" && e.status !== "canceled");
  const done = valid.filter((e) => e.status === "done");
  const inFlight = valid.some((e) => !["done", "error"].includes(e.status));

  // Announce each finished file once and refresh project stats.
  const announced = useRef(new Set<string>());
  useEffect(() => {
    for (const e of done) {
      if (announced.current.has(e.id)) continue;
      announced.current.add(e.id);
      toast({ title: t("upload.processingStarted", { name: `\u2068${e.name}\u2069` }), tone: "success" });
      void qc.invalidateQueries({ queryKey: ["projects"] });
    }
  }, [done, qc, t]);

  const onFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      void addFiles(backend, projectId, Array.from(list));
    },
    [addFiles, backend, projectId],
  );

  const dragHandlers = {
    onDragEnter: (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      onFiles(e.dataTransfer.files);
    },
  };

  return (
    <section aria-labelledby={`${inputId}-title`} className="flex flex-col gap-4">
      <div
        data-testid="dropzone"
        data-dragging={dragging || undefined}
        {...dragHandlers}
        className={cn(
          "paper-grid relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-input",
        )}
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UploadCloud className="size-6" aria-hidden />
        </span>
        <h2 id={`${inputId}-title`} className="text-panel font-bold text-foreground">
          {dragging ? t("upload.dropActive") : t("upload.dropTitle")}
        </h2>
        <p className="text-dense text-muted-foreground">
          <Ltr>PDF · DWG · DXF · PNG</Ltr>
          {" · "}
          {t("upload.accepts")}
        </p>
        <div className="flex items-center gap-3 text-dense text-muted-foreground">
          <span aria-hidden className="h-px w-8 bg-border" />
          {t("upload.dropOr")}
          <span aria-hidden className="h-px w-8 bg-border" />
        </div>
        <Button variant="secondary" onClick={() => inputRef.current?.click()}>
          {t("upload.browse")}
        </Button>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="sr-only"
          tabIndex={-1}
          aria-label={t("upload.browse")}
          data-testid="file-input"
          onChange={(e) => {
            onFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {entries.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <h3 className="text-dense font-medium text-foreground">{t("upload.listLabel")}</h3>
            <p className="text-meta text-muted-foreground" aria-live="polite">
              {t("upload.summary", { done: done.length, total: valid.length })}
              {inFlight ? ` · ${t("upload.background")}` : null}
            </p>
          </div>
          <ul className="divide-y divide-border" aria-label={t("upload.listLabel")}>
            {entries.map((e) => (
              <FileRow key={e.id} entry={e} backend={backend} />
            ))}
          </ul>
          {!inFlight && entries.length > 0 ? (
            <div className="flex justify-end border-t border-border px-4 py-2">
              <Button variant="ghost" size="sm" onClick={() => clearFinished(projectId)}>
                {t("upload.clearFinished")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const kindIcon = (kind: FileKind | null) =>
  kind === "png" ? FileImage : kind === null ? FileX2 : FileText;

function FileRow({ entry, backend }: { entry: UploadEntry; backend: Backend }) {
  const { t } = useTranslation();
  const { pause, resume, cancel, retry, remove } = useUploadStore.getState();
  const Icon = kindIcon(entry.kind);
  const pct = entry.size > 0 ? Math.floor((entry.loaded / entry.size) * 100) : 0;
  const failed = entry.status === "rejected" || entry.status === "error";
  const iso = `\u2068${entry.name}\u2069`;
  const showBar = ["queued", "preparing", "uploading", "paused", "finalizing", "done"].includes(entry.status);
  const cancellable = ["queued", "preparing", "uploading", "paused"].includes(entry.status);

  const errorText = (() => {
    switch (entry.errorCode) {
      case "unsupported":
        return t("upload.errorUnsupported", { name: iso });
      case "too_large":
        return t("upload.errorTooLarge");
      case "empty":
        return t("upload.errorEmpty", { name: iso });
      case "mismatch":
        return t("upload.errorMismatch", { name: iso });
      case "duplicate":
        return t("upload.errorDuplicate", { name: iso });
      case "network":
        return t("upload.errorNetwork");
      case "expired":
        return t("upload.errorExpired");
      case "server":
        return t("upload.errorServer");
      default:
        return null;
    }
  })();

  const iconBtn = (label: string, onClick: () => void, icon: ReactNode) => (
    <Button variant="ghost" size="icon-sm" onClick={onClick} aria-label={label} title={label}>
      {icon}
    </Button>
  );

  return (
    <li className="flex items-start gap-3 px-4 py-3" data-status={entry.status}>
      <Icon
        className={cn("mt-0.5 size-5 shrink-0", failed ? "text-destructive" : "text-muted-foreground")}
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <bdi className="truncate text-body font-medium text-foreground">{entry.name}</bdi>
          <Ltr className="text-meta text-muted-foreground">{formatBytes(entry.size)}</Ltr>
          {entry.kind === "png" ? (
            <Badge variant="warning">
              <AlertTriangle className="size-3 text-conf-mid" aria-hidden />
              {t("upload.rasterWarning")}
            </Badge>
          ) : null}
          <span
            className={cn(
              "ms-auto inline-flex items-center gap-1 text-meta",
              entry.status === "done" ? "text-conf-high" : failed ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {entry.status === "done" ? <Check className="size-3.5" aria-hidden /> : null}
            {t(`upload.status.${entry.status}`)}
            {entry.status === "uploading" || entry.status === "paused" ? <Ltr>{` ${pct}%`}</Ltr> : null}
          </span>
        </div>
        {showBar ? (
          <Progress
            value={entry.status === "done" || entry.status === "finalizing" ? 100 : pct}
            aria-label={t("upload.progress", { name: entry.name })}
            indicatorClassName={cn(
              entry.status === "done" && "bg-conf-high",
              entry.status === "paused" && "bg-state-existing",
            )}
          />
        ) : null}
        {entry.result?.deduplicated ? (
          <p className="text-meta text-muted-foreground">{t("upload.deduplicated")}</p>
        ) : null}
        {errorText ? (
          <p className="text-dense text-destructive" role="alert">
            {errorText}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {entry.status === "uploading"
          ? iconBtn(t("upload.pause", { name: entry.name }), () => pause(entry.id), <Pause aria-hidden />)
          : null}
        {entry.status === "paused"
          ? iconBtn(t("upload.resume", { name: entry.name }), () => resume(entry.id), <Play aria-hidden />)
          : null}
        {entry.status === "error" || entry.status === "canceled"
          ? iconBtn(t("upload.retry"), () => retry(backend, entry.id), <RotateCcw aria-hidden />)
          : null}
        {cancellable
          ? iconBtn(t("upload.cancel", { name: entry.name }), () => cancel(entry.id), <Ban aria-hidden />)
          : entry.status !== "finalizing"
            ? iconBtn(t("upload.remove", { name: entry.name }), () => remove(entry.id), <X aria-hidden />)
            : null}
      </div>
    </li>
  );
}
