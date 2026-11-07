import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import {
  deleteConfirmationMatches,
  DocIdSchema,
  PROJECT_DELETE_MISMATCH_HE,
  projectQuotaOf,
  SHEET_SET_DELETE_BUSY_HE,
  storagePaths,
  type DeleteProjectRequest,
  type DeleteProjectResponse,
  type DeleteSheetSetResponse,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, notFound } from '../common/api-exception';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { HOUSEKEEPING_REPOSITORY, type HousekeepingRepository } from '../db/housekeeping-repository';
import { REPOSITORY, RepoConflictError, type Repository } from '../db/repository';
import { GOVERNANCE_STORAGE, type GovernanceStorage } from '../governance/governance-storage';

const validId = (s: string) => DocIdSchema.safeParse(s).success;

/**
 * Sprint 8 housekeeping (docs/agents/SPRINT8_BRIEF.md §3): delete a sheet set (editor+) or a whole project (admin + MFA +
 * sign-in ≤ 10 min, SEC-07 "מחיקת פרויקט", typed confirmation). Both release the storage quota, revoke the share links
 * that show the deleted sheets / project, remove every Storage object (`uploads/`, `infected/`, sheet artifacts, marked
 * PDFs; for a project the whole `orgs/{o}/projects/{p}/` prefix incl. BOQ evidence / snapshots / exports / share
 * snapshots) and the Firestore docs, and are audited (`sheetSets/delete`, `projects/delete`, `shareLinks/revoke_all`).
 */
@Injectable()
export class HousekeepingService {
  private readonly logger = new Logger('HousekeepingService');

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(HOUSEKEEPING_REPOSITORY) private readonly hk: HousekeepingRepository,
    @Inject(GOVERNANCE_STORAGE) private readonly storage: GovernanceStorage,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async deleteSheetSet(user: AuthContext, projectId: string, setId: string): Promise<DeleteSheetSetResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    if (!validId(setId)) throw notFound('sheet set');
    let plan;
    try {
      plan = await this.hk.beginSheetSetDelete(orgId, projectId, setId, user.uid);
    } catch (err) {
      if (err instanceof RepoConflictError && err.reason === 'busy') throw new ApiException(HttpStatus.CONFLICT, 'conflict', SHEET_SET_DELETE_BUSY_HE, [{ path: 'sheetSetId', message: 'busy' }]);
      throw err;
    }
    if (!plan) throw notFound('sheet set');
    const pre = storagePaths.projectPrefix(orgId, projectId);
    const prefixes = [
      storagePaths.uploadsPrefix(orgId, projectId, setId),
      storagePaths.infectedPrefix(orgId, projectId, setId),
      ...plan.sheetIds.map((s) => storagePaths.sheetPrefix(orgId, projectId, s)),
      ...plan.exportIds.map((id) => `${pre}exports/${id}/`),
    ];
    const objects = await this.storage.deletePrefixes(prefixes);
    const [counts, org] = await Promise.all([this.hk.finishSheetSetDelete(orgId, projectId, setId, plan), this.repo.getOrg(orgId)]);
    this.logger.log({ orgId, projectId, setId, ...counts, objects, releasedBytes: plan.releasedBytes, revoked: plan.revokedShareLinks }, 'sheet set deleted');
    return {
      sheetSetId: setId,
      deleted: { sheets: counts.sheets, versions: counts.versions, docs: counts.docs, objects },
      releasedBytes: plan.releasedBytes,
      storageBytes: plan.storageBytes,
      storageQuotaBytes: projectQuotaOf(org?.settings),
      revokedShareLinks: plan.revokedShareLinks,
    };
  }

  async deleteProject(user: AuthContext, projectId: string, req: DeleteProjectRequest): Promise<DeleteProjectResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'admin');
    await this.access.requireSensitiveAdmin(user, orgId, this.cfg.OFFBOARDING_REQUIRE_MFA);
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    if (!deleteConfirmationMatches(req.confirmName, project.name)) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', PROJECT_DELETE_MISMATCH_HE, [{ path: 'confirmName', message: 'mismatch' }]);
    }
    const plan = await this.hk.beginProjectDelete(orgId, projectId, user.uid);
    if (!plan) throw notFound('project');
    // From here the project is invisible to every read (tombstone); the rest only removes data.
    const objects = await this.storage.deletePrefixes([storagePaths.projectPrefix(orgId, projectId)]);
    const docs = await this.hk.finishProjectDelete(orgId, projectId, plan.tokenHashes);
    this.logger.log({ orgId, projectId, docs, objects, releasedBytes: plan.releasedBytes, revoked: plan.revokedShareLinks }, 'project deleted');
    return { projectId, deleted: { docs, objects }, releasedBytes: plan.releasedBytes, revokedShareLinks: plan.revokedShareLinks };
  }
}
