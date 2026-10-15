// NOTE: reference `import.meta.env.X` literally (not via an alias) — vite.config.ts injects
// the .env.firebase values with `define`, which only matches the full expression.
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? "",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || undefined,
} as const;

export const env = {
  /** API is same-origin: Firebase Hosting rewrites /api/** to the `api` function; Vite proxies it in dev. */
  apiBase: "/api/v1",
  useMocks: import.meta.env.VITE_USE_MOCKS === "true",
  analyticsConsent: import.meta.env.VITE_ANALYTICS_CONSENT === "true",
  firebaseConfigured: Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId),
} as const;
