import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { InMemoryRepository } from './in-memory.repository';
import { PgPoolDatabase } from './pg-pool.database';
import { PgRepository } from './pg.repository';
import { REPOSITORY, type Repository } from './repository';

export function createRepository(cfg: AppConfig): Repository {
  if (cfg.DATA_DRIVER === 'memory') return new InMemoryRepository();
  const ssl =
    cfg.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: cfg.DATABASE_SSL === 'verify-full' };
  return new PgRepository(
    new PgPoolDatabase({ connectionString: cfg.DATABASE_URL, ssl, max: cfg.DATABASE_POOL_MAX }),
  );
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
