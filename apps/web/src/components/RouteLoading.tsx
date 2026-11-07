import { useNavigation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * Sprint 8 (code-splitting): every screen is its own chunk. While a chunk loads on the FIRST page load the route
 * shows this skeleton (title bar + a few rows, `role="status"`, reduced-motion safe); in-app navigations keep the
 * current screen and show <NavigationProgress /> instead.
 */
export function RouteLoading({ variant = "page" }: { variant?: "page" | "full" }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-live="polite"
      data-route-loading
      className={cn("mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6", variant === "full" && "min-h-dvh")}
    >
      <span className="sr-only">{t("routes.loading")}</span>
      <div aria-hidden className="h-7 w-56 animate-pulse rounded bg-muted motion-reduce:animate-none" />
      <div aria-hidden className="h-4 w-80 max-w-full animate-pulse rounded bg-muted/70 motion-reduce:animate-none" />
      <div aria-hidden className="mt-2 grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border border-border bg-surface motion-reduce:animate-none" />
        ))}
      </div>
      <div aria-hidden className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded bg-muted/60 motion-reduce:animate-none" />
        ))}
      </div>
    </div>
  );
}

/** Thin bar under the top bar while the next screen's chunk (or route data) loads. */
export function NavigationProgress() {
  const { t } = useTranslation();
  const nav = useNavigation();
  if (nav.state === "idle") return null;
  return (
    <div role="progressbar" aria-label={t("routes.loading")} data-nav-progress className="fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-primary/20">
      <div className="h-full w-1/3 animate-[nav-progress_1.1s_ease-in-out_infinite] bg-primary motion-reduce:w-full motion-reduce:animate-none" />
    </div>
  );
}
