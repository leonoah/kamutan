/**
 * App-local DTOs mirroring @kamutan/contracts (packages/contracts/src/*.ts) field-for-field.
 * Kept local so the web app builds without the contracts package; switch to
 * `import type { … } from "@kamutan/contracts"` once its build is wired into turbo for web.
 */
import type {
  ApplyImportPricesResponse as ContractApplyImportPricesResponse,
  BoqBuildSummary as ContractBoqBuildSummary,
  BoqComparison as ContractBoqComparison,
  BoqCompareExportResponse as ContractBoqCompareExportResponse,
  BoqTotals as ContractBoqTotals,
  BulkLibraryPriceResponse as ContractBulkLibraryPriceResponse,
  DeleteProjectResponse as ContractDeleteProjectResponse,
  DeleteSheetSetResponse as ContractDeleteSheetSetResponse,
  InputQuality as ContractInputQuality,
  InputQualityIssue as ContractInputQualityIssue,
  ItemPrice as ContractItemPrice,
  PatchProjectPricingResponse as ContractPatchProjectPricingResponse,
  PriceImportReport as ContractPriceImportReport,
  ProjectPricing as ContractProjectPricing,
} from "@kamutan/contracts";

/* Sprint 8 shapes come straight from @kamutan/contracts ("Sprint 8 published"; type-only, no runtime cost). */
export type BoqTotals = ContractBoqTotals;
export type ItemPrice = ContractItemPrice;
export type ProjectPricing = ContractProjectPricing;
export type PatchProjectPricingResponse = ContractPatchProjectPricingResponse;
export type PriceImportReport = ContractPriceImportReport;
export type BoqComparison = ContractBoqComparison;
export type BoqCompareItem = BoqComparison["items"][number];
export type BoqCompareCause = BoqCompareItem["causes"][number];
export type BoqCompareExportResponse = ContractBoqCompareExportResponse;
/* Sprint 9 ("Sprint 9 published"): input-quality gate on the sheet version (worker-written). */
export type InputQuality = ContractInputQuality;
export type InputQualityIssue = ContractInputQualityIssue;
export type InputQualityIssueKind = InputQualityIssue["kind"];

export type Role = "admin" | "editor" | "reviewer" | "viewer";
export type FileKind = "pdf" | "dwg" | "dxf" | "png";

export interface MyOrg {
  id: string;
  name: string;
  role: Role;
  /** Sprint 3 (optional in the /me DTO): org policy, e.g. block export while "לבדיקה" lines remain. */
  settings?: Partial<OrgSettings>;
  /** Sprint 5: short url-safe org name typed to confirm offboarding (falls back to the id). */
  slug?: string;
  /** Sprint 5: `offboarding` blocks everything except the export download (SEC-52). */
  status?: OrgStatus;
  deleteAfter?: string | null;
}
export interface MeResponse {
  uid: string;
  mfa: boolean;
  orgs: MyOrg[];
}

export interface ProjectStats {
  sheets: number;
  reviewOpen: number;
  boqLines: number;
  red: number;
  yellow: number;
  green: number;
}

/** contracts ProjectSchema */
export interface Project {
  id: string;
  orgId: string;
  name: string;
  address?: string;
  templateId?: string | null;
  floors: { code: string; name: string; sortOrder: number }[];
  stats?: ProjectStats;
  /** Sprint 3: project doc `boq` (latest build pointer + stale flag). */
  boq?: ProjectBoqState | null;
  status: "active" | "archived";
  createdBy: string;
  createdAt: string; // ISO
  /** Sprint 7: bytes stored by the project (sources + derived), counted on finalize. */
  storageBytes?: number;
  /** Sprint 7 (contracts, read-only): the project's quota (from the org setting `projectQuotaBytes`). */
  storageQuotaBytes?: number;
  /** Sprint 8 (contracts ProjectPricing): discount (< 0) / markup (> 0) of the BOQ totals; `PATCH …/boq/pricing`. */
  pricing?: ProjectPricing | null;
  /** Integration (read-only): current (non-superseded) sheets and the per-project limit (hub banner). */
  sheetCount?: number;
  sheetLimit?: number;
}
/** Sprint 7: default per-project storage quota (org setting `projectQuotaBytes`). */
export const DEFAULT_PROJECT_QUOTA_BYTES = 2 * 1024 ** 3;

export interface CreateProjectInput {
  orgId: string;
  name: string;
  address?: string;
}

/** PATCH /api/v1/projects/:projectId (contracts UpdateProjectRequest — at least one field). */
export interface UpdateProjectInput {
  name?: string;
  address?: string;
  status?: "active" | "archived";
}

/** POST /api/v1/projects/:projectId/uploads */
export interface CreateUploadRequest {
  filename: string;
  sizeBytes: number;
  sha256?: string;
}
export interface CreateUploadResponse {
  fileId: string;
  /** orgs/{orgId}/uploads/{uid}/{fileId} */
  storagePath: string;
  uploadToken: string;
  contentType: string;
  fileKind: FileKind;
  maxBytes: number;
  expiresAt: string;
}

/** POST /api/v1/projects/:projectId/sheet-sets */
export interface FinalizeUploadRequest {
  uploadToken: string;
  name?: string;
  /**
   * Stage 10 (A-API-05, revised upload): this upload is a new revision of an existing set. The old set's sheets become
   * superseded versions of the matching new sheets (title/number + discipline/floor, else page order); the BOQ build
   * uses only current versions. Also used by "העלה מחדש" on a failed set (A-UI-05): nothing to match, the failed set is
   * marked superseded. Requested in apps/web/NOTES.md "Contract requests (Stage 10)".
   */
  replacesSheetSetId?: string;
}
export type SheetSetStatus = "uploaded" | "queued" | "splitting" | "ready" | "failed" | "superseded";
export type SheetVersionStatus = "uploaded" | "queued" | "processing" | "ready" | "failed";

export interface SheetSet {
  id: string;
  orgId: string;
  projectId: string;
  fileKind: FileKind;
  sha256: string;
  storagePath: string;
  status: SheetSetStatus;
  name?: string;
  uploadedBy: string;
  createdAt: string;
  /** Sprint 8 (read-only): bytes the set holds (source + derived) — what a delete releases. */
  storageBytes?: number;
  /** Stage 10 revised upload (contracts sheets.ts): the set this one replaces / the set that replaced this one. */
  replacesSheetSetId?: string | null;
  supersededBySetId?: string | null;
  supersededAt?: string | null;
  /** Mock / older name of `supersededBySetId`. */
  supersededBy?: string | null;
}
/* ---------- Sprint 1: ingest (docs/agents/SPRINT1_BRIEF.md, packages/contracts/src/sheets.ts + tiles.ts) ----------
 * TODO(contracts): hand-kept mirror of @kamutan/contracts (Sprint 1 shapes, still in flight on the API side).
 * Replace with `import type` from @kamutan/contracts once web depends on the built package.
 */
export const INGEST_STAGES = ["ingest", "render", "ocr", "classify", "scale", "legend", "detect", "rooms", "done"] as const;
export type IngestStage = (typeof INGEST_STAGES)[number];
export type ClassificationLevel = "green" | "yellow" | "red";

export interface SheetClassification {
  discipline: string | null;
  floors: string[];
  sheetTitle: string | null;
  scaleText: string | null;
  confidence: number; // 0..1
  level: ClassificationLevel;
  /** Reason codes (UI maps known codes to Hebrew; unknown codes are shown verbatim). */
  reasons: string[];
}

/** Tiles pyramid meta stored on the version doc (z = 0 fits one 256 px tile). */
export interface TilesMeta {
  prefix: string;
  format: "webp";
  tileSize: number;
  dpi: number;
  levels: number;
  widthPx: number;
  heightPx: number;
}

/** Point in paper mm. `{x, y}` (not `[x, y]`): Firestore cannot store nested arrays (contracts PointMmSchema). */
export interface PointMm {
  x: number;
  y: number;
}

/** contracts RegionSchema: id [A-Za-z0-9_-], ≤ 8 regions, 3..256 points, implicitly closed. */
export interface SheetRegion {
  id: string;
  floor: string;
  /** Paper mm, origin top-left, y down. */
  polygonMm: PointMm[];
  scaleDenominator: number;
}

/** orgs/{o}/projects/{p}/sheets/{sheetId}; sheetId = `${sheetSetId}-p${pageIndex}`. */
export interface Sheet {
  id: string;
  sheetSetId: string;
  currentVersionId: string | null;
  /** Sprint 0 field; Sprint 1 docs may omit it. */
  logicalKey?: string;
  titleBlock?: { sheetTitle?: string; sheetNumber?: string; scaleText?: string };
  pageIndex?: number;
  title?: string | null;
  discipline?: string | null;
  floors?: string[];
  scaleDenominator?: number | null;
  classification?: SheetClassification;
  confirmed?: boolean;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  updatedAt?: string;
  /** Stage 10 revised upload: the sheet (of the new set) this one became a superseded version of. Hidden in lists. */
  supersededBy?: string | null;
}
export interface SheetVersion {
  id: string;
  sheetId: string;
  versionNo?: number;
  status: SheetVersionStatus;
  createdAt: string;
  progress?: { stage: IngestStage; pct: number };
  error?: { code: string; message: string } | null;
  page?: { widthMm: number; heightMm: number; rotation: number };
  artifacts?: {
    tiles?: TilesMeta;
    primitives?: string;
    text?: string;
    thumbnail?: string;
    /** Sprint 2: full object paths of the understanding artifacts (gzip JSON). */
    legend?: string;
    detections?: string;
    rooms?: string;
    /** Sprint 3: `.../versions/{v}/links.json.gz` (kamutan.links/1). */
    links?: string;
  };
  regions?: SheetRegion[];
  stats?: VersionStats;
  /** Sprint 9: input-quality gate (raster input). Absent / null = not checked ≡ ok. `reject` → no counts. */
  quality?: InputQuality | null;
  workerVersion?: string;
  updatedAt?: string;
}
export interface SheetRow {
  sheet: Sheet;
  version: SheetVersion | null;
}

