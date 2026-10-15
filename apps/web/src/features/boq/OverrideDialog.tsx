import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BoqLine } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Ltr } from "@/components/Ltr";
import { fmtQty, isOverridden } from "./model";

/**
 * Manual quantity override (key `E`): a reason is mandatory ("למה משנים את הכמות? (יופיע בהיסטוריה)"); the line then
 * shows "ידני ✎" with the computed number struck through. A rebuild never overwrites it.
 */
export function OverrideDialog({
  line,
  open,
  onOpenChange,
  onSave,
  saving,
}: {
  line: BoqLine | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** `reason` is mandatory with a number; `null` clears the override. */
  onSave: (qtyOverride: number | null, reason: string | null) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const qtyId = useId();
  const noteId = useId();
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open || !line) return;
    setQty(fmtQty(line.qtyOverride ?? line.qty));
    setNote(isOverridden(line) ? (line.qtyOverrideReason ?? line.note ?? "") : "");
    setTouched(false);
  }, [open, line]);

  if (!line) return null;
  const n = Number(qty.replace(",", "."));
  const qtyErr = qty.trim() === "" || !Number.isFinite(n) || n < 0;
  const noteErr = note.trim().length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (qtyErr || noteErr) return;
            onSave(n, note.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t("boq.override.title", { code: "" })}
              <Ltr>{line.code}</Ltr>
            </DialogTitle>
            <DialogDescription>{line.description}</DialogDescription>
          </DialogHeader>
          <p className="mb-4 text-dense text-muted-foreground">
            {t("boq.override.computed")}: <span className="font-bold tabular text-foreground">{fmtQty(line.qty)}</span> {line.unit}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={qtyId}>{t("boq.override.qty")}</Label>
            <Input
              id={qtyId}
              dir="ltr"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              aria-invalid={touched && qtyErr}
              aria-describedby={touched && qtyErr ? `${qtyId}-err` : undefined}
              className="w-32 text-end tabular"
              autoFocus
            />
            {touched && qtyErr ? (
              <p id={`${qtyId}-err`} className="text-meta text-destructive">{t("boq.override.qtyInvalid")}</p>
            ) : null}
          </div>
          <div className="mt-4 flex flex-col gap-1.5">
            <Label htmlFor={noteId}>{t("boq.override.reason")}</Label>
            <textarea
              id={noteId}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("boq.override.reasonPlaceholder")}
              rows={3}
              maxLength={500}
              required
              aria-invalid={touched && noteErr}
              aria-describedby={touched && noteErr ? `${noteId}-err` : undefined}
              className="rounded border border-input bg-surface px-3 py-2 text-body text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            />
            {touched && noteErr ? (
              <p id={`${noteId}-err`} className="text-meta text-destructive">{t("boq.override.reasonRequired")}</p>
            ) : null}
          </div>
          <DialogFooter>
            {isOverridden(line) ? (
              <Button type="button" variant="ghost" className="me-auto" onClick={() => onSave(null, null)} disabled={saving}>
                {t("boq.override.clear")}
              </Button>
            ) : null}
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t("boq.override.cancel")}
            </Button>
            <Button type="submit" disabled={saving}>
              {t("boq.override.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
