import { Inject, Injectable } from '@nestjs/common';
import { DocIdSchema, type Job } from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, notFound } from '../common/api-exception';
import { REPOSITORY, type Repository } from '../db/repository';

@Injectable()
export class JobsService {
  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
  ) {}

  /** jobs/{jobId} is top level: authorize against the job's own orgId (non-members get 404, no existence leak). */
  async get(user: AuthContext, jobId: string): Promise<Job> {
    if (!DocIdSchema.safeParse(jobId).success) throw notFound('job');
    const job = await this.repo.getJob(jobId);
    if (!job) throw notFound('job');
    try {
      await this.access.requireRole(user, job.orgId, 'viewer');
    } catch (err) {
      if (err instanceof ApiException && err.code === 'not_found') throw notFound('job');
      throw err;
    }
    return job;
  }
}
