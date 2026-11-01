import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { BookMarked, Info } from "lucide-react";
import type { LibraryItem, LibrarySource } from "@/api/types";
import { cn } from "@/lib/utils";
import { useLibraryItems } from "./queries";

/**
 * Stage 10 (A-LIVE-01): which item library the org's BOQ uses, derived from the items' `source` — `none` (empty
 * library: lines fall back to the rule's description and unit), `default` (only the shipped default library) or
 * `imported` (a past BOQ was imported; it overrides / extends the defaults). `null` while loading.
 */
export function librarySourceOf(items: readonly Pick<LibraryItem, "source">[] | undefined): LibrarySource | null {
  if (!items) return null;
  if (items.length === 0) return "none";
  return items.every((i) => i.source === "default") ? "default" : "imported";
}

export function useLibrarySource(orgId: string | null): LibrarySource | null {
  const items = useLibraryItems(orgId ?? "", {});
  return orgId ? librarySourceOf(items.data?.items) : null;
}

/**
 * Explains the library state where the BOQ is shown (BOQ panel, project hub) with a link to import a past BOQ.
 * Nothing for an imported library.
 */
export function LibraryNotice({ orgId, canImport, variant = "panel" }: { orgId: string | null; canImport: boolean; variant?: "panel" | "card" }) {
  const { t } = useTranslation();
  const source = useLibrarySource(orgId);
  if (source === null || source === "imported") return null;
  const Icon = source === "none" ? Info : BookMarked;
  return (
    <div
      role="note"
      data-library-notice={source}
      className={cn(
        "flex items-start gap-2 text-dense",
        source === "none" ? "bg-conf-mid/[0.08]" : "bg-primary/[0.05]",
        variant === "panel" ? "shrink-0 border-b border-border px-4 py-2" : "border-b border-border px-4 py-2.5",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", source === "none" ? "text-conf-mid" : "text-primary")} aria-hidden />
      <p className="flex-1 text-foreground">
        <span className="font-medium">{t(source === "none" ? "libraryNotice.noneTitle" : "libraryNotice.defaultTitle")}</span>{" "}
        <span className="text-muted-foreground">{t(source === "none" ? "libraryNotice.noneBody" : "libraryNotice.defaultBody")}</span>{" "}
        {canImport ? (
          <Link to="/library?import=1" className="whitespace-nowrap font-medium text-primary underline-offset-2 hover:underline">
            {t("libraryNotice.importLink")}
          </Link>
        ) : (
          <span className="text-muted-foreground">{t("libraryNotice.askAdmin")}</span>
        )}
      </p>
    </div>
  );
}
