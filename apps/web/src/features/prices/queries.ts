import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useApi } from "@/api/client";
import { VAT_RATE_DEFAULT, type ApplyPriceImportRequest, type BoqLine, type BoqLinesResponse, type BulkPriceRequest, type LibraryItem, type LibraryItemPage } from "@/api/types";
import { useCurrentOrg } from "@/features/org/useCurrentOrg";
import { boqLinesKey } from "@/features/boq/queries";
import { useAuthStore } from "@/stores/authStore";
import { applyPriceOverride, type PricingSettings } from "./model";

/** VAT (org setting) + the project's discount / markup — what every total on screen is computed with. */
export function usePricing(projectId: string | null | undefined): PricingSettings {
  const { org } = useCurrentOrg();
  const api = useApi();
  // same key as useProject: the hub / settings page and the totals share one cache entry
  const project = useQuery({ queryKey: ["project", projectId ?? ""], queryFn: () => api.getProject(projectId!), enabled: Boolean(projectId), retry: false });
  return { vatRate: org?.settings?.vatRate ?? VAT_RATE_DEFAULT, adjustmentPct: projectId ? (project.data?.pricing?.adjustmentPct ?? null) : null };
}

function patchCached(qc: QueryClient, projectId: string, fn: (l: BoqLine) => BoqLine) {
  const prev = qc.getQueriesData<BoqLinesResponse>({ queryKey: boqLinesKey(projectId) });
  void qc.cancelQueries({ queryKey: boqLinesKey(projectId) });
  qc.setQueriesData<BoqLinesResponse>({ queryKey: boqLinesKey(projectId) }, (cur) => (cur ? { ...cur, items: cur.items.map(fn) } : cur));
  return () => prev.forEach(([k, v]) => qc.setQueryData(k, v));
}

/** The line's own unit price ("✎ ידני") or `null` = back to the price list. Optimistic; history + preview refetch. */
export function useLinePrice(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const uid = useAuthStore((s) => s.session?.uid ?? null);
  return useMutation({
    mutationFn: ({ lineId, amount, reason }: { lineId: string; amount: number | null; reason: string | null }) =>
      api.patchBoqLine(projectId, lineId, { priceOverride: amount, ...(amount !== null && reason ? { reason } : {}) }),
    onMutate: ({ lineId, amount, reason }) => ({ rollback: patchCached(qc, projectId, (l) => (l.id === lineId ? applyPriceOverride(l, amount, reason, uid) : l)) }),
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSuccess: (line) => {
      // the PATCH answer is a priced line (API); the summary totals come with the next GET boq
      patchCached(qc, projectId, (l) => (l.id === line.id ? line : l));
      void qc.invalidateQueries({ queryKey: boqLinesKey(projectId) });
      void qc.invalidateQueries({ queryKey: ["boq-document", projectId] });
      void qc.invalidateQueries({ queryKey: ["line-history", projectId] });
      void qc.invalidateQueries({ queryKey: ["boq-compare", projectId] });
    },
  });
}

/** Library prices changed → every BOQ, document and comparison shows other totals. */
function invalidatePriced(qc: QueryClient, orgId: string) {
  void qc.invalidateQueries({ queryKey: ["library-items", orgId] });
  void qc.invalidateQueries({ queryKey: ["boq-lines"] });
  void qc.invalidateQueries({ queryKey: ["boq-document"] });
  void qc.invalidateQueries({ queryKey: ["boq-compare"] });
}

/** One item's price (inline edit), optimistic in every cached library page. */
export function useItemPrice(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, amount }: { itemId: string; amount: number | null }) => api.patchLibraryItem(orgId, itemId, { price: amount }),
    onMutate: ({ itemId, amount }) => {
      const prev = qc.getQueriesData<LibraryItemPage>({ queryKey: ["library-items", orgId] });
      qc.setQueriesData<LibraryItemPage>({ queryKey: ["library-items", orgId] }, (cur) =>
        cur
          ? {
              ...cur,
              items: cur.items.map((i): LibraryItem =>
                i.id === itemId ? { ...i, price: amount === null ? null : { amount, currency: "ILS", updatedAt: new Date().toISOString(), by: null, source: "manual", importId: null } } : i,
              ),
            }
          : cur,
      );
      return { rollback: () => prev.forEach(([k, v]) => qc.setQueryData(k, v)) };
    },
    onError: (_e, _v, ctx) => ctx?.rollback(),
    onSettled: () => invalidatePriced(qc, orgId),
  });
}

export function useBulkPrices(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({ mutationFn: (req: BulkPriceRequest) => api.bulkPatchPrices(orgId, req), onSettled: () => invalidatePriced(qc, orgId) });
}

export function useApplyPriceImport(orgId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ importId, req }: { importId: string; req: ApplyPriceImportRequest }) => api.applyPriceImport(orgId, importId, req),
    onSettled: () => invalidatePriced(qc, orgId),
  });
}

/** PATCH /projects/:pid/boq/pricing {adjustmentPct} (editor+): null / 0 removes the discount / markup. */
export function useProjectPricing(projectId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (adjustmentPct: number | null) => api.patchProjectPricing(projectId, adjustmentPct),
    onSuccess: (r) => {
      qc.setQueryData<import("@/api/types").Project>(["project", projectId], (p) => (p ? { ...p, pricing: r.pricing } : p));
      void qc.invalidateQueries({ queryKey: ["project", projectId] });
      void qc.invalidateQueries({ queryKey: boqLinesKey(projectId) });
      void qc.invalidateQueries({ queryKey: ["boq-document", projectId] });
    },
  });
}