/** POST /v1/projects/:pid/sheets/:sid/confirm (contracts ConfirmSheetRequestSchema, strict). */
export interface ConfirmSheetRequest {
  discipline: string;
  floors: string[];
  /** Integer 1..10000; null for sheets without a scale (legends, schedules). */
  scaleDenominator: number | null;
  /** Replaces the current version's regions when present. */
  regions?: SheetRegion[];
}

/** PUT /v1/projects/:pid/sheets/:sid/regions response. */
export interface PutRegionsResponse {
  sheetId: string;
  versionId: string;
  regions: SheetRegion[];
}

/**
 * GET /v1/projects/:pid/sheets/:sid/versions/:vid/tiles-manifest (contracts TilesManifestQuerySchema).
 * No params → meta + thumbnail; `z` + inclusive `x0..x1, y0..y1` window → signed URLs (≤ maxBatch tiles).
 */
export interface TilesManifestQuery {
  z: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
export interface TileLevel {
  z: number;
  widthPx: number;
  heightPx: number;
  cols: number;
  rows: number;
  mmPerPx: number;
}
/** contracts TilesManifestSchema. Signed URLs live 15 min. */
export interface TilesManifest {
  sheetId: string;
  versionId: string;
  page: { widthMm: number; heightMm: number; rotation: number } | null;
  tiles: Omit<TilesMeta, "prefix">;
  levelGrid: TileLevel[];
  thumbnailUrl: string | null;
  /** Signed URLs keyed "{z}/{x}_{y}" for the requested window (empty without `z`). */
  urls: Record<string, string>;
  /** Earliest expiry among the returned URLs. */
  expiresAt: string;
  maxBatch: number;
}

/* ---------- Sprint 2: understanding (docs/agents/SPRINT2_BRIEF.md, contracts src/understanding.ts) ----------
 * TODO(contracts): hand-kept mirror of @kamutan/contracts understanding.ts (field-for-field).
 */
export type DbLevel = "green" | "yellow" | "red";
export type Lifecycle = "existing" | "new" | "demolish" | "unknown";

export interface DetectionStats {
  total: number;
  green: number;
  yellow: number;
  red: number;
  unknown: number;
  byClass: Record<string, number>;
}
export interface VersionStats {
  paths?: number;
  segments?: number;
  textLines?: number;
  glyphs?: number;
  detections?: DetectionStats;
  rooms?: number;
  legendEntries?: number;
  /** Sprint 5: calibration table the worker scored this version with. */
  calibration?: CalibrationStats;
  /** Sprint 5: per-stage worker timings. */
  timingsMs?: Record<string, number>;
}

/** Axis-aligned box in paper mm (x, y = top-left). */
export interface BBoxMm {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LegendBlock {
  id: string;
  bboxMm: BBoxMm;
  title: string | null;
  confidence: number;
}
export interface LegendArtifactEntry {
  id: string;
  legendId: string;
  symbolBboxMm: BBoxMm;
  labelBboxMm: BBoxMm;
  label: string;
  labelConfidence: number;
  /** Taxonomy id, "unknown", or null. */
  suggestedClass: string | null;
  classConfidence: number;
  signature: string;
  /** `legend/{entryId}.webp` relative to the version prefix, or null. */
  thumb: string | null;
}
export interface LegendArtifact {
  schema: "kamutan.legend/1";
  legends: LegendBlock[];
  entries: LegendArtifactEntry[];
}

export interface Detection {
  id: string;
  /** Taxonomy id or "unknown". */
  class: string;
  legendEntryId: string | null;
  centerMm: PointMm;
  bboxMm: BBoxMm;
  angleDeg: number;
  /** Calibrated score (Sprint 5: isotonic map of `scoreRaw`; equal to it when the class has no map). */
  score: number;
  /** Sprint 5: the detector's raw score before calibration (additive). */
  scoreRaw?: number;
  level: DbLevel;
  /** Hebrew reason chips (or known reason codes). */
  reasons: string[];
  roomId: string | null;
  floor: string | null;
  lifecycle: Lifecycle;
  supply: "contractor" | "client" | "existing" | null;
  annotations: string[];
  clusterId: string | null;
  /**
   * Client-side only (web `applyCorrections`): how a human changed this item — accepted / added / reclassified /
   * moved / learned ("תוקן בלמידה" ✦), with the correction id; `rejected` items stay visible as grey ✕ only when the
   * "נדחו" layer is on and never count.
   */
  manual?: "accepted" | "added" | "reclassified" | "moved" | "learned" | null;
  rejected?: boolean;
  correctionId?: string | null;
}
export interface UnknownCluster {
  id: string;
  signature: string;
  count: number;
  exemplarBboxMm: BBoxMm;
  thumb: string | null;
}
export interface DetectionsArtifact {
  schema: "kamutan.detections/1";
  detections: Detection[];
  unknownClusters: UnknownCluster[];
}

export interface Room {
  id: string;
  name: string | null;
  nameConfidence: number;
  floor: string | null;
  polygonMm: PointMm[];
  areaM2: number;
  perimeterM: number;
  confidence: number;
  level: DbLevel;
  reasons: string[];
  /* Sprint 4 (Worker-B, optional on older artifacts — the web derives fallbacks, see features/tiling/model.ts) */
  type?: RoomType;
  wet?: boolean;
  walls?: RoomWall[];
  openings?: RoomOpening[];
  externalCorners?: number;
}
export const ROOM_TYPES = ["bathroom", "wc", "kitchen", "bedroom", "living", "corridor", "balcony", "courtyard", "storage", "stairs", "other"] as const;
export type RoomType = (typeof ROOM_TYPES)[number];
export interface RoomWall {
  id: string;
  aMm: PointMm;
  bMm: PointMm;
  lengthM: number;
  exterior: boolean;
}
export interface RoomOpening {
  id: string;
  kind: "door" | "window" | "opening";
  wallId: string | null;
  widthM: number;
  heightM: number | null;
  centerMm: PointMm | null;
}
export interface RoomsArtifact {
  schema: "kamutan.rooms/1";
  rooms: Room[];
}

/** GET /v1/projects/:pid/sheets/:sid/versions/:vid/overlay — signed URLs of the artifacts + crops. */
export interface OverlayManifest {
  sheetId: string;
  versionId: string;
  legend: { url: string } | null;
  detections: { url: string } | null;
  rooms: { url: string } | null;
  /** Sprint 3: switch↔luminaire link graph of the version (kamutan.links/1), when the worker produced one. */
  links?: { url: string } | null;
  /** Crop URLs keyed by legend entry id (`le_…`) or unknown cluster id (`u_…`). */
  thumbs: Record<string, string>;
  stats: VersionStats | null;
  expiresAt: string;
}

export type LegendEntryStatus = "suggested" | "confirmed" | "ignored";
/** orgs/{o}/projects/{p}/legendEntries/{id} + signed crop URL (LegendEntryItem). */
export interface LegendEntry {
  id: string;
  sheetId: string;
  versionId: string;
  label: string;
  labelConfidence: number;
  suggestedClass: string | null;
  class: string | null;
  itemCode: string | null;
  signature: string;
  thumbPath: string | null;
  status: LegendEntryStatus;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
  updatedAt: string | null;
  thumbUrl: string | null;
  /**
   * Not in the Firestore doc: classConfidence of the suggestion (from legend.json). The list DTO may omit it;
   * the UI then falls back to labelConfidence.
   */
  classConfidence?: number;
}
export interface LegendEntryPage {
  items: LegendEntry[];
  nextCursor: string | null;
  expiresAt: string | null;
}
export interface ListLegendEntriesQuery {
  status?: LegendEntryStatus;
  sheetId?: string;
  cursor?: string;
  limit?: number;
}
/**
 * PATCH /v1/projects/:pid/legend-entries/:entryId.
 * `label` (edited OCR text) is requested from the API agent; sent only when the user changed it.
 */
export type PatchLegendEntryRequest =
  | { action: "confirm"; class?: string; itemCode?: string | null; label?: string }
  | { action: "reassign"; class: string; itemCode?: string | null; label?: string }
  | { action: "ignore" };
export interface PatchLegendEntryResponse {
  entry: Omit<LegendEntry, "thumbUrl">;
  mapping: unknown | null;
}
/**
 * POST /v1/projects/:pid/unknown-clusters/:clusterId/resolve.
 * `ignore: true` ("לא רלוונטי") is requested from the API agent; the current contract requires `class`.
 */
export type ResolveUnknownClusterRequest = {
  sheetId: string;
  versionId: string;
  itemCode?: string | null;
  createLegendEntry: boolean;
} & ({ class: string; ignore?: never } | { ignore: true; class?: never });
export interface ReprocessOutcome {
  sheetId: string;
  status: "queued" | "skipped";
  reason: string | null;
  versionId: string | null;
  jobId: string | null;
}
export interface ResolveUnknownClusterResponse {
  clusterId: string;
  signature: string;
  mapping: unknown | null;
  legendEntry: Omit<LegendEntry, "thumbUrl"> | null;
  reprocess: ReprocessOutcome[];
}


/* ---------- Sprint 3: BOQ, library, templates, rules (docs/agents/SPRINT3_BRIEF.md, contracts boq.ts) ----------
 * TODO(contracts): hand-kept mirror; the API agent defines the final shapes concurrently. Endpoint paths that the
 * brief does not spell out (org-scoped library/templates/rules, build status, import status) are this app's
 * proposal — see apps/web/NOTES.md "Sprint 3 — API assumptions".
 */
export type BoqLineStatus = "draft" | "reviewed" | "approved";
/** contracts BOQ_LINE_TRANSITIONS (reviewer/admin). Editors may only move draft ↔ reviewed (web policy). */
export const BOQ_LINE_TRANSITIONS: Readonly<Record<BoqLineStatus, readonly BoqLineStatus[]>> = {
  draft: ["reviewed"],
  reviewed: ["approved", "draft"],
  approved: ["reviewed"],
};

/** orgs/{o}/projects/{p}/boqLines/{lineId} (contracts BoqLineSchema + Sprint 3 fields). */
export interface BoqLine {
  id: string;
  /** Chapter code, e.g. "04". */
  chapter: string;
  chapterTitle?: string | null;
  /** TEXT ("4.10" !== "4.1"). */
  code: string;
  description: string;
  /** Computed quantity (from evidence). */
  qty: number;
  /** Manual override (never overwritten by a rebuild); the line then counts `qtyOverride`. */
  qtyOverride?: number | null;
  /** Mandatory reason of the override (contracts `qtyOverrideReason`). */
  qtyOverrideReason?: string | null;
  qtyOverrideBy?: string | null;
  qtyOverrideAt?: string | null;
  buildId?: string | null;
  unit: string;
  floor?: string | null;
  level: DbLevel;
  reasons?: string[];
  evidenceRef?: string | null;
  locked?: boolean;
  status: BoqLineStatus;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  /** Free note; required reason of a qty override. */
  note?: string | null;
  /** Per-floor breakdown of `qty` (floor code → qty). */
  byFloor: Record<string, number>;
  evidenceCount: number;
  ruleId: string | null;
  sourceVersions: { sheetId: string; versionId: string }[];
  computedAt: string | null;
  /** Optional: sort order inside the chapter (template order). */
  order?: number;
  /* Sprint 4 */
  /**
   * contracts `manualCount`: manual items (corrections add / count / measure) behind this line. For unit lines it is
   * the manual part of `qty` (receipt "16 = 14 שזוהו + 2 ידני"); m² / m' lines carry the manual quantities in
   * `breakdown` rows with `manual: true`.
   */
  manualCount?: number;
  /** Waste factor of the material (tiling, 0.07 = 7%) → `orderQty` = qty × (1 + waste). */
  wasteFactor?: number | null;
  orderQty?: number | null;
  /** Per-room / per-fixture composition of the quantity (tiling formula lines, plumbing points per fixture). */
  breakdown?: BoqBreakdownRow[];
  /* Stage 10 (contracts boq.ts, A-API-06 / A-pipeline-08) */
  /** Computed qty at approval; a rebuild with another qty drops the line to "נבדק" (`qtyChangedReason`). */
  approvedQty?: number | null;
  approvedQtyAt?: string | null;
  /* Sprint 6 (SPRINT6_BRIEF "Shared interfaces", additive; mirrored until the API agent publishes the contracts) */
  /** Where the quantity came from. Missing on older docs → inferred by `originOf()` (features/boq/sprint6.ts). */
  origin?: BoqLineOrigin;
  /**
   * The drawings do not carry the quantity: a person must measure / count / confirm it ("להשלמה ידנית"). The contract's
   * `qty: null` is mapped to `qty: 0` + `needsInput: true` by the HTTP adapter (`normalizeLineDto`).
   */
  needsInput?: boolean;
  /** One-click action that completes the line (opens the measure / count tool bound to the line and its sheet). */
  quickAction?: BoqQuickAction | null;
  /* Sprint 7 (SPRINT7_BRIEF "Shared interfaces", additive; mirrored until the API agent publishes "Sprint 7 published") */
  /** The project's own wording of the line ("✎ ידני"); never overwritten by a rebuild. `description` stays the original. */
  descriptionOverride?: string | null;
  descriptionOverrideBy?: string | null;
  descriptionOverrideAt?: string | null;
  descriptionOverrideReason?: string | null;
  /* Sprint 8 (contracts boq.ts) */
  /**
   * API-DERIVED on read (never stored): the EFFECTIVE unit price (`priceOverride` ?? the org library price; null =
   * "ללא מחיר"), where it comes from, and effective qty × unitPrice (a needsInput line without override counts 0).
   */
  unitPrice?: number | null;
  unitPriceSource?: "override" | "library" | null;
  lineTotal?: number | null;
  /** The project's own unit price for this line ("✎ ידני"); never overwritten by a rebuild. */
  priceOverride?: number | null;
  priceOverrideBy?: string | null;
  priceOverrideAt?: string | null;
  priceOverrideReason?: string | null;
}
/** Sprint 7: max length of a line description (rename). */
export const DESCRIPTION_MAX = 500;
/** Sprint 6: origin of a line's quantity. */
export const BOQ_LINE_ORIGINS = ["detected", "text", "geometry", "suggested", "manual"] as const;
export type BoqLineOrigin = (typeof BOQ_LINE_ORIGINS)[number];
export type BoqQuickActionKind = "measure_area" | "measure_length" | "count" | "confirm";
export interface BoqQuickAction {
  kind: BoqQuickActionKind;
  /** The sheet to measure on (null: any sheet / no drawing needed, e.g. confirm a קומפלט). */
  sheetId: string | null;
}
/**
 * POST /v1/projects/:pid/boq/lines/:lineId/quick-measure — stores a `measure` / `count` correction bound to the line
 * (confirm: the confirmed quantity) and recomputes the line. Shape mirrored from the brief until "Sprint 6 published".
 */
export interface QuickMeasureRequest {
  kind: BoqQuickActionKind;
  /** m² / m' / units; for `confirm` the confirmed quantity. */
  quantity: number;
  unit: CorrectionUnit;
  sheetId: string | null;
  versionId: string | null;
  /** Polygon (area), polyline (length) or points (count), paper mm; null for `confirm`. */
  geometry: CorrectionGeometry | null;
  floor: string | null;
}
export interface QuickMeasureResponse {
  line: BoqLine;
  /** The stored correction (undo = revert it); null when the server stored none (confirm). */
  correction: Correction | null;
}
/**
 * Sprint 6 (owner feedback, "approve everything at once"): POST /v1/projects/:pid/boq/lines/batch-status. Red lines
 * are skipped unless `includeRed`. Mirrored until the API agent publishes it.
 */
export interface BatchStatusRequest {
  lineIds: string[];
  to: BoqLineStatus;
  includeRed: boolean;
}
export type BatchSkipReason = "red" | "already" | "forbidden" | "invalid_transition" | "needs_input" | "not_found" | (string & {});
export interface BatchStatusResponse {
  /** Lines that moved (after the change). */
  updated: BoqLine[];
  skipped: { lineId: string; reason: BatchSkipReason }[];
}
/** Sprint 6: chapter coverage of a build (`build.stats.coverage`, Worker-BOQ). */
export interface BoqCoverage {
  libraryCodes: number;
  produced: number;
  suggested: number;
  missing: string[];
}
export interface BoqBreakdownRow {
  label: string;
  qty: number;
  /** Human-readable formula, e.g. "14.2 מ"א × 2.6 מ' − 3.1 מ"ר פתחים". */
  formula?: string | null;
  sheetId?: string | null;
  roomId?: string | null;
  manual?: boolean;
}

export interface ProjectBoqState {
  latestBuildId: string | null;
  builtAt: string | null;
  stale: boolean;
}

export type BoqBuildStatus = "queued" | "running" | "succeeded" | "failed";
/** orgs/{o}/projects/{p}/boqBuilds/{buildId} */
export interface BoqBuild {
  id: string;
  status: BoqBuildStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** Optional progress 0..100 (worker may report it). */
  progress?: number;
  stats?: { lines?: number; evidence?: number; sheets?: number; groups?: number; calibration?: CalibrationStats; coverage?: BoqCoverage } | null;
  error?: { code: string; message: string } | null;
}

/** GET /v1/projects/:pid/boq/lines */
export interface BoqLinesResponse {
  items: BoqLine[];
  boq: ProjectBoqState | null;
  /** Template chapters (title + notes) for the chapter headers; optional (else the default template's). */
  chapters?: BoqChapter[];
  /** Org setting (contracts BoqSummary.blockExportOnRed). */
  blockExportOnRed?: boolean;
  /** Sprint 5: calibration of the latest build (summary.calibration / build stats). */
  calibration?: CalibrationStats | null;
  /** Sprint 8 (contracts BoqSummary.totals): totals over ALL lines (effective prices, project discount, org VAT). */
  totals?: BoqTotals | null;
}
/** PATCH /v1/projects/:pid/boq/lines/:lineId */
export interface PatchBoqLineRequest {
  status?: BoqLineStatus;
  qtyOverride?: number | null;
  /** Required with a numeric qtyOverride (contracts PatchBoqLineRequest.reason); optional with `description`. */
  reason?: string;
  note?: string | null;
  /** Sprint 7: rename the line (≤ 500 chars); `null` restores the original wording. */
  description?: string | null;
  /** Sprint 7: also update the org library item of this code (editor+, MFA / recent sign-in like library edits). */
  alsoUpdateLibrary?: boolean;
  /** Sprint 8: the line's own unit price (0..PRICE_MAX ₪); `null` restores the library price. Editor+, `reason` optional. */
  priceOverride?: number | null;
}
/** POST /v1/projects/:pid/boq/build */
export interface BuildBoqResponse {
  buildId: string;
  jobId: string | null;
}

/** One evidence item of a line (kamutan.boq-evidence/1). */
export interface BoqEvidenceItem {
  sheetId: string;
  versionId: string;
  /** A detection id — or, for room-derived quantities (tiling, flooring), the ROOM id (worker units.room_det). */
  detectionId: string;
  linkGroupId: string | null;
  floor: string | null;
  /** Set on room-derived evidence. */
  roomId?: string | null;
  quantity?: number;
  source?: "auto" | "manual";
  /* Sprint 6 (additive evidence kinds) */
  /** Missing = a detection (or a room when `roomId` is set). */
  kind?: BoqEvidenceKind;
  /** `text`: the matched text (note / callout / legend row / panel schedule). */
  text?: string | null;
  /** `text`: bbox of the matched text, paper mm. */
  bboxMm?: BBoxMm | null;
  /** `geometry`: the measured polygon (area) or polyline (length), paper mm. */
  geometry?: { type: "polygon" | "polyline"; mm: PointMm[] } | null;
  /** `stair`: one closed outline per tread, paper mm. */
  treads?: PointMm[][] | null;
}
export const BOQ_EVIDENCE_KINDS = ["detection", "room", "text", "geometry", "stair"] as const;
export type BoqEvidenceKind = (typeof BOQ_EVIDENCE_KINDS)[number];
/** GET /v1/projects/:pid/boq/lines/:lineId/evidence */
export interface BoqLineEvidence {
  lineId: string;
  items: BoqEvidenceItem[];
}
export interface BoqEvidenceArtifact {
  schema: "kamutan.boq-evidence/1";
  lines: Record<string, Omit<BoqEvidenceItem, never>[]>;
}

export type LinkGroupKind = "single" | "two_way" | "shared" | "sensor" | "add_to_existing";
/** kamutan.links/1 group: switches that control the same luminaire points. */
export interface LinkGroup {
  id: string;
  switchIds: string[];
  /** Point ids (a point may be several luminaires wired together). */
  pointIds: string[];
  luminaireIds: string[];
  kind: LinkGroupKind;
  confidence: number;
  level: DbLevel;
  reasons: string[];
  /** Optional: the arc polylines as traced on the sheet (paper mm), `completed` = gap closed by the system. */
  arcs?: { pathMm: PointMm[]; completed?: boolean }[];
  /** Worker-A: ids into the artifact's top-level `arcs`. */
  arcIds?: string[];
  floor?: string | null;
  /** Optional: point id → luminaire detection ids. */
  points?: { id: string; luminaireIds: string[] }[];
}
export interface LinkArc {
  id: string;
  polylineMm: PointMm[];
  /** The switch end was inferred / the arc is ambiguous → drawn dotted. */
  inferredSwitch?: boolean;
  ambiguous?: boolean;
}
export interface LinksArtifact {
  schema: "kamutan.links/1";
  groups: LinkGroup[];
  /** Worker-A: traced arcs referenced by `groups[].arcIds`. */
  arcs?: LinkArc[];
  points?: { id: string; luminaireIds: string[]; centerMm?: PointMm }[];
}

/** GET /v1/projects/:pid/boq/evidence?sheetId=&versionId= — marker → line lookup for one sheet version. */
export interface BoqSheetEvidence {
  sheetId: string;
  versionId: string;
  buildId: string | null;
  detections: Record<string, string[]>;
  linkGroups: Record<string, string[]>;
}

/** POST /v1/projects/:pid/boq/export */
export interface ExportBoqRequest {
  templateId: string | null;
  split: "summed" | "byFloor";
  /** Add "טיוטה – כולל פריטים שלא אומתו" to the file title. */
  draftNote: boolean;
  /** Sprint 7 (= the preview options): the "רמת ביטחון" + "סטטוס" columns (API default true), only these chapters. */
  includeConfidence?: boolean;
  chapters?: string[];
}
export interface ExportBoqResponse {
  url: string;
  filename: string;
  expiresAt: string;
}

/* ---------- Sprint 7: BOQ document model (GET /v1/projects/:pid/boq/document) ----------
 * ONE export model built by the API, consumed by both the Excel writer and the preview — the browser never lays the
 * BOQ out itself. Mirrored from the brief until "Sprint 7 published".
 */
export type BoqDocumentColumnKey = "code" | "description" | "unit" | "qty" | "unitPrice" | "total" | "confidence" | "status" | (string & {});
export interface BoqDocumentColumn {
  key: BoqDocumentColumnKey;
  title: string;
}
export type BoqDocumentRowKind = "line" | "subtotal" | "note";
export interface BoqDocumentRow {
  /** null on subtotal / note rows. */
  lineId: string | null;
  code: string;
  /** The exported wording (a renamed line carries its override). */
  description: string;
  unit: string;
  /** null = "להשלמה ידנית" (empty cell + note in the Excel). */
  qty: number | null;
  price: number | null;
  total: number | null;
  level?: DbLevel | null;
  status?: BoqLineStatus | null;
  kind: BoqDocumentRowKind;
  /** Optional extras (not in the brief): split-by-floor row, the line waits for input, renamed, cell note. */
  floor?: string | null;
  needsInput?: boolean;
  qtyOverridden?: boolean;
  descriptionOverridden?: boolean;
  /** Sprint 8 (contracts): where the row's unit price comes from; `unpriced` = no price ("ללא מחיר"). */
  priceSource?: "override" | "library" | null;
  unpriced?: boolean;
  /** Comment of the quantity cell in the xlsx (contracts `cellNote`: "להשלמה ידנית", "כמות שונתה ידנית…"). */
  cellNote?: string | null;
  qtyFormat?: "general" | "decimal2";
}
export interface BoqDocumentChapter {
  code: string;
  title: string;
  notes: string[];
  rows: BoqDocumentRow[];
  subtotal: number | null;
}
export type BoqDocumentWarningKind = "red" | "reapproval" | "unapproved" | "needsInput" | "unpriced";
/** contracts: `warning` = the xlsx warning row, `title` = a template title row, `draft` = "טיוטה – …". */
export interface BoqDocumentTitleRow {
  kind: "warning" | "title" | "draft";
  text: string;
}
export interface BoqDocumentModel {
  titleRows: BoqDocumentTitleRow[];
  columns: BoqDocumentColumn[];
  chapters: BoqDocumentChapter[];
  /** Sprint 8: contracts BoqTotals (older documents: the three VAT totals only — the adapter fills the rest). */
  totals: Pick<BoqTotals, "beforeVat" | "vat" | "afterVat"> & Partial<BoqTotals>;
  warnings: { kind: BoqDocumentWarningKind; count: number }[];
  generatedAt: string;
  /** contracts `totals.vatRate` (lifted here). */
  vatRate?: number;
  /** contracts `exportBlocked`: POST …/boq/export would answer 409 now. */
  blocked?: boolean;
}
export interface BoqDocumentQuery {
  split: "none" | "floor";
  confidence: boolean;
  /** Chapter codes; null = all. */
  chapters: string[] | null;
}

/** orgs/{o}/itemLibrary/{itemId} */
export interface LibraryItem {
  id: string;
  code: string;
  chapter: string;
  chapterTitle: string | null;
  description: string;
  unit: string;
  tags: string[];
  /** Stage 10: `default` = seeded from the shipped default library (contracts ITEM_SOURCES). */
  source: "import" | "manual" | "default";
  defaultsVersion?: number;
  sourceRef?: string | null;
  active: boolean;
  updatedAt: string | null;
  /** Sprint 8 (contracts ItemPrice): the org's unit price of this item (absent / null = no price). */
  price?: ItemPrice | null;
}
export interface LibraryItemPage {
  items: LibraryItem[];
  nextCursor: string | null;
}
export interface ListLibraryQuery {
  q?: string;
  chapter?: string;
  cursor?: string;
  limit?: number;
}
/** code + description are the item's identity (contracts): only unit / chapterTitle / tags / active change. */
export type PatchLibraryItemRequest = Partial<Pick<LibraryItem, "unit" | "tags" | "active">> & {
  chapterTitle?: string;
  /** Sprint 8: set (₪) or clear (`null`) the item's price (`source: 'manual'`). Editor+. */
  price?: number | null;
};

export interface BoqChapter {
  code: string;
  title: string;
  notes: string[];
}
/** orgs/{o}/boqTemplates/{templateId} */
export interface BoqTemplate {
  id: string;
  name: string;
  chapters: BoqChapter[];
  /** Contracts: `{key, title}` objects; older docs/mocks: plain titles. */
  columns: (string | { key: string; title: string })[];
  titleRows: string[];
  default: boolean;
  updatedAt?: string | null;
}

export type BoqRuleKind = "class_to_item" | "composite_lighting" | "install_count" | "authority";
/** orgs/{o}/boqRules/{ruleId} */
export interface BoqRule {
  id: string;
  kind: BoqRuleKind;
  match: Record<string, unknown>;
  itemCode: string | null;
  /** Contracts: Hebrew item description hint. */
  itemDescription?: string | null;
  priority: number;
  enabled: boolean;
  /** Optional human description (Hebrew; mock only — the UI otherwise derives one from `match`). */
  description?: string | null;
  updatedAt: string | null;
}

/** POST /v1/orgs/:orgId/library/imports → an upload slot (same quarantine flow as drawing uploads). */
export interface CreateLibraryImportRequest {
  filename: string;
  sizeBytes: number;
  /** Sprint 8 (contracts): `prices` = take only the unit prices of a priced past BOQ; default `library`. */
  mode?: "library" | "prices";
  /** Sprint 8: an imported price may replace a MANUAL one (default false: reported as `manual_price` conflicts). */
  overwriteManualPrices?: boolean;
  /** Integration: compute the report without writing (mode `prices` only); then `applyPriceImport`. */
  dryRun?: boolean;
}
export interface CreateLibraryImportResponse {
  importId: string;
  /** orgs/{o}/imports/{uuid}.{ext} */
  storagePath: string;
  uploadToken: string;
  contentType: string;
}
export type LibraryImportStatus = "awaiting_upload" | "uploaded" | "queued" | "running" | "succeeded" | "failed" | "rejected";
export interface LibraryImportResult {
  itemsAdded: number;
  itemsUpdated: number;
  chapters: number;
  templateCreated: { id: string; name: string } | null;
  /** Codes whose description differs between files / rows (need a human decision). */
  ambiguousCodes: { code: string; descriptions: string[] }[];
  /** Sprint 8 (contracts `stats.prices`): the price report of the import. */
  prices?: PriceImportReport | null;
}
export interface LibraryImport {
  id: string;
  filename: string;
  /** Sprint 8 */
  mode?: "library" | "prices";
  overwriteManualPrices?: boolean;
  /** Integration: a dry run (nothing written yet) and when `apply-prices` ran. */
  dryRun?: boolean;
  pricesAppliedAt?: string | null;
  status: LibraryImportStatus;
  progress: number;
  jobId: string | null;
  result: LibraryImportResult | null;
  error: { code: string; message: string } | null;
}


/* ---------- Sprint 8: prices, version comparison, deletes — contracts "Sprint 8 published" ---------- */

export interface BulkPriceRequest {
  items: { itemId: string; amount: number | null }[];
}
/** POST /library/prices → {batchId, updated [{itemId, code, from, to}], skipped [{itemId, reason}]}. */
export type BulkPriceResponse = ContractBulkLibraryPriceResponse;

/** GET …/boq/compare query: `base` previous (default) | export ("מאז הייצוא האחרון"), or explicit build ids. */
export interface BoqCompareQuery {
  base?: "previous" | "export";
  from?: string;
  to?: string;
}
/** Integration: GET …/boq/builds (compare picker) → {items: BoqBuildSummary[]}. */
export type BoqBuildSummary = ContractBoqBuildSummary;
/** Integration: POST /library/imports/:id/apply-prices {orgId, overwriteItemIds} (a reviewed dry-run price import). */
export interface ApplyPriceImportRequest {
  overwriteItemIds: string[];
}
export type ApplyPriceImportResponse = ContractApplyImportPricesResponse;

/** DELETE /projects/:pid/sheet-sets/:id (contracts; `storageQuotaBytes` since the integration). */
export type DeleteSheetSetResponse = ContractDeleteSheetSetResponse;
export interface DeleteProjectRequest {
  /** Typed confirmation = the project name (contracts `deleteConfirmationMatches`: NFC, trimmed, spaces collapsed). */
  confirmName: string;
}
export type DeleteProjectResponse = ContractDeleteProjectResponse;
/** Sprint 8 (contracts MAX_SHEETS_PER_PROJECT): at most 100 sheets per project (409 `sheet_limit`). */
export const MAX_SHEETS_PER_PROJECT = 100;

/* ---------- Sprint 4: corrections, review queue, room settings, find-similar (docs/agents/SPRINT4_BRIEF.md) ----------
 * TODO(contracts): hand-kept mirror of the brief's shapes; the API agent adds them to @kamutan/contracts concurrently.
 * Routes are this app's proposal (apps/web/NOTES.md "Sprint 4 — API assumptions").
 */
export const CORRECTION_KINDS = ["add", "remove", "reclassify", "move", "link", "unlink", "measure", "count", "accept", "reject"] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
/** contracts CorrectionUnitSchema: m² (polygon measure), m' (polyline measure), units (count). */
export type CorrectionUnit = "m2" | "m" | "unit";
export interface CorrectionGeometry {
  type: "point" | "polygon" | "polyline";
  mm: PointMm[];
}
/** orgs/{o}/projects/{p}/corrections/{corrId} — written only via the API. */
export interface Correction {
  id: string;
  kind: CorrectionKind;
  sheetId: string;
  /** Version at the time of the edit. */
  versionId: string;
  /** Stable re-match key (paper mm). */
  anchorMm: PointMm;
  radiusMm: number;
  detectionId: string | null;
  signature: string | null;
  class: string | null;
  itemCode: string | null;
  linkGroupId: string | null;
  switchIds?: string[];
  pointIds?: string[];
  geometry: CorrectionGeometry | null;
  quantity: number | null;
  unit: CorrectionUnit | null;
  roomId: string | null;
  floor: string | null;
  reason: string | null;
  batchId: string | null;
  by: string;
  at: string;
  revertedAt: string | null;
  revertedBy?: string | null;
  /** Set by the server when a newer version could not re-match the correction ("תיקון לא הותאם"). */
  unmatched?: boolean;
}
/**
 * POST /v1/projects/:pid/corrections (contracts CreateCorrectionRequestSchema, strict). `id` / `batchId` are
 * client-side only (optimistic cache keys) and are stripped by the HTTP client; the server assigns both.
 */
export type CreateCorrectionRequest = Omit<Correction, "id" | "by" | "at" | "revertedAt" | "revertedBy" | "unmatched" | "batchId"> & { id?: string; batchId?: string | null };
export type CorrectionBatchSource = "cluster" | "lasso" | "similar" | "selection" | "other";
/** POST /v1/projects/:pid/corrections/batch → one server batch (= one undo step). */
export interface CreateCorrectionsBatchRequest {
  /** Client-side provisional id (mock keeps it; the real API returns its own `batch.id`). */
  batchId: string;
  corrections: CreateCorrectionRequest[];
  source?: CorrectionBatchSource;
  similarSearchId?: string | null;
}
export interface CorrectionsResponse {
  items: Correction[];
}
export interface CorrectionsBatchResponse {
  items: Correction[];
  /** The server's batch id (revert target). */
  batchId: string;
}

export const REVIEW_ITEM_KINDS = ["detection", "cluster", "unknown_cluster", "link_group", "room", "unmatched_correction", "line"] as const;
export type ReviewItemKind = (typeof REVIEW_ITEM_KINDS)[number];
export interface ReviewQueueMember {
  detectionId: string;
  bboxMm: BBoxMm;
  score: number;
  thumbUrl: string | null;
}
/** GET /v1/projects/:pid/review-queue — one ranked item. */
export interface ReviewQueueItem {
  id: string;
  kind: ReviewItemKind;
  sheetId: string;
  versionId: string;
  /** Paper-mm bbox to zoom to. */
  bboxMm: BBoxMm;
  thumbUrl: string | null;
  level: DbLevel | "unknown";
  reasons: string[];
  /** |qty impact on its BOQ line| × (1 − score) × level weight. */
  risk: number;
  /** Suggested action: what `A` does. */
  suggestedAction: "accept" | "reject" | "reclassify" | "resolve" | "open" | "settings" | "link";
  /** Class of the item(s) (detection / cluster). */
  class?: string | null;
  itemCode?: string | null;
  lineId?: string | null;
  detectionIds?: string[];
  members?: ReviewQueueMember[];
  clusterId?: string | null;
  linkGroupId?: string | null;
  roomId?: string | null;
  correctionId?: string | null;
  score?: number | null;
  /** Free label (line description / room name). */
  title?: string | null;
}
export interface ReviewQueueResponse {
  items: ReviewQueueItem[];
  total: number;
}

/** orgs/{o}/projects/{p}/roomSettings/{sheetId}__{roomId} */
export interface PartialCladding {
  wallId: string;
  fromM: number;
  toM: number;
  heightM: number;
  /** Height above the floor where the strip starts (kitchen backsplash over the counter). */
  bottomM?: number;
}
/** contracts PutRoomSettingsRequestSchema (strict). */
export interface RoomSettings {
  claddingHeightM: number;
  floorTiled: boolean;
  floorMaterialItemCode: string | null;
  wallMaterialItemCode: string | null;
  partialCladding: PartialCladding[];
  wasteFactor: number;
  includeInWaterproofing: boolean;
  /** Openings the user chose NOT to subtract from the cladding ("אפשר לבטל כל אחד"). */
  keepOpenings?: string[];
  /** User override of the room type. */
  type?: RoomType | null;
}
export interface RoomSettingsDoc extends RoomSettings {
  id: string;
  sheetId: string;
  roomId: string;
  by?: string | null;
  at?: string | null;
}
/** GET / PUT /v1/projects/:pid/rooms/:sheetId/:roomId/settings */
export interface RoomSettingsResponse {
  settings: RoomSettingsDoc;
  /** No stored doc: `settings` are the room type's defaults. */
  isDefault: boolean;
}

export type SimilarScope = "sheet" | "project";
/** POST /v1/projects/:pid/similar-searches → job `symbols.find_similar`. */
export interface FindSimilarRequest {
  /** `detectionId` is a mock-only hint (stripped by the HTTP client: the contract exemplar is a box + class). */
  exemplar: { sheetId: string; versionId: string; bboxMm: BBoxMm; class: string | null; detectionId?: string | null };
  scope: SimilarScope;
  correctionId?: string | null;
}
export interface SimilarCandidate {
  /** `c_…` */
  id?: string;
  sheetId: string;
  versionId: string;
  centerMm: PointMm;
  bboxMm: BBoxMm;
  score: number;
  alreadyDetected: string | null;
  currentClass: string | null;
}
export interface SimilarSearch {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  exemplar: FindSimilarRequest["exemplar"];
  candidates: SimilarCandidate[];
  /** Signed crop URLs keyed by candidate id (`thumbUrls` of the API view). */
  thumbs: Record<string, string>;
  error?: { code: string; message: string } | null;
}

export interface FinalizeUploadResponse {
  sheetSet: SheetSet;
  sheet: Sheet;
  sheetVersion: SheetVersion;
  deduplicated: boolean;
  jobId: string;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** jobs/{jobId} */
export interface Job {
  id: string;
  orgId: string;
  projectId?: string;
  /** Sprint 1 brief: the ingest job is per sheetSet (one uploaded file). */
  sheetSetId?: string;
  versionId?: string;
  type: string;
  status: JobStatus;
  progress: number; // 0–100
  stage?: string;
  error?: { code: string; message: string } | null;
  createdAt: string;
  updatedAt?: string;
}

/** contracts ApiErrorSchema body: { error: { code, message, requestId } } */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/* ---------- Sprint 5: calibration, history, audit, marked PDF, share links, org settings, offboarding ----------
 * docs/agents/SPRINT5_BRIEF.md §1–§5; hand-kept mirror of the API agent's contracts (see NOTES.md Sprint 5).
 */
export type CalibrationMode = "conservative" | "full";
/** `stats.calibration` on version docs and builds. */
export interface CalibrationStats {
  mode: CalibrationMode;
  version: string;
}
/** Hebrew reason the worker writes on items capped at yellow by the conservative calibration (brief §1). */
export const CONSERVATIVE_REASON = "כיול שמרני: אין מספיק נתוני אמת לסוג זה";
export const CONSERVATIVE_REASON_CODE = "CONSERVATIVE_CALIBRATION";

export type OrgStatus = "active" | "offboarding" | "deleted";
/** contracts OrgSettingsSchema (orgs/{orgId}.settings). */
export interface OrgSettings {
  llmEnabled: boolean;
  blockExportOnRed: boolean;
  /** 0.9–0.995 (reported against the calibration table's Wilson LB). */
  greenThreshold: number;
  trainingOptIn: boolean;
  llmMonthlyBudgetUsd?: number;
  vatRate?: number;
  autoRebuild?: boolean;
  /** Sprint 7: per-project storage quota (admin, default 2 GB). */
  projectQuotaBytes?: number;
}
export type PatchOrgSettingsRequest = Partial<Pick<OrgSettings, "greenThreshold" | "blockExportOnRed" | "llmEnabled" | "trainingOptIn" | "vatRate">>;
/** Sprint 8: VAT default (contracts DEFAULT_ORG_SETTINGS.vatRate). */
export const VAT_RATE_DEFAULT = 0.18;
export const GREEN_THRESHOLD_MIN = 0.9;
export const GREEN_THRESHOLD_MAX = 0.995;
export const GREEN_THRESHOLD_DEFAULT = 0.98;

export interface ActorRef {
  uid: string;
  displayName: string | null;
}
export type LineHistoryAction = "status" | "qtyOverride" | "note" | "rebuild" | "correction" | "description" | "price";
/** GET /v1/projects/:pid/boq/lines/:lineId/history — newest first. */
export interface LineHistoryItem {
  at: string;
  by: ActorRef | null;
  action: LineHistoryAction;
  before: unknown;
  after: unknown;
  reason: string | null;
}
export interface LineHistoryResponse {
  items: LineHistoryItem[];
}

/** One audit-log row (append-only, hash-chained; SEC-35). */
export interface AuditEvent {
  id: string;
  at: string;
  actor: ActorRef | null;
  /** contracts `actorKind`: user | share_link (external viewer) | system. */
  actorKind?: string;
  action: string;
  entity: string;
  entityId: string | null;
  projectId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown> | null;
  hash?: string | null;
  prevHash?: string | null;
  /** A-UI-13 (requested from the API, Stage 10): one readable Hebrew line, e.g. "הוספת פריט ידני · שקע כפול". */
  summary?: string | null;
}
export interface AuditQuery {
  cursor?: string | null;
  entity?: string | null;
  action?: string | null;
  limit?: number;
}
export interface AuditPage {
  items: AuditEvent[];
  nextCursor: string | null;
}
/** GET /v1/orgs/:orgId/audit/verify */
export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  brokenAt: string | null;
}

/** POST /v1/projects/:pid/boq/export/marked-pdf (legend is always on; watermark is the server's for share links). */
export interface MarkedPdfExportRequest {
  sheetIds: string[] | null;
  floorSplit: boolean;
  hideTitleBlock: boolean;
}
export type ExportKind = "xlsx" | "marked_pdf";
export type ExportStatus = "queued" | "running" | "succeeded" | "failed";
/** GET /v1/projects/:pid/exports/:id — `url` (15-min signed) once succeeded. */
export interface ExportDoc {
  id: string;
  kind: ExportKind;
  status: ExportStatus;
  progress?: number | null;
  pageCount: number | null;
  createdBy: string | null;
  createdAt: string;
  error: { code: string; message: string } | null;
  url: string | null;
  filename: string | null;
  expiresAt: string | null;
  /** Security gate F-3: with hideTitleBlock, every exported sheet was masked (null when not requested). */
  titleBlockMasked?: boolean | null;
  /** F-3: sheetId → masked; `false` sheets were left out of the PDF. */
  titleBlockBySheet?: Record<string, boolean> | null;
  /** Hebrew message from the API (error code / omitted sheets). */
  message?: string | null;
}
/** contracts EXPORT_ERROR_MESSAGES_HE / EXPORT_SHEETS_OMITTED_HE (fallbacks when the API sends no `message`). */
export const EXPORT_ERROR_MESSAGES_HE: Readonly<Record<string, string>> = {
  title_block_not_found: "לא נמצאה טבלת כותרת להסתרה באף גיליון, ולכן ה-PDF לא נוצר. בטלו את הסתרת טבלת הכותרת או בחרו גיליונות אחרים.",
};
export const EXPORT_SHEETS_OMITTED_HE = "חלק מהגיליונות הושמטו: לא נמצאה בהם טבלת כותרת להסתרה.";

/** Share link as returned to members (contracts ShareLinkSchema without tokenHash). */
export interface ShareLink {
  id: string;
  label: string;
  recipient: string | null;
  versionLock: string[];
  expiresAt: string;
  revokedAt: string | null;
  hideTitleBlock: boolean;
  allowPdfDownload: boolean;
  viewCount: number;
  lastViewedAt: string | null;
  createdBy: string;
  createdAt: string;
  /** Sprint 8: the snapshot carries unit prices + totals ("הצג מחירים", off by default). */
  showPrices?: boolean;
  /** Security gate F-3: per locked sheet — title block masked? part of the link? */
  sheets?: ShareLinkSheet[];
}
export interface ShareLinkSheet {
  sheetId: string;
  versionId: string;
  titleBlockMasked: boolean;
  included: boolean;
}
export interface ShareLinkWarning {
  code: "title_block_not_detected" | "title_block_not_detected_included";
  /** Hebrew, from the API. */
  message: string;
  sheetIds: string[];
}
/** contracts TITLE_BLOCK_WARNING_* (mock + fallbacks). */
export const TITLE_BLOCK_WARNING_EXCLUDED = "לא זוהתה טבלת כותרת בגיליונות אלה, ולכן לא ניתן להסתיר אותה — הם לא נכללו בקישור.";
export const TITLE_BLOCK_WARNING_INCLUDED = "לא זוהתה טבלת כותרת בגיליונות אלה — הם נכללו בקישור ללא הסתרת טבלת הכותרת (לפי בחירתך).";
export const SHARE_LINK_DEFAULT_DAYS = 14;
export const SHARE_LINK_MAX_DAYS = 90;
export interface CreateShareLinkRequest {
  days: number;
  label: string;
  recipient?: string | null;
  hideTitleBlock?: boolean;
  allowPdfDownload?: boolean;
  /** F-3: explicit opt-in to share sheets whose title block was not detected (they cannot be masked). */
  includeUnmaskedSheets?: boolean;
  /** Sprint 8: store prices in the snapshot (editor+, default false). */
  showPrices?: boolean;
}
/** The raw token is in `url` ONCE (never stored by the server). */
export interface CreateShareLinkResponse {
  link: ShareLink;
  url: string;
  warnings: ShareLinkWarning[];
}

/** Public (unauthenticated) share API `/v1/public/share/:token/…` — read-only by construction. */
export interface PublicShareSheet {
  id: string;
  versionId: string;
  title: string | null;
  discipline: string | null;
  floors: string[];
  page: { widthMm: number; heightMm: number } | null;
  tiles: { tileSize: number; dpi: number; levels: number; widthPx: number; heightPx: number } | null;
  /** F-3: the title block of this sheet is masked. */
  titleBlockMasked?: boolean;
}
export interface PublicShareMeta {
  linkId: string;
  projectName: string;
  orgName: string | null;
  label: string;
  expiresAt: string;
  /** Date of the locked version (newest sheet version of the lock). */
  versionDate: string | null;
  hideTitleBlock: boolean;
  allowPdfDownload: boolean;
  /** Owner opted to show the confidence column (●▲◆ + word only, never scores or reasons). */
  showConfidence: boolean;
  /** Sprint 8: the link was created with "הצג מחירים" (the snapshot carries prices). */
  showPrices?: boolean;
  /** "שותף עם {recipient|label} • {date} • {linkId-short}" (also burned into tiles + PDF by the server). */
  watermark: string;
  sheets: PublicShareSheet[];
  /** Per-link marked PDF: null = not allowed; `failed` may carry `errorCode` (e.g. title_block_not_found). */
  pdf?: { status: "queued" | "running" | "ready" | "failed"; errorCode?: string | null } | null;
}
/** Public BOQ line: no internal names, scores, reasons, notes or override authors. */
export interface PublicBoqLine {
  id: string;
  chapter: string;
  chapterTitle?: string | null;
  code: string;
  description: string;
  unit: string;
  qty: number;
  level: DbLevel | null;
  status: BoqLineStatus;
  floor?: string | null;
  byFloor: Record<string, number>;
  order?: number;
  /** Sprint 7: `description` is the project's own wording (renamed line) → "✎ ידני" marker. No author / reason. */
  descriptionManual?: boolean;
  /** Sprint 8: only in a snapshot made with "הצג מחירים" (effective unit price and qty × price). */
  unitPrice?: number | null;
  total?: number | null;
}
export interface PublicShareBoq {
  /** F-4: the BOQ is a snapshot taken at link creation (null = link older than snapshots → empty BOQ). */
  snapshotAt?: string | null;
  lines: PublicBoqLine[];
  chapters?: { code: string; title: string }[];
  /** contracts PublicShareBoq: floors in the snapshot and the confidence / approval counts. */
  floors?: string[];
  counts?: { lines: number; green: number; yellow: number; red: number; approved: number };
  /** Sprint 8 (contracts): only for links with "הצג מחירים". */
  showPrices?: boolean;
  totals?: BoqTotals | null;
}
/** One locked sheet version's overlay (no raw text layer). `evidence`: line id → detection ids on this sheet. */
export interface PublicShareOverlay {
  sheetId: string;
  versionId: string;
  detections: Pick<Detection, "id" | "class" | "centerMm" | "bboxMm" | "level" | "lifecycle" | "floor" | "roomId">[];
  rooms: Pick<Room, "id" | "name" | "floor" | "polygonMm" | "areaM2">[];
  linkGroups: Pick<LinkGroup, "id" | "switchIds" | "luminaireIds" | "pointIds" | "level">[];
  evidence: Record<string, string[]>;
}
export type ShareErrorKind = "expired" | "revoked" | "not_found" | "rate_limited" | "error";
export interface PublicShareClient {
  getMeta(token: string): Promise<PublicShareMeta>;
  getBoq(token: string): Promise<PublicShareBoq>;
  getOverlay(token: string, sheetId: string): Promise<PublicShareOverlay>;
  /** Same-origin, API-proxied tile URL (watermarked + title block masked by the server). */
  tileUrl(token: string, sheetId: string, z: number, x: number, y: number): string;
  /** Watermarked marked PDF (only when the owner allowed it). */
  pdfUrl(token: string): string;
}

/** Offboarding (SEC-52). */
export interface OffboardingExport {
  id: string;
  status: ExportStatus;
  progress?: number | null;
  url: string | null;
  expiresAt: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
}
export interface OffboardRequest {
  /** The org slug typed by the admin. */
  confirm: string;
}
export interface OffboardResponse {
  status: OrgStatus;
  deleteAfter: string;
  revokedShareLinks?: number;
}

/** Stage 10 revised upload: this set was replaced by a newer revision (contracts `supersededBySetId`). */
export const isSupersededSet = (s: Pick<SheetSet, "status" | "supersededBySetId" | "supersededBy">): boolean =>
  s.status === "superseded" || Boolean(s.supersededBySetId) || Boolean(s.supersededBy);

/* ---------- Stage 10: approval invalidated by a quantity change (mirror of contracts boq.ts) ---------- */
/** Chip of a line whose computed quantity changed after a human approved it (prefix of the full reason). */
export const QTY_CHANGED_REASON = "הכמות השתנתה מאז האישור";
const fmtQtyReason = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
/** "הכמות השתנתה מאז האישור (6 → 7)". */
export const qtyChangedReason = (from: number, to: number): string => `${QTY_CHANGED_REASON} (${fmtQtyReason(from)} → ${fmtQtyReason(to)})`;
export const isQtyChangedReason = (r: string): boolean => r === QTY_CHANGED_REASON || r.startsWith(`${QTY_CHANGED_REASON} (`);
/** contracts `needsReapproval`: still `approved` but the qty moved since, or carrying the chip. */
export function needsReapproval(l: Pick<BoqLine, "status" | "qty"> & { approvedQty?: number | null; reasons?: readonly string[] }): boolean {
  if (l.status !== "approved") return false;
  if (typeof l.approvedQty === "number" && Number.isFinite(l.approvedQty) && l.approvedQty !== l.qty) return true;
  return (l.reasons ?? []).some(isQtyChangedReason);
}
/** A line that lost its approval because its quantity changed (dropped to "נבדק" with the chip) or needs re-approval. */
export const qtyChangedSinceApproval = (l: Pick<BoqLine, "status" | "qty"> & { approvedQty?: number | null; reasons?: readonly string[] }): boolean =>
  needsReapproval(l) || (l.status === "reviewed" && (l.reasons ?? []).some(isQtyChangedReason));

/* ---------- Stage 10: members (A-API-01). Mirrored here until packages/contracts publishes them. ---------- */
export type MemberStatus = "active" | "pending";
/** GET /orgs/:orgId/members — an active member (doc id = uid) or a pending invitation (claimed on first sign-in). */
export interface OrgMember {
  /** uid for active members, invitation id for pending ones. */
  id: string;
  uid: string | null;
  email: string | null;
  displayName?: string | null;
  role: Role;
  status: MemberStatus;
  addedBy?: string | null;
  createdAt: string;
  /** Pending only: the invitation link stops working after this. */
  expiresAt?: string | null;
}
export interface MembersResponse {
  members: OrgMember[];
}
/** POST /orgs/:orgId/invites */
export interface InviteMemberRequest {
  email: string;
  role: Role;
}
/** The link is returned once; there is no email service yet, the admin copies it. */
export interface InviteMemberResponse {
  member: OrgMember;
  inviteUrl: string;
}
/** PATCH /orgs/:orgId/members/:memberId */
export interface PatchMemberRequest {
  role: Role;
}

/* ---------- Stage 10: which item library the BOQ uses (A-LIVE-01), derived from the library items' `source` ---------- */
export type LibrarySource = "imported" | "default" | "none";

export interface ApiClient {
  getMe(): Promise<MeResponse>;
  listProjects(orgId: string): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(id: string, patch: UpdateProjectInput): Promise<Project>;
  createUpload(projectId: string, req: CreateUploadRequest): Promise<CreateUploadResponse>;
  finalizeUpload(projectId: string, req: FinalizeUploadRequest): Promise<FinalizeUploadResponse>;
  /** Sprint 1: confirm a sheet's classification (sets confirmed/confirmedBy/confirmedAt). */
  confirmSheet(projectId: string, sheetId: string, req: ConfirmSheetRequest): Promise<Sheet>;
  /** Sprint 1: replace the floor regions of the sheet's current version (multi-floor sheets). */
  saveSheetRegions(projectId: string, sheetId: string, regions: SheetRegion[]): Promise<PutRegionsResponse>;
  /** Sprint 1: tiles meta + thumbnail (no query) or short-lived signed tile URLs for a window. */
  getTilesManifest(projectId: string, sheetId: string, versionId: string, q?: TilesManifestQuery): Promise<TilesManifest>;
  /** Sprint 2: signed URLs of legend/detections/rooms + crops of a sheet version. */
  getOverlay(projectId: string, sheetId: string, versionId: string): Promise<OverlayManifest>;
  /** Sprint 2: project legend entries (one page). */
  listLegendEntries(projectId: string, q?: ListLegendEntriesQuery): Promise<LegendEntryPage>;
  /** Sprint 2: confirm / reassign / ignore a legend entry. */
  patchLegendEntry(projectId: string, entryId: string, req: PatchLegendEntryRequest): Promise<PatchLegendEntryResponse>;
  /** Sprint 2: answer "מה זה?" once for a whole unknown-symbol cluster. */
  resolveUnknownCluster(projectId: string, clusterId: string, req: ResolveUnknownClusterRequest): Promise<ResolveUnknownClusterResponse>;

