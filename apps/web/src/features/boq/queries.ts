import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useApi, useBackend } from "@/api/client";
import type {
  BoqDocumentQuery,
  BoqBuild,
  BoqLine,
  BoqLinesResponse,
  BatchStatusRequest,
  BoqQuickActionKind,
  QuickMeasureRequest,
  ExportBoqRequest,
  ListLibraryQuery,
  PatchBoqLineRequest,
  PatchLibraryItemRequest,
  ProjectBoqState,
} from "@/api/types";
import { useSubscription } from "@/lib/useSubscription";
import { applyQuickMeasure } from "./sprint6";
import { applyRename } from "./sprint7";

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
    onSuccess: (line) => {
      qc.setQueriesData<BoqLinesResponse>({ queryKey: boqLinesKey(projectId) }, (cur) =>
        cur ? { ...cur, items: cur.items.map((l) => (l.id === line.id ? line : l)) } : cur,
      );
      void qc.invalidateQueries({ queryKey: ["boq-document", projectId] });
    },
  });
}

/**
 * Sprint 7: rename a line (or restore its original wording with `description: null`), optionally also in the org
 * library. Optimistic; the server's line replaces it; the preview document and the history refetch.
 */
export function useRenameLine(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, description, reason, alsoUpdateLibrary }: { lineId: string; description: string | null; reason: string | null; alsoUpdateLibrary: boolean }) =>
      api.patchBoqLine(projectId, lineId, {
        description,
        ...(reason ? { reason } : {}),
        ...(alsoUpdateLibrary ? { alsoUpdateLibrary: true } : {}),
      }),
    onMutate: ({ lineId, description, reason }) => ({
      rollback: patchCachedLines(qc, projectId, (l) => (l.id === lineId ? applyRename(l, description, reason, null) : l)),
    }),
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSuccess: (line, v) => {
      patchCachedLines(qc, projectId, (l) => (l.id === line.id ? line : l));
      void qc.invalidateQueries({ queryKey: ["boq-document", projectId] });
      void qc.invalidateQueries({ queryKey: ["line-history", projectId] });
      if (v.alsoUpdateLibrary) void qc.invalidateQueries({ queryKey: ["library-items"] });
    },
  });
}

/** Sprint 7: the BOQ document model (preview), per build and options. */
export function useBoqDocument(projectId: string, q: BoqDocumentQuery, buildId: string | null | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ["boq-document", projectId, buildId ?? null, q],
    enabled: Boolean(buildId),
    queryFn: () => api.getBoqDocument(projectId, q),
    placeholderData: (prev) => prev,
    staleTime: 0,
  });
}

/** Replace / patch lines in every cached lines query; returns a rollback. */
function patchCachedLines(qc: QueryClient, projectId: string, fn: (l: BoqLine) => BoqLine): () => void {
  const prev = qc.getQueriesData<BoqLinesResponse>({ queryKey: boqLinesKey(projectId) });
  void qc.cancelQueries({ queryKey: boqLinesKey(projectId) });
  qc.setQueriesData<BoqLinesResponse>({ queryKey: boqLinesKey(projectId) }, (cur) => (cur ? { ...cur, items: cur.items.map(fn) } : cur));
  return () => prev.forEach(([k, v]) => qc.setQueryData(k, v));
}

/**
 * Sprint 6 (owner feedback): one status for many lines. The planned lines move at once (optimistic); the answer then
 * replaces them (skipped ones roll back to their cached state).
 */
