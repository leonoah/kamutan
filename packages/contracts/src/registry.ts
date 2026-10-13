import type { ZodTypeAny } from 'zod';
import { IdTokenClaimsSchema } from './auth.js';
import { BoqLineSchema } from './boq.js';
import { ApiErrorSchema } from './errors.js';
import { HealthResponseSchema } from './health.js';
import { IngestSheetVersionJobSchema, JobSchema } from './jobs.js';
import { CreateOrgRequestSchema, MeResponseSchema, MemberSchema, MyOrgSchema, OrgSchema } from './org.js';
import { CreateProjectRequestSchema, ProjectPageSchema, ProjectSchema, UpdateProjectRequestSchema } from './project.js';
import { CorrectionSchema, ReviewItemSchema } from './review.js';
import { RoleSchema } from './roles.js';
import { ShareLinkSchema } from './share.js';
import {
  ConfirmSheetRequestSchema,
  DetectionStatsSchema,
  FileKindSchema,
  PutRegionsRequestSchema,
  PutRegionsResponseSchema,
  RegionSchema,
  ReprocessSheetResponseSchema,
  SheetClassificationSchema,
  SheetPageSchema,
  SheetSchema,
  SheetSetSchema,
  SheetSummarySchema,
  SheetVersionSchema,
  TilesArtifactSchema,
  VersionStageSchema,
} from './sheets.js';
import { DetectionClassSchema, SymbolClassSchema } from './taxonomy.js';
import { TilesManifestSchema } from './tiles.js';
import {
  BBoxMmSchema,
  DetectionSchema,
  DetectionsArtifactSchema,
  LegendArtifactSchema,
  LegendEntryPageSchema,
  LegendEntrySchema,
  OverlayManifestSchema,
  PatchLegendEntryRequestSchema,
  PatchLegendEntryResponseSchema,
  ResolveUnknownClusterRequestSchema,
  ResolveUnknownClusterResponseSchema,
  RoomSchema,
  RoomsArtifactSchema,
  SymbolMappingSchema,
  UnknownClusterSchema,
} from './understanding.js';
import {
  CreateUploadRequestSchema,
  CreateUploadResponseSchema,
  FinalizeUploadRequestSchema,
  FinalizeUploadResponseSchema,
} from './uploads.js';

/**
 * Schemas exported as JSON Schema (packages/contracts/json-schema/*.json) for
 * Python codegen (datamodel-code-generator -> py-packages/kamutan_contracts).
 */
export const jsonSchemaRegistry: Readonly<Record<string, ZodTypeAny>> = Object.freeze({
  Role: RoleSchema,
  FileKind: FileKindSchema,
  Org: OrgSchema,
  Member: MemberSchema,
  MyOrg: MyOrgSchema,
  MeResponse: MeResponseSchema,
  CreateOrgRequest: CreateOrgRequestSchema,
  Project: ProjectSchema,
  ProjectPage: ProjectPageSchema,
  CreateProjectRequest: CreateProjectRequestSchema,
  UpdateProjectRequest: UpdateProjectRequestSchema,
  SheetSet: SheetSetSchema,
  Sheet: SheetSchema,
  SheetVersion: SheetVersionSchema,
  SheetClassification: SheetClassificationSchema,
  SheetSummary: SheetSummarySchema,
  SheetPage: SheetPageSchema,
  Region: RegionSchema,
  TilesArtifact: TilesArtifactSchema,
  TilesManifest: TilesManifestSchema,
  ConfirmSheetRequest: ConfirmSheetRequestSchema,
  PutRegionsRequest: PutRegionsRequestSchema,
  PutRegionsResponse: PutRegionsResponseSchema,
  ReprocessSheetResponse: ReprocessSheetResponseSchema,
  Job: JobSchema,
  ReviewItem: ReviewItemSchema,
  Correction: CorrectionSchema,
  BoqLine: BoqLineSchema,
  ShareLink: ShareLinkSchema,
  CreateUploadRequest: CreateUploadRequestSchema,
  CreateUploadResponse: CreateUploadResponseSchema,
  FinalizeUploadRequest: FinalizeUploadRequestSchema,
  FinalizeUploadResponse: FinalizeUploadResponseSchema,
  IngestSheetVersionJob: IngestSheetVersionJobSchema,
  ApiError: ApiErrorSchema,
  IdTokenClaims: IdTokenClaimsSchema,
  HealthResponse: HealthResponseSchema,
  // Sprint 2 — understanding (worker artifacts, Firestore docs, API DTOs)
  VersionStage: VersionStageSchema,
  DetectionStats: DetectionStatsSchema,
  SymbolClass: SymbolClassSchema,
  DetectionClass: DetectionClassSchema,
  BBoxMm: BBoxMmSchema,
  LegendArtifact: LegendArtifactSchema,
  DetectionsArtifact: DetectionsArtifactSchema,
  Detection: DetectionSchema,
  UnknownCluster: UnknownClusterSchema,
  RoomsArtifact: RoomsArtifactSchema,
  Room: RoomSchema,
  LegendEntry: LegendEntrySchema,
  SymbolMapping: SymbolMappingSchema,
  OverlayManifest: OverlayManifestSchema,
  LegendEntryPage: LegendEntryPageSchema,
  PatchLegendEntryRequest: PatchLegendEntryRequestSchema,
  PatchLegendEntryResponse: PatchLegendEntryResponseSchema,
  ResolveUnknownClusterRequest: ResolveUnknownClusterRequestSchema,
  ResolveUnknownClusterResponse: ResolveUnknownClusterResponseSchema,
});
