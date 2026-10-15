import { create } from "zustand";
import type { AuthSession } from "@/features/auth/authService";

type AuthStatus = "loading" | "signedIn" | "signedOut";

interface AuthState {
  status: AuthStatus;
  session: AuthSession | null;
  setSession: (s: AuthSession | null) => void;
}

/** Driven exclusively by AuthService.onChange (Firebase onAuthStateChanged). */
export const useAuthStore = create<AuthState>((set) => ({
  status: "loading",
  session: null,
  setSession: (session) => set({ session, status: session ? "signedIn" : "signedOut" }),
}));