  /* Sprint 3 — BOQ */
  buildBoq(projectId: string): Promise<BuildBoqResponse>;
  getBoqBuild(projectId: string, buildId: string): Promise<BoqBuild>;
  listBoqLines(projectId: string): Promise<BoqLinesResponse>;
  patchBoqLine(projectId: string, lineId: string, req: PatchBoqLineRequest): Promise<BoqLine>;
  getBoqLineEvidence(projectId: string, lineId: string): Promise<BoqLineEvidence>;
  /** Sprint 6: one status for many lines (bulk "סמן כנבדק" / "אשר"). */
  batchBoqLineStatus(projectId: string, req: BatchStatusRequest): Promise<BatchStatusResponse>;
  /** Sprint 6: measure / count / confirm a line from its quick action (stores a correction bound to the line). */
  quickMeasureBoqLine(projectId: string, lineId: string, req: QuickMeasureRequest): Promise<QuickMeasureResponse>;
  getBoqSheetEvidence(projectId: string, sheetId: string, versionId: string): Promise<BoqSheetEvidence>;
  exportBoq(projectId: string, req: ExportBoqRequest): Promise<ExportBoqResponse>;
  /** Sprint 7: the BOQ document model (same layout as the Excel) for the preview. */
  getBoqDocument(projectId: string, q: BoqDocumentQuery): Promise<BoqDocumentModel>;
  /* Sprint 3 — org library, templates, rules */
  listLibraryItems(orgId: string, q?: ListLibraryQuery): Promise<LibraryItemPage>;
  patchLibraryItem(orgId: string, itemId: string, req: PatchLibraryItemRequest): Promise<LibraryItem>;
  createLibraryImport(orgId: string, req: CreateLibraryImportRequest): Promise<CreateLibraryImportResponse>;
  startLibraryImport(orgId: string, importId: string, uploadToken: string): Promise<LibraryImport>;
  getLibraryImport(orgId: string, importId: string): Promise<LibraryImport>;
  listBoqTemplates(orgId: string): Promise<BoqTemplate[]>;
  setDefaultBoqTemplate(orgId: string, templateId: string): Promise<BoqTemplate>;
  listBoqRules(orgId: string): Promise<BoqRule[]>;
  patchBoqRule(orgId: string, ruleId: string, req: { enabled: boolean }): Promise<BoqRule>;

