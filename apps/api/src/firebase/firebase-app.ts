import { getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import type { AppConfig } from '../config/config';

const APP_NAME = 'kamutan-api';

/**
 * Single firebase-admin app. Credentials come from Application Default
 * Credentials (Cloud Functions runtime SA) or GOOGLE_APPLICATION_CREDENTIALS
 * locally — never from code or config files. Emulators are honoured through the
 * standard *_EMULATOR_HOST variables.
 */
export function firebaseApp(cfg: Pick<AppConfig, 'GOOGLE_CLOUD_PROJECT' | 'FIREBASE_STORAGE_BUCKET'>): App {
  if (getApps().some((a) => a.name === APP_NAME)) return getApp(APP_NAME);
  return initializeApp({ projectId: cfg.GOOGLE_CLOUD_PROJECT, storageBucket: cfg.FIREBASE_STORAGE_BUCKET }, APP_NAME);
}
