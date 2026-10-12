import { Global, Module } from '@nestjs/common';
import { getFirestore } from 'firebase-admin/firestore';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { firebaseApp } from '../firebase/firebase-app';
import { FirestoreRepository } from './firestore.repository';
import { InMemoryRepository } from './in-memory.repository';
import { REPOSITORY, type Repository } from './repository';

export function createRepository(cfg: AppConfig): Repository {
  if (cfg.DATA_DRIVER === 'memory') return new InMemoryRepository();
  const db = getFirestore(firebaseApp(cfg));
  return new FirestoreRepository(db);
}

@Global()
@Module({
  providers: [{ provide: REPOSITORY, inject: [APP_CONFIG], useFactory: createRepository }],
  exports: [REPOSITORY],
})
export class DatabaseModule {}
