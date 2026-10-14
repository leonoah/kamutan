import { z } from 'zod';
import { TimestampSchema, pageOf } from './common.js';
import { ProjectBoqSummarySchema } from './boq.js';
import { DocIdSchema, UidSchema } from './org.js';

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const FloorMetaSchema = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1).max(100),
  sortOrder: z.number().int(),
  elevationM: z.number().optional(),
});
export type FloorMeta = z.infer<typeof FloorMetaSchema>;

export const ProjectStatsSchema = z.object({
  sheets: z.number().int().nonnegative(),
  reviewOpen: z.number().int().nonnegative(),
  boqLines: z.number().int().nonnegative(),
  red: z.number().int().nonnegative(),
  yellow: z.number().int().nonnegative(),
  green: z.number().int().nonnegative(),
});

/**
 * orgs/{orgId}/projects/{projectId}. `projectId` (== doc id) and `orgId` are
 * stored on the doc too so the API can resolve a bare project id with a
 * collection-group query (`projects` where projectId == X).
 */
export const ProjectSchema = z.object({
  id: DocIdSchema,
  orgId: DocIdSchema,
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional(),
  templateId: z.string().nullable().optional(),
  floors: z.array(FloorMetaSchema),
  stats: ProjectStatsSchema.optional(),
  /** Sprint 3: BOQ build state (latest build, stale flag). Absent before the first build request. */
  boq: ProjectBoqSummarySchema.optional(),
  status: ProjectStatusSchema,
  createdBy: UidSchema,
  createdAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectRequestSchema = z
  .object({
    orgId: DocIdSchema,
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().max(500).optional(),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().max(500).optional(),
    status: ProjectStatusSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const ListProjectsQuerySchema = z.object({
  orgId: DocIdSchema,
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;

export const ProjectPageSchema = pageOf(ProjectSchema);
export type ProjectPage = z.infer<typeof ProjectPageSchema>;
