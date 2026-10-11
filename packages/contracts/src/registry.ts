import type { ZodTypeAny } from 'zod';
import { AccessTokenClaimsSchema } from './auth.js';
import { ApiErrorSchema } from './errors.js';
import { HealthResponseSchema } from './health.js';
import { IngestSheetVersionJobSchema } from './jobs.js';
import { CreateOrgRequestSchema, MeResponseSchema, MembershipSchema, OrgSchema } from './org.js';
import {
  CreateProjectRequestSchema,
  ProjectPageSchema,
  ProjectSchema,
  UpdateProjectRequestSchema,
} from './project.js';
import { RoleSchema } from './roles.js';
import { FileKindSchema, SheetSetSchema, SheetVersionSchema } from './sheets.js';
import {
  CreateUploadRequestSchema,
  CreateUploadResponseSchema,
  FinalizeUploadRequestSchema,
  FinalizeUploadResponseSchema,
} from './uploads.js';

/**
 * Schemas exported as JSON Schema (packages/contracts/json-schema/*.json) for
 * Python codegen (datamodel-code-generator → py-packages/kamutan_contracts).
 * Key = output file name / model name.
 */
export const jsonSchemaRegistry: Readonly<Record<string, ZodTypeAny>> = Object.freeze({
  Role: RoleSchema,
  FileKind: FileKindSchema,
  Org: OrgSchema,
  Membership: MembershipSchema,
  MeResponse: MeResponseSchema,
  CreateOrgRequest: CreateOrgRequestSchema,
  Project: ProjectSchema,
  ProjectPage: ProjectPageSchema,
  CreateProjectRequest: CreateProjectRequestSchema,
  UpdateProjectRequest: UpdateProjectRequestSchema,
  SheetSet: SheetSetSchema,
  SheetVersion: SheetVersionSchema,
  CreateUploadRequest: CreateUploadRequestSchema,
  CreateUploadResponse: CreateUploadResponseSchema,
  FinalizeUploadRequest: FinalizeUploadRequestSchema,
  FinalizeUploadResponse: FinalizeUploadResponseSchema,
  IngestSheetVersionJob: IngestSheetVersionJobSchema,
  ApiError: ApiErrorSchema,
  AccessTokenClaims: AccessTokenClaimsSchema,
  HealthResponse: HealthResponseSchema,
});
