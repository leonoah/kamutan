import { useTranslation } from "react-i18next";
import type { SheetRow } from "@/api/types";
import { useTilesManifest } from "@/features/viewer/tiles";
import { cn } from "@/lib/utils";

/** Sheet thumbnail (tiles manifest) on a white "paper" — shared by the confirm cards and the project hub gallery. */
export function SheetThumb({ projectId, row, name, className }: { projectId: string; row: SheetRow; name: string; className?: string }) {
  const { t } = useTranslation();
  const m = useTilesManifest(projectId, row);
  const src = m.data?.thumbnailUrl;
  return (
    <div className={cn("relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-white", className)}>
      {src ? (
        <img src={src} alt={t("sheets.thumbnailAlt", { name })} className="size-full object-contain" loading="lazy" />
      ) : (
        <span className="paper-grid size-full" aria-hidden />
      )}
    </div>
  );
}
