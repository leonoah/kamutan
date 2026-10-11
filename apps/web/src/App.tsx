import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { ApiContext, createApiClient } from "@/api/client";
import type { ApiClient } from "@/api/types";
import { Toaster } from "@/components/ui/toast";
import { createRouter } from "@/routes/router";

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
  });
}

export function Providers({ api, queryClient, children }: { api: ApiClient; queryClient: QueryClient; children: ReactNode }) {
  return (
    <ApiContext.Provider value={api}>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </ApiContext.Provider>
  );
}

export function App() {
  const [api] = useState(createApiClient);
  const [qc] = useState(makeQueryClient);
  const [router] = useState(createRouter);
  return (
    <Providers api={api} queryClient={qc}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </Providers>
  );
}