  /* Sprint 4 — corrections, queue, room settings, find-similar */
  listCorrections(projectId: string, q?: { sheetId?: string }): Promise<CorrectionsResponse>;
  createCorrection(projectId: string, req: CreateCorrectionRequest): Promise<Correction>;
  createCorrectionsBatch(projectId: string, req: CreateCorrectionsBatchRequest): Promise<CorrectionsBatchResponse>;
  /** Undo = set `revertedAt` (one correction). */
  revertCorrection(projectId: string, correctionId: string): Promise<Correction>;
  /** Undo a whole batch (one step in the history). */
  revertCorrectionsBatch(projectId: string, batchId: string): Promise<{ reverted: number }>;
  getReviewQueue(projectId: string, filter?: string): Promise<ReviewQueueResponse>;
  getRoomSettings(projectId: string, sheetId: string, roomId: string): Promise<RoomSettingsResponse>;
  putRoomSettings(projectId: string, sheetId: string, roomId: string, req: RoomSettings): Promise<RoomSettingsResponse>;
  findSimilar(projectId: string, req: FindSimilarRequest): Promise<SimilarSearch>;
  getSimilarSearch(projectId: string, searchId: string): Promise<SimilarSearch>;

  /* Sprint 5 — history, audit, marked PDF, share links, org settings, offboarding */
  getLineHistory(projectId: string, lineId: string): Promise<LineHistoryResponse>;
  listAudit(orgId: string, q?: AuditQuery): Promise<AuditPage>;
  verifyAudit(orgId: string): Promise<AuditVerifyResult>;
  exportMarkedPdf(projectId: string, req: MarkedPdfExportRequest): Promise<{ exportId: string }>;
  getExport(projectId: string, exportId: string): Promise<ExportDoc>;
  createShareLink(projectId: string, req: CreateShareLinkRequest): Promise<CreateShareLinkResponse>;
  listShareLinks(projectId: string): Promise<ShareLink[]>;
  revokeShareLink(projectId: string, linkId: string): Promise<ShareLink | null>;
  patchOrgSettings(orgId: string, req: PatchOrgSettingsRequest): Promise<OrgSettings>;
  startOffboardingExport(orgId: string): Promise<OffboardingExport>;
  getOffboardingExport(orgId: string, exportId: string): Promise<OffboardingExport>;
  offboardOrg(orgId: string, req: OffboardRequest): Promise<OffboardResponse>;

