import { createContext, useContext } from "react";
import { env } from "@/lib/env";
import { getFirebase } from "@/lib/firebase";
import { createHttpClient, createPublicShareClient } from "./http";
import { createMockBackend } from "./mock";
import { createFirebaseUploads, createFirestoreRealtime } from "./firebaseBackend";
import type { ApiClient, Backend } from "./types";
import { getIdToken } from "@/features/auth/authService";

export * from "./types";

/** True on the external share viewer route (`/s/:token`). */
export const isShareViewerPath = (path: string) => /^\/s\/[^/]+\/?$/.test(path);

/**
 * Backend of the external share viewer: ONLY the unauthenticated GET-only public client. Firebase is never
 * initialized (no Auth listener, no ID token, no Firestore channel) and every member API call throws — so nothing
 * on `/s/:token` can write, even by accident (E2E-09).
 */
export function createPublicOnlyBackend(publicShare = createPublicShareClient()): Backend {
  const refuse = (what: string) =>
    new Proxy({} as never, {
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        return () => {
          throw new Error(`${what}.${String(prop)} is not available in the share viewer`);
        };
      },
    });
  return { api: refuse("api"), uploads: refuse("uploads"), realtime: refuse("realtime"), publicShare };
}

/** Mock backend when VITE_USE_MOCKS=true; otherwise REST API + Firebase Storage + Firestore listeners. */
export function createBackend(): Backend {
  const path = typeof location !== "undefined" ? location.pathname : "/";
  if (!env.useMocks && isShareViewerPath(path)) return createPublicOnlyBackend();
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
      // The share viewer demo needs lines (the mock seeds demo links: /s/demo-noah, /s/demo-expired, /s/demo-revoked).
      ...(q.get("mockBoq") === "built" || isShareViewerPath(path) ? { boqPrebuilt: true } : {}),
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
    publicShare: createPublicShareClient(),
  };
}

export const BackendContext = createContext<Backend | null>(null);

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error("useBackend must be used inside <BackendContext.Provider>");
  return b;
}

export const useApi = (): ApiClient => useBackend().api;
