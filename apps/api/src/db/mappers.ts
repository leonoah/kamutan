import {
  DetectionClassSchema,
  DetectionStatsSchema,
  LinkStatsSchema,
  ItemCodeSchema,
  JOB_STATUSES,
  LEGEND_ENTRY_STATUSES,
  SymbolClassSchema,
  PageGeometrySchema,
  ProcessingErrorSchema,
  RegionSchema,
  SHEET_SET_STATUSES,
  SHEET_VERSION_STATUSES,
  SheetClassificationSchema,
  TilesArtifactSchema,
  VERSION_STAGES,
  VersionStatsSchema,
  type Job,
  type JobProgress,
  type LegendEntry,
  type SymbolMapping,
  type Member,
  type Org,
  type ProcessingError,
  type Project,
  type ProjectBoqSummary,
  type Region,
  type Role,
  type Sheet,
  type SheetSet,
  type SheetVersion,
  type VersionArtifacts,
  type VersionProgress,
} from '@kamutan/contracts';

/**
 * Doc → DTO mappers shared by the in-memory and Firestore repositories.
 * Firestore Timestamps are converted to Date before mapping (see `plain()`).
 * Sheets/versions/jobs are largely worker-written, so mapping is tolerant:
 * malformed fields fall back to safe defaults instead of failing the request.
 */
export type Doc = Record<string, unknown>;

export function iso(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

/** Date | ISO string → ISO string, anything else → null. */
export function isoOrNull(d: unknown): string | null {
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString();
  if (typeof d === 'string' && !Number.isNaN(Date.parse(d))) return new Date(d).toISOString();
  return null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isInteger(v) ? v : dflt);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

function processingError(v: unknown): ProcessingError | null {
  const r = ProcessingErrorSchema.safeParse(v);
  return r.success ? r.data : null;
}

export function toOrg(id: string, d: Doc): Org {
  return { id, name: String(d.name), settings: d.settings as Org['settings'], createdAt: iso(d.createdAt) };
}

export function toMember(d: Doc): Member {
  return {
    uid: String(d.uid),
    role: d.role as Role,
    ...(d.email ? { email: String(d.email) } : {}),
    ...(d.addedBy ? { addedBy: String(d.addedBy) } : {}),
    createdAt: iso(d.createdAt),
  };
}

export function toProject(id: string, d: Doc): Project {
  return {
    id,
    orgId: String(d.orgId),
    name: String(d.name),
    ...(typeof d.address === 'string' ? { address: d.address } : {}),
    templateId: (d.templateId as string | null | undefined) ?? null,
    floors: (d.floors as Project['floors']) ?? [],
    ...(d.boq && typeof d.boq === 'object' ? { boq: toProjectBoq(d.boq as Doc) } : {}),
    status: d.status as Project['status'],
    createdBy: String(d.createdBy),
    createdAt: iso(d.createdAt),
  };
}

/** Date | ISO string | Firestore Timestamp (nested fields are not converted by `plain()`) → ISO or null. */
export function anyIso(v: unknown): string | null {
  if (v && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return isoOrNull((v as { toDate(): Date }).toDate());
  }
  return isoOrNull(v);
}

export function toProjectBoq(d: Doc): ProjectBoqSummary {
  return {
    latestBuildId: str(d.latestBuildId),
    builtAt: anyIso(d.builtAt),
    stale: d.stale === true,
    pendingBuildId: str(d.pendingBuildId),
    staleReason: str(d.staleReason),
    staleAt: anyIso(d.staleAt),
  };
}

export function toSheetSet(orgId: string, projectId: string, id: string, d: Doc): SheetSet {
  return {
    id,
    orgId,
    projectId,
    fileKind: d.fileKind as SheetSet['fileKind'],
    sha256: String(d.sha256),
    storagePath: String(d.storagePath),
    status: oneOf(d.status, SHEET_SET_STATUSES, 'uploaded'),
    ...(typeof d.name === 'string' ? { name: d.name } : {}),
    uploadedBy: String(d.uploadedBy),
    ...(typeof d.sizeBytes === 'number' ? { sizeBytes: d.sizeBytes } : {}),
    ...(typeof d.ingestJobId === 'string' ? { ingestJobId: d.ingestJobId } : {}),
    ...(typeof d.versionId === 'string' ? { versionId: d.versionId } : {}),
    ...(typeof d.pageCount === 'number' ? { pageCount: d.pageCount } : {}),
    createdAt: iso(d.createdAt),
  };
}

function strings(v: unknown, max: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, max) : [];
}

