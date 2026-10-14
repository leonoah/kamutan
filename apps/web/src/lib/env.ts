export const env = {
  firebase: {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
    appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "",
  },
  apiUrl: (import.meta.env.VITE_API_URL ?? "http://localhost:3001").replace(/\/+$/, ""),
  useMocks: import.meta.env.VITE_USE_MOCKS === "true",
} as const;
