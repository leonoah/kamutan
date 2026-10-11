import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import type { AppConfig } from '../../src/config/config';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { REPOSITORY } from '../../src/db/repository';
import { INGEST_QUEUE, InMemoryIngestQueue } from '../../src/queue/ingest-queue';

export interface TestApp {
  app: NestExpressApplication;
  repo: InMemoryRepository;
  queue: InMemoryIngestQueue;
  cfg: AppConfig;
}

/** Boots the real AppModule with a fake repository and the in-memory queue. */
export async function createTestApp(cfg: AppConfig): Promise<TestApp> {
  const repo = new InMemoryRepository();
  const queue = new InMemoryIngestQueue();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] })
    .overrideProvider(REPOSITORY)
    .useValue(repo)
    .overrideProvider(INGEST_QUEUE)
    .useValue(queue)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, cfg);
  await app.init();
  return { app, repo, queue, cfg };
}
