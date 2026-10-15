import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { INGEST_QUEUE, InMemoryIngestQueue, PubSubIngestQueue, type IngestQueue } from './ingest-queue';

export function createIngestQueue(cfg: AppConfig): IngestQueue {
  if (cfg.QUEUE_DRIVER === 'pubsub') return new PubSubIngestQueue(cfg.GOOGLE_CLOUD_PROJECT, cfg.INGEST_TOPIC);
  return new InMemoryIngestQueue(cfg.INGEST_TOPIC);
}

@Global()
@Module({
  providers: [{ provide: INGEST_QUEUE, inject: [APP_CONFIG], useFactory: createIngestQueue }],
  exports: [INGEST_QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(@Inject(INGEST_QUEUE) private readonly queue: IngestQueue) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
