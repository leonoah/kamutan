import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/api/client";
import type { MyOrg } from "@/api/types";
import { useAuthStore } from "@/stores/authStore";
import { useOrgStore } from "@/stores/orgStore";

export function useMe() {
  const api = useApi();
  const uid = useAuthStore((s) => s.session?.uid);
  return useQuery({ queryKey: ["me", uid], queryFn: () => api.getMe(), enabled: !!uid, staleTime: 5 * 60_000 });
}

/** Effective org: the persisted choice if the user is still a member, else the first org. */
export function useCurrentOrg(): { org: MyOrg | null; orgs: MyOrg[]; isLoading: boolean; isError: boolean; refetch: () => void } {
  const me = useMe();
  const selected = useOrgStore((s) => s.selectedOrgId);
  const orgs = me.data?.orgs ?? [];
  const org = orgs.find((o) => o.id === selected) ?? orgs[0] ?? null;
  return { org, orgs, isLoading: me.isLoading, isError: me.isError, refetch: () => void me.refetch() };
}

/** For components rendered under <RequireOrg>: the org is guaranteed. */
export function useOrgId(): string {
  const { org } = useCurrentOrg();
  if (!org) throw new Error("useOrgId used outside <RequireOrg>");
  return org.id;
}
