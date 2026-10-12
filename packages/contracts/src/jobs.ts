import { z } from 'zod';
import { Sha256HexSchema, TimestampSchema } from './common.js';
import { SOURCE_PATH_RE } from './firestore.js';
import { DocIdSchema } from './org.js';
import { FileKindSchema } from './sheets.js';

/** Pub/Sub topics (ADR 0008). */
export const TOPICS = Object.freeze({ ingest: 'ingest' } as const);

export const JOB_TYPES = Object.freeze({ ingestSheetVersion: 'ingest.sheet_version' } as const);

/** W3C trace-context `traceparent` header value. */
export const TraceparentSchema = z
  .string()
  .regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/, 'invalid W3C traceparent');

/**
 * Pub/Sub message data (JSON) on topic `ingest`, type `ingest.sheet_version`.
 * Identifiers only (SEC-24). The worker must load jobs/{jobId} and the docs
 * under orgs/{orgId}/projects/{projectId}/... and write only under that org.
 */
export const IngestSheetVersionJobSchema = z
  .object({
    schemaVersion: z.literal(2),
    type: z.literal(JOB_TYPES.ingestSheetVersion),
    jobId: DocIdSchema,
    orgId: DocIdSchema,
    projectId: DocIdSchema,
    sheetSetId: DocIdSchema,
    sheetId: DocIdSchema,
    versionId: DocIdSchema,
    /** orgs/{orgId}/projects/{projectId}/sources/{sha256}.{ext} in the default bucket. */
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
export type IngestSheetVersionJob = z.infer<typeof IngestSheetVersionJobSchema>;

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** jobs/{jobId} — server/worker-written; readable by members of orgId. */
export const JobSchema = z.object({
  id: DocIdSchema,
  orgId: DocIdSchema,
  projectId: DocIdSchema.optional(),
  versionId: DocIdSchema.optional(),
  type: z.string().min(1).max(64),
  status: JobStatusSchema,
  progress: z.number().min(0).max(100),
  stage: z.string().max(64).optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullable().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema.optional(),
});
export type Job = z.infer<typeof JobSchema>;