export function useBatchStatus(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ req }: { req: BatchStatusRequest; optimisticIds: readonly string[] }) => api.batchBoqLineStatus(projectId, req),
    onMutate: ({ req, optimisticIds }) => {
      const ids = new Set(optimisticIds);
      return { rollback: patchCachedLines(qc, projectId, (l) => (ids.has(l.id) ? { ...l, status: req.to } : l)) };
    },
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSuccess: (res, { optimisticIds }, ctx) => {
      const byId = new Map(res.updated.filter((l) => l.status).map((l) => [l.id, l]));
      const moved = new Set(res.updated.map((l) => l.id));
      // optimistic lines the server skipped go back
      if (optimisticIds.some((id) => !moved.has(id))) ctx?.rollback();
      patchCachedLines(qc, projectId, (l) => byId.get(l.id) ?? l);
      if (byId.size !== moved.size) void qc.invalidateQueries({ queryKey: boqLinesKey(projectId) });
      void qc.invalidateQueries({ queryKey: ["line-history", projectId] });
    },
  });
}

/**
 * Sprint 6: a line's quick action (measure / count / confirm). The line takes the quantity at once (optimistic, no
 * longer "להשלמה ידנית"); the server's line replaces it, and the drawing's manual items / evidence are refreshed.
 */
export function useQuickMeasure(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, req }: { lineId: string; req: QuickMeasureRequest; label: string }) => api.quickMeasureBoqLine(projectId, lineId, req),
    onMutate: ({ lineId, req, label }) => ({
      rollback: patchCachedLines(qc, projectId, (l) => (l.id === lineId ? applyQuickMeasure(l, req.kind as BoqQuickActionKind, req.quantity, label, req.sheetId) : l)),
    }),
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSuccess: (res) => {
      patchCachedLines(qc, projectId, (l) => (l.id === res.line.id ? res.line : l));
      void qc.invalidateQueries({ queryKey: ["corrections", projectId] });
      void qc.invalidateQueries({ queryKey: ["boq-evidence", projectId] });
      void qc.invalidateQueries({ queryKey: ["boq-sheet-evidence", projectId] });
      void qc.invalidateQueries({ queryKey: ["review-queue", projectId] });
    },
  });
}

/**
 * A-UI-07: a drawing correction that adds / removes one counted item moves its BOQ line(s) at once (the receipt's
 * manual part too); the server's re-derive / rebuild then replaces the cache (invalidateAfterCorrection). Returns a
 * rollback for a failed write.
 */
export function bumpLinesOptimistic(qc: QueryClient, projectId: string, lineIds: readonly string[], delta: number): () => void {
  if (!lineIds.length || !delta) return () => undefined;
  const ids = new Set(lineIds);
  const prev = qc.getQueriesData<BoqLinesResponse>({ queryKey: boqLinesKey(projectId) });
  void qc.cancelQueries({ queryKey: boqLinesKey(projectId) });
  qc.setQueriesData<BoqLinesResponse>({ queryKey: boqLinesKey(projectId) }, (cur) =>
    cur
      ? {
          ...cur,
          items: cur.items.map((l) =>
            ids.has(l.id)
              ? { ...l, qty: Math.max(0, l.qty + delta), ...(delta > 0 ? { manualCount: (l.manualCount ?? 0) + delta } : {}), evidenceCount: Math.max(0, l.evidenceCount + delta) }
              : l,
          ),
        }
      : cur,
  );
  return () => prev.forEach(([k, v]) => qc.setQueryData(k, v));
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

/* ---------------- Sprint 5: marked PDF export (job → poll → signed URL) ---------------- */

export function useExportMarkedPdf(projectId: string) {
  const api = useApi();
  return useMutation({ mutationFn: (req: import("@/api/types").MarkedPdfExportRequest) => api.exportMarkedPdf(projectId, req) });
}

/** Polls the export doc until it succeeds / fails (the signed URL arrives with `succeeded`). */
export function useExportDoc(projectId: string, exportId: string | null, intervalMs = 700) {
  const api = useApi();
  return useQuery({
    queryKey: ["export", projectId, exportId],
    queryFn: () => api.getExport(projectId, exportId!),
    enabled: Boolean(exportId),
    refetchInterval: (q) => (q.state.data?.status === "succeeded" || q.state.data?.status === "failed" ? false : intervalMs),
    staleTime: 0,
  });
}
