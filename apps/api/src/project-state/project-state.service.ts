import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Project, ProjectStats } from '@kamutan/contracts';
import { PROJECT_STATE_REPOSITORY, planSupersede, revisionProcessed, type ProjectStateRepository } from '../db/project-state-repository';

/**
 * Stage 10 project-level state owned by the API:
 *  - A-LIVE-02 card counters: `Project.stats` = the worker-written counters (`stats.sheets` after each ingest,
 *    `stats.{boqLines, green, yellow, red}` after each build) where present, else counted live; `reviewOpen` is always
 *    the API's (non-green lines not approved). The live system showed "0 גיליונות" because nobody wrote `stats` and
 *    the mapper dropped it.
 *  - A-API-05 revised uploads: once a revision is processed, its old sheets are linked + superseded.
 * Callers authorized the project's org first. Every method is best effort for the request that triggers it.
 */
@Injectable()
export class ProjectStateService {
  private readonly logger = new Logger('ProjectStateService');

  constructor(@Inject(PROJECT_STATE_REPOSITORY) private readonly state: ProjectStateRepository) {}

  async withStats<P extends Project>(orgId: string, project: P): Promise<P> {
    try {
      const c = await this.state.counters(orgId, project.id);
      const s: Partial<ProjectStats> = project.stats ?? {};
      return { ...project, stats: { sheets: s.sheets ?? c.sheets, boqLines: s.boqLines ?? c.boqLines, green: s.green ?? c.green, yellow: s.yellow ?? c.yellow, red: s.red ?? c.red, reviewOpen: c.reviewOpen } };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, orgId, projectId: project.id }, 'project counters failed');
      return project;
    }
  }

  /** Links + supersedes the old sheets of every processed revision of the project. Returns the number applied. */
  async reconcileSupersedes(orgId: string, projectId: string): Promise<number> {
    let applied = 0;
    try {
      for (const p of await this.state.pendingSupersedes(orgId, projectId)) {
        const newSheets = await this.state.setSheets(orgId, projectId, p.newSetId);
        if (!revisionProcessed(p.newSetStatus, newSheets)) continue;
        const oldSheets = await this.state.setSheets(orgId, projectId, p.oldSetId);
        if (await this.state.applySupersede(orgId, projectId, p, planSupersede(oldSheets, newSheets))) applied++;
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, orgId, projectId }, 'supersede reconcile failed');
    }
    return applied;
  }
}
