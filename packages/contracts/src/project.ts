import { z } from 'zod';
import { TimestampSchema, UuidSchema, pageOf } from './common.js';

export const PROJECT_STATUSES = ['active', 'archived'] as const;
export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSchema = z.object({
  id: UuidSchema,
  orgId: UuidSchema,
  name: z.string().min(1).max(200),
  address: z.string().max(500).nullable(),
  status: ProjectStatusSchema,
  createdBy: UuidSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectRequestSchema = z
  .object({
    orgId: UuidSchema,
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().max(500).nullish(),
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    address: z.string().trim().max(500).nullable().optional(),
    status: ProjectStatusSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const ListProjectsQuerySchema = z.object({
  orgId: UuidSchema.optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListProjectsQuery = z.infer<typeof ListProjectsQuerySchema>;

export const ProjectPageSchema = pageOf(ProjectSchema);
export type ProjectPage = z.infer<typeof ProjectPageSchema>;
