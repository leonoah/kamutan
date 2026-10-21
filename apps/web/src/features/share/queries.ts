import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi, useBackend } from "@/api/client";
import type { CreateShareLinkRequest, ShareLink } from "@/api/types";

export function useShareLinks(projectId: string, enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: ["share-links", projectId], queryFn: () => api.listShareLinks(projectId), enabled, staleTime: 0 });
}

export function useCreateShareLink(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateShareLinkRequest) => api.createShareLink(projectId, req),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["share-links", projectId] }),
  });
}

export function useRevokeShareLink(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (linkId: string) => api.revokeShareLink(projectId, linkId),
    onSuccess: (_r, linkId) => {
      // Immediate: mark revoked in the cache, then refetch.
      qc.setQueryData<ShareLink[]>(["share-links", projectId], (cur) => cur?.map((l) => (l.id === linkId ? { ...l, revokedAt: l.revokedAt ?? new Date().toISOString() } : l)));
      void qc.invalidateQueries({ queryKey: ["share-links", projectId] });
    },
  });
}

export type LinkState = "active" | "expired" | "revoked";
export const linkState = (l: Pick<ShareLink, "revokedAt" | "expiresAt">, now = Date.now()): LinkState =>
  l.revokedAt ? "revoked" : Date.parse(l.expiresAt) <= now ? "expired" : "active";

/* ---------------- public viewer ---------------- */

export function useShareMeta(token: string) {
  const { publicShare } = useBackend();
  return useQuery({ queryKey: ["share", token, "meta"], queryFn: () => publicShare.getMeta(token), retry: false, staleTime: 5 * 60_000 });
}
export function useShareBoq(token: string, enabled: boolean) {
  const { publicShare } = useBackend();
  return useQuery({ queryKey: ["share", token, "boq"], queryFn: () => publicShare.getBoq(token), enabled, retry: false, staleTime: 5 * 60_000 });
}
export function useShareOverlay(token: string, sheetId: string | null) {
  const { publicShare } = useBackend();
  return useQuery({
    queryKey: ["share", token, "overlay", sheetId],
    queryFn: () => publicShare.getOverlay(token, sheetId!),
    enabled: Boolean(sheetId),
    retry: false,
    staleTime: 5 * 60_000,
  });
}
