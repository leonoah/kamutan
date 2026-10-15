import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi, useBackend } from "@/api/client";
import type {
  BoqBuild,
  BoqLine,
  BoqLinesResponse,
  ExportBoqRequest,
  ListLibraryQuery,
  PatchBoqLineRequest,
  PatchLibraryItemRequest,
  ProjectBoqState,
} from "@/api/types";
import { useSubscription } from "@/lib/useSubscription";

/* ---------------- BOQ state + builds (Firestore listeners) ---------------- */

export function useBoqState(orgId: string | null, projectId: string) {
  const { realtime } = useBackend();
  return useSubscription<ProjectBoqState | null>(
    ["live", "boqState", orgId, projectId],
    orgId ? (onData, onError) => realtime.boqState(orgId, projectId, onData, onError) : null,
  );
}

export function useBoqBuild(orgId: string | null, projectId: string, buildId: string | null) {
  const { realtime } = useBackend();
  return useSubscription<BoqBuild | null>(
    ["live", "boqBuild", orgId, projectId, buildId],
    orgId && buildId ? (onData, onError) => realtime.boqBuild(orgId, projectId, buildId, onData, onError) : null,
  );
}

export const isBuildActive = (b: BoqBuild | null | undefined) => b?.status === "queued" || b?.status === "running";

export function useBuildBoq(projectId: string) {
  const api = useApi();
  return useMutation({ mutationFn: () => api.buildBoq(projectId) });
}

/* ---------------- lines ---------------- */

export const boqLinesKey = (projectId: string) => ["boq-lines", projectId] as const;

/** Lines of the latest build; refetched when the latest build id changes. */
export function useBoqLines(projectId: string, latestBuildId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...boqLinesKey(projectId), latestBuildId ?? null],
    queryFn: () => api.listBoqLines(projectId),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

/** PATCH a line (status / qtyOverride / note), optimistic with rollback. */
export function usePatchBoqLine(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: PatchBoqLineRequest }) => api.patchBoqLine(projectId, id, req),
    onMutate: async ({ id, req }) => {
      await qc.cancelQueries({ queryKey: boqLinesKey(projectId) });
      const prev = qc.getQueriesData<BoqLinesResponse>({ queryKey: boqLinesKey(projectId) });
      qc.setQueriesData<BoqLinesResponse>({ queryKey: boqLinesKey(projectId) }, (cur) =>
        cur
          ? {
              ...cur,
              items: cur.items.map((l) => {
                if (l.id !== id) return l;
                const { reason, ...rest } = req;
                return { ...l, ...rest, ...(reason !== undefined ? { qtyOverrideReason: reason } : {}) } as BoqLine;
              }),
            }
          : cur,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev.forEach(([k, v]) => qc.setQueryData(k, v)),
    onSuccess: (line) =>
      qc.setQueriesData<BoqLinesResponse>({ queryKey: boqLinesKey(projectId) }, (cur) =>
        cur ? { ...cur, items: cur.items.map((l) => (l.id === line.id ? line : l)) } : cur,
      ),
  });
}

/* ---------------- evidence ---------------- */

export function useLineEvidence(projectId: string, lineId: string | null, buildId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ["boq-evidence", projectId, buildId ?? null, lineId],
    enabled: Boolean(lineId),
    staleTime: 5 * 60_000,
    queryFn: () => api.getBoqLineEvidence(projectId, lineId!),
  });
}

/** Bulk marker → line map of one sheet version (`GET …/boq/evidence?sheetId=&versionId=`), per build. */
export function useSheetEvidence(projectId: string, sheetId: string | null, versionId: string | null, buildId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ["boq-sheet-evidence", projectId, buildId ?? null, sheetId, versionId],
    enabled: Boolean(sheetId && versionId && buildId),
    staleTime: 5 * 60_000,
    queryFn: () => api.getBoqSheetEvidence(projectId, sheetId!, versionId!),
  });
}

/* ---------------- export ---------------- */

export function useExportBoq(projectId: string) {
  const api = useApi();
  return useMutation({ mutationFn: (req: ExportBoqRequest) => api.exportBoq(projectId, req) });
}

/* ---------------- library / templates / rules ---------------- */

export function useLibraryItems(orgId: string, q: ListLibraryQuery) {
  const api = useApi();
  return useQuery({
    queryKey: ["library-items", orgId, q],
    queryFn: () => api.listLibraryItems(orgId, { limit: 500, ...q }),
    placeholderData: (prev) => prev,
  });
}

export function usePatchLibraryItem(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: PatchLibraryItemRequest }) => api.patchLibraryItem(orgId, id, req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["library-items", orgId] }),
  });
}

export function useTemplates(orgId: string) {
  const api = useApi();
  return useQuery({ queryKey: ["boq-templates", orgId], queryFn: () => api.listBoqTemplates(orgId), staleTime: 60_000 });
}

export function useSetDefaultTemplate(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) => api.setDefaultBoqTemplate(orgId, templateId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["boq-templates", orgId] }),
  });
}

export function useRules(orgId: string) {
  const api = useApi();
  return useQuery({ queryKey: ["boq-rules", orgId], queryFn: () => api.listBoqRules(orgId), staleTime: 60_000 });
}

export function usePatchRule(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patchBoqRule(orgId, id, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["boq-rules", orgId] }),
  });
}