export function toSheet(id: string, d: Doc): Sheet {
  const cls = SheetClassificationSchema.safeParse(d.classification);
  const scale = d.scaleDenominator;
  const disc = str(d.discipline);
  return {
    id,
    sheetSetId: String(d.sheetSetId),
    pageIndex: int(d.pageIndex, 0),
    title: str(d.title),
    discipline: disc && /^[a-z][a-z0-9_]{0,39}$/.test(disc) ? disc : null,
    floors: strings(d.floors, 16),
    scaleDenominator: typeof scale === 'number' && Number.isInteger(scale) && scale >= 1 ? scale : null,
    classification: cls.success ? cls.data : null,
    confirmed: d.confirmed === true,
    ...(d.confirmedBy !== undefined ? { confirmedBy: str(d.confirmedBy) } : {}),
    ...(d.confirmedAt !== undefined ? { confirmedAt: isoOrNull(d.confirmedAt) } : {}),
    currentVersionId: str(d.currentVersionId),
    updatedAt: isoOrNull(d.updatedAt),
  };
}

export function toProgress(v: unknown, status: SheetVersion['status']): VersionProgress {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.pct === 'number') {
      return { stage: oneOf(o.stage, VERSION_STAGES, status === 'ready' ? 'done' : 'ingest'), pct: Math.min(100, Math.max(0, o.pct)) };
    }
  }
  if (typeof v === 'number') return { stage: status === 'ready' ? 'done' : 'ingest', pct: Math.min(100, Math.max(0, v)) };
  return status === 'ready' ? { stage: 'done', pct: 100 } : { stage: 'ingest', pct: 0 };
}

export function toRegions(v: unknown): Region[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((r) => {
    const p = RegionSchema.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

function toArtifacts(v: unknown): VersionArtifacts {
  if (!v || typeof v !== 'object') return {};
  const o = v as Record<string, unknown>;
  const tiles = TilesArtifactSchema.safeParse(o.tiles);
  return {
    ...(tiles.success ? { tiles: tiles.data } : {}),
    ...(typeof o.primitives === 'string' ? { primitives: o.primitives } : {}),
    ...(typeof o.text === 'string' ? { text: o.text } : {}),
    ...(typeof o.thumbnail === 'string' ? { thumbnail: o.thumbnail } : {}),
    ...(typeof o.legend === 'string' ? { legend: o.legend } : {}),
    ...(typeof o.detections === 'string' ? { detections: o.detections } : {}),
    ...(typeof o.links === 'string' ? { links: o.links } : {}),
    ...(typeof o.rooms === 'string' ? { rooms: o.rooms } : {}),
  };
}

const nonNegInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);

/** Sprint-1 counters are required; Sprint-2 additions are kept only when well-formed (worker-written). */
function toStats(v: unknown): SheetVersion['stats'] {
  const base = VersionStatsSchema.pick({ paths: true, segments: true, textLines: true, glyphs: true }).safeParse(v);
  if (!base.success) return null;
  const o = v as Record<string, unknown>;
  const det = DetectionStatsSchema.safeParse(o.detections);
  const rooms = nonNegInt(o.rooms);
  const legendEntries = nonNegInt(o.legendEntries);
  const links = LinkStatsSchema.safeParse(o.links);
  return {
    ...base.data,
    ...(det.success ? { detections: det.data } : {}),
    ...(rooms !== undefined ? { rooms } : {}),
    ...(legendEntries !== undefined ? { legendEntries } : {}),
    ...(links.success ? { links: links.data } : {}),
  };
}

export function toVersion(sheetId: string, id: string, d: Doc): SheetVersion {
  const status = oneOf(d.status, SHEET_VERSION_STATUSES, 'queued');
  const page = PageGeometrySchema.safeParse(d.page);

  return {
    id,
    sheetId,
    ...(typeof d.versionNo === 'number' && d.versionNo >= 1 ? { versionNo: Math.floor(d.versionNo) } : {}),
    status,
    progress: toProgress(d.progress, status),
    ...(d.error !== undefined ? { error: processingError(d.error) } : {}),
    page: page.success ? page.data : null,
    artifacts: toArtifacts(d.artifacts),
    regions: toRegions(d.regions),
    stats: toStats(d.stats),
    workerVersion: str(d.workerVersion),
    ...(typeof d.jobId === 'string' ? { jobId: d.jobId } : {}),
    ...(d.createdAt !== undefined ? { createdAt: isoOrNull(d.createdAt) } : {}),
    updatedAt: isoOrNull(d.updatedAt),
  };
}

function toJobProgress(v: unknown): JobProgress {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.pct === 'number') {
      const stage = typeof o.stage === 'string' && o.stage.length > 0 ? o.stage.slice(0, 32) : 'ingest';
      return { stage, pct: Math.min(100, Math.max(0, o.pct)) };
    }
  }
  return { stage: 'ingest', pct: typeof v === 'number' ? Math.min(100, Math.max(0, v)) : 0 };
}