  /* Stage 10 — members (admin; MFA + recent sign-in like offboarding) */
  listMembers(orgId: string): Promise<MembersResponse>;
  inviteMember(orgId: string, req: InviteMemberRequest): Promise<InviteMemberResponse>;
  patchMember(orgId: string, memberId: string, req: PatchMemberRequest): Promise<OrgMember>;
  removeMember(orgId: string, memberId: string): Promise<void>;
  /** POST /invites/:inviteId/accept (signed-in user whose verified email matches). */
  acceptInvite(inviteId: string): Promise<{ orgId: string; role: Role; alreadyMember: boolean }>;

  /* Sprint 8 — prices, comparison, deletes */
  /** POST /library/prices */
  bulkPatchPrices(orgId: string, req: BulkPriceRequest): Promise<BulkPriceResponse>;
  /** PATCH /projects/:pid/boq/pricing {adjustmentPct} */
  patchProjectPricing(projectId: string, adjustmentPct: number | null): Promise<PatchProjectPricingResponse>;
  /** Integration: POST /library/imports/:id/apply-prices */
  applyPriceImport(orgId: string, importId: string, req: ApplyPriceImportRequest): Promise<ApplyPriceImportResponse>;
  /** Integration: GET …/boq/builds?limit= (newest first) */
  listBoqBuilds(projectId: string): Promise<BoqBuildSummary[]>;
  /** GET …/boq/compare?from=&to=&base= */
  compareBoqBuilds(projectId: string, q: BoqCompareQuery): Promise<BoqComparison>;
  /** POST …/boq/compare/export {from?, to?, base} */
  exportBoqComparison(projectId: string, q: BoqCompareQuery): Promise<BoqCompareExportResponse>;
  deleteSheetSet(projectId: string, sheetSetId: string): Promise<DeleteSheetSetResponse>;
  deleteProject(projectId: string, req: DeleteProjectRequest): Promise<DeleteProjectResponse>;
}

/* ---------- Storage (resumable uploads) ---------- */

export type UploadTaskState = "running" | "paused" | "success" | "canceled" | "error";

export interface UploadHandle {
  pause(): boolean;
  resume(): boolean;
  cancel(): boolean;
  /** Resolves on success; rejects with `UploadCanceledError` or a transport error. */
  done: Promise<void>;
}

export class UploadCanceledError extends Error {
  constructor() {
    super("upload canceled");
    this.name = "UploadCanceledError";
  }
}

export interface UploadTransport {
  start(
    storagePath: string,
    file: Blob,
    contentType: string,
    onProgress: (bytesTransferred: number, totalBytes: number, state: UploadTaskState) => void,
  ): UploadHandle;
}

/* ---------- Realtime (Firestore listeners) ---------- */

export type Unsubscribe = () => void;
export type OnError = (err: Error) => void;

export interface RealtimeSource {
  /** jobs where orgId == X (and projectId == Y if given), newest first. */
  jobs(orgId: string, projectId: string | null, onData: (jobs: Job[]) => void, onError: OnError): Unsubscribe;
  sheetSets(orgId: string, projectId: string, onData: (sets: SheetSet[]) => void, onError: OnError): Unsubscribe;
  /** Sheets of a project joined with their current version (status). */
  sheets(
    orgId: string,
    projectId: string,
    onData: (rows: SheetRow[]) => void,
    onError: OnError,
  ): Unsubscribe;
  /** Sprint 3: the project doc's `boq` field (latest build + stale flag). */
  boqState(orgId: string, projectId: string, onData: (s: ProjectBoqState | null) => void, onError: OnError): Unsubscribe;
  /** Sprint 3: one build doc (status / progress). */
  boqBuild(orgId: string, projectId: string, buildId: string, onData: (b: BoqBuild | null) => void, onError: OnError): Unsubscribe;
}

export interface Backend {
  api: ApiClient;
  /** Sprint 5: unauthenticated, GET-only client of the share viewer (`/s/:token`). */
  publicShare: PublicShareClient;
  uploads: UploadTransport;
  realtime: RealtimeSource;
}
