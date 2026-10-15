import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { firebaseApp } from '../firebase/firebase-app';
import { FirebaseObjectStorage } from './storage/firebase.storage';
import { InMemoryObjectStorage } from './storage/in-memory.storage';
import { OBJECT_STORAGE, type ObjectStorage } from './storage/object-storage';
import { UploadTokenSigner } from './upload-token';
import { UploadsController } from './uploads.controller';
import { UPLOAD_TOKEN_SIGNER, UploadsService } from './uploads.service';

export function createObjectStorage(cfg: AppConfig): ObjectStorage {
  if (cfg.STORAGE_DRIVER === 'memory') return new InMemoryObjectStorage();
  return new FirebaseObjectStorage(firebaseApp(cfg), cfg.FIREBASE_STORAGE_BUCKET);
}

@Module({
  controllers: [UploadsController],
  providers: [
    UploadsService,
    { provide: OBJECT_STORAGE, inject: [APP_CONFIG], useFactory: createObjectStorage },
    {
      provide: UPLOAD_TOKEN_SIGNER,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => new UploadTokenSigner(c.UPLOAD_TOKEN_SECRET as string),
    },
  ],
  exports: [OBJECT_STORAGE],
})
export class UploadsModule {}
