import { z } from 'zod';
import { Sha256HexSchema, UuidSchema } from './common.js';
import { FileKindSchema } from './sheets.js';
import { StoragePathSchema } from './uploads.js';

/** BullMQ queue names (04_architecture.md "Queues"). */
export const QUEUE_NAMES = Object.freeze({
  ingest: 'ingest',
  render: 'render',
  analyze: 'analyze',
  projectAggregate: 'project-aggregate',
  learn: 'learn',
  export: 'export',
  llm: 'llm',
} as const);

export const JOB_TYPES = Object.freeze({
  ingestSheetVersion: 'ingest.sheet_version',
} as const);

/** W3C trace-context `traceparent` header value. */
export const TraceparentSchema = z
  .string()
  .regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/, 'invalid W3C traceparent');

/**
 * Payload of job `ingest.sheet_version` on queue `ingest`.
 * Contains identifiers only (SEC-24): the worker re-validates them against the DB
 * and must scope every write by `orgId`.
 */
export const IngestSheetVersionJobSchema = z
  .object({
    schemaVersion: z.literal(1),
    sheetVersionId: UuidSchema,
    orgId: UuidSchema,
    projectId: UuidSchema,
    /** Object path inside the private `drawings` bucket: {orgId}/upload/{uuid}. */
    storagePath: StoragePathSchema,
    sha256: Sha256HexSchema,
    fileKind: FileKindSchema,
    traceparent: TraceparentSchema.nullable(),
  })
  .strict()
  .refine((j) => j.storagePath.startsWith(`${j.orgId}/`), {
    message: 'storagePath must be inside the job org prefix',
    path: ['storagePath'],
  });
export type IngestSheetVersionJob = z.infer<typeof IngestSheetVersionJobSchema>;

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;
