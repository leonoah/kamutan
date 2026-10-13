import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { firebaseApp } from '../firebase/firebase-app';
import { SheetsModule } from '../sheets/sheets.module';
import { ARTIFACT_READER, FirebaseArtifactReader, InMemoryArtifactReader, type ArtifactReader } from './artifact-reader';
import { UnderstandingController } from './understanding.controller';
import { UnderstandingService } from './understanding.service';

export function createArtifactReader(cfg: AppConfig): ArtifactReader {
  return cfg.STORAGE_DRIVER === 'memory' ? new InMemoryArtifactReader() : new FirebaseArtifactReader(firebaseApp(cfg), cfg.FIREBASE_STORAGE_BUCKET);
}

@Module({
  imports: [SheetsModule],
  controllers: [UnderstandingController],
  providers: [UnderstandingService, { provide: ARTIFACT_READER, inject: [APP_CONFIG], useFactory: createArtifactReader }],
})
export class UnderstandingModule {}
