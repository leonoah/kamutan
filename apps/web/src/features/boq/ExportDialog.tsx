import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useInRouterContext } from "react-router-dom";
import { AlertTriangle, Ban, Download, Eye, FileSpreadsheet, FileText } from "lucide-react";
import { ApiError, EXPORT_ERROR_MESSAGES_HE, EXPORT_SHEETS_OMITTED_HE, type BoqLine, type BoqTemplate, type SheetRow, needsReapproval } from "@/api/types";
import { Progress } from "@/components/ui/progress";
import { sheetName } from "@/features/sheets/model";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import { useExportBoq, useExportDoc, useExportMarkedPdf } from "./queries";

/**
 * S12 export: summed / by floor, template choice; when non-green lines remain, the spec's warning copy
 * ("יש פריטים שלא נבדקו" … [חזרה לבדיקה (מומלץ)] [ייצא בכל זאת] + the draft-note checkbox); when the org blocks
 * export with "לבדיקה" lines, a blocked state with [עבור לפריטים]. Download = the signed URL (mock: a toast).
 */
export function ExportDialog({
  projectId,
  open,
  onOpenChange,
  lines,
  templates,
  blockOnRed,
  built,
  onGoToItems,
  sheets = [],
  canMarkedPdf = false,
  pollMs,
  initialSplit = "summed",
  showPreviewLink = true,
  previewOptions,
}: {
  /** Sprint 7: the preview's other options, sent with the Excel export (contracts ExportBoqRequest). */
  previewOptions?: { includeConfidence: boolean; chapters: string[] | null };
  /** Sprint 7: the split chosen on the preview screen. */
  initialSplit?: "summed" | "byFloor";
  /** Sprint 7: "תצוגה מקדימה" link (off when the dialog is opened from the preview itself). */
  showPreviewLink?: boolean;
  /** Sprint 5: ready sheets (marked-PDF subset picker). */
  sheets?: readonly SheetRow[];
  /** Sprint 5: editor+ may export the marked PDF. */
  canMarkedPdf?: boolean;
  pollMs?: number;
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lines: readonly BoqLine[];
  templates: readonly BoqTemplate[];
  blockOnRed: boolean;
  built: boolean;
  onGoToItems: () => void;
}) {
  const { t } = useTranslation();
  const exp = useExportBoq(projectId);
  const inRouter = useInRouterContext();
  const tplId = useId();
  const draftId = useId();
  const [templateId, setTemplateId] = useState<string>("");
  const [split, setSplit] = useState<"summed" | "byFloor">("summed");
  const [draftNote, setDraftNote] = useState(true);
  const [serverBlocked, setServerBlocked] = useState<number | null>(null);
  const [format, setFormat] = useState<"xlsx" | "pdf">("xlsx");

  useEffect(() => {
    if (!open) return;
    setServerBlocked(null);
    setSplit(initialSplit);
    setTemplateId((cur) => cur || (templates.find((x) => x.default)?.id ?? templates[0]?.id ?? ""));
  }, [open, templates, initialSplit]);

  // Stage 10 (contracts exportBlockingLines): an approved line whose qty changed since approval blocks like a red one.
  const red = lines.filter((l) => needsReapproval(l) || (l.level === "red" && l.status !== "approved")).length;
  const yellow = lines.filter((l) => l.level === "yellow" && l.status !== "approved").length;
  const blocked = (blockOnRed && red > 0) || serverBlocked !== null;
  const warn = red + yellow > 0;

  const run = async () => {
    try {
      const res = await exp.mutateAsync({
        templateId: templateId || null,
        split,
        draftNote: warn && draftNote,
        ...(previewOptions ? { includeConfidence: previewOptions.includeConfidence } : {}),
        ...(previewOptions?.chapters?.length ? { chapters: previewOptions.chapters } : {}),
      });
      onOpenChange(false);
      if (env.useMocks || res.url.startsWith("mock:")) {
        toast({ title: t("boq.export.mockDone", { name: res.filename }) });
        return;
      }
      toast({ title: t("boq.export.done", { name: res.filename }), tone: "success" });
      const a = document.createElement("a");
      a.href = res.url;
      a.download = res.filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === "export_blocked") setServerBlocked(red);
      else toast({ title: t("boq.export.error"), tone: "error" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{format === "pdf" ? t("markedPdf.title") : t("boq.export.title")}</DialogTitle>
          <DialogDescription>{format === "pdf" ? t("markedPdf.description") : t("boq.export.description")}</DialogDescription>
        </DialogHeader>

        <div role="radiogroup" aria-label={t("markedPdf.format")} className="mb-4 inline-flex self-start rounded-md border border-input p-0.5">
          {(
            [
              { v: "xlsx", label: t("markedPdf.formatXlsx"), Icon: FileSpreadsheet },
              { v: "pdf", label: t("markedPdf.formatPdf"), Icon: FileText },
            ] as const
          ).map(({ v, label, Icon }) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={format === v}
              onClick={() => setFormat(v)}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-[5px] px-3 text-dense font-medium",
                format === v ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          ))}
        </div>

        {format === "pdf" ? (
          <MarkedPdfExport
            projectId={projectId}
            sheets={sheets}
            built={built}
            blocked={blockOnRed && red > 0}
            red={red}
            canExport={canMarkedPdf}
            onGoToItems={() => {
              onOpenChange(false);
              onGoToItems();
            }}
            open={open}
            {...(pollMs !== undefined ? { pollMs } : {})}
          />
        ) : (
        <>
        {!built ? (
          <p role="alert" className="text-body text-foreground">{t("boq.export.notBuilt")}</p>
        ) : blocked ? (
          <div role="alert" className="flex gap-3 rounded-md border border-conf-low/40 bg-conf-low/[0.07] p-4">
            <Ban className="mt-0.5 size-5 shrink-0 text-conf-low" aria-hidden />
            <div className="flex flex-col gap-1 text-body">
              <p className="font-bold text-foreground">{t("boq.export.blockedTitle")}</p>
              <p className="text-foreground">{t("boq.export.blockedBody", { count: serverBlocked ?? red })}</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 text-body">
              <label htmlFor={tplId} className="text-muted-foreground">{t("boq.export.template")}</label>
              <select
                id={tplId}
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                className="h-9 rounded border border-input bg-surface px-2 text-foreground"
              >
                {templates.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
              <span id={`${tplId}-split`} className="text-muted-foreground">{t("boq.export.split")}</span>
              <div role="radiogroup" aria-labelledby={`${tplId}-split`} className="flex gap-4">
                {(["summed", "byFloor"] as const).map((v) => (
                  <label key={v} className="inline-flex cursor-pointer items-center gap-1.5 text-foreground">
                    <input
                      type="radio"
                      name="split"
                      value={v}
                      checked={split === v}
                      onChange={() => setSplit(v)}
                      className="size-4 accent-[rgb(var(--primary))]"
                    />
                    {v === "summed" ? t("boq.export.splitSummed") : t("boq.export.splitByFloor")}
                  </label>
                ))}
              </div>
            </div>
            {showPreviewLink && inRouter ? (
              <p className="flex flex-wrap items-center gap-x-2 text-dense">
                <Link
                  to={`/projects/${projectId}/boq/preview${split === "byFloor" ? "?split=floor" : ""}`}
                  onClick={() => onOpenChange(false)}
                  data-preview-link
                  className="inline-flex items-center gap-1 rounded-sm font-medium text-primary hover:underline"
                >
                  <Eye className="size-4" aria-hidden />
                  {t("boq.export.preview")}
                </Link>
                <span className="text-muted-foreground">{t("boq.export.previewHint")}</span>
              </p>
            ) : null}
            {warn ? (
              <div role="alert" className="flex gap-3 rounded-md border border-conf-mid/40 bg-conf-mid/[0.08] p-4">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-conf-mid" aria-hidden />
                <div className="flex flex-col gap-1.5 text-body text-foreground">
                  <p className="font-bold">{t("boq.export.warnTitle")}</p>
                  <p>
                    {t("boq.export.warnBody", {
                      red: t("boq.export.warnRed", { count: red }),
                      yellow: t("boq.export.warnYellow", { count: yellow }),
                    })}
                  </p>
                  <p className="text-muted-foreground">{t("boq.export.warnColumn")}</p>
                  <label htmlFor={draftId} className="mt-1 inline-flex cursor-pointer items-start gap-2">
                    <input
                      id={draftId}
                      type="checkbox"
                      checked={draftNote}
                      onChange={(e) => setDraftNote(e.target.checked)}
                      className="mt-1 size-4 shrink-0 accent-[rgb(var(--primary))]"
                    />
                    <span>{t("boq.export.draftNote")}</span>
                  </label>
                </div>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {blocked ? (
            <Button
              onClick={() => {
                onOpenChange(false);
                onGoToItems();
              }}
            >
              {t("boq.export.goToItems")}
            </Button>
          ) : warn && built ? (
            <>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  onGoToItems();
                }}
              >
                {t("boq.export.backToReview")}
              </Button>
              <Button variant="secondary" onClick={() => void run()} disabled={exp.isPending}>
                <Download aria-hidden />
                {exp.isPending ? t("boq.export.exporting") : t("boq.export.exportAnyway")}
              </Button>
            </>
          ) : (
            <Button onClick={() => void run()} disabled={exp.isPending || !built}>
              <Download aria-hidden />
              {exp.isPending ? t("boq.export.exporting") : t("boq.export.submit")}
            </Button>
          )}
        </DialogFooter>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * FR-29 / E2E-13: marked PDF — every evidence symbol coloured by its BOQ line + legend page + ●▲◆ glyphs.
 * Options: one page per floor, hide the title block, a subset of sheets. The job runs in the worker; the dialog
 * polls the export doc and offers the 15-minute signed URL as a download.
 */
function MarkedPdfExport({
  projectId,
  sheets,
  built,
  blocked,
  red,
  canExport,
  onGoToItems,
  open,
  pollMs,
}: {
  projectId: string;
  sheets: readonly SheetRow[];
  built: boolean;
  blocked: boolean;
  red: number;
  canExport: boolean;
  onGoToItems: () => void;
  open: boolean;
  pollMs?: number;
}) {
  const { t } = useTranslation();
  const start = useExportMarkedPdf(projectId);
  const [exportId, setExportId] = useState<string | null>(null);
  const doc = useExportDoc(projectId, exportId, pollMs);
  const [floorSplit, setFloorSplit] = useState(false);
  // Same privacy default as the share dialog (A-UI-20): a PDF sent out does not carry the client's address by accident.
  const [hideTitleBlock, setHideTitleBlock] = useState(true);
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [serverBlocked, setServerBlocked] = useState(false);
  const fsId = useId();
  const tbId = useId();
  const allId = useId();

  useEffect(() => {
    if (open) return;
    setExportId(null);
    setServerBlocked(false);
  }, [open]);

  const d = doc.data;
  const done = d?.status === "succeeded";
  const failed = d?.status === "failed" || doc.isError;
  const running = Boolean(exportId) && !done && !failed;
  // F-3: sheets left out because no title block could be masked.
  const omitted = Object.entries(d?.titleBlockBySheet ?? {})
    .filter(([, masked]) => !masked)
    .map(([sid]) => sid);
  const nameOf = (sid: string) => {
    const r = sheets.find((x) => x.sheet.id === sid);
    return r ? sheetName(r) : sid;
  };
  useEffect(() => {
    if (done) toast({ title: t("markedPdf.done"), tone: "success" });
  }, [done, t]);

  const submit = async () => {
    const sheetIds = all ? null : [...picked];
    if (sheetIds && sheetIds.length === 0) return;
    try {
      const r = await start.mutateAsync({ sheetIds, floorSplit, hideTitleBlock });
      setExportId(r.exportId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === "export_blocked") setServerBlocked(true);
      else toast({ title: t("markedPdf.failed"), tone: "error" });
    }
  };

  if (!built) return <p role="alert" className="text-body text-foreground">{t("boq.export.notBuilt")}</p>;
  if (!canExport) return <p role="alert" className="text-body text-foreground">{t("markedPdf.noPermission")}</p>;
  if (blocked || serverBlocked) {
    return (
      <>
        <div role="alert" className="flex gap-3 rounded-md border border-conf-low/40 bg-conf-low/[0.07] p-4">
          <Ban className="mt-0.5 size-5 shrink-0 text-conf-low" aria-hidden />
          <div className="flex flex-col gap-1 text-body">
            <p className="font-bold text-foreground">{t("boq.export.blockedTitle")}</p>
            <p className="text-foreground">{t("boq.export.blockedBody", { count: red })}</p>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onGoToItems}>{t("boq.export.goToItems")}</Button>
        </DialogFooter>
      </>
    );
  }
  const noneSelected = !all && picked.size === 0;
  return (
    <>
      <div className="flex flex-col gap-3 text-body" data-marked-pdf>
        <label htmlFor={fsId} className="inline-flex cursor-pointer items-center gap-2 text-foreground">
          <input id={fsId} type="checkbox" checked={floorSplit} onChange={(e) => setFloorSplit(e.target.checked)} disabled={running} className="size-4 accent-[rgb(var(--primary))]" />
          {t("markedPdf.floorSplit")}
        </label>
        <label htmlFor={tbId} className="inline-flex cursor-pointer items-center gap-2 text-foreground">
          <input id={tbId} type="checkbox" checked={hideTitleBlock} onChange={(e) => setHideTitleBlock(e.target.checked)} disabled={running} className="size-4 accent-[rgb(var(--primary))]" />
          {t("markedPdf.hideTitleBlock")}
        </label>
        <fieldset className="flex flex-col gap-1.5 rounded-md border border-border p-3" disabled={running}>
          <legend className="px-1 text-dense text-muted-foreground">
            {t("markedPdf.sheets")} · {all ? t("markedPdf.allSheets", { count: sheets.length }) : t("markedPdf.someSheets", { n: picked.size, count: sheets.length })}
          </legend>
          <label htmlFor={allId} className="inline-flex cursor-pointer items-center gap-2 font-medium text-foreground">
            <input
              id={allId}
              type="checkbox"
              checked={all}
              onChange={(e) => {
                setAll(e.target.checked);
                // Unticking "all" starts an empty subset (A-UI-20); the user ticks the sheets to include.
                if (!e.target.checked) setPicked(new Set());
              }}
              className="size-4 accent-[rgb(var(--primary))]"
            />
            {t("markedPdf.allSheets", { count: sheets.length })}
          </label>
          {!all ? (
            <ul className="grid max-h-40 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto ps-6">
              {sheets.map((r) => (
                <li key={r.sheet.id}>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-dense text-foreground">
                    <input
                      type="checkbox"
                      checked={picked.has(r.sheet.id)}
                      onChange={(e) =>
                        setPicked((cur) => {
                          const n = new Set(cur);
                          if (e.target.checked) n.add(r.sheet.id);
                          else n.delete(r.sheet.id);
                          return n;
                        })
                      }
                      className="size-4 accent-[rgb(var(--primary))]"
                    />
                    <span className="truncate">{sheetName(r)}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          {noneSelected ? <p role="alert" className="text-meta text-destructive">{t("markedPdf.sheetsNone")}</p> : null}
        </fieldset>

        {omitted.length && (done || failed) ? (
          <div role="alert" className="flex gap-2 rounded-md border border-conf-mid/50 bg-conf-mid/[0.1] p-3 text-dense text-foreground" data-omitted>
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-conf-mid" aria-hidden />
            <div className="flex flex-col gap-1">
              <p>{done ? (d?.message ?? EXPORT_SHEETS_OMITTED_HE) : t("markedPdf.omitted")}</p>
              <ul className="list-disc ps-5 text-meta text-muted-foreground">
                {omitted.map((sid) => (
                  <li key={sid}>{nameOf(sid)}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {exportId ? (
          <div role="status" aria-live="polite" className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken p-3">
            {failed ? (
              <p className="text-destructive" data-export-error={d?.error?.code ?? undefined}>
                {d?.message ?? (d?.error?.code ? EXPORT_ERROR_MESSAGES_HE[d.error.code] : undefined) ?? t("markedPdf.failed")}
              </p>
            ) : done ? (
              <>
                <p className="font-medium text-foreground">{t("markedPdf.ready", { count: d?.pageCount ?? 0 })}</p>
                <p className="text-meta text-muted-foreground">{t("markedPdf.linkExpires")}</p>
              </>
            ) : (
              <>
                <p className="text-foreground">{d && (d.progress ?? 0) > 0 ? t("markedPdf.preparing", { pct: d.progress ?? 0 }) : t("markedPdf.queued")}</p>
                <Progress value={d?.progress ?? 0} aria-label={t("markedPdf.preparing", { pct: d?.progress ?? 0 })} />
              </>
            )}
          </div>
        ) : null}
      </div>
      <DialogFooter>
        {done && d?.url ? (
          <Button asChild>
            <a href={d.url} download={d.filename ?? "marked.pdf"} rel="noopener noreferrer" referrerPolicy="no-referrer">
              <Download aria-hidden />
              {t("markedPdf.download")}
            </a>
          </Button>
        ) : (
          <Button onClick={() => void submit()} disabled={start.isPending || running || noneSelected}>
            <FileText aria-hidden />
            {running || start.isPending ? t("markedPdf.queued") : failed ? t("markedPdf.submit") : t("markedPdf.submit")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
