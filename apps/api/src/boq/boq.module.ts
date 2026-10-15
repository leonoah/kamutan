import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { firebaseApp } from '../firebase/firebase-app';
import { LibraryController, RulesController, TemplatesController } from '../library/library.controller';
import { LibraryService } from '../library/library.service';
import { ARTIFACT_READER } from '../understanding/artifact-reader';
import { createArtifactReader } from '../understanding/understanding.module';
import { BoqController } from './boq.controller';
import { BoqService } from './boq.service';
import { BOQ_STORAGE, FirebaseBoqStorage, InMemoryBoqStorage, type BoqStorage } from './boq-storage';

export function createBoqStorage(cfg: AppConfig): BoqStorage {
  return cfg.STORAGE_DRIVER === 'memory' ? new InMemoryBoqStorage() : new FirebaseBoqStorage(firebaseApp(cfg), cfg.FIREBASE_STORAGE_BUCKET);
}

/** Sprint 3: library, templates, rules, project BOQ + export. */
@Global()
@Module({
  controllers: [LibraryController, TemplatesController, RulesController, BoqController],
  providers: [
    LibraryService,
    BoqService,
    { provide: BOQ_STORAGE, inject: [APP_CONFIG], useFactory: createBoqStorage },
    // links.json.gz for the evidence listing (same reader/caps as the overlay).
    { provide: ARTIFACT_READER, inject: [APP_CONFIG], useFactory: createArtifactReader },
  ],
  exports: [BOQ_STORAGE],
})
export class BoqModule {}
