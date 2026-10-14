import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from "lucide-react";
import { useBackend } from "@/api/client";
import type { LibraryImport } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Ltr } from "@/components/Ltr";
import { cn } from "@/lib/utils";

const MAX_BYTES = 20 * 1024 * 1024;
type Phase = { kind: "pick"; error?: string } | { kind: "uploading"; pct: number; name: string } | { kind: "processing"; importId: string; name: string };

/**
 * Import a past BOQ (xls/xlsx): upload slot from the API → Storage upload (same quarantine path rules as drawings)
 * → start the `library.import` job → progress → result summary (items added, template created, ambiguous codes).
 */
export function ImportDialog({ orgId, open, onOpenChange }: { orgId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const { api, uploads } = useBackend();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (open) setPhase({ kind: "pick" });
  }, [open]);

  const importId = phase.kind === "processing" ? phase.importId : null;
  const status = useQuery({
    queryKey: ["library-import", orgId, importId],
    enabled: Boolean(importId),
    queryFn: () => api.getLibraryImport(orgId, importId!),
    refetchInterval: (q) => {
      const s = (q.state.data as LibraryImport | undefined)?.status;
      return s === "succeeded" || s === "failed" || s === "rejected" ? false : 400;
    },
  });
  const done = status.data?.status === "succeeded";
  useEffect(() => {
    if (done) {
      void qc.invalidateQueries({ queryKey: ["library-items", orgId] });
      void qc.invalidateQueries({ queryKey: ["boq-templates", orgId] });
    }
  }, [done, qc, orgId]);

  const start = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".xls") && !lower.endsWith(".xlsx")) return setPhase({ kind: "pick", error: t("library.importBadType") });
    if (file.size > MAX_BYTES) return setPhase({ kind: "pick", error: t("library.importTooBig") });
    try {
      setPhase({ kind: "uploading", pct: 0, name: file.name });
      const slot = await api.createLibraryImport(orgId, { filename: file.name, sizeBytes: file.size });
      const h = uploads.start(slot.storagePath, file, slot.contentType, (sent, total) =>
        setPhase({ kind: "uploading", pct: Math.round((sent / Math.max(total, 1)) * 100), name: file.name }),
      );
      await h.done;
      const im = await api.startLibraryImport(orgId, slot.importId, slot.uploadToken);
      setPhase({ kind: "processing", importId: im.id, name: file.name });
    } catch (e) {
      setPhase({ kind: "pick", error: t("library.importFailed", { message: (e as Error).message }) });
    }
  };

  const im = status.data;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("library.importTitle")}</DialogTitle>
          <DialogDescription>{t("library.importBody")}</DialogDescription>
        </DialogHeader>

        {phase.kind === "pick" ? (
          <div className="flex flex-col gap-3">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files[0];
                if (f) void start(f);
              }}
              className={cn(
                "flex flex-col items-center gap-3 rounded-md border-2 border-dashed px-6 py-8 text-center",
                drag ? "border-primary bg-primary/[0.05]" : "border-input",
              )}
            >
              <FileSpreadsheet className="size-9 text-primary" aria-hidden />
              <p className="text-body text-foreground">{t("library.importDrop")}</p>
              <Button variant="secondary" onClick={() => input.current?.click()}>
                <Upload aria-hidden />
                {t("library.importPick")}
              </Button>
              <input
                ref={input}
                type="file"
                accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                aria-label={t("library.importPick")}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void start(f);
                }}
              />
            </div>
            {phase.error ? (
              <p role="alert" className="text-dense text-destructive">{phase.error}</p>
            ) : null}
          </div>
        ) : phase.kind === "uploading" || !im || im.status === "queued" || im.status === "running" || im.status === "uploaded" ? (
          <div role="status" className="flex flex-col gap-2">
            <p className="flex items-center gap-2 text-body text-foreground">
              <FileSpreadsheet className="size-4 text-primary" aria-hidden />
              <bdi className="truncate">{phase.name}</bdi>
            </p>
            <Progress value={phase.kind === "uploading" ? phase.pct : (im?.progress ?? 0)} aria-label={phase.name} />
            <p className="text-meta text-muted-foreground">
              {phase.kind === "uploading" ? t("library.importUploading", { pct: phase.pct }) : t("library.importProcessing", { pct: im?.progress ?? 0 })}
            </p>
          </div>
        ) : im.status === "failed" || im.status === "rejected" ? (
          <p role="alert" className="flex items-start gap-2 text-body text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t("library.importFailed", { message: im.error?.message ?? "" })}
          </p>
        ) : im.result ? (
          <div role="status" className="flex flex-col gap-3 text-body">
            <p className="flex items-center gap-2 font-bold text-foreground">
              <CheckCircle2 className="size-5 text-conf-high" aria-hidden />
              {t("library.importDone")}
            </p>
            <ul className="flex flex-col gap-1 ps-7 text-foreground">
              <li>{t("library.importAdded", { count: im.result.itemsAdded })}</li>
              <li>{t("library.importUpdated", { count: im.result.itemsUpdated })}</li>
              <li>{im.result.templateCreated ? t("library.importTemplate", { name: im.result.templateCreated.name }) : t("library.importNoTemplate")}</li>
            </ul>
            {im.result.ambiguousCodes.length ? (
              <div className="rounded-md border border-conf-mid/40 bg-conf-mid/[0.08] p-3">
                <p className="mb-1.5 flex items-center gap-1.5 font-medium text-foreground">
                  <AlertTriangle className="size-4 text-conf-mid" aria-hidden />
                  {t("library.importAmbiguous", { count: im.result.ambiguousCodes.length })}
                </p>
                <ul className="flex flex-col gap-1.5 text-dense">
                  {im.result.ambiguousCodes.map((a) => (
                    <li key={a.code}>
                      <span className="font-mono">
                        <Ltr>{a.code}</Ltr>
                      </span>
                      : {a.descriptions.join(" / ")}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {im && (im.status === "succeeded" || im.status === "failed" || im.status === "rejected") ? (
            <Button variant="secondary" onClick={() => setPhase({ kind: "pick" })}>
              {t("library.importAnother")}
            </Button>
          ) : null}
          <Button variant={im?.status === "succeeded" ? "primary" : "secondary"} onClick={() => onOpenChange(false)}>
            {t("library.importClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
