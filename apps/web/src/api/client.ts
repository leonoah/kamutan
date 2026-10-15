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
  if (env.useMocks) {
    // Dev/demo: ?mockDetections=2000 on the first page load sizes the synthetic overlay (performance checks).
    // Sprint 3: ?mockBlockExport=1 (org blocks export with red lines), ?mockBoq=built (start with a built BOQ),
    // ?mockRole=editor|reviewer|viewer (role of the demo user).
    const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
    const n = Number(q.get("mockDetections"));
    const role = q.get("mockRole");
    return createMockBackend({
      ...(n > 0 ? { fixtureDetections: Math.min(n, 20_000), devIndex: false } : {}),
      ...(q.get("mockBlockExport") === "1" ? { blockExportOnRed: true } : {}),
      ...(q.get("mockBoq") === "built" ? { boqPrebuilt: true } : {}),
      ...(q.get("mockBoq") === "engine" ? { boqEngineOnly: true } : {}),
      ...(role === "editor" || role === "reviewer" || role === "viewer" || role === "admin"
        ? { orgs: [{ id: "org-demo", name: "סטודיו נח לעיצוב פנים", role }] }
        : {}),
    });
  }
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
