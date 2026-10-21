import {
  DEFAULT_ORG_SETTINGS,
  fsPaths,
  type Job,
  type LegendEntry,
  type LegendEntryStatus,
  type Member,
  type Org,
  type ProcessingError,
  type Project,
  type Region,
  type Role,
  type Sheet,
  type SheetSet,
  type SheetSetStatus,
  type SheetSummary,
  type SheetVersion,
  type SymbolMapping,
} from '@kamutan/contracts';
import { FieldPath, FieldValue, Timestamp, type DocumentData, type Firestore, type Query, type Transaction } from 'firebase-admin/firestore';
import { auditHash, logAuditEvent } from './audit-chain';
import { confirmAudit, newVersionDoc, regionsAudit } from './in-memory.repository';
import { clusterLegendEntryDoc, decisionLabel, legendDecisionAudit, legendDecisionPatch, mappingDoc, resolveClusterAudit } from './legend-docs';
import { mappers, versionSummary } from './mappers';
import {
  RepoConflictError,
  type AuditInput,
  type ConfirmInput,
  type LegendDecision,
  type NewSheetSet,
  type ReprocessResult,
  type Repository,
  type ResolveClusterInput,
} from './repository';

/** Per-transaction audit chain state (head read in this tx + events written so far). */
const auditTxState = new WeakMap<Transaction, Map<string, { hash: string | null; count: number | null; writes: number }>>();

/** Firestore Timestamp → Date (top level and one nested level), so mappers see plain values. */
function plain(d: DocumentData | undefined): Record<string, unknown> | null {
  if (!d) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) out[k] = v instanceof Timestamp ? v.toDate() : v;
  return out;
}

/**
 * Firestore implementation (firebase-admin). Admin SDK bypasses Security
 * Rules: every tenant read/write is addressed under orgs/{orgId}/... from the
 * caller-supplied orgId; authorization happens in AccessService beforehand.
 */
export class FirestoreRepository implements Repository {
  constructor(readonly db: Firestore) {}

  // --- orgs & members -----------------------------------------------------------
  async getMember(orgId: string, uid: string): Promise<Member | null> {
    const d = plain((await this.db.doc(fsPaths.member(orgId, uid)).get()).data());
    return d ? mappers.toMember(d) : null;
  }

  async listMembershipsOf(uid: string): Promise<Array<{ orgId: string; role: Role }>> {
    // Needs the collection-group field override on members.uid (firebase/firestore.indexes.json).
    const snap = await this.db.collectionGroup('members').where('uid', '==', uid).get();
    return snap.docs
      .filter((d) => d.ref.parent.parent?.parent.id === 'orgs')
      .map((d) => ({ orgId: d.ref.parent.parent?.id as string, role: d.get('role') as Role }));
  }

  async getOrg(orgId: string): Promise<Org | null> {
    const d = plain((await this.db.doc(fsPaths.org(orgId)).get()).data());
    return d ? mappers.toOrg(orgId, d) : null;
  }

  async createOrgWithAdmin(name: string, admin: { uid: string; email?: string }): Promise<Org> {
    const ref = this.db.collection('orgs').doc();
    const createdAt = Timestamp.now();
    await this.db.runTransaction(async (tx) => {
      const head = await this.auditHead(tx, ref.id);
      tx.create(ref, { name, settings: { ...DEFAULT_ORG_SETTINGS }, createdAt });
      tx.create(this.db.doc(fsPaths.member(ref.id, admin.uid)), {
        uid: admin.uid,
        role: 'admin',
        ...(admin.email ? { email: admin.email } : {}),
        addedBy: admin.uid,
        createdAt,
      });
      this.writeAudit(tx, ref.id, head, { actorId: admin.uid, entity: 'orgs', entityId: ref.id, action: 'create' });
    });
    return mappers.toOrg(ref.id, { name, settings: DEFAULT_ORG_SETTINGS, createdAt: createdAt.toDate() });
  }

  // --- projects ---------------------------------------------------------------------
  async findProjectOrgId(projectId: string): Promise<string | null> {
    // Needs a collection-group field override on projects.projectId.
    const snap = await this.db.collectionGroup('projects').where('projectId', '==', projectId).limit(2).get();
    const docs = snap.docs.filter((d) => d.ref.parent.parent?.parent.id === 'orgs');
    if (docs.length !== 1) return null;
    return docs[0]?.ref.parent.parent?.id ?? null;
  }

