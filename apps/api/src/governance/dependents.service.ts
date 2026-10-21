import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  INGEST_JOB_SCHEMA_VERSION,
  JOB_TYPES,
  REPROCESS_REASON_MESSAGE,
  type ReprocessRequest,
  type SheetVersion,
} from '@kamutan/contracts';
import { GOVERNANCE_REPOSITORY, type GovernanceRepository } from '../db/governance-repository';
import { REPOSITORY, RepoConflictError, type Repository } from '../db/repository';
import { INGEST_QUEUE, type IngestQueue } from '../queue/ingest-queue';

/** Actor of automatic re-processing (audit `actorId`, job `createdBy`). */
export const DEPENDENTS_ACTOR = 'system_dependents';
/** After a publish failure, try again this much later (seconds). */
export const REPROCESS_RETRY_S = 300;
export const DEPENDENTS_BATCH = 100;

export type DependentDecision = { kind: 'fire' } | { kind: 'wait' } | { kind: 'drop'; reason: string };

/**
 * Mirror of workers/drawing lifecycle/dependents.py `due_requests` for ONE due request:
 * sheet gone → drop; current version queued/processing → wait; the sheet was re-processed meanwhile (another version
 * than `dependentVersionId`) with every requested source already used → drop; else fire.
 */
export function decideDependent(req: ReprocessRequest, sheetExists: boolean, current: Pick<SheetVersion, 'id' | 'status' | 'referenceSources'> | null): DependentDecision {
  if (!sheetExists || !current) return { kind: 'drop', reason: 'sheet_gone' };
  if (current.status === 'queued' || current.status === 'processing') return { kind: 'wait' };
  const refs = current.referenceSources;
  if (current.id !== req.dependentVersionId && refs !== undefined && req.sources.every((s) => refs.includes(s))) return { kind: 'drop', reason: 'already_reprocessed' };
  return { kind: 'fire' };
}

export interface DependentsRunResult {
  fired: number;
  dropped: number;
  waiting: number;
  skipped: number;
  failed: number;
}

/**
 * Sprint 5 (Worker-B request): turns due `reprocessRequests/{sheetId}` docs into re-process jobs on topic `ingest`.
 * Run every minute by the scheduled function `reprocessDependents` (src/function.ts). Idempotent: each request is
 * claimed in a transaction (`pending` → `firing`) before anything is created, so overlapping runs / redelivery fire it
 * once; a crashed claim is retried after REPROCESS_CLAIM_TIMEOUT_S. Debounce/cap: only `notBefore` (≤ first + 900 s) due.
 */
@Injectable()
export class DependentsService {
  private readonly logger = new Logger('DependentsService');

  constructor(
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(GOVERNANCE_REPOSITORY) private readonly gov: GovernanceRepository,
    @Inject(INGEST_QUEUE) private readonly queue: IngestQueue,
  ) {}

  async runDue(nowMs = Date.now()): Promise<DependentsRunResult> {
    const nowSec = nowMs / 1000;
    const res: DependentsRunResult = { fired: 0, dropped: 0, waiting: 0, skipped: 0, failed: 0 };
    for (const due of await this.gov.listDueReprocessRequests(nowSec, DEPENDENTS_BATCH)) {
      try {
        const out = await this.handle(due.orgId, due.projectId, due.sheetId, nowSec);
        res[out]++;
      } catch (err) {
        res.failed++;
        this.logger.error({ err: (err as Error).message, orgId: due.orgId, projectId: due.projectId, sheetId: due.sheetId }, 'dependent reprocess failed');
      }
    }
    if (res.fired + res.dropped + res.failed > 0) this.logger.log({ ...res }, 'dependents run');
    return res;
  }

  private async handle(orgId: string, projectId: string, sheetId: string, nowSec: number): Promise<keyof DependentsRunResult> {
    const req = await this.gov.claimReprocessRequest(orgId, projectId, sheetId, nowSec);
    if (!req) return 'skipped';
    const backToPending = (notBefore = req.notBefore) => this.gov.finishReprocessRequest(orgId, projectId, sheetId, { status: 'pending', claimedAt: null, notBefore });
    const org = await this.repo.getOrg(orgId);
    if (!org || org.status === 'offboarding') {
      await this.gov.finishReprocessRequest(orgId, projectId, sheetId, { status: 'dropped', dropReason: 'org_inactive' });
      return 'dropped';
    }
    const sheet = await this.repo.getSheet(orgId, projectId, sheetId);
    const current = sheet?.currentVersionId ? await this.repo.getVersion(orgId, projectId, sheetId, sheet.currentVersionId) : null;
    const d = decideDependent(req, !!sheet, current);
    if (d.kind === 'wait') {
      await backToPending();
      return 'waiting';
    }
    if (d.kind === 'drop') {
      await this.gov.finishReprocessRequest(orgId, projectId, sheetId, { status: 'dropped', dropReason: d.reason });
      return 'dropped';
    }
    let created;
    try {
      created = await this.repo.createReprocessVersion(orgId, projectId, sheetId, DEPENDENTS_ACTOR, JOB_TYPES.ingestSheetVersion);
    } catch (err) {
      if (err instanceof RepoConflictError && err.reason === 'in_progress') {
        await backToPending();
        return 'waiting';
      }
      throw err;
    }
    if (!created) {
      await this.gov.finishReprocessRequest(orgId, projectId, sheetId, { status: 'dropped', dropReason: 'sheet_gone' });
      return 'dropped';
    }
    await this.gov.setVersionReprocessReason(orgId, projectId, sheetId, created.version.id, { kind: 'reference_walls', sources: req.sources.slice(0, 32), message: REPROCESS_REASON_MESSAGE });
    try {
      await this.queue.publish({
        schemaVersion: INGEST_JOB_SCHEMA_VERSION,
        type: JOB_TYPES.ingestSheetVersion,
        jobId: created.jobId,
        orgId,
        projectId,
        sheetSetId: created.sheetSet.id,
        sheetId,
        pageIndex: created.sheet.pageIndex,
        versionId: created.version.id,
        storagePath: created.sheetSet.storagePath,
        sha256: created.sheetSet.sha256,
        fileKind: created.sheetSet.fileKind,
        traceparent: null,
      });
    } catch (err) {
      await this.repo.failJob(orgId, created.jobId, { code: 'publish_failed', message: 'could not schedule processing' }, { projectId, sheetId, versionId: created.version.id }).catch(() => undefined);
      await backToPending(nowSec + REPROCESS_RETRY_S);
      throw err;
    }
    await this.gov.finishReprocessRequest(orgId, projectId, sheetId, { status: 'fired', firedAt: nowSec, versionId: created.version.id, claimedAt: null });
    return 'fired';
  }
}
