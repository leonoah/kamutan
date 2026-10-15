import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module';
import { ID_TOKEN_VERIFIER } from '../../src/auth/id-token-verifier';
import { configureApp } from '../../src/bootstrap';
import { BOQ_STORAGE, type InMemoryBoqStorage } from '../../src/boq/boq-storage';
import { BOQ_REPOSITORY } from '../../src/db/boq-repository';
import type { InMemoryBoqRepository } from '../../src/db/boq-memory.repository';
import type { AppConfig } from '../../src/config/config';
import { InMemoryRepository } from '../../src/db/in-memory.repository';
import { REPOSITORY } from '../../src/db/repository';
import { INGEST_QUEUE, InMemoryIngestQueue } from '../../src/queue/ingest-queue';
import { FakeUrlSigner, URL_SIGNER } from '../../src/sheets/url-signer';
import { ARTIFACT_READER, InMemoryArtifactReader } from '../../src/understanding/artifact-reader';
import { InMemoryObjectStorage } from '../../src/uploads/storage/in-memory.storage';
import { OBJECT_STORAGE } from '../../src/uploads/storage/object-storage';
import { FakeIdTokenVerifier } from './fake-verifier';

export interface TestApp {
  app: NestExpressApplication;
  repo: InMemoryRepository;
  queue: InMemoryIngestQueue;
  storage: InMemoryObjectStorage;
  signer: FakeUrlSigner;
  artifacts: InMemoryArtifactReader;
  auth: FakeIdTokenVerifier;
  cfg: AppConfig;
  /** Sprint 3 */
  boq: InMemoryBoqRepository;
  boqStorage: InMemoryBoqStorage;
}

/** Boots the real AppModule with in-memory Firestore/Storage/PubSub and a fake ID-token verifier. */
export async function createTestApp(cfg: AppConfig): Promise<TestApp> {
  const repo = new InMemoryRepository();
  const queue = new InMemoryIngestQueue();
  const storage = new InMemoryObjectStorage();
  const auth = new FakeIdTokenVerifier();
  const signer = new FakeUrlSigner('test-bucket', cfg.SIGNED_URL_TTL_SECONDS);
  const artifacts = new InMemoryArtifactReader();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(cfg)] })
    .overrideProvider(REPOSITORY)
    .useValue(repo)
    .overrideProvider(INGEST_QUEUE)
    .useValue(queue)
    .overrideProvider(OBJECT_STORAGE)
    .useValue(storage)
    .overrideProvider(URL_SIGNER)
    .useValue(signer)
    .overrideProvider(ARTIFACT_READER)
    .useValue(artifacts)
    .overrideProvider(ID_TOKEN_VERIFIER)
    .useValue(auth)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app, cfg);
  await app.init();
  return { app, repo, queue, storage, signer, artifacts, auth, cfg, boq: app.get(BOQ_REPOSITORY), boqStorage: app.get(BOQ_STORAGE) };
}
