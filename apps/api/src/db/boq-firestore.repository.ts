import {
  DEFAULT_BOQ_RULES,
  DEFAULT_BOQ_TEMPLATE,
  DEFAULT_ITEM_LIBRARY_ADDITIONS,
  planDefaultLibrarySeed,
  templateNeedsUpgrade,
  defaultRuleDoc,
  fsPaths,
  ruleNeedsReseed,
  JOB_TYPES,
  type BoqExport,
  type BoqLine,
  type BoqRule,
  type BoqTemplate,
  type ItemLibraryItem,
  type LibraryImport,
  type PatchBoqLineRequest,
  type PatchBoqRuleRequest,
  type PatchBoqTemplateRequest,
  type PatchLibraryItemRequest,
  type ProcessingError,
  type ProjectPricing,
  type StaleReason,
} from '@kamutan/contracts';
import { FieldPath, FieldValue, Timestamp, type DocumentData, type DocumentReference, type Firestore, type Query } from 'firebase-admin/firestore';
import {
  approvalInvalidatedAudit,
  approvalsInvalidatedOf,
  importPricesAudit,
  importedPriceSkip,
  isBoqExportDoc,
  priceApplyBlocker,
  planBatchStatus,
  planLibraryItemPatch,
  planLinePatch,
  samePrice,
  toBoqBuild,
  toBoqExport,
  toBoqLine,
  toLibraryImport,
  toLibraryItem,
  toRule,
  toTemplate,
} from './boq-docs';
import { isActive, ruleAudit } from './boq-memory.repository';
import { BATCH_STATUS_CHUNK, MAX_BOQ_LINES, MAX_LIBRARY_ITEMS, type BatchStatusResult, type BoqRepository, type BulkPriceResult, type ImportedPriceResult } from './boq-repository';
import type { FirestoreRepository } from './firestore.repository';
import type { Doc } from './mappers';
import { RepoConflictError } from './repository';

const plain = (d: DocumentData | undefined): Doc | null => (d ? (d as Doc) : null);
const strip = <T extends { id: string }>(v: T): Omit<T, 'id'> => {
  const { id: _id, ...rest } = v;
  return rest;
};

/**
 * Firestore implementation of the Sprint 3 collections. Mappers convert Timestamps at any depth (`isoDeep`/`anyIso`),
 * so raw doc data is passed through. Audit events go through the core repository's per-org hash chain.
 */
export class FirestoreBoqRepository implements BoqRepository {
  constructor(private readonly core: FirestoreRepository) {}

  private get db(): Firestore {
    return this.core.db;
  }

  // --- library ---------------------------------------------------------------
  async listLibraryItems(orgId: string, opts: { chapter?: string; active?: boolean }): Promise<ItemLibraryItem[]> {
    let q: Query = this.db.collection(fsPaths.itemLibrary(orgId));
    if (opts.chapter !== undefined) q = q.where('chapter', '==', opts.chapter);
    if (opts.active !== undefined) q = q.where('active', '==', opts.active);
    const snap = await q.orderBy(FieldPath.documentId()).limit(MAX_LIBRARY_ITEMS).get();
    return snap.docs.map((d) => toLibraryItem(d.id, d.data())).filter((x): x is ItemLibraryItem => x !== null);
  }

  async getLibraryItem(orgId: string, itemId: string): Promise<ItemLibraryItem | null> {
    const d = plain((await this.db.doc(fsPaths.libraryItem(orgId, itemId)).get()).data());
    return d ? toLibraryItem(itemId, d) : null;
  }

