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
}

interface ToastState {
  items: ToastItem[];
  push: (t: Omit<ToastItem, "id" | "tone"> & { tone?: ToastTone }) => void;
  dismiss: (id: number) => void;
}

let toastSeq = 0;
export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (t) => set((s) => ({ items: [...s.items, { tone: "neutral", ...t, id: ++toastSeq }] })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

/** Imperative helper: toast({ title: "הפרויקט נוצר." }) */
export const toast = (t: Parameters<ToastState["push"]>[0]) => useToastStore.getState().push(t);

const toneBar: Record<ToastTone, string> = {
  neutral: "bg-primary",
  success: "bg-conf-high",
  error: "bg-destructive",
};

/** Mount once at the app root. Radix Toast renders an aria-live region (polite; errors use foreground=assertive). */
export function Toaster() {
  const { t } = useTranslation();
  const { items, dismiss } = useToastStore();
  return (
    // swipeDirection "left" = toward the inline-end edge in RTL
    <ToastPrimitive.Provider swipeDirection="left" duration={6000}>
      {items.map((item) => (
        <ToastPrimitive.Root
          key={item.id}
          type={item.tone === "error" ? "foreground" : "background"}
          onOpenChange={(open) => !open && dismiss(item.id)}
          className={cn(
            "group relative flex w-full items-start gap-3 overflow-hidden rounded border border-border bg-surface py-3 pe-10 ps-4 shadow-float",
            "data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          )}
        >
          <span aria-hidden className={cn("absolute inset-y-0 start-0 w-[3px]", toneBar[item.tone])} />
          <div className="flex flex-1 flex-col gap-0.5">
            <ToastPrimitive.Title className="text-body font-medium text-foreground">{item.title}</ToastPrimitive.Title>
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
      <ToastPrimitive.Viewport className="fixed bottom-4 end-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  );
}
