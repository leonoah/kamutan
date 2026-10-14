import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { InMemoryRepository } from './in-memory.repository';
import { getFirestore } from 'firebase-admin/firestore';
import { getFirebaseApp } from '../firebase/firebase-app';
import { FirestoreRepository } from './firestore.repository';
import { REPOSITORY, type Repository } from './repository';

export function createRepository(cfg: AppConfig): Repository {
  if (cfg.DATA_DRIVER === 'memory') return new InMemoryRepository();
  return new FirestoreRepository(getFirestore(getFirebaseApp(cfg)));
}

@Global()
@Module({
  providers: [{ provide: REPOSITORY, inject: [APP_CONFIG], useFactory: createRepository }],
  exports: [REPOSITORY],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(REPOSITORY) private readonly repo: Repository) {}

  async onApplicationShutdown(): Promise<void> {
    await this.repo.close();
  }
}
