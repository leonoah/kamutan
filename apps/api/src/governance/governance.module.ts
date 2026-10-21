import { Module } from '@nestjs/common';
import { BOQ_STORAGE, InMemoryBoqStorage, type BoqStorage } from '../boq/boq-storage';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { firebaseApp } from '../firebase/firebase-app';
import { ReviewArtifacts } from '../review/artifact-views';
import { PublicShareController } from '../share/public-share.controller';
import { PublicShareService, SHARE_RATE_LIMITER, TILE_WATERMARKER } from '../share/public-share.service';
import { ShareLinksService } from '../share/share-links.service';
import { ShareRateLimiter } from '../share/share-rate-limit';
import { resolveFontFile, TileWatermarker } from '../share/watermark';
import { ARTIFACT_READER, InMemoryArtifactReader, type ArtifactReader } from '../understanding/artifact-reader';
import { createArtifactReader } from '../understanding/understanding.module';
import { InMemoryObjectStorage } from '../uploads/storage/in-memory.storage';
import { OBJECT_STORAGE, type ObjectStorage } from '../uploads/storage/object-storage';
import { UploadsModule } from '../uploads/uploads.module';
import { API_JOBS_QUEUE, InMemoryApiJobsQueue, PubSubApiJobsQueue, type ApiJobsQueue } from './api-jobs-queue';
import { AUTH_ADMIN, FirebaseAuthAdmin, InMemoryAuthAdmin, type AuthAdmin } from './auth-admin';
import { AuditService } from './audit.service';
import { DependentsService } from './dependents.service';
import { ExportsService } from './exports.service';
import { OrgGovernanceController, ProjectGovernanceController } from './governance.controller';
import { FirebaseGovernanceStorage, GOVERNANCE_STORAGE, InMemoryGovernanceStorage, type GovernanceStorage } from './governance-storage';
import { OffboardingService } from './offboarding.service';

/** In memory mode the governance store is linked to the other in-memory stores (one "bucket" for sources + purge). */
export function createGovernanceStorage(cfg: AppConfig, objects: ObjectStorage, boq: BoqStorage, artifacts: ArtifactReader): GovernanceStorage {
  if (cfg.STORAGE_DRIVER !== 'memory') return new FirebaseGovernanceStorage(firebaseApp(cfg), cfg.FIREBASE_STORAGE_BUCKET);
  const s = new InMemoryGovernanceStorage();
  if (objects instanceof InMemoryObjectStorage) s.link(objects.objects);
  if (boq instanceof InMemoryBoqStorage) s.link(boq.objects);
  if (artifacts instanceof InMemoryArtifactReader) s.link(artifacts.objects);
  return s;
}

export function createApiJobsQueue(cfg: AppConfig): ApiJobsQueue {
  return cfg.QUEUE_DRIVER === 'pubsub' ? new PubSubApiJobsQueue(cfg.GOOGLE_CLOUD_PROJECT, cfg.API_JOBS_TOPIC) : new InMemoryApiJobsQueue();
}

export function createAuthAdmin(cfg: AppConfig): AuthAdmin {
  return cfg.DATA_DRIVER === 'memory' ? new InMemoryAuthAdmin() : new FirebaseAuthAdmin(firebaseApp(cfg));
}

/** Sprint 5: audit log + history, marked-PDF exports, share links (+ public viewer API), org settings, offboarding. */
@Module({
  imports: [UploadsModule],
  controllers: [OrgGovernanceController, ProjectGovernanceController, PublicShareController],
  providers: [
    AuditService,
    DependentsService,
    ExportsService,
    OffboardingService,
    ShareLinksService,
    PublicShareService,
    ReviewArtifacts,
    { provide: ARTIFACT_READER, inject: [APP_CONFIG], useFactory: createArtifactReader },
    { provide: GOVERNANCE_STORAGE, inject: [APP_CONFIG, OBJECT_STORAGE, BOQ_STORAGE, ARTIFACT_READER], useFactory: createGovernanceStorage },
    { provide: API_JOBS_QUEUE, inject: [APP_CONFIG], useFactory: createApiJobsQueue },
    { provide: AUTH_ADMIN, inject: [APP_CONFIG], useFactory: createAuthAdmin },
    {
      provide: SHARE_RATE_LIMITER,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) =>
        new ShareRateLimiter({ perMinute: c.SHARE_RATE_LIMIT_PER_MIN, tilePerMinute: c.SHARE_TILE_RATE_LIMIT_PER_MIN, unknownPerMinute: c.SHARE_UNKNOWN_TOKEN_LIMIT, lockoutMs: c.SHARE_LOCKOUT_MS }),
    },
    { provide: TILE_WATERMARKER, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new TileWatermarker(resolveFontFile(c.WATERMARK_FONT_FILE)) },
  ],
  exports: [OffboardingService, DependentsService, API_JOBS_QUEUE, GOVERNANCE_STORAGE, AUTH_ADMIN],
})
export class GovernanceModule {}
