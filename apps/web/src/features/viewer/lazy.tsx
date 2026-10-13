import { lazy, Suspense, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";

/**
 * Deck.gl lives in its own chunk: everything that renders a drawing goes through this lazy boundary,
 * so the login/projects/upload bundle never pays for WebGL code.
 */
const SheetViewerImpl = lazy(() => import("./SheetViewer"));

export type SheetViewerProps = ComponentProps<typeof SheetViewerImpl>;

export function SheetViewer(props: SheetViewerProps) {
  const { t } = useTranslation();
  return (
    <Suspense
      fallback={
        <div role="status" className="flex h-full items-center justify-center bg-surface-sunken text-dense text-muted-foreground">
          {t("sheets.viewerLoading")}
        </div>
      }
    >
      <SheetViewerImpl {...props} />
    </Suspense>
  );
}
