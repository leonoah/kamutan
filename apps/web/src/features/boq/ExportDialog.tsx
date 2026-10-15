import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Ban, Download } from "lucide-react";
import { ApiError, type BoqLine, type BoqTemplate } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { env } from "@/lib/env";
import { useExportBoq } from "./queries";

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
}: {
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
  const tplId = useId();
  const draftId = useId();
  const [templateId, setTemplateId] = useState<string>("");
  const [split, setSplit] = useState<"summed" | "byFloor">("summed");
  const [draftNote, setDraftNote] = useState(true);
  const [serverBlocked, setServerBlocked] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    setServerBlocked(null);
    setTemplateId((cur) => cur || (templates.find((x) => x.default)?.id ?? templates[0]?.id ?? ""));
  }, [open, templates]);

  const red = lines.filter((l) => l.level === "red" && l.status !== "approved").length;
  const yellow = lines.filter((l) => l.level === "yellow" && l.status !== "approved").length;
  const blocked = (blockOnRed && red > 0) || serverBlocked !== null;
  const warn = red + yellow > 0;

  const run = async () => {
    try {
      const res = await exp.mutateAsync({ templateId: templateId || null, split, draftNote: warn && draftNote });
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
          <DialogTitle>{t("boq.export.title")}</DialogTitle>
          <DialogDescription>{t("boq.export.description")}</DialogDescription>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  );
}
