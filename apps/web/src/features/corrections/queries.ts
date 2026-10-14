import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import { useApi } from "@/api/client";
import type {
  ApiClient,
  Correction,
  CorrectionBatchSource,
  CorrectionsResponse,
  CreateCorrectionRequest,
  FindSimilarRequest,
  RoomSettings,
  RoomSettingsDoc,
  RoomSettingsResponse,
  SimilarSearch,
} from "@/api/types";
import { materialize, newId, popRedo, popUndo, pushStep, reissue, type History, type HistoryStep } from "./model";

/* ---------------- corrections (project-wide; small) ---------------- */

export const correctionsKey = (projectId: string) => ["corrections", projectId] as const;

export function useCorrections(projectId: string) {
  const api = useApi();
  return useQuery({
    queryKey: correctionsKey(projectId),
    queryFn: async () => (await api.listCorrections(projectId)).items,
    staleTime: 60_000,
  });
}

/** Everything a correction can change on the server side (mock: re-derived at once; real: rebuild on demand). */
export function invalidateAfterCorrection(qc: QueryClient, projectId: string) {
  void qc.invalidateQueries({ queryKey: ["boq-lines", projectId] });
  void qc.invalidateQueries({ queryKey: ["boq-sheet-evidence", projectId] });
  void qc.invalidateQueries({ queryKey: ["boq-evidence", projectId] });
  void qc.invalidateQueries({ queryKey: ["review-queue", projectId] });
}

/* ---------------- session history (undo / redo) ---------------- */

interface HistoryState {
  byProject: Record<string, History>;
  set(projectId: string, h: History): void;
}
export const useHistoryStore = create<HistoryState>((set) => ({
  byProject: {},
  set: (projectId, h) => set((s) => ({ byProject: { ...s.byProject, [projectId]: h } })),
}));
const EMPTY_HISTORY: History = { past: [], future: [] };
export const useHistory = (projectId: string) => useHistoryStore((s) => s.byProject[projectId] ?? EMPTY_HISTORY);

async function send(
  api: ApiClient,
  projectId: string,
  reqs: CreateCorrectionRequest[],
  batchId: string | null,
  source: CorrectionBatchSource,
  similarSearchId: string | null,
): Promise<{ items: Correction[]; batchId: string | null }> {
  if (reqs.length === 1 && !batchId) return { items: [await api.createCorrection(projectId, reqs[0]!)], batchId: null };
  return api.createCorrectionsBatch(projectId, { batchId: batchId ?? newId("batch"), corrections: reqs, source, similarSearchId });
}

/**
 * Server ids of a step that is still in flight (provisional client id of its first correction → promise). Undo of
 * a step that was not acknowledged yet waits for it, so the revert targets the server's ids / batch id.
 */
const pendingSteps = new Map<string, Promise<{ ids: string[]; batchId: string | null } | null>>();

export interface ApplyOptions {
  /** History label, e.g. "שיוך 7 פריטים ל-4.03" (shown in the undo toast). */
  label: string;
  /** Not recorded in the undo stack (e.g. the redo of a step). */
  record?: boolean;
  /** Group action → one batch id (one undo step). Defaults to a batch for > 1 correction. */
  batchId?: string | null;
  /** Extra info kept on the step (e.g. the queue item to restore on undo). */
  meta?: Record<string, unknown>;
  /** Batch origin (contracts CorrectionBatchSource). */
  source?: CorrectionBatchSource;
  /** "החל על N" of a similar search. */
  similarSearchId?: string | null;
}

/**
 * Optimistic corrections: the cache gains the corrections at once (the overlay re-derives synchronously), the API
 * call runs in the background, an error rolls the cache back. Each call is one undo step (≤ 100 per session).
 */
