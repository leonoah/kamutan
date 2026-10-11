import { IngestSheetVersionJobSchema, JOB_TYPES, QUEUE_NAMES, type IngestSheetVersionJob } from '@kamutan/contracts';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const INGEST_QUEUE = Symbol('INGEST_QUEUE');

export interface EnqueuedJob {
  jobId: string;
  /** False when a job with the same id already existed (idempotent re-enqueue). */
  created: boolean;
}

/** Port for scheduling ingest work. Payload is validated against the contract before enqueue. */
export interface IngestQueue {
  enqueueIngest(payload: IngestSheetVersionJob, opts: { jobId: string }): Promise<EnqueuedJob>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface InMemoryJob {
  id: string;
  name: string;
  queue: string;
  payload: IngestSheetVersionJob;
  enqueuedAt: Date;
}

/** Process-local queue for tests and Redis-less dev. Nothing consumes it. */
export class InMemoryIngestQueue implements IngestQueue {
  readonly jobs: InMemoryJob[] = [];

  async enqueueIngest(payload: IngestSheetVersionJob, opts: { jobId: string }): Promise<EnqueuedJob> {
    const data = IngestSheetVersionJobSchema.parse(payload);
    if (this.jobs.some((j) => j.id === opts.jobId)) return { jobId: opts.jobId, created: false };
    this.jobs.push({
      id: opts.jobId,
      name: JOB_TYPES.ingestSheetVersion,
      queue: QUEUE_NAMES.ingest,
      payload: data,
      enqueuedAt: new Date(),
    });
    return { jobId: opts.jobId, created: true };
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * BullMQ producer for queue `ingest` (consumed by the Python drawing worker via
 * the official `bullmq` Python package). The job id is the `jobs` row id, so
 * re-enqueueing the same job is a no-op (BullMQ dedupes by job id).
 */
export class BullMqIngestQueue implements IngestQueue {
  private readonly connection: IORedis;
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: false, lazyConnect: false });
    this.connection.on('error', () => undefined); // surfaced via ping()/enqueue errors
    this.queue = new Queue(QUEUE_NAMES.ingest, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  async enqueueIngest(payload: IngestSheetVersionJob, opts: { jobId: string }): Promise<EnqueuedJob> {
    const data = IngestSheetVersionJobSchema.parse(payload);
    const existing = await this.queue.getJob(opts.jobId);
    if (existing) return { jobId: opts.jobId, created: false };
    const job = await this.queue.add(JOB_TYPES.ingestSheetVersion, data, { jobId: opts.jobId });
    return { jobId: job.id ?? opts.jobId, created: true };
  }

  async ping(): Promise<void> {
    await this.connection.ping();
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }
}
