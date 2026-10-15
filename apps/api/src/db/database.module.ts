import { Global, Module } from '@nestjs/common';
import { getFirestore } from 'firebase-admin/firestore';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { firebaseApp } from '../firebase/firebase-app';
import { BOQ_REPOSITORY, type BoqRepository } from './boq-repository';
import { FirestoreBoqRepository } from './boq-firestore.repository';
import { InMemoryBoqRepository } from './boq-memory.repository';
import { FirestoreRepository } from './firestore.repository';
import { InMemoryRepository } from './in-memory.repository';
import { REPOSITORY, type Repository } from './repository';

export function createRepository(cfg: AppConfig): Repository {
  if (cfg.DATA_DRIVER === 'memory') return new InMemoryRepository();
  const db = getFirestore(firebaseApp(cfg));
  return new FirestoreRepository(db);
}

/** Sprint 3 collections share the core store (in-memory docs map / Firestore client + audit chain). */
export function createBoqRepository(core: Repository): BoqRepository {
  if (core instanceof InMemoryRepository) return new InMemoryBoqRepository(core);
  if (core instanceof FirestoreRepository) return new FirestoreBoqRepository(core);
  throw new Error('unsupported repository for the BOQ repository');
}

@Global()
@Module({
  providers: [
    { provide: REPOSITORY, inject: [APP_CONFIG], useFactory: createRepository },
    { provide: BOQ_REPOSITORY, inject: [REPOSITORY], useFactory: createBoqRepository },
  ],
  exports: [REPOSITORY, BOQ_REPOSITORY],
})
export class DatabaseModule {}
