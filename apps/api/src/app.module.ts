import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { RolesGuard } from './auth/roles.guard';
import { UserThrottlerGuard } from './auth/user-throttler.guard';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { loggerParams } from './common/logging';
import type { AppConfig } from './config/config';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './db/database.module';
import { HealthModule } from './health/health.module';
import { OrgsModule } from './orgs/orgs.module';
import { ProjectsModule } from './projects/projects.module';
import { QueueModule } from './queue/queue.module';
import { UploadsModule } from './uploads/uploads.module';

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(cfg),
        LoggerModule.forRoot(loggerParams(cfg)),
        // In-memory store; per-instance limits. Redis storage is a Sprint 1 item (see NOTES.md).
        ThrottlerModule.forRoot([{ name: 'default', ttl: cfg.THROTTLE_TTL_MS, limit: cfg.THROTTLE_LIMIT }]),
        DatabaseModule,
        QueueModule,
        AuthModule,
        HealthModule,
        OrgsModule,
        ProjectsModule,
        UploadsModule.forRoot(cfg),
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