export function toJob(id: string, d: Doc): Job {
  // Sprint 0 / worker docs may carry `progress: number` + `stage`; normalise to {stage, pct}.
  const progress = toJobProgress(d.progress);
  if (typeof d.progress === 'number' && typeof d.stage === 'string' && d.stage) progress.stage = d.stage.slice(0, 32);
  return {
    id,
    orgId: String(d.orgId),
    projectId: str(d.projectId),
    ...(d.sheetSetId !== undefined ? { sheetSetId: str(d.sheetSetId) } : {}),
    ...(typeof d.buildId === 'string' ? { buildId: d.buildId } : {}),
    ...(typeof d.importId === 'string' ? { importId: d.importId } : {}),
    ...(d.sheetId !== undefined ? { sheetId: str(d.sheetId) } : {}),
    ...(typeof d.versionId === 'string' ? { versionId: d.versionId } : {}),
    type: String(d.type),
    status: oneOf(d.status, JOB_STATUSES, 'queued'),
    progress,
    attempts: int(d.attempts, 0),
    ...(d.error !== undefined ? { error: processingError(d.error) } : {}),
    ...(typeof d.createdBy === 'string' ? { createdBy: d.createdBy } : {}),
    ...(d.createdAt !== undefined ? { createdAt: isoOrNull(d.createdAt) } : {}),
    updatedAt: isoOrNull(d.updatedAt),
  };
}

/** Summary of the current version for the sheets list. */
export function versionSummary(v: SheetVersion | null): Pick<SheetVersion, 'id' | 'status' | 'progress' | 'error'> | null {
  if (!v) return null;
  return { id: v.id, status: v.status, progress: v.progress, ...(v.error !== undefined ? { error: v.error } : {}) };
}

const conf = (v: unknown): number => (typeof v === 'number' && v >= 0 && v <= 1 ? v : 0);

/** orgs/{o}/projects/{p}/legendEntries/{id} — worker-written; tolerant like the other worker docs. */
export function toLegendEntry(id: string, d: Doc): LegendEntry {
  const suggested = DetectionClassSchema.safeParse(d.suggestedClass);
  const cls = SymbolClassSchema.safeParse(d.class);
  const code = ItemCodeSchema.safeParse(d.itemCode);
  return {
    id,
    sheetId: String(d.sheetId),
    versionId: String(d.versionId),
    label: typeof d.label === 'string' ? d.label.slice(0, 300) : '',
    labelConfidence: conf(d.labelConfidence),
    suggestedClass: suggested.success ? suggested.data : null,
    class: cls.success ? cls.data : null,
    itemCode: code.success ? code.data : null,
    signature: String(d.signature),
    thumbPath: str(d.thumbPath),
    status: oneOf(d.status, LEGEND_ENTRY_STATUSES, 'suggested'),
    ...(d.confirmedBy !== undefined ? { confirmedBy: str(d.confirmedBy) } : {}),
    ...(d.confirmedAt !== undefined ? { confirmedAt: isoOrNull(d.confirmedAt) } : {}),
    updatedAt: isoOrNull(d.updatedAt),
  };
}

/** orgs/{o}/symbolMappings/{signature} — API-written. */
export function toSymbolMapping(signature: string, d: Doc): SymbolMapping {
  const cls = SymbolClassSchema.safeParse(d.class);
  return {
    signature,
    class: cls.success ? cls.data : null,
    ignored: d.ignored === true,
    itemCode: typeof d.itemCode === 'string' ? d.itemCode : null,
    label: typeof d.label === 'string' ? d.label : '',
    confirmedBy: String(d.confirmedBy),
    confirmedAt: iso(d.confirmedAt),
    uses: int(d.uses, 1),
  };
}

export const mappers = { toOrg, toMember, toProject, toSheetSet, toSheet, toVersion, toJob, toLegendEntry, toSymbolMapping };
