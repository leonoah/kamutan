import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { useBackend } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ACCEPT_ATTR } from "./validation";
import { useUploadStore } from "./uploadStore";

/**
 * A-UI-05 (07_test_plan E2E-14): "העלה מחדש" on a failed file. Picks one file and uploads it as the replacement of the
 * failed set (`replacesSheetSetId`), so the failed set leaves the list once the new one is in.
 */
export function ReuploadButton({
  projectId,
  sheetSetId,
  name,
  label,
  labelFor,
}: {
  projectId: string;
  sheetSetId: string | null;
  name: string | null;
  /** Sprint 9: visible text (default "העלה מחדש") and its accessible name with the file name. */
  label?: string;
  labelFor?: string;
}) {
  const { t } = useTranslation();
  const backend = useBackend();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => inputRef.current?.click()}
        aria-label={name ? (labelFor ?? t("upload.reuploadFor", { name })) : (label ?? t("upload.reupload"))}
        data-reupload={sheetSetId ?? ""}
      >
        <RotateCcw aria-hidden />
        {label ?? t("upload.reupload")}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="reupload-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          void useUploadStore.getState().addFiles(backend, projectId, [f], sheetSetId ? { replacesSheetSetId: sheetSetId } : {});
        }}
      />
    </>
  );
}
