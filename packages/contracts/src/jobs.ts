import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema } from './common.js';
import { LIBRARY_IMPORT_PATH_RE, PROJECT_UPLOAD_PATH_RE, SOURCE_PATH_RE } from './firestore.js';
import { SimilarExemplarSchema, SimilarScopeSchema, SIMILAR_MAX_CANDIDATES } from './corrections.js';
import { DocIdSchema } from './org.js';
import { FileKindSchema, ProcessingErrorSchema } from './sheets.js';

/** Pub/Sub topics (ADR 0008). */
export const TOPICS = Object.freeze({ ingest: 'ingest' } as const);

export const JOB_TYPES = Object.freeze({
  ingestSheetVersion: 'ingest.sheet_version',
  /** Sprint 3: aggregate all current, ready sheet versions of a project into boqLines. */
  boqBuild: 'boq.build',
  /** Sprint 3: parse a past BOQ (xls/xlsx) into the org item library (+ a template). */
  libraryImport: 'library.import',
  /** Sprint 4: "learn from correction" — find symbols similar to an exemplar (Worker-A). */
  findSimilar: 'symbols.find_similar',
} as const);
export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/** Past-BOQ file kinds accepted by `library.import` (magic bytes checked by the API). */
export const LIBRARY_IMPORT_KINDS = ['xls', 'xlsx'] as const;

export const INGEST_JOB_SCHEMA_VERSION = 3 as const;

/** W3C trace-context `traceparent` header value. */
export const TraceparentSchema = z
  .string()
  .regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/, 'invalid W3C traceparent');

/**
 * Pub/Sub message data (JSON) on topic `ingest`, type `ingest.sheet_version`, schemaVersion 3.
 * Attributes: `type`, `orgId`, `jobId`, `schemaVersion` (routing/dedupe without parsing data).
 * Identifiers only (SEC-24). The worker must load jobs/{jobId}, check `job.orgId == orgId`, and write only
 * under orgs/{orgId}/projects/{projectId}/... and jobs/{jobId}. Delivery is at-least-once: jobs/{jobId}
 * is the idempotency key.
 *
 * Two modes:
 * - **initial** (`sheetId == null`, `pageIndex == null`): split every page i of the upload into
 *   `sheets/{sheetSetId}-p{i}` with version doc `versions/{versionId}` (same versionId for all pages).
 * - **reprocess** (`sheetId` + `pageIndex` set): re-run page `pageIndex` into the existing, already-created
 *   `sheets/{sheetId}/versions/{versionId}` (status `queued`, regions copied from the previous version).
 */
export const IngestSheetVersionJobSchema = z
  .object({
    schemaVersion: z.literal(INGEST_JOB_SCHEMA_VERSION),
    type: z.literal(JOB_TYPES.ingestSheetVersion),
    jobId: DocIdSchema,
    orgId: DocIdSchema,
    projectId: DocIdSchema,
    sheetSetId: DocIdSchema,
    sheetId: DocIdSchema.nullable(),
    pageIndex: z.number().int().nonnegative().max(10_000).nullable(),
    versionId: DocIdSchema,
    /** orgs/{orgId}/projects/{projectId}/uploads/{sheetSetId}/source.{ext} in the default bucket. */
    storagePath: z.string().regex(PROJECT_UPLOAD_PATH_RE, 'invalid upload path'),
    sha256: Sha256HexSchema,
    fileKind: FileKindSchema,
    traceparent: TraceparentSchema.nullable(),
  })
  .strict()
  .refine((j) => j.storagePath === `orgs/${j.orgId}/projects/${j.projectId}/uploads/${j.sheetSetId}/source.${j.fileKind}`, {
    message: 'storagePath must be the upload of the job org/project/sheetSet/fileKind',
    path: ['storagePath'],
  })
  .refine((j) => (j.sheetId === null) === (j.pageIndex === null), {
    message: 'sheetId and pageIndex must both be set (reprocess) or both be null (initial)',
    path: ['pageIndex'],
  });
export type IngestSheetVersionJob = z.infer<typeof IngestSheetVersionJobSchema>;

/** @deprecated Sprint 0 payload (schemaVersion 2, content-addressed `sources/` path). Not published anymore. */
export const IngestSheetVersionJobV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    type: z.literal(JOB_TYPES.ingestSheetVersion),
    jobId: DocIdSchema,
    orgId: DocIdSchema,
    projectId: DocIdSchema,
    sheetSetId: DocIdSchema,
    sheetId: DocIdSchema,
    versionId: DocIdSchema,
    storagePath: z.string().regex(SOURCE_PATH_RE, 'invalid source path'),
    sha256: Sha256HexSchema,
    fileKind: FileKindSchema,
    traceparent: TraceparentSchema.nullable(),
  })
  .strict()
  .refine((j) => j.storagePath.startsWith(`orgs/${j.orgId}/projects/${j.projectId}/sources/${j.sha256}.`), {
    message: 'storagePath must belong to the job org/project/sha256',
    path: ['storagePath'],
  });
export type IngestSheetVersionJobV2 = z.infer<typeof IngestSheetVersionJobV2Schema>;

export const BOQ_BUILD_JOB_SCHEMA_VERSION = 1 as const;
export const LIBRARY_IMPORT_JOB_SCHEMA_VERSION = 1 as const;

/**
 * Topic `ingest`, type `boq.build` (Sprint 3). The worker loads jobs/{jobId} (orgId must match) and
 * orgs/{orgId}/projects/{projectId}/boqBuilds/{buildId}, aggregates every current `ready` sheet version, writes
 * boqLines (never overwriting BOQ_LINE_PRESERVED_FIELDS), evidence.json.gz, the build doc and project `boq`
 * (`latestBuildId`, `builtAt`, `stale: false`, `pendingBuildId: null`).
 */
