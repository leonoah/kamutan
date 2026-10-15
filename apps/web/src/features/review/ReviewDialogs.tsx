import { useTranslation } from "react-i18next";
import { Ban, Check, Hash, Tags, X } from "lucide-react";
import type { Detection } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/Kbd";
import { countsByClass } from "@/features/understanding/model";
import { className } from "@/features/understanding/taxonomy";

/** Keyboard map (spec §טבלת קיצורי מקלדת), by physical key — also on a Hebrew layout. */
export const SHORTCUTS: { group: "queue" | "tools" | "global"; keys: string[]; label: string }[] = [
  { group: "queue", keys: ["A"], label: "shortcuts.accept" },
  { group: "queue", keys: ["R"], label: "shortcuts.reject" },
  { group: "queue", keys: ["E"], label: "shortcuts.edit" },
  { group: "queue", keys: ["N", "J"], label: "shortcuts.next" },
  { group: "queue", keys: ["P", "K"], label: "shortcuts.prev" },
  { group: "queue", keys: ["Shift+N"], label: "shortcuts.skip" },
  { group: "queue", keys: ["F"], label: "shortcuts.focus" },
  { group: "queue", keys: ["Shift+L"], label: "shortcuts.learn" },
  { group: "queue", keys: ["[", "]"], label: "shortcuts.step" },
  { group: "tools", keys: ["V"], label: "viewer.select" },
  { group: "tools", keys: ["L"], label: "viewer.lasso" },
  { group: "tools", keys: ["+"], label: "viewer.add" },
  { group: "tools", keys: ["Del"], label: "viewer.remove" },
  { group: "tools", keys: ["W"], label: "viewer.move" },
  { group: "tools", keys: ["G"], label: "viewer.link" },
  { group: "tools", keys: ["C"], label: "viewer.count" },
  { group: "tools", keys: ["M"], label: "viewer.area" },
  { group: "tools", keys: ["D"], label: "viewer.length" },
  { group: "tools", keys: ["S"], label: "viewer.calibrate" },
  { group: "global", keys: ["Z", "⌘Z"], label: "shortcuts.undo" },
  { group: "global", keys: ["Shift+Z", "⌘⇧Z"], label: "shortcuts.redo" },
  { group: "global", keys: ["?"], label: "shortcuts.help" },
  { group: "global", keys: ["Esc"], label: "shortcuts.esc" },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title")}</DialogTitle>
          <DialogDescription>{t("shortcuts.note")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-3">
          {(["queue", "tools", "global"] as const).map((g) => (
            <section key={g} aria-labelledby={`sc-${g}`}>
              <h3 id={`sc-${g}`} className="mb-1.5 text-dense font-bold text-foreground">
                {t(`shortcuts.groups.${g}`)}
              </h3>
              <dl className="flex flex-col gap-1 text-dense">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <div key={s.label} className="flex items-center justify-between gap-2">
                    <dt className="text-foreground">{t(s.label)}</dt>
                    <dd className="flex shrink-0 gap-1">
                      {s.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Lasso result card (spec: "נבחרו 14 פריטים (9 שקע כפול, 5 שקע בודד)" + אשר הכל / דחה הכל / שייך לסעיף… / ספור ידנית כאן).
 * Floating over the canvas (inside the LTR drawing subtree, itself RTL).
 */
export function LassoCard({
  items,
  onAccept,
  onReject,
  onAssign,
  onCount,
  onClose,
}: {
  items: Detection[];
  onAccept: () => void;
  onReject: () => void;
  onAssign: () => void;
  onCount: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const by = countsByClass(items)
    .map((c) => `${c.total} ${className(c.cls, t("understanding.unknownClass"))}`)
    .join(", ");
  // Centred with a flex wrapper: logical insets inside the LTR canvas would resolve against the card's own RTL.
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex justify-center">
      <section
        dir="rtl"
        aria-labelledby="lasso-title"
        data-lasso-card
        onPointerDown={(e) => e.stopPropagation()}
        className="pointer-events-auto flex w-[min(420px,calc(100%-5rem))] flex-col gap-2 rounded-lg border border-border bg-surface p-3 shadow-float"
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 id="lasso-title" className="text-dense font-bold text-foreground">
              {t("tools.lassoTitle", { count: items.length })}
            </h2>
            {by ? <p className="text-meta text-muted-foreground">({by})</p> : null}
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label={t("tools.lassoClose")}>
            <X aria-hidden />
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={onAccept} disabled={!items.length} aria-keyshortcuts="A">
            <Check aria-hidden />
            {t("queue.acceptAll")}
          </Button>
          <Button size="sm" variant="secondary" onClick={onReject} disabled={!items.length} aria-keyshortcuts="R">
            <Ban aria-hidden />
            {t("queue.rejectAll")}
          </Button>
          <Button size="sm" variant="secondary" onClick={onAssign} disabled={!items.length} aria-keyshortcuts="E">
            <Tags aria-hidden />
            {t("tools.lassoAssign")}
          </Button>
          <Button size="sm" variant="secondary" onClick={onCount}>
            <Hash aria-hidden />
            {t("tools.lassoCount")}
          </Button>
        </div>
      </section>
    </div>
  );
}
