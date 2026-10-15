import { create } from "zustand";

const KEY = "kamutan.currentOrg";

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

interface OrgState {
  /** User's explicit choice (persisted). The effective org is resolved against /me in useCurrentOrg. */
  selectedOrgId: string | null;
  select: (orgId: string | null) => void;
}

export const useOrgStore = create<OrgState>((set) => ({
  selectedOrgId: read(),
  select: (selectedOrgId) => {
    try {
      if (selectedOrgId) localStorage.setItem(KEY, selectedOrgId);
      else localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    set({ selectedOrgId });
  },
}));
