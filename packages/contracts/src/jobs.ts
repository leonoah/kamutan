import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema } from './common.js';
import { PROJECT_UPLOAD_PATH_RE, SOURCE_PATH_RE } from './firestore.js';
import { DocIdSchema } from './org.js';
import { FileKindSchema, ProcessingErrorSchema } from './sheets.js';

/** Pub/Sub topics (ADR 0008). */
export const TOPICS = Object.freeze({ ingest: 'ingest' } as const);

export const JOB_TYPES = Object.freeze({ ingestSheetVersion: 'ingest.sheet_version' } as const);

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
  projectId: DocIdSchema,
  sheetSetId: DocIdSchema,
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
