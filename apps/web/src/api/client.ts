import { createContext, useContext } from "react";
import { env } from "@/lib/env";
import { createHttpClient } from "./http";
import { createMockClient } from "./mock";
import type { ApiClient } from "./types";
import { getAccessToken } from "@/features/auth/authService";

export * from "./types";

/** Picks the adapter: in-memory mocks when VITE_USE_MOCKS=true, otherwise the REST API. */
export function createApiClient(): ApiClient {
  return env.useMocks ? createMockClient() : createHttpClient(getAccessToken);
}

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi must be used inside <ApiContext.Provider>");
  return api;
}
