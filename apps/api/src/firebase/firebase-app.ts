import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import type { AppConfig } from '../config/config';

/**
 * Single Firebase Admin app shared by Firestore and Storage.
 * Credentials come from Application Default Credentials: set
 * GOOGLE_APPLICATION_CREDENTIALS to a service-account key file locally, or run on
 * GCP with an attached service account. Set FIRESTORE_EMULATOR_HOST to use the
 * Firestore emulator (no credentials needed).
 */
export function getFirebaseApp(cfg: AppConfig): App {
  const existing = getApps()[0];
  if (existing) return existing;
  return initializeApp({
    projectId: cfg.FIREBASE_PROJECT_ID,
    storageBucket: cfg.STORAGE_BUCKET,
    credential: process.env.FIRESTORE_EMULATOR_HOST ? undefined : applicationDefault(),
  });
}
