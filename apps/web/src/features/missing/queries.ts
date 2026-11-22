import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "@/api/client";
import type { MissingItemFilter, SetBoqExclusionRequest } from "@/api/types";

export const missingItemsKey = (projectId: string) => ["missing-items", projectId] as const;

/** The "סעיפים שלא זוהו" list of the latest build (server-computed; counts cover all three filters). */
export function useMissingItems(projectId: string, filter: MissingItemFilter, latestBuildId: string | null | undefined, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: [...missingItemsKey(projectId), filter, latestBuildId ?? null],
    queryFn: () => api.getMissingItems(projectId, filter),
    enabled,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

/** "לא רלוונטי בפרויקט הזה" / "החזר": the decision is stored per project; the BOQ, preview, export and share re-read. */
export function useSetExclusion(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: SetBoqExclusionRequest) => api.setBoqExclusion(projectId, req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: missingItemsKey(projectId) });
      void qc.invalidateQueries({ queryKey: ["boq-lines", projectId] });
      void qc.invalidateQueries({ queryKey: ["boq-document", projectId] });
      void qc.invalidateQueries({ queryKey: ["review-queue", projectId] });
      void qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}
