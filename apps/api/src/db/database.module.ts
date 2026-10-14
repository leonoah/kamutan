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
import { FirestoreReviewRepository } from './review-firestore.repository';
import { InMemoryReviewRepository } from './review-memory.repository';
import { REVIEW_REPOSITORY, type ReviewRepository } from './review-repository';

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

/** Sprint 4 collections (corrections, room settings, similar searches, debounced builds) share the core store too. */
export function createReviewRepository(core: Repository): ReviewRepository {
  if (core instanceof InMemoryRepository) return new InMemoryReviewRepository(core);
  if (core instanceof FirestoreRepository) return new FirestoreReviewRepository(core);
  throw new Error('unsupported repository for the review repository');
}

@Global()
@Module({
  providers: [
    { provide: REPOSITORY, inject: [APP_CONFIG], useFactory: createRepository },
    { provide: BOQ_REPOSITORY, inject: [REPOSITORY], useFactory: createBoqRepository },
    { provide: REVIEW_REPOSITORY, inject: [REPOSITORY], useFactory: createReviewRepository },
  ],
  exports: [REPOSITORY, BOQ_REPOSITORY, REVIEW_REPOSITORY],
})
export class DatabaseModule {}
