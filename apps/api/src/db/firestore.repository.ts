import {
  DEFAULT_ORG_SETTINGS,
  fsPaths,
  type Member,
  type Org,
  type Project,
  type Role,
  type SheetVersionStatus,
} from '@kamutan/contracts';
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
import { auditHash } from './audit-chain';
import { mappers } from './in-memory.repository';
import type { AuditInput, NewSheetSet, Repository, SheetSetBundle } from './repository';

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
  constructor(private readonly db: Firestore) {}

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
  private async readBundle(orgId: string, projectId: string, setId: string, tx?: Transaction): Promise<SheetSetBundle | null> {
    const get = (r: DocumentReference) => (tx ? tx.get(r) : r.get());
    const setSnap = await get(this.db.doc(fsPaths.sheetSet(orgId, projectId, setId)));
    if (!setSnap.exists) return null;
    const sheetsQ = this.db.collection(`orgs/${orgId}/projects/${projectId}/sheets`).where('sheetSetId', '==', setId).limit(1);
    const sheets = tx ? await tx.get(sheetsQ) : await sheetsQ.get();
    const sheetDoc = sheets.docs[0];
    if (!sheetDoc) return null;
    const versionId = sheetDoc.get('currentVersionId') as string;
    const vSnap = await get(this.db.doc(fsPaths.version(orgId, projectId, sheetDoc.id, versionId)));
    if (!vSnap.exists) return null;
    const set = plain(setSnap.data()) ?? {};
    return {
      sheetSet: mappers.toSheetSet(orgId, projectId, setId, set),
      sheet: mappers.toSheet(sheetDoc.id, plain(sheetDoc.data()) ?? {}),
      sheetVersion: mappers.toVersion(sheetDoc.id, versionId, plain(vSnap.data()) ?? {}),
      jobId: String(set.ingestJobId),
    };
  }

  findSheetSetBySha(orgId: string, projectId: string, sha256: string): Promise<SheetSetBundle | null> {
    return this.readBundle(orgId, projectId, sha256);
  }

  async createSheetSetBundle(orgId: string, projectId: string, input: NewSheetSet) {
    return this.db.runTransaction(async (tx) => {
      // All reads before writes (Firestore transaction rule).
      const existing = await this.readBundle(orgId, projectId, input.sha256, tx);
      if (existing) return { bundle: existing, deduplicated: true };
      const project = await tx.get(this.db.doc(fsPaths.project(orgId, projectId)));
      if (!project.exists) throw new Error('project does not exist');
      const head = await this.auditHead(tx, orgId);

      const now = Timestamp.now();
      const setId = input.sha256; // doc id = sha256 → atomic per-project dedupe
      const sheetRef = this.db.collection(`orgs/${orgId}/projects/${projectId}/sheets`).doc();
      const versionRef = sheetRef.collection('versions').doc();
      const jobRef = this.db.collection('jobs').doc();
      const set = {
        fileKind: input.fileKind,
        sha256: input.sha256,
        storagePath: input.storagePath,
        status: 'uploaded',
        name: input.name,
        uploadedBy: input.uploadedBy,
        sizeBytes: input.sizeBytes,
        ingestJobId: jobRef.id,
        createdAt: now,
      };
      const sheet = {
        logicalKey: `upload:${setId.slice(0, 12)}`,
        discipline: [],
        floorRegions: [],
        scale: null,
        currentVersionId: versionRef.id,
        sheetSetId: setId,
      };
      const version = { versionNo: 1, status: 'uploaded', sha256: input.sha256, pageIndex: 0, artifacts: {}, createdAt: now };
      tx.create(this.db.doc(fsPaths.sheetSet(orgId, projectId, setId)), set);
      tx.create(sheetRef, sheet);
      tx.create(versionRef, version);
      tx.create(jobRef, {
        orgId,
        projectId,
        sheetSetId: setId,
        sheetId: sheetRef.id,
        versionId: versionRef.id,
        type: input.jobType,
        status: 'queued',
        progress: 0,
        createdAt: now,
      });
      this.writeAudit(tx, orgId, head, {
        actorId: input.uploadedBy,
        entity: 'sheetSets',
        entityId: setId,
        action: 'upload',
        after: { projectId, fileKind: input.fileKind, sha256: input.sha256, sizeBytes: input.sizeBytes },
      });
      return {
        bundle: {
          sheetSet: mappers.toSheetSet(orgId, projectId, setId, plain(set) ?? {}),
          sheet: mappers.toSheet(sheetRef.id, sheet),
          sheetVersion: mappers.toVersion(sheetRef.id, versionRef.id, plain(version) ?? {}),
          jobId: jobRef.id,
        },
        deduplicated: false,
      };
    });
  }

  async setVersionStatus(orgId: string, projectId: string, sheetId: string, versionId: string, status: SheetVersionStatus) {
    await this.db.doc(fsPaths.version(orgId, projectId, sheetId, versionId)).update({ status });
  }

  // --- audit -------------------------------------------------------------------------
  private async auditHead(tx: Transaction, orgId: string): Promise<string | null> {
    const snap = await tx.get(this.db.collection(`orgs/${orgId}/auditLog`).orderBy('at', 'desc').limit(1));
    return (snap.docs[0]?.get('hash') as string | undefined) ?? null;
  }

  private writeAudit(tx: Transaction, orgId: string, prevHash: string | null, event: AuditInput): void {
    const at = Timestamp.now();
    const body = {
      actorId: event.actorId,
      actorKind: 'user',
      entity: event.entity,
      entityId: event.entityId,
      action: event.action,
      after: event.after ?? null,
      at: at.toDate().toISOString(),
    };
    tx.create(this.db.collection(`orgs/${orgId}/auditLog`).doc(), { ...body, at, prevHash, hash: auditHash(prevHash, body) });
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
