import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { firebaseApp } from '../firebase/firebase-app';
import { SheetsController } from './sheets.controller';
import { SheetsService } from './sheets.service';
import { CachingUrlSigner, FakeUrlSigner, FirebaseUrlSigner, URL_SIGNER, type UrlSigner } from './url-signer';

export function createUrlSigner(cfg: AppConfig): UrlSigner {
  const inner =
    cfg.STORAGE_DRIVER === 'memory'
      ? new FakeUrlSigner(cfg.FIREBASE_STORAGE_BUCKET, cfg.SIGNED_URL_TTL_SECONDS)
      : new FirebaseUrlSigner(firebaseApp(cfg), cfg.FIREBASE_STORAGE_BUCKET, cfg.SIGNED_URL_TTL_SECONDS);
  // Reuse a URL while it still has >= 2/3 of its lifetime left (10 of 15 minutes).
  return new CachingUrlSigner(inner, Math.floor((cfg.SIGNED_URL_TTL_SECONDS * 1000 * 2) / 3));
}

@Module({
  controllers: [SheetsController],
  providers: [SheetsService, { provide: URL_SIGNER, inject: [APP_CONFIG], useFactory: createUrlSigner }],
})
export class SheetsModule {}
