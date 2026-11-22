import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  computeMissingItems,
  DEFAULT_BOQ_TEMPLATE,
  exclusionIdFor,
  filterMissing,
  missingCounts,
  type MissingItemsQuery,
  type MissingItemsView,
  type SetBoqExclusionRequest,
  type SetBoqExclusionResponse,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { notFound } from '../common/api-exception';
import { BOQ_REPOSITORY, type BoqRepository } from '../db/boq-repository';
import { REPOSITORY, type Repository } from '../db/repository';

/** Sprint 15: "סעיפים שלא זוהו" — the missing-items list and the "לא רלוונטי בפרויקט הזה" decision (docs/spec/11). */
@Injectable()
export class MissingItemsService {
  private readonly logger = new Logger('MissingItemsService');

  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(BOQ_REPOSITORY) private readonly boq: BoqRepository,
  ) {}

  /** GET …/boq/missing-items (viewer+). Empty (`built: false`) until the first build exists. */
  async view(user: AuthContext, projectId: string, q: MissingItemsQuery): Promise<MissingItemsView> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    const project = await this.repo.getProject(orgId, projectId);
    if (!project) throw notFound('project');
    const built = Boolean(project.boq?.latestBuildId);
    if (!built) return { built: false, filter: q.filter, counts: { all: 0, inProject: 0, notRelevant: 0 }, items: [] };
    const [lines, library, templates, rules, exclusions] = await Promise.all([
      this.boq.listLines(orgId, projectId),
      this.boq.listLibraryItems(orgId, { active: true }),
      this.boq.listTemplates(orgId),
      this.boq.listRules(orgId),
      this.boq.listExclusions(orgId, projectId),
    ]);
    const template = templates.find((t) => t.default) ?? DEFAULT_BOQ_TEMPLATE;
    const all = computeMissingItems({ library, lines, exclusions, templateChapters: template.chapters, rules });
    return { built: true, filter: q.filter, counts: missingCounts(all), items: filterMissing(all, q.filter) };
  }

  /**
   * POST …/boq/exclusions (editor+, the role of a quantity / price override): idempotent. Excluding needs the code to
   * exist (a library item or a project line); the display snapshot (description / unit / chapter) is stored with it.
   * Restoring a code that was never excluded is 404. Audited `boqExclusions/exclude|restore` only when the state
   * changes. Marks nothing stale: the decision applies at read time, a rebuild cannot lose it.
   */
  async set(user: AuthContext, projectId: string, req: SetBoqExclusionRequest): Promise<SetBoqExclusionResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const code = req.code.trim();
    let snapshot = { description: '', unit: '', chapter: '' };
    if (req.excluded) {
      const [library, lines] = await Promise.all([this.boq.listLibraryItems(orgId, { active: true }), this.boq.listLines(orgId, projectId)]);
      const item = library.find((i) => i.code.trim() === code) ?? null;
      const line = lines.find((l) => l.code.trim() === code) ?? null;
      if (!item && !line) throw notFound('item');
      snapshot = { description: item?.description ?? line?.description ?? '', unit: item?.unit ?? line?.unit ?? '', chapter: item?.chapter ?? line?.chapter ?? '' };
    }
    const r = await this.boq.setExclusion(orgId, projectId, { code, excluded: req.excluded, ...(req.reason ? { reason: req.reason } : {}), ...snapshot }, user.uid);
    if (!r) throw notFound('project');
    if (!r.exclusion) throw notFound('exclusion');
    this.logger.log({ orgId, projectId, id: exclusionIdFor(code), excluded: req.excluded, changed: r.changed }, 'boq exclusion');
    return { exclusion: r.exclusion, changed: r.changed };
  }
}

