import { Global, Module } from '@nestjs/common';
import { ProjectStateService } from './project-state.service';

/** Stage 10: project counters + revised-upload supersede, used by projects / sheets / BOQ / review services. */
@Global()
@Module({ providers: [ProjectStateService], exports: [ProjectStateService] })
export class ProjectStateModule {}
