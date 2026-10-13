import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JobSchema, type Job } from '@kamutan/contracts';
import type { AuthContext } from '../auth/auth-context';
import { CurrentUser } from '../auth/decorators';
import { ApiErrors, ApiZodResponse } from '../common/zod-openapi';
import { JobsService } from './jobs.service';

@ApiTags('jobs')
@ApiBearerAuth()
@Controller({ path: 'jobs', version: '1' })
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** Job status/progress. Org membership is checked in the service against job.orgId (viewer+). */
  @Get(':jobId')
  @ApiZodResponse(200, JobSchema)
  @ApiErrors(401, 404)
  get(@Param('jobId') jobId: string, @CurrentUser() user: AuthContext): Promise<Job> {
    return this.jobs.get(user, jobId);
  }
}