  async getProject(orgId: string, projectId: string): Promise<Project | null> {
    const d = plain((await this.db.doc(fsPaths.project(orgId, projectId)).get()).data());
    return d ? mappers.toProject(projectId, d) : null;
  }

  async listProjects(orgId: string, opts: { limit: number; cursor?: string }) {
    let q = this.db.collection(`orgs/${orgId}/projects`).orderBy('createdAt', 'desc').limit(opts.limit + 1);
    if (opts.cursor) {
      const cur = await this.db.doc(fsPaths.project(orgId, opts.cursor)).get();
      if (!cur.exists) return { items: [], nextCursor: null };
      q = q.startAfter(cur);
    }
    const snap = await q.get();
    const items = snap.docs.slice(0, opts.limit).map((d) => mappers.toProject(d.id, plain(d.data()) ?? {}));
    return { items, nextCursor: snap.docs.length > opts.limit && items.length ? (items.at(-1) as Project).id : null };
  }

  async createProject(orgId: string, input: { name: string; address?: string }, actorUid: string): Promise<Project> {
    const ref = this.db.collection(`orgs/${orgId}/projects`).doc();
    const doc = {
      projectId: ref.id,
      orgId,
      name: input.name,
      ...(input.address ? { address: input.address } : {}),
      templateId: null,
      floors: [],
      status: 'active',
      createdBy: actorUid,
      createdAt: Timestamp.now(),
    };
    await this.db.runTransaction(async (tx) => {
      const org = await tx.get(this.db.doc(fsPaths.org(orgId)));
      if (!org.exists) throw new Error('org does not exist');
      const head = await this.auditHead(tx, orgId);
      tx.create(ref, doc);
      this.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'projects', entityId: ref.id, action: 'create' });
    });
    return mappers.toProject(ref.id, plain(doc) ?? {});
  }

  async updateProject(
    orgId: string,
    projectId: string,
    patch: { name?: string; address?: string; status?: Project['status'] },
    actorUid: string,
  ): Promise<Project | null> {
    const ref = this.db.doc(fsPaths.project(orgId, projectId));
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    return this.db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) return null;
      const head = await this.auditHead(tx, orgId);
      tx.update(ref, { ...clean, updatedAt: FieldValue.serverTimestamp() });
      this.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'projects', entityId: projectId, action: 'update', after: clean });
      return mappers.toProject(projectId, { ...(plain(cur.data()) ?? {}), ...clean });
    });
  }

  // --- sheet sets ---------------------------------------------------------------------
  async getSheetSet(orgId: string, projectId: string, sheetSetId: string): Promise<SheetSet | null> {
    const d = plain((await this.db.doc(fsPaths.sheetSet(orgId, projectId, sheetSetId)).get()).data());
    return d ? mappers.toSheetSet(orgId, projectId, sheetSetId, d) : null;
  }

  async createSheetSetIngest(orgId: string, projectId: string, input: NewSheetSet) {
    return this.db.runTransaction(async (tx) => {
      // All reads before writes (Firestore transaction rule).
      const setRef = this.db.doc(fsPaths.sheetSet(orgId, projectId, input.sha256)); // doc id = sha256 → atomic dedupe
      const existing = await tx.get(setRef);
      if (existing.exists) {
        return { sheetSet: mappers.toSheetSet(orgId, projectId, setRef.id, plain(existing.data()) ?? {}), deduplicated: true };
      }
      const project = await tx.get(this.db.doc(fsPaths.project(orgId, projectId)));
      if (!project.exists) throw new Error('project does not exist');
      const head = await this.auditHead(tx, orgId);

      const now = Timestamp.now();
      const jobRef = this.db.collection('jobs').doc();
      const versionId = this.db.collection('_').doc().id; // auto id, used by every page sheet of this set
      const set = {
        fileKind: input.fileKind,
        sha256: input.sha256,
        storagePath: input.storagePath,
        status: 'uploaded',
        name: input.name,
        uploadedBy: input.uploadedBy,
        uploadFileId: input.uploadFileId,
        sizeBytes: input.sizeBytes,
        ingestJobId: jobRef.id,
        versionId,
        pageCount: null,
        createdAt: now,
      };
      tx.create(setRef, set);
      tx.create(jobRef, {
        orgId,
        projectId,
        sheetSetId: setRef.id,
        sheetId: null,
        versionId,
        type: input.jobType,
        status: 'queued',
        progress: { stage: 'ingest', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: input.uploadedBy,
        createdAt: now,
        updatedAt: now,
      });
      this.writeAudit(tx, orgId, head, {
        actorId: input.uploadedBy,
        entity: 'sheetSets',
        entityId: setRef.id,
        action: 'upload',
        after: { projectId, fileKind: input.fileKind, sha256: input.sha256, sizeBytes: input.sizeBytes, jobId: jobRef.id },
      });
      return { sheetSet: mappers.toSheetSet(orgId, projectId, setRef.id, plain(set) ?? {}), deduplicated: false };
    });
  }

  async findSheetSetByUploadFileId(orgId: string, projectId: string, fileId: string): Promise<SheetSet | null> {
    const snap = await this.db.collection(`orgs/${orgId}/projects/${projectId}/sheetSets`).where('uploadFileId', '==', fileId).limit(1).get();
    const d = snap.docs[0];
    return d ? mappers.toSheetSet(orgId, projectId, d.id, plain(d.data()) ?? {}) : null;
  }

  async setSheetSetStatus(orgId: string, projectId: string, sheetSetId: string, status: SheetSetStatus) {
    await this.db.doc(fsPaths.sheetSet(orgId, projectId, sheetSetId)).update({ status });
  }

  // --- sheets & versions --------------------------------------------------------------
  async listSheets(orgId: string, projectId: string, opts: { limit: number; cursor?: string; sheetSetId?: string }) {
    let q: Query = this.db.collection(fsPaths.sheets(orgId, projectId));
    if (opts.sheetSetId) q = q.where('sheetSetId', '==', opts.sheetSetId);
    q = q.orderBy(FieldPath.documentId());
    if (opts.cursor) q = q.startAfter(opts.cursor);
    const snap = await q.limit(opts.limit + 1).get();
    const docs = snap.docs.slice(0, opts.limit);
    const sheets = docs.map((d) => mappers.toSheet(d.id, plain(d.data()) ?? {}));
    const refs = sheets.flatMap((sh) => (sh.currentVersionId ? [this.db.doc(fsPaths.version(orgId, projectId, sh.id, sh.currentVersionId))] : []));
    const versions = new Map<string, SheetVersion>();
    if (refs.length) {
      for (const v of await this.db.getAll(...refs)) {
        const sheetId = v.ref.parent.parent?.id as string;
        if (v.exists) versions.set(`${sheetId}/${v.id}`, mappers.toVersion(sheetId, v.id, plain(v.data()) ?? {}));
      }
    }
    const items: SheetSummary[] = sheets.map((sh) => ({
      ...sh,
      currentVersion: versionSummary(sh.currentVersionId ? (versions.get(`${sh.id}/${sh.currentVersionId}`) ?? null) : null),
    }));
    return { items, nextCursor: snap.docs.length > opts.limit && items.length ? (items.at(-1) as SheetSummary).id : null };
  }

  async getSheet(orgId: string, projectId: string, sheetId: string): Promise<Sheet | null> {
    const d = plain((await this.db.doc(fsPaths.sheet(orgId, projectId, sheetId)).get()).data());
    return d ? mappers.toSheet(sheetId, d) : null;
  }

  async getVersion(orgId: string, projectId: string, sheetId: string, versionId: string): Promise<SheetVersion | null> {
    const d = plain((await this.db.doc(fsPaths.version(orgId, projectId, sheetId, versionId)).get()).data());
    return d ? mappers.toVersion(sheetId, versionId, d) : null;
  }

  async confirmSheet(orgId: string, projectId: string, sheetId: string, input: ConfirmInput, actorUid: string): Promise<Sheet | null> {
    const ref = this.db.doc(fsPaths.sheet(orgId, projectId, sheetId));
    return this.db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) return null;
      if (((cur.get('currentVersionId') as string | undefined) ?? null) !== input.expectedVersionId) {
        throw new RepoConflictError('version_changed');
      }
      const vRef = input.regions && input.expectedVersionId ? this.db.doc(fsPaths.version(orgId, projectId, sheetId, input.expectedVersionId)) : null;
      if (vRef && !(await tx.get(vRef)).exists) throw new RepoConflictError('version_missing');
      const head = await this.auditHead(tx, orgId);
      const now = Timestamp.now();
      const patch = {
        discipline: input.discipline,
        floors: input.floors,
        scaleDenominator: input.scaleDenominator,
        confirmed: true,
        confirmedBy: actorUid,
        confirmedAt: now,
        updatedAt: now,
      };
      tx.update(ref, patch);
      if (vRef && input.regions) tx.update(vRef, { regions: input.regions, regionsUpdatedBy: actorUid, regionsUpdatedAt: now });
      this.writeAudit(tx, orgId, head, {
        actorId: actorUid,
        entity: 'sheets',
        entityId: sheetId,
        action: 'confirm',
        after: confirmAudit(projectId, input),
      });
      return mappers.toSheet(sheetId, { ...(plain(cur.data()) ?? {}), ...plain(patch) });
    });
  }

  async setRegions(orgId: string, projectId: string, sheetId: string, versionId: string, regions: Region[], actorUid: string) {
    const sRef = this.db.doc(fsPaths.sheet(orgId, projectId, sheetId));
    const vRef = this.db.doc(fsPaths.version(orgId, projectId, sheetId, versionId));
    return this.db.runTransaction(async (tx) => {
      const [sheet, version] = await Promise.all([tx.get(sRef), tx.get(vRef)]);
      if (!sheet.exists || !version.exists) return null;
      if (sheet.get('currentVersionId') !== versionId) throw new RepoConflictError('version_changed');
      const head = await this.auditHead(tx, orgId);
      const now = Timestamp.now();
      tx.update(vRef, { regions, regionsUpdatedBy: actorUid, regionsUpdatedAt: now });
      this.writeAudit(tx, orgId, head, {
        actorId: actorUid,
        entity: 'sheetVersions',
        entityId: versionId,
        action: 'set_regions',
        after: regionsAudit(projectId, sheetId, regions),
      });
      return mappers.toVersion(sheetId, versionId, { ...(plain(version.data()) ?? {}), regions });
    });
  }

  async createReprocessVersion(orgId: string, projectId: string, sheetId: string, actorUid: string, jobType: string) {
    const sRef = this.db.doc(fsPaths.sheet(orgId, projectId, sheetId));
    return this.db.runTransaction(async (tx): Promise<ReprocessResult | null> => {
      const sheetSnap = await tx.get(sRef);
      if (!sheetSnap.exists) return null;
      const sheet = mappers.toSheet(sheetId, plain(sheetSnap.data()) ?? {});
      const setSnap = await tx.get(this.db.doc(fsPaths.sheetSet(orgId, projectId, sheet.sheetSetId)));
      if (!setSnap.exists) return null;
      let curV: SheetVersion | null = null;
      if (sheet.currentVersionId) {
        const v = await tx.get(this.db.doc(fsPaths.version(orgId, projectId, sheetId, sheet.currentVersionId)));
        if (v.exists) curV = mappers.toVersion(sheetId, v.id, plain(v.data()) ?? {});
      }
      if (curV && (curV.status === 'queued' || curV.status === 'processing')) throw new RepoConflictError('in_progress');
      const head = await this.auditHead(tx, orgId);

      const now = Timestamp.now();
      const vRef = sRef.collection('versions').doc();
      const jobRef = this.db.collection('jobs').doc();
      const version = newVersionDoc(curV, jobRef.id, now);
      tx.create(vRef, version);
      tx.create(jobRef, {
        orgId,
        projectId,
        sheetSetId: sheet.sheetSetId,
        sheetId,
        versionId: vRef.id,
        type: jobType,
        status: 'queued',
        progress: { stage: 'ingest', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: actorUid,
        createdAt: now,
        updatedAt: now,
      });
      tx.update(sRef, { currentVersionId: vRef.id, updatedAt: now });
      this.writeAudit(tx, orgId, head, {
        actorId: actorUid,
        entity: 'sheets',
        entityId: sheetId,
        action: 'reprocess',
        after: { projectId, versionId: vRef.id, previousVersionId: sheet.currentVersionId, jobId: jobRef.id },
      });
      return {
        sheet: { ...sheet, currentVersionId: vRef.id, updatedAt: now.toDate().toISOString() },
        version: mappers.toVersion(sheetId, vRef.id, plain(version) ?? {}),
        sheetSet: mappers.toSheetSet(orgId, projectId, sheet.sheetSetId, plain(setSnap.data()) ?? {}),
        jobId: jobRef.id,
      };
    });
  }

  async failJob(orgId: string, jobId: string, error: ProcessingError, version?: { projectId: string; sheetId: string; versionId: string }) {
    const batch = this.db.batch();
    const jobRef = this.db.doc(fsPaths.job(jobId));
    const job = await jobRef.get();
    if (job.exists && job.get('orgId') === orgId) {
      batch.update(jobRef, { status: 'failed', error, updatedAt: FieldValue.serverTimestamp() });
    }
    if (version) {
      batch.update(this.db.doc(fsPaths.version(orgId, version.projectId, version.sheetId, version.versionId)), {
        status: 'failed',
        error,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }

  // --- legend entries & symbol mappings ------------------------------------------------
  async listLegendEntries(orgId: string, projectId: string, opts: { limit: number; cursor?: string; status?: LegendEntryStatus; sheetId?: string }) {
    // Equality filters + document-id order are served by the automatic single-field indexes.
    let q: Query = this.db.collection(fsPaths.legendEntries(orgId, projectId));
    if (opts.status) q = q.where('status', '==', opts.status);
    if (opts.sheetId) q = q.where('sheetId', '==', opts.sheetId);
    q = q.orderBy(FieldPath.documentId());
    if (opts.cursor) q = q.startAfter(opts.cursor);
    const snap = await q.limit(opts.limit + 1).get();
    const items = snap.docs.slice(0, opts.limit).map((d) => mappers.toLegendEntry(d.id, plain(d.data()) ?? {}));
    return { items, nextCursor: snap.docs.length > opts.limit && items.length ? (items.at(-1) as LegendEntry).id : null };
  }

  async getLegendEntry(orgId: string, projectId: string, entryId: string): Promise<LegendEntry | null> {
    const d = plain((await this.db.doc(fsPaths.legendEntry(orgId, projectId, entryId)).get()).data());
    return d ? mappers.toLegendEntry(entryId, d) : null;
  }

  async decideLegendEntry(orgId: string, projectId: string, entryId: string, decision: LegendDecision, actorUid: string) {
    const ref = this.db.doc(fsPaths.legendEntry(orgId, projectId, entryId));
    return this.db.runTransaction(async (tx) => {
      // All reads before writes.
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const cur = mappers.toLegendEntry(entryId, plain(snap.data()) ?? {});
      const mRef = decision.action === 'ignore' ? null : this.db.doc(fsPaths.symbolMapping(orgId, cur.signature));
      const prevMapping = mRef ? plain((await tx.get(mRef)).data()) : null;
      const head = await this.auditHead(tx, orgId);
      const now = Timestamp.now();
      const patch = legendDecisionPatch(cur, decision, actorUid, now);
      let mapping: SymbolMapping | null = null;
      if (mRef && decision.action !== 'ignore') {
        const m = mappingDoc(prevMapping ?? undefined, { class: decision.class, itemCode: patch.itemCode as string | null, label: decisionLabel(cur, decision) }, actorUid, now);
        tx.set(mRef, m);
        mapping = mappers.toSymbolMapping(cur.signature, plain(m) ?? {});
      }
      tx.update(ref, patch);
      this.writeAudit(tx, orgId, head, legendDecisionAudit(projectId, cur, decision, patch, mapping?.uses ?? null, actorUid));
      return { entry: mappers.toLegendEntry(entryId, { ...(plain(snap.data()) ?? {}), ...plain(patch) }), mapping };
    });
  }

  async resolveUnknownCluster(orgId: string, projectId: string, input: ResolveClusterInput, actorUid: string) {
    const mRef = this.db.doc(fsPaths.symbolMapping(orgId, input.signature));
    return this.db.runTransaction(async (tx) => {
      const prev = plain((await tx.get(mRef)).data());
      const head = await this.auditHead(tx, orgId);
      const now = Timestamp.now();
      const m = mappingDoc(prev ?? undefined, input, actorUid, now);
      tx.set(mRef, m);
      let legendEntry: LegendEntry | null = null;
      if (input.legendEntry) {
        const doc = clusterLegendEntryDoc(input, input.legendEntry.thumbPath, actorUid, now);
        tx.set(this.db.doc(fsPaths.legendEntry(orgId, projectId, input.legendEntry.id)), doc);
        legendEntry = mappers.toLegendEntry(input.legendEntry.id, plain(doc) ?? {});
      }
      const mapping = mappers.toSymbolMapping(input.signature, plain(m) ?? {});
      this.writeAudit(tx, orgId, head, resolveClusterAudit(projectId, input, mapping.uses, actorUid));
      return { mapping, legendEntry };
    });
  }

  async getSymbolMapping(orgId: string, signature: string): Promise<SymbolMapping | null> {
    const d = plain((await this.db.doc(fsPaths.symbolMapping(orgId, signature)).get()).data());
    return d ? mappers.toSymbolMapping(signature, d) : null;
  }

  // --- jobs -----------------------------------------------------------------------------
  async getJob(jobId: string): Promise<Job | null> {
    const d = plain((await this.db.doc(fsPaths.job(jobId)).get()).data());
    return d ? mappers.toJob(jobId, d) : null;
  }

  // --- audit -------------------------------------------------------------------------
  /**
   * @internal shared with the other Firestore repositories.
   * Sprint 5: reads the chain head doc `orgs/{o}/auditMeta/head` inside the transaction, so two concurrent appends
   * conflict on that document and one of them retries (a query read alone does not lock "the next" document, which
   * could fork the chain). Falls back to the newest event for logs written before the head doc existed.
   */
  async auditHead(tx: Transaction, orgId: string): Promise<string | null> {
    const headSnap = await tx.get(this.db.doc(fsPaths.auditHead(orgId)));
    const fromHead = headSnap.exists ? (headSnap.get('hash') as string | undefined) : undefined;
    let head: string | null = fromHead ?? null;
    let count: number | null = headSnap.exists ? ((headSnap.get('count') as number | undefined) ?? null) : null;
    if (!headSnap.exists) {
      const snap = await tx.get(this.db.collection(`orgs/${orgId}/auditLog`).orderBy('at', 'desc').limit(1));
      head = (snap.docs[0]?.get('hash') as string | undefined) ?? null;
      count = null;
    }
    auditTxState.set(tx, new Map([[orgId, { hash: head, count, writes: 0 }]]));
    return head;
  }

  /** @internal Several events in one transaction chain onto each other (per-transaction state). */
  writeAudit(tx: Transaction, orgId: string, prevHash0: string | null, event: AuditInput): void {
    const state = auditTxState.get(tx)?.get(orgId);
    const prevHash = state && state.writes > 0 ? state.hash : prevHash0;
    const at = Timestamp.now();
    const body = {
      actorId: event.actorId,
      actorKind: event.actorKind ?? 'user',
      entity: event.entity,
      entityId: event.entityId,
      action: event.action,
      after: event.after ?? null,
      at: at.toDate().toISOString(),
    };
    const hash = auditHash(prevHash, body);
    logAuditEvent(orgId, event, hash);
    tx.create(this.db.collection(`orgs/${orgId}/auditLog`).doc(), { ...body, at, prevHash, hash });
    const writes = (state?.writes ?? 0) + 1;
    const count = state?.count ?? null;
    tx.set(this.db.doc(fsPaths.auditHead(orgId)), { hash, at, ...(count !== null ? { count: count + writes } : {}) }, { merge: true });
    if (state) Object.assign(state, { hash, writes });
    else auditTxState.set(tx, new Map([[orgId, { hash, count: null, writes }]]));
  }

  async appendAudit(orgId: string, event: AuditInput): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const head = await this.auditHead(tx, orgId);
      this.writeAudit(tx, orgId, head, event);
    });
  }

  async ping(): Promise<void> {
    await this.db.collection('orgs').limit(1).select().get();
  }
}
