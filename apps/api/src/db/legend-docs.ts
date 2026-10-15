import type { LegendEntry, SymbolClass } from '@kamutan/contracts';
import type { Doc } from './mappers';
import type { AuditInput, LegendDecision, ResolveClusterInput } from './repository';

/**
 * Pure document builders shared by the Firestore and in-memory repositories (Sprint 2 legend flow), so both
 * write exactly the same fields. `now` is a Firestore Timestamp or a Date.
 */

/** Patch for legendEntries/{id} after a decision. */
export function legendDecisionPatch(cur: LegendEntry, decision: LegendDecision, actorUid: string, now: unknown): Doc {
  if (decision.action === 'ignore') {
    return { status: 'ignored', class: null, itemCode: null, confirmedBy: actorUid, confirmedAt: now, updatedAt: now };
  }
  return {
    status: 'confirmed',
    class: decision.class,
    itemCode: decision.itemCode === undefined ? cur.itemCode : decision.itemCode,
    ...(decision.label !== undefined ? { label: decision.label } : {}),
    confirmedBy: actorUid,
    confirmedAt: now,
    updatedAt: now,
  };
}

/**
 * Upserted orgs/{o}/symbolMappings/{signature} doc (brief shape + `ignored`): uses = previous uses + 1.
 * `ignored: true` ⇒ class and itemCode null (the worker skips the signature).
 */
export function mappingDoc(
  prev: Doc | undefined,
  m: { class: SymbolClass | null; itemCode: string | null; label: string; ignored?: boolean },
  actorUid: string,
  now: unknown,
): Doc {
  const prevUses = typeof prev?.uses === 'number' && Number.isInteger(prev.uses) && prev.uses > 0 ? prev.uses : 0;
  const ignored = m.ignored === true;
  return {
    class: ignored ? null : m.class,
    itemCode: ignored ? null : m.itemCode,
    label: m.label,
    ignored,
    confirmedBy: actorUid,
    confirmedAt: now,
    uses: prevUses + 1,
  };
}

/** Label written to the mapping on confirm/reassign: the user-edited one when given, else the entry's. */
export const decisionLabel = (cur: LegendEntry, decision: LegendDecision): string =>
  decision.action !== 'ignore' && decision.label !== undefined ? decision.label : cur.label;

/** Audit event of a legend decision. Ids/classes only — never OCR text (SEC-34). */
export function legendDecisionAudit(projectId: string, cur: LegendEntry, decision: LegendDecision, next: Doc, mappingUses: number | null, actorUid: string): AuditInput {
  return {
    actorId: actorUid,
    entity: 'legendEntries',
    entityId: cur.id,
    action: decision.action,
    after: {
      projectId,
      sheetId: cur.sheetId,
      versionId: cur.versionId,
      signature: cur.signature,
      previousStatus: cur.status,
      previousClass: cur.class,
      class: (next.class as string | null) ?? null,
      itemCode: (next.itemCode as string | null) ?? null,
      /** Whether the user edited the label (never the text itself — SEC-34). */
      labelChanged: decision.action !== 'ignore' && decision.label !== undefined && decision.label !== cur.label,
      mappingUses,
    },
  };
}

/** Confirmed legend entry created from a resolved unknown cluster. */
export function clusterLegendEntryDoc(input: ResolveClusterInput, thumbPath: string | null, actorUid: string, now: unknown): Doc {
  return {
    sheetId: input.sheetId,
    versionId: input.versionId,
    label: input.label,
    labelConfidence: 1,
    suggestedClass: input.class,
    class: input.ignored ? null : input.class,
    itemCode: input.ignored ? null : input.itemCode,
    signature: input.signature,
    thumbPath,
    status: input.ignored ? 'ignored' : 'confirmed',
    confirmedBy: actorUid,
    confirmedAt: now,
    updatedAt: now,
  };
}

export function resolveClusterAudit(projectId: string, input: ResolveClusterInput, mappingUses: number, actorUid: string): AuditInput {
  return {
    actorId: actorUid,
    entity: 'unknownClusters',
    entityId: input.clusterId,
    action: input.ignored ? 'ignore' : 'resolve',
    after: {
      projectId,
      sheetId: input.sheetId,
      versionId: input.versionId,
      signature: input.signature,
      ignored: input.ignored,
      class: input.class,
      itemCode: input.itemCode,
      legendEntryId: input.legendEntry?.id ?? null,
      mappingUses,
    },
  };
}
