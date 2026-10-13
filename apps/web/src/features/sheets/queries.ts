import { useMutation } from "@tanstack/react-query";
import { useApi } from "@/api/client";
import type { ConfirmSheetRequest, SheetRegion } from "@/api/types";

/** Writes go through the API (no client writes in firestore.rules); the live listener reflects them. */
export function useConfirmSheets(projectId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: async (items: { sheetId: string; req: ConfirmSheetRequest }[]) => {
      for (const { sheetId, req } of items) await api.confirmSheet(projectId, sheetId, req);
      return items.length;
    },
  });
}

export function useSaveRegions(projectId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: ({ sheetId, regions }: { sheetId: string; regions: SheetRegion[] }) => api.saveSheetRegions(projectId, sheetId, regions),
  });
}