export const BoqBuildJobSchema = z
  .object({
    schemaVersion: z.literal(BOQ_BUILD_JOB_SCHEMA_VERSION),
    type: z.literal(JOB_TYPES.boqBuild),
    jobId: DocIdSchema,
    orgId: DocIdSchema,
    projectId: DocIdSchema,
    buildId: DocIdSchema,
    traceparent: TraceparentSchema.nullable(),
  })
  .strict();
export type BoqBuildJob = z.infer<typeof BoqBuildJobSchema>;

/**
 * Topic `ingest`, type `library.import` (Sprint 3). `storagePath` = orgs/{orgId}/imports/{importId}.{sourceKind}
 * (verified by the API: size + magic bytes). The worker upserts orgs/{orgId}/itemLibrary/{itemIdFor(code, desc)}
 * (source `import`, sourceRef = importId), creates a template from the file's structure when the org has none, and
 * may write status/stats/error on orgs/{orgId}/libraryImports/{importId}.
 */
export const LibraryImportJobSchema = z
  .object({
    schemaVersion: z.literal(LIBRARY_IMPORT_JOB_SCHEMA_VERSION),
    type: z.literal(JOB_TYPES.libraryImport),
    jobId: DocIdSchema,
    orgId: DocIdSchema,
    projectId: DocIdSchema.nullable(),
    importId: z.string().uuid(),
    storagePath: z.string().regex(LIBRARY_IMPORT_PATH_RE, 'invalid import path'),
    sourceKind: z.enum(LIBRARY_IMPORT_KINDS),
    traceparent: TraceparentSchema.nullable(),
  })
  .strict()
  .refine((j) => j.storagePath === `orgs/${j.orgId}/imports/${j.importId}.${j.sourceKind}`, {
    message: 'storagePath must be the import object of the job org/importId/sourceKind',
    path: ['storagePath'],
  });
export type LibraryImportJob = z.infer<typeof LibraryImportJobSchema>;

export const FIND_SIMILAR_JOB_SCHEMA_VERSION = 1 as const;

/**
 * Topic `ingest`, type `symbols.find_similar` (Sprint 4, Worker-A). The worker loads jobs/{jobId} (orgId must
 * match) and orgs/{orgId}/projects/{projectId}/similarSearches/{searchId}; builds a template from the exemplar's
 * strokes (sheet version primitives inside `bboxMm`), searches the exemplar's sheet (`scope: sheet`) or every
 * current ready version of the project (`scope: project`), and writes `status`, `candidates` (score desc, ≤
 * `maxCandidates`, `alreadyDetected` = detection id at that position or null, `currentClass`), `thumbs` and
 * `finishedAt`; crops go to orgs/{o}/projects/{p}/similar/{searchId}/{candidateId}.webp (≤ 256 px).
 */
export const FindSimilarJobSchema = z
  .object({
    schemaVersion: z.literal(FIND_SIMILAR_JOB_SCHEMA_VERSION),
    type: z.literal(JOB_TYPES.findSimilar),
    jobId: DocIdSchema,
    orgId: DocIdSchema,
    projectId: DocIdSchema,
    searchId: DocIdSchema,
    exemplar: SimilarExemplarSchema,
    scope: SimilarScopeSchema,
    maxCandidates: z.number().int().min(1).max(SIMILAR_MAX_CANDIDATES),
    traceparent: TraceparentSchema.nullable(),
  })
  .strict();
export type FindSimilarJob = z.infer<typeof FindSimilarJobSchema>;

/**
 * Every message on topic `ingest` (discriminate on `type`; attribute `type` carries it too). Python: validate with
 * json-schema/IngestTopicJob.json (anyOf) and dispatch on `type`.
 */
export const IngestTopicJobSchema = z.union([IngestSheetVersionJobSchema, BoqBuildJobSchema, LibraryImportJobSchema, FindSimilarJobSchema]);
export type IngestTopicJob = z.infer<typeof IngestTopicJobSchema>;

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Job progress: stage name (worker-defined, e.g. the version stages) + percentage. */
export const JobProgressSchema = z.object({
  stage: z.string().min(1).max(32),
  pct: z.number().min(0).max(100),
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

/**
 * jobs/{jobId} (top level) — written by the API (create) and the worker (status/progress/attempts/error).
 * Readable by members of `orgId` (client listeners); never client-writable.
 */
export const JobSchema = z.object({
  id: DocIdSchema,
  orgId: DocIdSchema,
  /** null for org-level jobs (`library.import` without a project). */
  projectId: DocIdSchema.nullable(),
  /** Ingest jobs only (null/absent for `boq.build` / `library.import`). */
  sheetSetId: DocIdSchema.nullable().optional(),
  /** `boq.build`: boqBuilds/{buildId}. */
  buildId: DocIdSchema.optional(),
  /** `library.import`: libraryImports/{importId}. */
  importId: z.string().uuid().optional(),
  /** `symbols.find_similar`: similarSearches/{searchId}. */
  searchId: DocIdSchema.optional(),
  /** null for an initial ingest (all pages); the sheet for a reprocess. */
  sheetId: DocIdSchema.nullable().optional(),
  versionId: DocIdSchema.optional(),
  type: z.string().min(1).max(64),
  status: JobStatusSchema,
  progress: JobProgressSchema,
  attempts: z.number().int().nonnegative(),
  error: ProcessingErrorSchema.nullable().optional(),
  createdBy: z.string().max(128).optional(),
  createdAt: TimestampSchema.nullable().optional(),
  updatedAt: TimestampSchema.nullable(),
});
export type Job = z.infer<typeof JobSchema>;
