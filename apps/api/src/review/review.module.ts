import { Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config';
import { SheetsModule } from '../sheets/sheets.module';
import { ARTIFACT_READER } from '../understanding/artifact-reader';
import { createArtifactReader } from '../understanding/understanding.module';
import { ReviewArtifacts } from './artifact-views';
import { CorrectionsService } from './corrections.service';
import { RebuildService } from './rebuild.service';
import { ReviewController } from './review.controller';
import { ReviewQueueService } from './review-queue.service';
import { RoomSettingsService } from './room-settings.service';
import { SimilarService } from './similar.service';

/** Sprint 4: corrections, review queue, room settings, learn-from-correction. */
@Module({
  imports: [SheetsModule],
  controllers: [ReviewController],
  providers: [
    RebuildService,
    CorrectionsService,
    ReviewQueueService,
    RoomSettingsService,
    SimilarService,
    ReviewArtifacts,
    { provide: ARTIFACT_READER, inject: [APP_CONFIG], useFactory: createArtifactReader },
  ],
})
export class ReviewModule {}
