import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getStorage, type FirebaseStorage } from "firebase/storage";
import { env, firebaseConfig } from "./env";

export interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
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
  services = { app, auth, db: getFirestore(app), storage: getStorage(app) };
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

/** Test seam. */
export function resetFirebaseForTests() {
  services = null;
}
