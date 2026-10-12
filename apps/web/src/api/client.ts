import { createContext, useContext } from "react";
import { env } from "@/lib/env";
import { getFirebase } from "@/lib/firebase";
import { createHttpClient } from "./http";
import { createMockBackend } from "./mock";
import { createFirebaseUploads, createFirestoreRealtime } from "./firebaseBackend";
import type { ApiClient, Backend } from "./types";
import { getIdToken } from "@/features/auth/authService";

export * from "./types";

/** Mock backend when VITE_USE_MOCKS=true; otherwise REST API + Firebase Storage + Firestore listeners. */
export function createBackend(): Backend {
  if (env.useMocks) return createMockBackend();
  const fb = getFirebase();
  return {
    api: createHttpClient(getIdToken),
    uploads: createFirebaseUploads(fb.storage),
    realtime: createFirestoreRealtime(fb.db),
  };
}

export const BackendContext = createContext<Backend | null>(null);

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error("useBackend must be used inside <BackendContext.Provider>");
  return b;
}

export const useApi = (): ApiClient => useBackend().api;
