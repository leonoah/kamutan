import { useState, type ReactNode } from "react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@/api/types";
import { RouterProvider } from "react-router-dom";
import { BackendContext, createBackend } from "@/api/client";
import type { Backend } from "@/api/types";
import { Toaster } from "@/components/ui/toast";
import { createRouter } from "@/routes/router";

/**
 * Sprint 5: any `403 org_offboarding` (API AccessService) means the org was offboarded meanwhile → refetch /me so
 * <RequireOrg> shows the blocked screen (only the admin's export download stays reachable).
 */
export function makeQueryClient() {
  let qc: QueryClient;
  const onError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 403 && e.code === "org_offboarding") void qc.invalidateQueries({ queryKey: ["me"] });
  };
  qc = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
  });
  return qc;
}

export function Providers({ backend, queryClient, children }: { backend: Backend; queryClient: QueryClient; children: ReactNode }) {
  return (
    <BackendContext.Provider value={backend}>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </BackendContext.Provider>
  );
}

export function App() {
  const [backend] = useState(createBackend);
  const [qc] = useState(makeQueryClient);
  const [router] = useState(createRouter);
  return (
    <Providers backend={backend} queryClient={qc}>
      <RouterProvider router={router} />
    </Providers>
  );
}
