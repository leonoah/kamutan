import { activeExclusionCodes, isLineExcluded, withoutExcludedLines, type BoqLine } from '@kamutan/contracts';
import type { BoqRepository } from '../db/boq-repository';

/**
 * Sprint 15: the project's lines as every BOQ surface (view, document / Excel, share snapshot, comparison, review queue)
 * sees them — without the lines a human declared "לא רלוונטי בפרויקט הזה" (and that still have no quantity). The
 * decisions live in `boqExclusions`, apart from `boqLines`, so a rebuild (which rewrites lines) never loses them.
 */
export async function listActiveLines(boq: Pick<BoqRepository, 'listLines' | 'listExclusions'>, orgId: string, projectId: string): Promise<BoqLine[]> {
  const [lines, exclusions] = await Promise.all([boq.listLines(orgId, projectId), boq.listExclusions(orgId, projectId)]);
  return withoutExcludedLines(lines, exclusions);
}

/** Ids of the lines currently hidden by an exclusion (review queue: drop their `line` items). */
export async function hiddenLineIds(boq: Pick<BoqRepository, 'listLines' | 'listExclusions'>, orgId: string, projectId: string): Promise<Set<string>> {
  const exclusions = await boq.listExclusions(orgId, projectId);
  const codes = activeExclusionCodes(exclusions);
  if (codes.size === 0) return new Set();
  return new Set((await boq.listLines(orgId, projectId)).filter((l) => isLineExcluded(l, codes)).map((l) => l.id));
}
