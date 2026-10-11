import { useCallback, useId, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileImage, FileText, FileX2, RotateCcw, UploadCloud, X, Check } from "lucide-react";
import { useApi } from "@/api/client";
import type { FileKind } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/toast";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";
import { formatBytes, formatDate } from "@/lib/format";
import { ACCEPT_ATTR } from "./validation";
import { useUploadStore, type UploadEntry } from "./uploadStore";

export function Dropzone({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const qc = useQueryClient();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const allEntries = useUploadStore((s) => s.entries);
  const entries = allEntries.filter((e) => e.projectId === projectId);
  const { addFiles, retry, remove, clearProject } = useUploadStore.getState();

  const valid = entries.filter((e) => e.status !== "rejected");
  const done = valid.filter((e) => e.status === "done");
  const inFlight = valid.some((e) => e.status === "uploading" || e.status === "queued");

  const onFiles = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      void addFiles(api, projectId, Array.from(list));
    },
    [addFiles, api, projectId],
  );

  const finish = useMutation({
    mutationFn: () =>
      api.createSheetSet(
        projectId,
        done.map((e) => e.uploadId!).filter(Boolean),
        t("upload.setName", { date: formatDate(new Date()) }),
      ),
    onSuccess: (set) => {
      toast({ title: t("upload.setCreated", { count: set.fileCount }), tone: "success" });
      clearProject(projectId);
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["sheet-sets", projectId] });
    },
    onError: () => toast({ title: t("upload.setError"), tone: "error" }),
  });

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
              <FileRow key={e.id} entry={e} onRemove={() => remove(e.id)} onRetry={() => retry(api, e.id)} />
            ))}
          </ul>
          <div className="flex justify-end border-t border-border px-4 py-3">
            <Button
              onClick={() => finish.mutate()}
              disabled={done.length === 0 || inFlight || finish.isPending}
            >
              {finish.isPending ? t("upload.finishing") : t("upload.finish")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const kindIcon = (kind: FileKind | null) =>
  kind === "png" ? FileImage : kind === null ? FileX2 : FileText;

function FileRow({ entry, onRemove, onRetry }: { entry: UploadEntry; onRemove: () => void; onRetry: () => void }) {
  const { t } = useTranslation();
  const Icon = kindIcon(entry.kind);
  const pct = entry.size > 0 ? Math.round((entry.loaded / entry.size) * 100) : 0;
  const failed = entry.status === "rejected" || entry.status === "error";

  const errorText = (() => {
    switch (entry.errorCode) {
      case "unsupported":
        return t("upload.errorUnsupported", { name: `⁨${entry.name}⁩` });
      case "too_large":
        return t("upload.errorTooLarge");
      case "empty":
        return t("upload.errorEmpty", { name: `⁨${entry.name}⁩` });
      case "mismatch":
        return t("upload.errorMismatch", { name: `⁨${entry.name}⁩` });
      case "duplicate":
        return t("upload.errorDuplicate", { name: `⁨${entry.name}⁩` });
      case "network":
        return t("upload.errorNetwork");
      default:
        return null;
    }
  })();

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
            {entry.status === "uploading" ? <Ltr>{` ${pct}%`}</Ltr> : null}
          </span>
        </div>
        {entry.status === "uploading" || entry.status === "queued" || entry.status === "done" ? (
          <Progress
            value={entry.status === "done" ? 100 : pct}
            aria-label={t("upload.progress", { name: entry.name })}
            indicatorClassName={entry.status === "done" ? "bg-conf-high" : undefined}
          />
        ) : null}
        {errorText ? (
          <p className="text-dense text-destructive" role="alert">
            {errorText}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {entry.status === "error" ? (
          <Button variant="ghost" size="icon-sm" onClick={onRetry} aria-label={t("upload.retry")} title={t("upload.retry")}>
            <RotateCcw aria-hidden />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label={t("upload.remove", { name: entry.name })}
          title={t("upload.remove", { name: entry.name })}
        >
          <X aria-hidden />
        </Button>
      </div>
    </li>
  );
}
