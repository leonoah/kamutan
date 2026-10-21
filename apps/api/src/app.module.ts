import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { BoqModule } from './boq/boq.module';
import { RolesGuard } from './auth/roles.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { loggerParams } from './common/logging';
import type { AppConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './db/database.module';
import { GovernanceModule } from './governance/governance.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { OrgsModule } from './orgs/orgs.module';
import { ProjectsModule } from './projects/projects.module';
import { QueueModule } from './queue/queue.module';
import { ReviewModule } from './review/review.module';
import { SheetsModule } from './sheets/sheets.module';
import { UnderstandingModule } from './understanding/understanding.module';
import { UploadsModule } from './uploads/uploads.module';

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(cfg),
        LoggerModule.forRoot(loggerParams(cfg)),
        // In-memory store: per function instance. Shared store + per-org quotas are a follow-up (NOTES.md).
        ThrottlerModule.forRoot([{ name: 'default', ttl: cfg.THROTTLE_TTL_MS, limit: cfg.THROTTLE_LIMIT }]),
        DatabaseModule,
        QueueModule,
        AuthModule,
        HealthModule,
        OrgsModule,
        ProjectsModule,
        UploadsModule,
        SheetsModule,
        UnderstandingModule,
        BoqModule,
        ReviewModule,
        GovernanceModule,
        JobsModule,
      ],
      providers: [
        // Order matters: authenticate → rate-limit per user → authorize.
        { provide: APP_GUARD, useExisting: AuthGuard },
        { provide: APP_GUARD, useClass: UserThrottlerGuard },
        { provide: APP_GUARD, useExisting: RolesGuard },
        { provide: APP_FILTER, useClass: HttpExceptionFilter },
      ],
    };
  }
}
