/**
 * App-local DTOs mirroring @kamutan/contracts (packages/contracts/src/*.ts) field-for-field.
 * Kept local so the web app builds without the contracts package; switch to
 * `import type { … } from "@kamutan/contracts"` once its build is wired into turbo for web.
 */
export type Role = "admin" | "editor" | "reviewer" | "viewer";
export type FileKind = "pdf" | "dwg" | "dxf" | "png";

export interface MyOrg {
  id: string;
  name: string;
  role: Role;
  /** Sprint 3 (optional in the /me DTO): org policy, e.g. block export while "לבדיקה" lines remain. */
  settings?: { blockExportOnRed?: boolean };
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
}

export interface CreateProjectInput {
  orgId: string;
  name: string;
  address?: string;
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
}
export type SheetSetStatus = "uploaded" | "queued" | "splitting" | "ready" | "failed";
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
  score: number;
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
  stats?: { lines?: number; evidence?: number; sheets?: number; groups?: number } | null;
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
}
/** PATCH /v1/projects/:pid/boq/lines/:lineId */
export interface PatchBoqLineRequest {
  status?: BoqLineStatus;
  qtyOverride?: number | null;
  /** Required with a numeric qtyOverride (contracts PatchBoqLineRequest.reason). */
  reason?: string;
  note?: string | null;
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
  detectionId: string;
  linkGroupId: string | null;
  floor: string | null;
}
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
}
export interface ExportBoqResponse {
  url: string;
  filename: string;
  expiresAt: string;
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
  source: "import" | "manual";
  sourceRef?: string | null;
  active: boolean;
  updatedAt: string | null;
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
export type PatchLibraryItemRequest = Partial<Pick<LibraryItem, "unit" | "tags" | "active">> & { chapterTitle?: string };

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
}
export interface LibraryImport {
  id: string;
  filename: string;
  status: LibraryImportStatus;
  progress: number;
  jobId: string | null;
  result: LibraryImportResult | null;
  error: { code: string; message: string } | null;
}

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

export interface ApiClient {
  getMe(): Promise<MeResponse>;
  listProjects(orgId: string): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  createProject(input: CreateProjectInput): Promise<Project>;
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
  getBoqSheetEvidence(projectId: string, sheetId: string, versionId: string): Promise<BoqSheetEvidence>;
  exportBoq(projectId: string, req: ExportBoqRequest): Promise<ExportBoqResponse>;
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
  uploads: UploadTransport;
  realtime: RealtimeSource;
}
