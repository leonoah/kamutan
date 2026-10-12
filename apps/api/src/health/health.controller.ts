import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthResponseSchema, type HealthResponse } from '@kamutan/contracts';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { ApiZodResponse } from '../common/zod-openapi';
import { REPOSITORY, type Repository } from '../db/repository';
import { INGEST_QUEUE, type IngestQueue } from '../queue/ingest-queue';

const VERSION = process.env.APP_VERSION ?? '0.2.0';

async function check(fn: () => Promise<void>, timeoutMs = 3000): Promise<'ok' | 'fail'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    return 'ok';
  } catch {
    return 'fail';
  } finally {
    clearTimeout(timer);
  }
}

@ApiTags('health')
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
  ) {}

  /** Liveness: process is up. */
  @Get()
  @ApiZodResponse(200, HealthResponseSchema)
  live(): HealthResponse {
    return { status: 'ok', version: VERSION };
  }

  /** Readiness: Firestore reachable (queue check is a no-op for Pub/Sub). */
  @Get('ready')
  @ApiZodResponse(200, HealthResponseSchema)
  @ApiZodResponse(503, HealthResponseSchema)
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    const [db, queue] = await Promise.all([check(() => this.repo.ping()), check(() => this.queue.ping())]);
    const ok = db === 'ok' && queue === 'ok';
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', version: VERSION, checks: { db, queue } };
  }
}
