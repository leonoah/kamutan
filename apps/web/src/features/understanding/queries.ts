import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useApi } from "@/api/client";
import type {
  DetectionsArtifact,
  LegendArtifact,
  LegendEntry,
  LegendEntryPage,
  LinksArtifact,
  OverlayManifest,
  PatchLegendEntryRequest,
  ResolveUnknownClusterRequest,
  RoomsArtifact,
  SheetRow,
} from "@/api/types";
import { applyClusterResolution } from "./model";
import { fetchArtifact } from "./artifacts";

export { fetchArtifact };

/** Signed URLs live 15 min → refresh the overlay well before. */
const OVERLAY_STALE_MS = 10 * 60_000;

export interface OverlayData {
  manifest: OverlayManifest;
  legend: LegendArtifact | null;
  detections: DetectionsArtifact | null;
  rooms: RoomsArtifact | null;
  /** Sprint 3: switch↔luminaire link graph (null when the worker produced none). */
  links: LinksArtifact | null;
}

export const overlayKey = (projectId: string, sheetId: string, versionId: string) => ["overlay", projectId, sheetId, versionId] as const;

/** Overlay (legend + detections + rooms) of a sheet's current version. Disabled until the version is ready. */
export function useOverlay(projectId: string, row: SheetRow | null | undefined) {
  const api = useApi();
  const sheetId = row?.sheet.id ?? "";
  const versionId = row?.version?.id ?? "";
  return useQuery({
    queryKey: overlayKey(projectId, sheetId, versionId),
    enabled: Boolean(row && row.version?.status === "ready"),
    staleTime: OVERLAY_STALE_MS,
    retry: 1,
    queryFn: async ({ signal }): Promise<OverlayData> => {
      const manifest = await api.getOverlay(projectId, sheetId, versionId);
      const soft = <T,>(p: Promise<T>) => p.catch(() => null);
      const [legend, detections, rooms, links] = await Promise.all([
        manifest.legend ? soft(fetchArtifact<LegendArtifact>(manifest.legend.url, "kamutan.legend/1", signal)) : null,
        // Detections are the point of the overlay: a failure here is an error, not "no data".
        manifest.detections ? fetchArtifact<DetectionsArtifact>(manifest.detections.url, "kamutan.detections/1", signal) : null,
        manifest.rooms ? soft(fetchArtifact<RoomsArtifact>(manifest.rooms.url, "kamutan.rooms/1", signal)) : null,
        manifest.links ? soft(fetchArtifact<LinksArtifact>(manifest.links.url, "kamutan.links/1", signal)) : null,
      ]);
      return { manifest, legend, detections, rooms, links };
    },
  });
}

/* ---------------- legend entries ---------------- */

export const legendKey = (projectId: string) => ["legend-entries", projectId] as const;

/** All legend entries of the project (pages followed, capped at 20 × 200). */
export function useLegendEntries(projectId: string) {
  const api = useApi();
  return useQuery({
    queryKey: legendKey(projectId),
    staleTime: 60_000,
    queryFn: async () => {
      const items: LegendEntry[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const page: LegendEntryPage = await api.listLegendEntries(projectId, { limit: 200, ...(cursor ? { cursor } : {}) });
        items.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return items;
    },
  });
}

/** Optimistic local state of a patch (the server is the source of truth on success). */
function optimistic(e: LegendEntry, req: PatchLegendEntryRequest): LegendEntry {
  if (req.action === "ignore") return { ...e, status: "ignored" };
  return {
    ...e,
    status: "confirmed",
    class: req.class ?? e.class ?? e.suggestedClass,
    ...(req.label !== undefined ? { label: req.label } : {}),
    ...(req.itemCode !== undefined ? { itemCode: req.itemCode } : {}),
  };
}

export function usePatchLegendEntry(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, req }: { id: string; req: PatchLegendEntryRequest }) => api.patchLegendEntry(projectId, id, req),
    onMutate: async ({ id, req }) => {
      await qc.cancelQueries({ queryKey: legendKey(projectId) });
      const prev = qc.getQueryData<LegendEntry[]>(legendKey(projectId));
      qc.setQueryData<LegendEntry[]>(legendKey(projectId), (cur) => cur?.map((e) => (e.id === id ? optimistic(e, req) : e)));
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(legendKey(projectId), ctx.prev);
    },
    onSuccess: (res) => {
      qc.setQueryData<LegendEntry[]>(legendKey(projectId), (cur) => cur?.map((e) => (e.id === res.entry.id ? { ...e, ...res.entry } : e)));
      // A confirmed / reassigned class changes the detections matched to that entry.
      void qc.invalidateQueries({ queryKey: ["overlay", projectId] });
    },
  });
}

/** Undo a local "confirmed/ignored" back to suggested (UI only until the API has an un-confirm action). */
export function setLocalEntry(qc: QueryClient, projectId: string, entry: LegendEntry) {
  qc.setQueryData<LegendEntry[]>(legendKey(projectId), (cur) => cur?.map((e) => (e.id === entry.id ? entry : e)));
}

/* ---------------- unknown clusters ---------------- */

export interface ResolveVars {
  clusterId: string;
  sheetId: string;
  versionId: string;
  /** Class id, or null for "לא רלוונטי". */
  cls: string | null;
  remember: boolean;
}

/** "מה זה?" — answer once per cluster. Optimistic: the overlay updates at once and rolls back on error. */
export function useResolveCluster(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: ResolveVars) => {
      const base = { sheetId: v.sheetId, versionId: v.versionId, createLegendEntry: v.cls !== null && v.remember };
      const req: ResolveUnknownClusterRequest = v.cls === null ? { ...base, ignore: true } : { ...base, class: v.cls };
      return api.resolveUnknownCluster(projectId, v.clusterId, req);
    },
    onMutate: async (v) => {
      const key = overlayKey(projectId, v.sheetId, v.versionId);
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<OverlayData>(key);
      if (prev?.detections)
        qc.setQueryData<OverlayData>(key, { ...prev, detections: applyClusterResolution(prev.detections, v.clusterId, v.cls) });
      return { prev, key };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: legendKey(projectId) });
    },
  });
}