export function useCorrectionActions(projectId: string, opts: { onError?: (e: unknown) => void } = {}) {
  const api = useApi();
  const qc = useQueryClient();
  const key = correctionsKey(projectId);
  const setHistory = useHistoryStore((s) => s.set);
  const getHistory = () => useHistoryStore.getState().byProject[projectId] ?? EMPTY_HISTORY;

  const apply = useCallback(
    async (reqs: CreateCorrectionRequest[], o: ApplyOptions): Promise<Correction[] | null> => {
      if (!reqs.length) return [];
      const batchId = o.batchId !== undefined ? o.batchId : reqs.length > 1 ? newId("batch") : null;
      const withIds = reqs.map((r) => ({ ...r, id: r.id ?? newId("corr"), batchId: batchId ?? r.batchId ?? null }));
      const optimistic = withIds.map((r) => materialize(r, "me"));
      const prev = qc.getQueryData<Correction[]>(key);
      qc.setQueryData<Correction[]>(key, (cur) => [...(cur ?? []), ...optimistic]);
      if (o.record !== false)
        setHistory(
          projectId,
          pushStep(getHistory(), { label: o.label, ids: withIds.map((r) => r.id!), redo: withIds, batchId, ...(o.meta ? { meta: o.meta } : {}) }),
        );
      const provisional = withIds.map((r) => r.id!);
      let settle!: (v: { ids: string[]; batchId: string | null } | null) => void;
      pendingSteps.set(`${projectId}/${provisional[0]}`, new Promise((r) => (settle = r)));
      try {
        const res = await send(api, projectId, withIds, batchId, o.source ?? "other", o.similarSearchId ?? null);
        const saved = res.items;
        // The server assigns ids (and the batch id): swap the optimistic entries by position, re-key the history.
        const swap = new Map(provisional.map((id, i) => [id, saved[i] ?? null]));
        qc.setQueryData<Correction[]>(key, (cur) => (cur ?? []).map((c) => swap.get(c.id) ?? c));
        const ids = provisional.map((id, i) => saved[i]?.id ?? id);
        const rekey = (s: HistoryStep) => (s.ids[0] === provisional[0] ? { ...s, ids, batchId: res.batchId ?? s.batchId } : s);
        const h = getHistory();
        setHistory(projectId, { past: h.past.map(rekey), future: h.future.map(rekey) });
        settle({ ids, batchId: res.batchId });
        invalidateAfterCorrection(qc, projectId);
        return saved;
      } catch (e) {
        settle(null);
        pendingSteps.delete(`${projectId}/${provisional[0]}`);
        const ids = new Set(withIds.map((r) => r.id));
        qc.setQueryData<Correction[]>(key, (cur) => (cur ?? prev ?? []).filter((c) => !ids.has(c.id)));
        if (o.record !== false) {
          const h = getHistory();
          setHistory(projectId, { ...h, past: h.past.filter((s) => !s.ids.some((id) => ids.has(id))) });
        }
        opts.onError?.(e);
        return null;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, qc, projectId, setHistory],
  );

  /** Revert one step (optimistic `revertedAt`). Returns the step (for the "בוטל: …" toast) or null. */
  const undo = useCallback(async (): Promise<HistoryStep | null> => {
    const popped = popUndo(getHistory());
    let step = popped.step;
    const next = popped.next;
    if (!step) return null;
    setHistory(projectId, next);
    const pend = pendingSteps.get(`${projectId}/${step.ids[0]}`);
    if (pend) {
      const ack = await pend;
      if (ack) step = { ...step, ids: ack.ids, batchId: ack.batchId ?? step.batchId };
    }
    const at = new Date().toISOString();
    const ids = new Set(step.ids);
    const prev = qc.getQueryData<Correction[]>(key);
    qc.setQueryData<Correction[]>(key, (cur) => (cur ?? []).map((c) => (ids.has(c.id) ? { ...c, revertedAt: at } : c)));
    try {
      if (step.batchId) await api.revertCorrectionsBatch(projectId, step.batchId);
      else await Promise.all(step.ids.map((id) => api.revertCorrection(projectId, id)));
      invalidateAfterCorrection(qc, projectId);
    } catch (e) {
      if (prev) qc.setQueryData(key, prev);
      setHistory(projectId, { past: [...getHistory().past, step], future: getHistory().future.filter((s) => s !== step) });
      opts.onError?.(e);
      return null;
    }
    return step;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, qc, projectId, setHistory]);

  /** Re-apply the last undone step with fresh ids (the reverted originals stay in the audit trail). */
  const redo = useCallback(async (): Promise<HistoryStep | null> => {
    const { step, next } = popRedo(getHistory());
    if (!step) return null;
    const batchId = step.batchId ? newId("batch") : null;
    const reqs = reissue(step.redo, batchId);
    const replay: HistoryStep = { ...step, ids: reqs.map((r) => r.id!), redo: reqs, batchId };
    setHistory(projectId, { past: [...next.past.slice(0, -1), replay], future: next.future });
    const res = await apply(reqs, { label: step.label, record: false, batchId });
    return res ? replay : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apply, projectId, setHistory]);

  return { apply, undo, redo };
}

/** Revert a single correction outside the history (e.g. "תיקון לא הותאם" → בטל תיקון). */
export function useRevertCorrection(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revertCorrection(projectId, id),
    onSuccess: (c) => {
      qc.setQueryData<Correction[]>(correctionsKey(projectId), (cur) => (cur ?? []).map((x) => (x.id === c.id ? c : x)));
      invalidateAfterCorrection(qc, projectId);
    },
  });
}

