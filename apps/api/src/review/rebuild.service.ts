import { Inject, Injectable, Logger } from '@nestjs/common';
import { BOQ_BUILD_JOB_SCHEMA_VERSION, BOQ_REBUILD_DEBOUNCE_MS, JOB_TYPES, type RebuildOutcome, type StaleReason } from '@kamutan/contracts';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { REVIEW_REPOSITORY, type ReviewRepository } from '../db/review-repository';
import { INGEST_QUEUE, type IngestQueue } from '../queue/ingest-queue';

/**
 * After every correction / room-settings change: project.boq → stale, and (org `autoRebuild`, default true) a
 * DEBOUNCED rebuild. Serverless-safe debounce: the API publishes the `boq.build` message once, when it creates the
 * build doc with `debounceUntil = now + 5 s`; later edits only push `debounceUntil` back (no new build, no new
 * message). The worker sleeps until `debounceUntil`, re-reads the doc and loops (capped at BOQ_REBUILD_MAX_WAIT_MS).
 * A change while a build is RUNNING creates exactly one follow-up build (`afterBuildId`). Best effort: a failure
 * here never fails the user's edit (the BOQ stays stale; POST …/boq/build still works).
 */
@Injectable()
export class RebuildService {
  private readonly logger = new Logger('RebuildService');
  /** Overridable in tests. */
  debounceMs = BOQ_REBUILD_DEBOUNCE_MS;

  constructor(
    @Inject(REVIEW_REPOSITORY) private readonly review: ReviewRepository,
    @Inject(BOQ_REPOSITORY) private readonly boq: BoqRepository,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
  ) {}

  async afterChange(orgId: string, projectId: string, reason: StaleReason, actorUid: string, traceparent: string): Promise<RebuildOutcome> {
    let r;
    try {
      r = await this.review.scheduleAutoBuild(orgId, projectId, { reason, actorUid, jobType: JOB_TYPES.boqBuild, nowMs: Date.now(), debounceMs: this.debounceMs });
    } catch (err) {
      this.logger.error({ err: (err as Error).message, orgId, projectId }, 'auto rebuild scheduling failed');
      await this.boq.markStale(orgId, projectId, reason).catch(() => undefined);
      return { stale: true, autoRebuild: 'failed', buildId: null, notBefore: null };
    }
    if (!r) return { stale: false, autoRebuild: 'off', buildId: null, notBefore: null };
    const out: RebuildOutcome = {
      stale: true,
      autoRebuild: r.outcome,
      buildId: r.build?.id ?? null,
      notBefore: r.notBeforeMs === null ? null : new Date(r.notBeforeMs).toISOString(),
    };
    if (!r.publish || !r.build || !r.jobId) return out;
    try {
      await this.boq.seedDefaults(orgId); // the worker needs the org's rules + template
      await this.queue.publish({ schemaVersion: BOQ_BUILD_JOB_SCHEMA_VERSION, type: JOB_TYPES.boqBuild, jobId: r.jobId, orgId, projectId, buildId: r.build.id, traceparent });
      return out;
    } catch (err) {
      this.logger.error({ err: (err as Error).message, buildId: r.build.id }, 'auto boq.build publish failed');
      await this.boq.failBuild(orgId, projectId, r.build.id, r.jobId, { code: 'publish_failed', message: 'could not schedule the build' }).catch(() => undefined);
      return { ...out, autoRebuild: 'failed', notBefore: null };
    }
  }
}