  async createLibraryItem(orgId: string, item: Omit<ItemLibraryItem, 'updatedAt' | 'updatedBy'>, actorUid: string): Promise<ItemLibraryItem> {
    const ref = this.db.doc(fsPaths.libraryItem(orgId, item.id));
    return this.db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) throw new RepoConflictError('exists');
      const head = await this.core.auditHead(tx, orgId);
      const doc = { ...strip(item), updatedAt: Timestamp.now(), updatedBy: actorUid };
      tx.create(ref, doc);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'itemLibrary', entityId: item.id, action: 'create', after: { code: item.code, chapter: item.chapter } });
      return toLibraryItem(item.id, doc) as ItemLibraryItem;
    });
  }

  async patchLibraryItem(orgId: string, itemId: string, patch: PatchLibraryItemRequest, actorUid: string): Promise<ItemLibraryItem | null> {
    const ref = this.db.doc(fsPaths.libraryItem(orgId, itemId));
    return this.db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) return null;
      const item = toLibraryItem(itemId, cur.data() as Doc);
      if (!item) return null;
      const head = await this.core.auditHead(tx, orgId);
      const { upd, audit } = planLibraryItemPatch(item, patch, actorUid, Timestamp.now());
      tx.update(ref, upd);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'itemLibrary', entityId: itemId, action: 'update', after: audit });
      return toLibraryItem(itemId, { ...cur.data(), ...upd });
    });
  }

  async bulkSetLibraryPrices(orgId: string, entries: ReadonlyArray<{ itemId: string; amount: number | null }>, actorUid: string, batchId: string): Promise<BulkPriceResult> {
    const out: BulkPriceResult = { updated: [], skipped: [] };
    for (let i = 0; i < entries.length; i += BATCH_STATUS_CHUNK) {
      const chunk = entries.slice(i, i + BATCH_STATUS_CHUNK);
      const refs = chunk.map((e) => this.db.doc(fsPaths.libraryItem(orgId, e.itemId)));
      // Retries re-run the closure: the chunk's result is collected locally and merged after the commit.
      const part = await this.db.runTransaction(async (tx) => {
        const res: BulkPriceResult = { updated: [], skipped: [] };
        const snaps = await tx.getAll(...refs);
        const head = await this.core.auditHead(tx, orgId);
        const now = Timestamp.now();
        snaps.forEach((snap, j) => {
          const e = chunk[j] as { itemId: string; amount: number | null };
          const cur = snap.exists ? toLibraryItem(e.itemId, snap.data() as Doc) : null;
          if (!cur) return void res.skipped.push({ itemId: e.itemId, reason: 'not_found' });
          if (samePrice(cur, e.amount)) return void res.skipped.push({ itemId: e.itemId, reason: 'unchanged' });
          const { upd, audit } = planLibraryItemPatch(cur, { price: e.amount }, actorUid, now, batchId);
          tx.update(refs[j] as DocumentReference, upd);
          this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'itemLibrary', entityId: e.itemId, action: 'update', after: audit });
          res.updated.push({ itemId: e.itemId, code: cur.code, from: cur.price?.amount ?? null, to: e.amount });
        });
        return res;
      });
      out.updated.push(...part.updated);
      out.skipped.push(...part.skipped);
    }
    return out;
  }

  async auditImportPrices(orgId: string, importId: string): Promise<boolean> {
    const ref = this.db.doc(fsPaths.libraryImport(orgId, importId));
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = plain(snap.data());
      if (!d || d.pricesAuditedAt) return false;
      const ev = importPricesAudit(importId, toLibraryImport(importId, d));
      if (!ev) return false;
      const head = await this.core.auditHead(tx, orgId);
      tx.update(ref, { pricesAuditedAt: Timestamp.now() });
      this.core.writeAudit(tx, orgId, head, ev);
      return true;
    });
  }

  async claimPriceApply(orgId: string, importId: string, actorUid: string): Promise<LibraryImport | null> {
    const ref = this.db.doc(fsPaths.libraryImport(orgId, importId));
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = plain(snap.data());
      if (!d) return null;
      const blocker = priceApplyBlocker(toLibraryImport(importId, d));
      if (blocker) throw new RepoConflictError(blocker);
      const now = Timestamp.now();
      tx.update(ref, { pricesAppliedAt: now, pricesAppliedBy: actorUid });
      return toLibraryImport(importId, { ...d, pricesAppliedAt: now, pricesAppliedBy: actorUid });
    });
  }

  async writeImportedPrices(orgId: string, importId: string, entries: ReadonlyArray<{ itemId: string; amount: number; allowManual: boolean }>, actorUid: string): Promise<ImportedPriceResult> {
    const out: ImportedPriceResult = { written: [], skipped: [] };
    for (let i = 0; i < entries.length; i += BATCH_STATUS_CHUNK) {
      const chunk = entries.slice(i, i + BATCH_STATUS_CHUNK);
      const refs = chunk.map((e) => this.db.doc(fsPaths.libraryItem(orgId, e.itemId)));
      const part = await this.db.runTransaction(async (tx) => {
        const res: ImportedPriceResult = { written: [], skipped: [] };
        const snaps = await tx.getAll(...refs);
        const head = await this.core.auditHead(tx, orgId);
        const now = Timestamp.now();
        snaps.forEach((snap, j) => {
          const e = chunk[j] as { itemId: string; amount: number; allowManual: boolean };
          const cur = snap.exists ? toLibraryItem(e.itemId, snap.data() as Doc) : null;
          const skip = importedPriceSkip(cur, e.amount, e.allowManual);
          if (skip || !cur) return void res.skipped.push({ itemId: e.itemId, reason: skip ?? 'not_found' });
          const { upd, audit } = planLibraryItemPatch(cur, { price: e.amount }, actorUid, now, undefined, importId);
          tx.update(refs[j] as DocumentReference, upd);
          this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'itemLibrary', entityId: e.itemId, action: 'update', after: audit });
          res.written.push({ itemId: e.itemId, overwroteManual: cur.price?.source === 'manual' });
        });
        return res;
      });
      out.written.push(...part.written);
      out.skipped.push(...part.skipped);
    }
    return out;
  }

  // --- imports ---------------------------------------------------------------
  async createLibraryImport(orgId: string, doc: LibraryImport): Promise<LibraryImport> {
    const stored = { ...strip(doc), createdAt: Timestamp.fromDate(new Date(doc.createdAt)), expiresAt: Timestamp.fromDate(new Date(doc.expiresAt)) };
    await this.db.doc(fsPaths.libraryImport(orgId, doc.id)).create(stored);
    return toLibraryImport(doc.id, stored);
  }

  async getLibraryImport(orgId: string, importId: string): Promise<LibraryImport | null> {
    const d = plain((await this.db.doc(fsPaths.libraryImport(orgId, importId)).get()).data());
    return d ? toLibraryImport(importId, d) : null;
  }

  async queueLibraryImport(orgId: string, importId: string, actorUid: string) {
    const ref = this.db.doc(fsPaths.libraryImport(orgId, importId));
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const d = snap.data() as Doc;
      if (d.status !== 'awaiting_upload') return { doc: toLibraryImport(importId, d), jobId: (d.jobId as string | null) ?? null, created: false };
      const head = await this.core.auditHead(tx, orgId);
      const now = Timestamp.now();
      const jobRef = this.db.collection('jobs').doc();
      tx.create(jobRef, {
        orgId,
        projectId: d.projectId ?? null,
        sheetSetId: null,
        importId,
        type: JOB_TYPES.libraryImport,
        status: 'queued',
        progress: { stage: 'import', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: actorUid,
        createdAt: now,
        updatedAt: now,
      });
      const upd = { status: 'queued', jobId: jobRef.id, finalizedAt: now };
      tx.update(ref, upd);
      this.core.writeAudit(tx, orgId, head, {
        actorId: actorUid,
        entity: 'libraryImports',
        entityId: importId,
        action: 'finalize',
        after: { jobId: jobRef.id, sourceKind: d.sourceKind, sizeBytes: d.sizeBytes, projectId: d.projectId ?? null },
      });
      return { doc: toLibraryImport(importId, { ...d, ...upd }), jobId: jobRef.id, created: true };
    });
  }

  async failLibraryImport(orgId: string, importId: string, status: 'rejected' | 'failed', error: ProcessingError): Promise<void> {
    const ref = this.db.doc(fsPaths.libraryImport(orgId, importId));
    const snap = await ref.get();
    if (!snap.exists) return;
    const batch = this.db.batch();
    batch.update(ref, { status, error });
    const jobId = snap.get('jobId') as string | null | undefined;
    if (jobId) {
      const job = await this.db.doc(fsPaths.job(jobId)).get();
      if (job.exists && job.get('orgId') === orgId) batch.update(job.ref, { status: 'failed', error, updatedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
  }

  // --- templates & rules ---------------------------------------------------------
  async seedDefaults(orgId: string) {
    return this.db.runTransaction(async (tx) => {
      const tplRef = this.db.doc(fsPaths.boqTemplate(orgId, DEFAULT_BOQ_TEMPLATE.id));
      const ruleRefs = DEFAULT_BOQ_RULES.map((r) => this.db.doc(fsPaths.boqRule(orgId, r.id)));
      const addRefs = DEFAULT_ITEM_LIBRARY_ADDITIONS.map((it) => this.db.doc(fsPaths.libraryItem(orgId, it.id)));
      const [tpl, ...rest] = await tx.getAll(tplRef, ...ruleRefs, ...addRefs);
      const rules = rest.slice(0, ruleRefs.length);
      const additions = rest.slice(ruleRefs.length);
      const defaults = await tx.get(this.db.collection(fsPaths.boqTemplates(orgId)).where('default', '==', true).limit(1));
      const anyItem = await tx.get(this.db.collection(fsPaths.itemLibrary(orgId)).limit(1));
      // Sprint 6 (library v2): only when some newer default item is missing, check whether the org has the default
      // library and which of the missing codes it already has (cheap queries; the common case is one getAll).
      const missing = DEFAULT_ITEM_LIBRARY_ADDITIONS.filter((_, i) => !additions[i]?.exists);
      let hasDefault = false;
      const takenCodes = new Set<string>();
      if (!anyItem.empty && missing.length) {
        hasDefault = !(await tx.get(this.db.collection(fsPaths.itemLibrary(orgId)).where('source', '==', 'default').limit(1))).empty;
        if (hasDefault) {
          const codes = [...new Set(missing.map((m) => m.code))];
          for (let i = 0; i < codes.length; i += 30) {
            const snap = await tx.get(this.db.collection(fsPaths.itemLibrary(orgId)).where('code', 'in', codes.slice(i, i + 30)));
            for (const d of snap.docs) takenCodes.add(String(d.get('code')));
          }
        }
      }
      const existingIds = new Set(DEFAULT_ITEM_LIBRARY_ADDITIONS.filter((_, i) => additions[i]?.exists).map((it) => it.id));
      const now = Timestamp.now();
      let templates = 0;
      let created = 0;
      if (!tpl?.exists) {
        tx.create(tplRef, { ...strip(structuredClone(DEFAULT_BOQ_TEMPLATE) as BoqTemplate), default: defaults.empty, updatedAt: now, updatedBy: null });
        templates++;
      } else if (templateNeedsUpgrade(tpl.data())) {
        // Sprint 6: an unedited generic v2 seed becomes v3 (chapters 02 / 06 / 07); its `default` flag is kept.
        tx.set(tplRef, { ...strip(structuredClone(DEFAULT_BOQ_TEMPLATE) as BoqTemplate), default: tpl.get('default') === true, updatedAt: now, updatedBy: null });
        templates++;
      }
      rules.forEach((snap, i) => {
        if (!ruleNeedsReseed(snap.exists ? (snap.data() as { source?: string; defaultsVersion?: number }) : null)) return;
        tx.set(ruleRefs[i] as DocumentReference, { ...strip(structuredClone(defaultRuleDoc(DEFAULT_BOQ_RULES[i] as (typeof DEFAULT_BOQ_RULES)[number]))), updatedAt: now, updatedBy: null });
        created++;
      });
      // Stage 10 (A-LIVE-01): empty library → the shipped defaults (deterministic ids; never re-seeded once non-empty).
      let items = 0;
      // v1 ids are not read here: an org that has the default library has them, and the plan only adds v2 ids.
      const plan = planDefaultLibrarySeed({ empty: anyItem.empty, hasDefault, existingIds, takenCodes }).filter((it) => anyItem.empty || (it.defaultsVersion ?? 1) > 1);
      for (const it of plan) {
        tx.set(this.db.doc(fsPaths.libraryItem(orgId, it.id)), { ...strip(structuredClone(it) as ItemLibraryItem), updatedAt: now, updatedBy: null });
        items++;
      }
      return { templates, rules: created, items };
    });
  }

  async listTemplates(orgId: string): Promise<BoqTemplate[]> {
    const snap = await this.db.collection(fsPaths.boqTemplates(orgId)).limit(200).get();
    return snap.docs
      .map((d) => toTemplate(d.id, d.data()))
      .filter((t): t is BoqTemplate => t !== null)
      .sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
  }

  async getTemplate(orgId: string, templateId: string): Promise<BoqTemplate | null> {
    const d = plain((await this.db.doc(fsPaths.boqTemplate(orgId, templateId)).get()).data());
    return d ? toTemplate(templateId, d) : null;
  }

  async patchTemplate(orgId: string, templateId: string, patch: PatchBoqTemplateRequest, actorUid: string): Promise<BoqTemplate | null> {
    const ref = this.db.doc(fsPaths.boqTemplate(orgId, templateId));
    return this.db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) return null;
      const others = patch.default ? await tx.get(this.db.collection(fsPaths.boqTemplates(orgId)).where('default', '==', true)) : null;
      const head = await this.core.auditHead(tx, orgId);
      const now = Timestamp.now();
      for (const o of others?.docs ?? []) if (o.id !== templateId) tx.update(o.ref, { default: false, updatedAt: now });
      const upd = { ...patch, updatedAt: now, updatedBy: actorUid };
      tx.update(ref, upd);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'boqTemplates', entityId: templateId, action: 'update', after: { fields: Object.keys(patch).sort() } });
      return toTemplate(templateId, { ...cur.data(), ...upd });
    });
  }

  async listRules(orgId: string): Promise<BoqRule[]> {
    const snap = await this.db.collection(fsPaths.boqRules(orgId)).limit(500).get();
    return snap.docs
      .map((d) => toRule(d.id, d.data()))
      .filter((r): r is BoqRule => r !== null)
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  }

  async patchRule(orgId: string, ruleId: string, patch: PatchBoqRuleRequest, actorUid: string): Promise<BoqRule | null> {
    const ref = this.db.doc(fsPaths.boqRule(orgId, ruleId));
    return this.db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      if (!cur.exists) return null;
      const before = cur.data() as Doc;
      const upd = { ...patch, ...(before.source === 'default' ? { source: 'user' } : {}), updatedAt: Timestamp.now(), updatedBy: actorUid };
      const rule = toRule(ruleId, { ...before, ...upd });
      if (!rule) throw new RepoConflictError('invalid_rule');
      const head = await this.core.auditHead(tx, orgId);
      tx.update(ref, upd);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'boqRules', entityId: ruleId, action: 'update', after: ruleAudit(before, patch) });
      return rule;
    });
  }

  // --- builds --------------------------------------------------------------------
  async requestBuild(orgId: string, projectId: string, actorUid: string, jobType: string) {
    const pRef = this.db.doc(fsPaths.project(orgId, projectId));
    return this.db.runTransaction(async (tx) => {
      const project = await tx.get(pRef);
      if (!project.exists) return null;
      const boq = (project.get('boq') as Doc | undefined) ?? {};
      const pendingId = typeof boq.pendingBuildId === 'string' ? boq.pendingBuildId : null;
      if (pendingId) {
        const pending = await tx.get(this.db.doc(fsPaths.boqBuild(orgId, projectId, pendingId)));
        const createdAt = pending.get('createdAt') as Timestamp | undefined;
        if (pending.exists && isActive(pending.get('status'), createdAt?.toDate(), Date.now())) {
          return { build: toBoqBuild(pendingId, pending.data() as Doc), jobId: (pending.get('jobId') as string | null) ?? null, deduplicated: true };
        }
      }
      const head = await this.core.auditHead(tx, orgId);
      const now = Timestamp.now();
      const bRef = this.db.collection(`${fsPaths.project(orgId, projectId)}/boqBuilds`).doc();
      const jobRef = this.db.collection('jobs').doc();
      const build = { status: 'queued', jobId: jobRef.id, requestedBy: actorUid, createdAt: now, startedAt: null, finishedAt: null, stats: null, error: null, evidenceRef: null };
      tx.create(bRef, build);
      tx.create(jobRef, {
        orgId,
        projectId,
        sheetSetId: null,
        buildId: bRef.id,
        type: jobType,
        status: 'queued',
        progress: { stage: 'boq', pct: 0 },
        attempts: 0,
        error: null,
        createdBy: actorUid,
        createdAt: now,
        updatedAt: now,
      });
      // Dotted field paths: only these keys of the `boq` map change (worker-written ones are kept).
      tx.update(pRef, {
        'boq.pendingBuildId': bRef.id,
        ...(boq.latestBuildId === undefined ? { 'boq.latestBuildId': null, 'boq.builtAt': null } : {}),
        ...(boq.stale === undefined ? { 'boq.stale': true } : {}),
      });
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'boqBuilds', entityId: bRef.id, action: 'request', after: { projectId, jobId: jobRef.id } });
      return { build: toBoqBuild(bRef.id, build), jobId: jobRef.id, deduplicated: false };
    });
  }

  async failBuild(orgId: string, projectId: string, buildId: string, jobId: string, error: ProcessingError): Promise<void> {
    const pRef = this.db.doc(fsPaths.project(orgId, projectId));
    await this.db.runTransaction(async (tx) => {
      const [project, job] = await Promise.all([tx.get(pRef), tx.get(this.db.doc(fsPaths.job(jobId)))]);
      tx.update(this.db.doc(fsPaths.boqBuild(orgId, projectId, buildId)), { status: 'failed', error, finishedAt: FieldValue.serverTimestamp() });
      if (job.exists && job.get('orgId') === orgId) tx.update(job.ref, { status: 'failed', error, updatedAt: FieldValue.serverTimestamp() });
      if (project.exists && project.get('boq.pendingBuildId') === buildId) tx.update(pRef, { 'boq.pendingBuildId': null });
    });
  }

  async auditApprovalsInvalidated(orgId: string, projectId: string, buildId: string): Promise<number> {
    const ref = this.db.doc(fsPaths.boqBuild(orgId, projectId, buildId));
    return this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      const snap = await tx.get(ref);
      const d = snap.data() as Doc | undefined;
      if (!d || d.status !== 'succeeded' || d.approvalsAuditedAt) return 0;
      const list = approvalsInvalidatedOf(d.approvalsInvalidated);
      if (list.length === 0) return 0;
      for (const e of list) this.core.writeAudit(tx, orgId, head, approvalInvalidatedAudit(projectId, buildId, e));
      tx.update(ref, { approvalsAuditedAt: Timestamp.now() });
      return list.length;
    });
  }

  async getBuild(orgId: string, projectId: string, buildId: string) {
    const d = plain((await this.db.doc(fsPaths.boqBuild(orgId, projectId, buildId)).get()).data());
    return d ? toBoqBuild(buildId, d) : null;
  }

  async markStale(orgId: string, projectId: string, reason: StaleReason): Promise<void> {
    try {
      await this.db.doc(fsPaths.project(orgId, projectId)).update({ 'boq.stale': true, 'boq.staleReason': reason, 'boq.staleAt': FieldValue.serverTimestamp() });
    } catch (err) {
      if ((err as { code?: number }).code === 5) return; // NOT_FOUND
      throw err;
    }
  }

  async listBuilds(orgId: string, projectId: string, limit: number) {
    const snap = await this.db.collection(`orgs/${orgId}/projects/${projectId}/boqBuilds`).orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map((d) => toBoqBuild(d.id, d.data() as Doc));
  }

  async setProjectPricing(orgId: string, projectId: string, adjustmentPct: number, actorUid: string): Promise<ProjectPricing | null> {
    const ref = this.db.doc(fsPaths.project(orgId, projectId));
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || (snap.data() as Doc).deletingAt) return null;
      const from = ((snap.data() as Doc).pricing as Doc | undefined)?.adjustmentPct ?? 0;
      const head = await this.core.auditHead(tx, orgId);
      const now = Timestamp.now();
      tx.update(ref, { pricing: { adjustmentPct, updatedBy: actorUid, updatedAt: now } });
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'projects', entityId: projectId, action: 'update_pricing', after: { projectId, from, to: adjustmentPct } });
      return { adjustmentPct, updatedBy: actorUid, updatedAt: now.toDate().toISOString() };
    });
  }

  async markOrgStale(orgId: string, reason: StaleReason): Promise<number> {
    const snap = await this.db.collection(`orgs/${orgId}/projects`).select().get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = this.db.batch();
      for (const d of snap.docs.slice(i, i + 400)) batch.update(d.ref, { 'boq.stale': true, 'boq.staleReason': reason, 'boq.staleAt': FieldValue.serverTimestamp() });
      await batch.commit();
    }
    return snap.size;
  }

  // --- lines -----------------------------------------------------------------------
  async listLines(orgId: string, projectId: string): Promise<BoqLine[]> {
    const snap = await this.db.collection(fsPaths.boqLines(orgId, projectId)).limit(MAX_BOQ_LINES).get();
    return snap.docs.map((d) => toBoqLine(d.id, d.data()));
  }

  async getLine(orgId: string, projectId: string, lineId: string): Promise<BoqLine | null> {
    const d = plain((await this.db.doc(fsPaths.boqLine(orgId, projectId, lineId)).get()).data());
    return d ? toBoqLine(lineId, d) : null;
  }

  async patchLine(orgId: string, projectId: string, lineId: string, req: PatchBoqLineRequest, actorUid: string): Promise<BoqLine | null> {
    const ref = this.db.doc(fsPaths.boqLine(orgId, projectId, lineId));
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const head = await this.core.auditHead(tx, orgId);
      const { patch, audit } = planLinePatch(projectId, toBoqLine(lineId, snap.data() as Doc), req, actorUid, Timestamp.now());
      tx.update(ref, patch);
      this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'boqLines', entityId: lineId, action: 'update', after: audit });
      return toBoqLine(lineId, { ...snap.data(), ...patch });
    });
  }

  async batchLineStatus(orgId: string, projectId: string, lineIds: readonly string[], to: 'reviewed' | 'approved', opts: { includeRed: boolean; allowed: boolean; batchId: string }, actorUid: string): Promise<BatchStatusResult> {
    const out: BatchStatusResult = { updated: [], skipped: [] };
    for (let i = 0; i < lineIds.length; i += BATCH_STATUS_CHUNK) {
      const chunk = lineIds.slice(i, i + BATCH_STATUS_CHUNK);
      const refs = chunk.map((id) => this.db.doc(fsPaths.boqLine(orgId, projectId, id)));
      // Retries re-run the closure: collect the chunk's result locally and append it only after the commit.
      const part = await this.db.runTransaction(async (tx) => {
        const res: BatchStatusResult = { updated: [], skipped: [] };
        const snaps = await tx.getAll(...refs);
        const head = await this.core.auditHead(tx, orgId);
        const now = Timestamp.now();
        snaps.forEach((snap, j) => {
          const lineId = chunk[j] as string;
          const plan = planBatchStatus(projectId, snap.exists ? toBoqLine(lineId, snap.data() as Doc) : null, to, opts, actorUid, now);
          if ('skip' in plan) {
            res.skipped.push({ lineId, reason: plan.skip });
            return;
          }
          tx.update(refs[j] as DocumentReference, plan.patch);
          this.core.writeAudit(tx, orgId, head, { actorId: actorUid, entity: 'boqLines', entityId: lineId, action: 'update', after: plan.audit });
          res.updated.push({ lineId, from: plan.from, to: plan.to });
        });
        return res;
      });
      out.updated.push(...part.updated);
      out.skipped.push(...part.skipped);
    }
    return out;
  }

  // --- exports ---------------------------------------------------------------------
  async latestBoqExport(orgId: string, projectId: string): Promise<BoqExport | null> {
    return (await this.listBoqExports(orgId, projectId, 1))[0] ?? null;
  }

  async listBoqExports(orgId: string, projectId: string, limit: number): Promise<BoqExport[]> {
    // Newest first; marked PDFs / comparison exports are skipped in code (≤ 200 recent records looked at).
    const snap = await this.db.collection(`orgs/${orgId}/projects/${projectId}/exports`).orderBy('createdAt', 'desc').limit(200).get();
    return snap.docs
      .filter((d) => isBoqExportDoc(d.data() as Doc))
      .slice(0, limit)
      .map((d) => toBoqExport(d.id, d.data() as Doc))
      .filter((x): x is BoqExport => x !== null);
  }

  async createExport(orgId: string, projectId: string, doc: BoqExport): Promise<BoqExport> {
    const ref = this.db.doc(fsPaths.boqExport(orgId, projectId, doc.id));
    await this.db.runTransaction(async (tx) => {
      const head = await this.core.auditHead(tx, orgId);
      tx.create(ref, { ...strip(doc), createdAt: Timestamp.fromDate(new Date(doc.createdAt)) });
      this.core.writeAudit(tx, orgId, head, {
        actorId: doc.createdBy,
        entity: 'exports',
        entityId: doc.id,
        action: 'create',
        after: { projectId, templateId: doc.templateId, split: doc.split, markDraft: doc.markDraft, buildId: doc.buildId, sha256: doc.sha256, lines: doc.counts.lines, red: doc.counts.red, yellow: doc.counts.yellow },
      });
    });
    return doc;
  }
}
