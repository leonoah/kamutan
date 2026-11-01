import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BoqLine } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Ltr } from "@/components/Ltr";
import { fmtQty } from "./model";

/**
 * Sprint 6 quick action `confirm` (a suggested קומפלט / unit line the drawings cannot compute): the estimate (or 1) is
 * prefilled; saving stores it through `quick-measure` and the line leaves "להשלמה ידנית".
 */
export function QuickConfirmDialog({
  line,
  open,
  onOpenChange,
  onSave,
}: {
  line: BoqLine | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSave: (qty: number) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [qty, setQty] = useState("1");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open || !line) return;
    setQty(fmtQty(line.qty > 0 ? line.qty : 1));
    setTouched(false);
  }, [open, line]);
  if (!line) return null;
  const n = Number(qty.replace(",", "."));
  const bad = !Number.isFinite(n) || n <= 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!bad) onSave(n);
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t("boq.quickConfirm.title", { code: "" })}
              <Ltr>{line.code}</Ltr>
            </DialogTitle>
            <DialogDescription>{line.description}</DialogDescription>
          </DialogHeader>
          <p className="mb-4 text-dense text-muted-foreground">{t("boq.quickConfirm.body")}</p>
          {line.reasons?.[0] ? <p className="mb-4 text-dense text-foreground">{t("boq.reason", { reason: line.reasons[0] })}</p> : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>{t("boq.quickConfirm.qty", { unit: line.unit })}</Label>
            <Input
              id={id}
              dir="ltr"
              inputMode="decimal"
              autoFocus
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              aria-invalid={touched && bad}
              aria-describedby={touched && bad ? `${id}-err` : undefined}
              className="w-32 text-end tabular"
            />
            {touched && bad ? (
              <p id={`${id}-err`} role="alert" className="text-meta text-destructive">
                {t("boq.quickConfirm.invalid")}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t("boq.quickConfirm.cancel")}
            </Button>
            <Button type="submit">{t("boq.quickConfirm.save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
