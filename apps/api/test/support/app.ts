import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module';
import { ID_TOKEN_VERIFIER } from '../../src/auth/id-token-verifier';
import { configureApp } from '../../src/bootstrap';
import type { AppConfig } from '../../src/config/config';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { REPOSITORY } from '../../src/db/repository';
import { INGEST_QUEUE, InMemoryIngestQueue } from '../../src/queue/ingest-queue';
import { InMemoryObjectStorage } from '../../src/uploads/storage/in-memory.storage';
import { OBJECT_STORAGE } from '../../src/uploads/storage/object-storage';
import { FakeIdTokenVerifier } from './fake-verifier';

export interface TestApp {
  app: NestExpressApplication;
  repo: InMemoryRepository;
  queue: InMemoryIngestQueue;
  storage: InMemoryObjectStorage;
  auth: FakeIdTokenVerifier;
  cfg: AppConfig;
}

/** Boots the real AppModule with in-memory Firestore/Storage/PubSub and a fake ID-token verifier. */
export async function createTestApp(cfg: AppConfig): Promise<TestApp> {
  const repo = new InMemoryRepository();
  const queue = new InMemoryIngestQueue();
  const storage = new InMemoryObjectStorage();
  const auth = new FakeIdTokenVerifier();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] })
    .overrideProvider(REPOSITORY)
    .useValue(repo)
    .overrideProvider(INGEST_QUEUE)
    .useValue(queue)
    .overrideProvider(OBJECT_STORAGE)
    .useValue(storage)
    .overrideProvider(ID_TOKEN_VERIFIER)
    .useValue(auth)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, cfg);
  await app.init();
  return { app, repo, queue, storage, auth, cfg };
}
