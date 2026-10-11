import { DynamicModule, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { LocalStorageController } from './local-storage.controller';
import { LocalObjectStorage } from './storage/local.storage';
import { OBJECT_STORAGE, type ObjectStorage } from './storage/object-storage';
import { SupabaseObjectStorage } from './storage/supabase.storage';
import { UploadTokenSigner } from './upload-token';
import { UploadsController } from './uploads.controller';
import { UPLOAD_TOKEN_SIGNER, UploadsService } from './uploads.service';

export function createObjectStorage(cfg: AppConfig): ObjectStorage {
  if (cfg.STORAGE_DRIVER === 'supabase') {
    return new SupabaseObjectStorage(
      cfg.SUPABASE_URL as string,
      cfg.SUPABASE_SERVICE_ROLE_KEY as string,
      cfg.STORAGE_BUCKET,
    );
  }
  return new LocalObjectStorage(cfg.STORAGE_LOCAL_DIR, cfg.PUBLIC_API_URL, cfg.UPLOAD_TOKEN_SECRET as string);
}

@Module({})
export class UploadsModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: UploadsModule,
      controllers: [UploadsController, ...(cfg.STORAGE_DRIVER === 'local' ? [LocalStorageController] : [])],
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
    };
  }
}