/* ---------------- review queue ---------------- */

/** Ranked queue; re-read when the latest build changes (the queue is computed from the build + live corrections). */
export function useReviewQueue(projectId: string, buildId: string | null = null, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["review-queue", projectId, buildId],
    queryFn: () => api.getReviewQueue(projectId),
    enabled,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
}

/* ---------------- room settings ---------------- */

export const roomSettingsKey = (projectId: string, sheetId: string, roomId: string) => ["room-settings", projectId, sheetId, roomId] as const;

/** Settings of one room (stored, or the type defaults with `isDefault`). */
export function useRoomSettings(projectId: string, sheetId: string | null, roomId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: roomSettingsKey(projectId, sheetId ?? "", roomId ?? ""),
    enabled: Boolean(sheetId && roomId),
    queryFn: () => api.getRoomSettings(projectId, sheetId!, roomId!),
    staleTime: 60_000,
  });
}

export function usePutRoomSettings(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { sheetId: string; roomId: string; settings: RoomSettings }) => api.putRoomSettings(projectId, v.sheetId, v.roomId, v.settings),
    onMutate: async (v) => {
      const key = roomSettingsKey(projectId, v.sheetId, v.roomId);
      const prev = qc.getQueryData<RoomSettingsResponse>(key);
      const doc: RoomSettingsDoc = { ...v.settings, id: `${v.sheetId}__${v.roomId}`, sheetId: v.sheetId, roomId: v.roomId };
      qc.setQueryData<RoomSettingsResponse>(key, { settings: doc, isDefault: false });
      return { prev, key };
    },
    onError: (_e, _v, ctx) => {
      if (ctx) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSuccess: (res, v) => {
      qc.setQueryData(roomSettingsKey(projectId, v.sheetId, v.roomId), res);
      invalidateAfterCorrection(qc, projectId);
    },
  });
}

/* ---------------- learn from correction (find similar) ---------------- */

export function useFindSimilar(projectId: string) {
  const api = useApi();
  return useMutation({ mutationFn: (req: FindSimilarRequest) => api.findSimilar(projectId, req) });
}

/** Polls the search doc until it is done (real: Firestore `similarSearches/{id}`; here GET). */
export function useSimilarSearch(projectId: string, initial: SimilarSearch | null) {
  const api = useApi();
  const id = initial?.id ?? null;
  return useQuery({
    queryKey: ["similar-search", projectId, id],
    enabled: Boolean(id),
    queryFn: () => api.getSimilarSearch(projectId, id!),
    initialData: initial && (initial.status === "succeeded" || initial.status === "failed") ? initial : undefined,
    refetchInterval: (q) => {
      const st = (q.state.data as SimilarSearch | undefined)?.status;
      return st === "succeeded" || st === "failed" ? false : 300;
    },
  });
}

export type { CorrectionsResponse };
