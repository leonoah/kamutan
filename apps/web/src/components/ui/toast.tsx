import { useEffect, useState } from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { X } from "lucide-react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type ToastTone = "neutral" | "success" | "error";

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
  action?: { label: string; onClick: () => void };
  /** ms since epoch; hidden (collapsed) toasts are dropped once this passes. */
  expiresAt: number;
  /** Duplicates of this toast pushed while it was open (shown as "×N"). */
  repeat: number;
}

/** Owner feedback (Sprint 6): at most 3 toasts on screen, newest on top; older ones collapse into "+N הודעות". */
export const MAX_VISIBLE_TOASTS = 3;
/** Errors auto-dismiss after 5 s, summaries with an action (undo) stay 8 s, the rest 6 s. */
export const toastDuration = (t: Pick<ToastItem, "tone" | "action">) => (t.tone === "error" ? 5000 : t.action ? 8000 : 6000);
/** Keep the store bounded even if nothing is rendered (tests, background tabs). */
const MAX_STORED = 20;

interface ToastState {
  items: ToastItem[];
  push: (t: Omit<ToastItem, "id" | "tone" | "expiresAt" | "repeat"> & { tone?: ToastTone }) => void;
  dismiss: (id: number) => void;
}

let toastSeq = 0;
export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (t) =>
    set((s) => {
      const tone = t.tone ?? "neutral";
      const expiresAt = Date.now() + toastDuration({ tone, action: t.action });
      // The same message again (e.g. pressing A on an approved line): one toast, moved to the top, "×N".
      const same = s.items.find((i) => i.title === t.title && i.tone === tone && i.description === t.description && !i.action && !t.action);
      if (same) return { items: [...s.items.filter((i) => i !== same), { ...same, id: ++toastSeq, expiresAt, repeat: same.repeat + 1 }] };
      return { items: [...s.items, { ...t, tone, id: ++toastSeq, expiresAt, repeat: 1 }].slice(-MAX_STORED) };
    }),
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

/** Imperative helper: toast({ title: "הפרויקט נוצר." }) */
export const toast = (t: Parameters<ToastState["push"]>[0]) => useToastStore.getState().push(t);

/**
 * A-UI-23: a Radix toast is a dismissable layer mounted after any open dialog, so it is the "highest layer" and eats
 * the Escape meant for the dialog. One Escape should close both: the toast closes itself (default) and the Escape is
 * forwarded to the top-most open dialog through its close button.
 */
export function forwardEscapeToDialog(doc: Document = document) {
  const open = [...doc.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]')];
  open.at(-1)?.querySelector<HTMLButtonElement>("[data-dialog-close]")?.click();
}

const toneBar: Record<ToastTone, string> = {
  neutral: "bg-primary",
  success: "bg-conf-high",
  error: "bg-destructive",
};

/** Mount once at the app root. Radix Toast renders an aria-live region (polite; errors use foreground=assertive). */
export function Toaster() {
  const { t } = useTranslation();
  const { items, dismiss } = useToastStore();
  const [expanded, setExpanded] = useState(false);
  // newest first (top of the stack); only the newest MAX_VISIBLE_TOASTS are mounted unless expanded
  const newestFirst = [...items].reverse();
  const shown = expanded ? newestFirst : newestFirst.slice(0, MAX_VISIBLE_TOASTS);
  const hidden = items.length - shown.length;
  // collapsed toasts are not mounted (no Radix timer): drop them once they expire
  useEffect(() => {
    if (!hidden) return;
    const id = setInterval(() => {
      const now = Date.now();
      const visible = new Set(useToastStore.getState().items.slice(-MAX_VISIBLE_TOASTS).map((i) => i.id));
      for (const i of useToastStore.getState().items) if (!visible.has(i.id) && i.expiresAt < now) useToastStore.getState().dismiss(i.id);
    }, 1000);
    return () => clearInterval(id);
  }, [hidden]);
  useEffect(() => {
    if (items.length <= MAX_VISIBLE_TOASTS) setExpanded(false);
  }, [items.length]);
  return (
    // swipeDirection "left" = toward the inline-end edge in RTL
    <ToastPrimitive.Provider swipeDirection="left" duration={6000}>
      {shown.map((item) => (
        <ToastPrimitive.Root
          key={item.id}
          duration={toastDuration(item)}
          data-toast-tone={item.tone}
          type={item.tone === "error" ? "foreground" : "background"}
          onOpenChange={(open) => !open && dismiss(item.id)}
          onEscapeKeyDown={() => forwardEscapeToDialog()}
          className={cn(
            "group relative flex w-full items-start gap-3 overflow-hidden rounded border border-border bg-surface py-3 pe-10 ps-4 shadow-float",
            "data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          )}
        >
          <span aria-hidden className={cn("absolute inset-y-0 start-0 w-[3px]", toneBar[item.tone])} />
          <div className="flex flex-1 flex-col gap-0.5">
            <ToastPrimitive.Title className="text-body font-medium text-foreground">
              {item.title}
              {item.repeat > 1 ? (
                <span className="ms-1.5 text-meta font-normal text-muted-foreground">
                  <bdi dir="ltr">×{item.repeat}</bdi>
                </span>
              ) : null}
            </ToastPrimitive.Title>
            {item.description ? (
              <ToastPrimitive.Description className="text-dense text-muted-foreground">
                {item.description}
              </ToastPrimitive.Description>
            ) : null}
          </div>
          {item.action ? (
            <ToastPrimitive.Action
              altText={item.action.label}
              onClick={item.action.onClick}
              className="text-dense font-medium text-primary hover:underline"
            >
              {item.action.label}
            </ToastPrimitive.Action>
          ) : null}
          <ToastPrimitive.Close
            aria-label={t("common.close")}
            className="absolute end-2 top-2 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      {/* newest on top; the "+N הודעות" pill sits under the stack (the older, collapsed ones) */}
      <ToastPrimitive.Viewport
        className={cn(
          "fixed end-4 z-[60] flex max-h-[calc(100dvh-5rem)] w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2 overflow-y-auto outline-none print:hidden",
          hidden > 0 || expanded ? "bottom-14" : "bottom-4",
        )}
      />
      {hidden > 0 || expanded ? (
        <button
          type="button"
          data-toast-overflow
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="fixed bottom-4 end-4 z-[60] rounded-full border border-border bg-surface px-3 py-1 text-meta font-medium text-foreground shadow-float hover:bg-muted print:hidden"
        >
          {expanded ? t("common.collapseToasts") : t("common.moreToasts", { count: hidden })}
        </button>
      ) : null}
    </ToastPrimitive.Provider>
  );
}
