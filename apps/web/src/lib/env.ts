export const env = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? "",
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? "",
  apiUrl: (import.meta.env.VITE_API_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
  useMocks: import.meta.env.VITE_USE_MOCKS === "true",
} as const;
