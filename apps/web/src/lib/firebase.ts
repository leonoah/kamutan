import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import type { Firestore } from "firebase/firestore";
import type { FirebaseStorage } from "firebase/storage";
import { env, firebaseConfig } from "./env";

/**
 * Sprint 8: only App + Auth are in the entry chunk. Firestore and Storage are dynamic imports (`loadFirestore`,
 * `loadStorage`), fetched the first time a screen subscribes to live data or uploads (api/lazyBackend.ts).
 */
export interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
}

let services: FirebaseServices | null = null;

/**
 * Lazily initializes the Firebase web app from VITE_FIREBASE_* (public config —
 * security comes from Auth + Security Rules, ADR 0008). Never called in mock mode.
 */
export function getFirebase(): FirebaseServices {
  if (services) return services;
  if (!env.firebaseConfigured) {
    throw new Error("Firebase is not configured: set VITE_FIREBASE_* (see apps/web/.env.firebase) or VITE_USE_MOCKS=true");
  }
  const app = getApps()[0] ?? initializeApp(firebaseConfig);
  const auth = getAuth(app);
  auth.languageCode = "he"; // Hebrew emails / Google consent screen
  services = { app, auth };
  void maybeStartAnalytics(app);
  return services;
}

/** Analytics only with explicit consent (default OFF — privacy, 06_security). Loaded lazily so it isn't even bundled into the main chunk. */
export async function maybeStartAnalytics(app: FirebaseApp, consent = env.analyticsConsent): Promise<boolean> {
  if (!consent || !firebaseConfig.measurementId) return false;
  const { getAnalytics, isSupported } = await import("firebase/analytics");
  if (!(await isSupported())) return false;
  getAnalytics(app);
  return true;
}

export async function loadFirestore(): Promise<Firestore> {
  const { getFirestore } = await import("firebase/firestore");
  return getFirestore(getFirebase().app);
}
export async function loadStorage(): Promise<FirebaseStorage> {
  const { getStorage } = await import("firebase/storage");
  return getStorage(getFirebase().app);
}

/** Test seam. */
export function resetFirebaseForTests() {
  services = null;
}
