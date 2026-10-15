import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { BackendContext, createBackend } from "@/api/client";
import type { Backend } from "@/api/types";
import { Toaster } from "@/components/ui/toast";
import { createRouter } from "@/routes/router";

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false } },
  });
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
