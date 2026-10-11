import { create } from "zustand";

export type ThemePref = "system" | "light" | "dark";
const KEY = "kamutan.theme";

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

interface ThemeState {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  pref: read(),
  setPref: (pref) => {
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* ignore */
    }
    applyTheme(pref);
    set({ pref });
  },
}));
