import { env } from "@/lib/env";
import {
  ApiError,
  type ApiClient,
  type BoqBuild,
  type BoqLine,
  type BoqRule,
  type BoqTemplate,
  type Correction,
  type LibraryImport,
  type Project,
  type CreateCorrectionRequest,
  type ReviewQueueItem,
  type RoomSettings,
  type RoomSettingsResponse,
  type SimilarSearch,
  type AuditEvent,
  type AuditPage,
  type CalibrationStats,
  type ExportDoc,
  type OffboardingExport,
  type OrgSettings,
  type PublicShareBoq,
  type PublicShareClient,
  type PublicShareMeta,
  type PublicShareOverlay,
  type ShareErrorKind,
  type ShareLink,
  type CreateShareLinkResponse,
} from "./types";

/* ---------------- Sprint 4 adapters (contracts corrections.ts ↔ app DTOs) ---------------- */

/** Strict create body: drop the client-only `id` / `batchId` (the server assigns both). */
export function toCorrectionBody(req: CreateCorrectionRequest): Omit<CreateCorrectionRequest, "id" | "batchId"> {
  const { id: _id, batchId: _b, ...body } = req;
  return body;
}

interface ReviewQueueItemDto {
  id: string;
  kind: ReviewQueueItem["kind"];
  level: "green" | "yellow" | "red";
  risk: number;
  score: number | null;
  qtyImpact: number;
  title: string;
  reasons: string[];
  suggestedAction: string;
  sheetId: string | null;
  versionId: string | null;
  floor: string | null;
  bboxMm: { x: number; y: number; w: number; h: number } | null;
  thumbUrl: string | null;
  class: string | null;
  itemCode: string | null;
  lineIds: string[];
  detectionIds: string[];
  memberBboxesMm?: { x: number; y: number; w: number; h: number }[];
  count: number;
  ref: { detectionId?: string; clusterId?: string; linkGroupId?: string; roomId?: string; correctionId?: string; lineId?: string; signature?: string };
}
interface ReviewQueuePageDto {
  items: ReviewQueueItemDto[];
  nextCursor: string | null;
  total: number;
}
const ACTION: Record<string, ReviewQueueItem["suggestedAction"]> = {
  accept: "accept",
  reject: "reject",
  reclassify: "reclassify",
  resolve_unknown: "resolve",
  review_link: "link",
  room_settings: "settings",
  name_room: "settings",
  close_room: "settings",
  redo_correction: "open",
  review_line: "accept",
};
export function toQueueItem(v: ReviewQueueItemDto): ReviewQueueItem {
  const bbox = v.bboxMm ?? { x: 0, y: 0, w: 0, h: 0 };
  return {
    id: v.id,
    kind: v.kind,
    sheetId: v.sheetId ?? "",
    versionId: v.versionId ?? "",
    bboxMm: bbox,
    thumbUrl: v.thumbUrl,
    level: v.kind === "unknown_cluster" ? "unknown" : v.level,
    reasons: v.reasons,
    risk: v.risk,
    suggestedAction: ACTION[v.suggestedAction] ?? "accept",
    class: v.class,
    itemCode: v.itemCode,
    lineId: v.ref.lineId ?? v.lineIds[0] ?? null,
    detectionIds: v.detectionIds,
    members:
      v.kind === "cluster" || v.kind === "unknown_cluster"
        ? v.detectionIds.map((id, i) => ({ detectionId: id, bboxMm: v.memberBboxesMm?.[i] ?? bbox, score: v.score ?? 0, thumbUrl: null }))
        : undefined,
    clusterId: v.ref.clusterId ?? null,
    linkGroupId: v.ref.linkGroupId ?? null,
    roomId: v.ref.roomId ?? null,
    correctionId: v.ref.correctionId ?? null,
    score: v.score,
    title: v.title,
  };
}

interface RoomSettingsResponseDto {
  settings: RoomSettings & { sheetId: string; roomId: string; by: string | null; at: string | null };
  isDefault: boolean;
}
export function toRoomSettings(v: RoomSettingsResponseDto): RoomSettingsResponse {
  return { settings: { ...v.settings, id: `${v.settings.sheetId}__${v.settings.roomId}` }, isDefault: v.isDefault };
}
/** Strict PUT body (contracts PutRoomSettingsRequestSchema). */
export function toRoomSettingsBody(s: RoomSettings): RoomSettings {
  return {
    claddingHeightM: s.claddingHeightM,
    floorTiled: s.floorTiled,
    floorMaterialItemCode: s.floorMaterialItemCode,
    wallMaterialItemCode: s.wallMaterialItemCode,
    partialCladding: s.partialCladding.map((p) => ({ wallId: p.wallId, fromM: p.fromM, toM: p.toM, heightM: p.heightM, ...(p.bottomM !== undefined ? { bottomM: p.bottomM } : {}) })),
    wasteFactor: s.wasteFactor,
    includeInWaterproofing: s.includeInWaterproofing,
    ...(s.keepOpenings?.length ? { keepOpenings: s.keepOpenings } : {}),
    ...(s.type !== undefined ? { type: s.type } : {}),
  };
}

interface SimilarSearchDto {
  id: string;
  status: SimilarSearch["status"];
  exemplar: SimilarSearch["exemplar"];
  candidates: (SimilarSearch["candidates"][number] & { id: string; thumb: string | null })[];
  error: { code: string; message: string } | null;
}
export function toSimilar(v: SimilarSearchDto, thumbUrls: Record<string, string>): SimilarSearch {
  return { id: v.id, status: v.status, exemplar: v.exemplar, candidates: v.candidates, thumbs: thumbUrls, error: v.error };
}

/** GET /v1/projects/:pid/boq (contracts BoqView). */
interface BoqViewDto {
  summary: {
    latestBuildId: string | null;
    builtAt: string | null;
    stale: boolean;
    build: BoqBuild | null;
    blockExportOnRed: boolean;
    /** Sprint 5 (optional): calibration of the latest build. */
    calibration?: CalibrationStats | null;
  };
  items: BoqLine[];
  nextCursor: string | null;
}

/** Contracts lines may omit the Sprint-3 worker fields on old docs. */
export function normalizeLineDto(l: BoqLine): BoqLine {
  return { ...l, byFloor: l.byFloor ?? {}, evidenceCount: l.evidenceCount ?? 0, ruleId: l.ruleId ?? null, sourceVersions: l.sourceVersions ?? [], computedAt: l.computedAt ?? null };
}

/** contracts LibraryImportView → app LibraryImport (stats → result summary). */
export function toLibraryImport(v: {
  id: string;
  originalName?: string;
  status: string;
  jobId: string | null;
  stats: { created?: number; updated?: number; templates?: number; chapters?: number; ambiguousCodes?: { code: string; descriptions: string[] }[]; templateName?: string } | null;
  error: { code: string; message: string } | null;
  job?: { progress?: number | { pct?: number } } | null;
}): LibraryImport {
  const p = v.job?.progress;
  const pct = typeof p === "number" ? p : (p?.pct ?? 0);
  const st = v.stats;
  return {
    id: v.id,
    filename: v.originalName ?? "",
    status: (v.status === "awaiting_upload" ? "uploaded" : v.status) as LibraryImport["status"],
    progress: v.status === "succeeded" ? 100 : pct,
    jobId: v.jobId,
    result: st
      ? {
          itemsAdded: st.created ?? 0,
          itemsUpdated: st.updated ?? 0,
          chapters: st.chapters ?? 0,
          templateCreated: st.templates ? { id: "", name: st.templateName ?? "" } : null,
          ambiguousCodes: st.ambiguousCodes ?? [],
        }
      : null,
    error: v.error,
  };
}

/* ---------------- Sprint 5 adapters ---------------- */

/** Export doc (GET …/exports/:id → `{export, url?}` or the doc itself) → app DTO. */
export function toExportDoc(v: Record<string, unknown>): ExportDoc {
  const doc = (v.export as Record<string, unknown> | undefined) ?? v;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  const err = doc.error as ExportDoc["error"] | undefined;
  return {
    id: String(doc.id ?? doc.exportId ?? ""),
    kind: (doc.kind as ExportDoc["kind"]) ?? "marked_pdf",
    // contracts ExportStatus uses `ready` (the worker may write `succeeded`); the app says `succeeded`.
    status: doc.status === "ready" ? "succeeded" : ((doc.status as ExportDoc["status"]) ?? "queued"),
    progress: typeof doc.progress === "number" ? doc.progress : null,
    pageCount: typeof doc.pageCount === "number" ? doc.pageCount : null,
    createdBy: str(doc.createdBy),
    createdAt: str(doc.createdAt) ?? new Date().toISOString(),
    error: err ?? null,
    url: str(v.url) ?? str(v.signedUrl) ?? str(doc.url),
    titleBlockMasked: typeof doc.titleBlockMasked === "boolean" ? doc.titleBlockMasked : null,
    titleBlockBySheet: (doc.titleBlockBySheet as Record<string, boolean> | null | undefined) ?? null,
    message: str(v.message),
    filename: str(v.fileName) ?? str(v.filename) ?? str(doc.fileName) ?? str(doc.filename),
    expiresAt: str(v.expiresAt) ?? str(doc.expiresAt),
  };
}

/** Share link DTO (additive fields may be missing on links created before Sprint 5). */
export function toShareLink(v: Partial<ShareLink> & { id: string; expiresAt: string; createdAt: string }): ShareLink {
  return {
    id: v.id,
    label: v.label ?? "",
    recipient: v.recipient ?? null,
    versionLock: v.versionLock ?? [],
    expiresAt: v.expiresAt,
    revokedAt: v.revokedAt ?? null,
    hideTitleBlock: v.hideTitleBlock ?? true,
    allowPdfDownload: v.allowPdfDownload ?? false,
    viewCount: v.viewCount ?? 0,
    lastViewedAt: v.lastViewedAt ?? null,
    createdBy: v.createdBy ?? "",
    createdAt: v.createdAt,
    ...(v.sheets ? { sheets: v.sheets } : {}),
  };
}

export function toOffboardingExport(v: Record<string, unknown>): OffboardingExport {
  const doc = (v.export as Record<string, unknown> | undefined) ?? (v.job as Record<string, unknown> | undefined) ?? v;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  return {
    id: String(doc.id ?? v.exportId ?? v.jobId ?? ""),
    status: doc.status === "ready" ? "succeeded" : ((doc.status as OffboardingExport["status"]) ?? "queued"),
    progress: typeof doc.progress === "number" ? doc.progress : null,
    url: str(v.url) ?? str(doc.url),
    expiresAt: str(v.expiresAt) ?? str(doc.expiresAt),
    error: (doc.error as OffboardingExport["error"]) ?? null,
    createdAt: str(doc.createdAt) ?? new Date().toISOString(),
  };
}

/** Public share errors: 404 unknown; 410 expired / revoked (by code); 429 rate limited. */
export function shareErrorKind(e: unknown): ShareErrorKind {
  if (!(e instanceof ApiError)) return "error";
  if (e.status === 404) return "not_found";
  if (e.status === 429) return "rate_limited";
  if (e.status === 410) {
    if (/revok/i.test(e.code)) return "revoked";
    if (/expir/i.test(e.code)) return "expired";
    return "expired";
  }
  return "error";
}

/**
 * Unauthenticated client of `/v1/public/share/:token/…` (external viewer). GET only, no Authorization header, no
 * cookies, no referrer — it cannot write: there is no method for it and every request is a hard-coded GET.
 */
export function createPublicShareClient(base = env.apiBase, fetchImpl: typeof fetch = fetch): PublicShareClient {
  const enc = encodeURIComponent;
  const path = (token: string, rest: string) => `${base}/public/share/${enc(token)}${rest}`;
  async function get<T>(url: string): Promise<T> {
    const res = await fetchImpl(url, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      let code = res.status === 410 ? "gone" : res.status === 404 ? "not_found" : "internal_error";
      let message = res.statusText;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        /* non-JSON */
      }
      // contracts SHARE_STATE_HEADER: 410 bodies are identical (`share_unavailable`); the header tells which screen.
      const state = res.headers?.get?.("x-share-state");
      if (res.status === 410 && (state === "expired" || state === "revoked")) code = `share_${state}`;
      throw new ApiError(res.status, code, message);
    }
    return (await res.json()) as T;
  }
  return {
    getMeta: async (token) => normalizeShareMeta(await get<PublicShareMeta>(path(token, "/meta"))),
    getBoq: async (token) => {
      const v = await get<PublicShareBoq & { items?: PublicShareBoq["lines"] }>(path(token, "/boq"));
      // F-4: a snapshot frozen at link creation (contracts lines have no reasons / override marker).
      const lines = (v.lines ?? v.items ?? []).map((l) => ({ ...l, byFloor: l.byFloor ?? {} }));
      return { snapshotAt: v.snapshotAt ?? null, lines, ...(v.chapters ? { chapters: v.chapters } : {}) };
    },
    getOverlay: async (token, sheetId) => normalizeShareOverlay(await get<Parameters<typeof normalizeShareOverlay>[0]>(path(token, `/sheets/${enc(sheetId)}/overlay`)), sheetId),
    tileUrl: (token, sheetId, z, x, y) => path(token, `/sheets/${enc(sheetId)}/tiles/${z}/${x}/${y}`),
    pdfUrl: (token) => path(token, "/pdf"),
  };
}

/** contracts PublicShareMetaSchema: `{ link, project, sheets: [{ sheetId, … }], pdf }`. */
interface PublicShareMetaDto {
  link: { shortId: string; label: string; recipient: string | null; expiresAt: string; createdAt: string; hideTitleBlock: boolean; allowPdfDownload: boolean; watermark: string };
  project: { name: string; address: string | null };
  sheets: (Omit<PublicShareMeta["sheets"][number], "id"> & { sheetId: string })[];
  pdf: { status: "queued" | "running" | "ready" | "failed"; errorCode?: string | null } | null;
}
export function normalizeShareMeta(raw: PublicShareMeta | PublicShareMetaDto): PublicShareMeta {
  if ("link" in raw && "project" in raw) {
    const { link, project, sheets, pdf } = raw;
    return normalizeShareMeta({
      linkId: link.shortId,
      projectName: project.name,
      orgName: null,
      label: link.label,
      expiresAt: link.expiresAt,
      // The versions are locked when the link is created.
      versionDate: link.createdAt,
      hideTitleBlock: link.hideTitleBlock,
      // The per-link watermarked PDF is generated after creation: offer it once it is ready.
      allowPdfDownload: link.allowPdfDownload && pdf?.status === "ready",
      pdf: link.allowPdfDownload ? (pdf ?? null) : null,
      showConfidence: true,
      watermark: link.watermark,
      sheets: sheets.map(({ sheetId, ...x }) => ({ ...x, id: sheetId })),
    });
  }
  const v = raw;
  return {
    ...v,
    orgName: v.orgName ?? null,
    label: v.label ?? "",
    versionDate: v.versionDate ?? null,
    hideTitleBlock: v.hideTitleBlock ?? true,
    allowPdfDownload: v.allowPdfDownload ?? false,
    showConfidence: v.showConfidence ?? true,
    watermark: v.watermark ?? "",
    pdf: v.pdf ?? (v.allowPdfDownload ? { status: "ready" } : null),
    sheets: (v.sheets ?? []).map((s) => ({ ...s, floors: s.floors ?? [], title: s.title ?? null, discipline: s.discipline ?? null, page: s.page ?? null, tiles: s.tiles ?? null })),
  };
}

/** Overlay: accepts `evidence` (line → detections) or per-detection `lineIds`. */
type ShareDetectionDto = Omit<PublicShareOverlay["detections"][number], "lifecycle" | "roomId"> & { lifecycle?: PublicShareOverlay["detections"][number]["lifecycle"]; roomId?: string | null; lineIds?: string[] };
type ShareRoomDto = Omit<PublicShareOverlay["rooms"][number], "polygonMm" | "floor"> & { polygonMm?: { x: number; y: number }[]; floor?: string | null; bboxMm?: { x: number; y: number; w: number; h: number } | null };
type ShareLinkGroupDto = PublicShareOverlay["linkGroups"][number] & { lineIds?: string[] };
/**
 * contracts PublicShareOverlaySchema: detections carry `lineIds` (no lifecycle / room), groups are `links`, rooms have a
 * `bboxMm` (no polygon — drawn as their box). Also accepts the app's own shape (mock).
 */
export function normalizeShareOverlay(
  v: Omit<Partial<PublicShareOverlay>, "detections" | "rooms" | "linkGroups"> & { detections?: ShareDetectionDto[]; rooms?: ShareRoomDto[]; linkGroups?: ShareLinkGroupDto[]; links?: ShareLinkGroupDto[]; maskMm?: unknown },
  sheetId: string,
): PublicShareOverlay {
  const evidence: Record<string, string[]> = { ...(v.evidence ?? {}) };
  if (!v.evidence)
    for (const d of v.detections ?? []) for (const l of d.lineIds ?? []) (evidence[l] ??= []).push(d.id);
  const box = (b: { x: number; y: number; w: number; h: number }) => [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
  return {
    sheetId: v.sheetId ?? sheetId,
    versionId: v.versionId ?? "",
    detections: (v.detections ?? []).map(({ lineIds: _l, ...d }) => ({ ...d, lifecycle: d.lifecycle ?? "new", roomId: d.roomId ?? null })),
    rooms: (v.rooms ?? [])
      .filter((r) => r.polygonMm?.length || r.bboxMm)
      .map(({ bboxMm, polygonMm, ...r }) => ({ ...r, floor: r.floor ?? null, polygonMm: polygonMm?.length ? polygonMm : box(bboxMm!) })),
    linkGroups: (v.linkGroups ?? v.links ?? []).map(({ lineIds: _l, ...g }) => ({ ...g, pointIds: g.pointIds ?? [] })),
    evidence,
  };
}

/** contracts AuditPage item → app AuditEvent. */
interface AuditEventDto {
  id: string;
  actorId: string | null;
  actorKind: string;
  actorName: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  after: Record<string, unknown> | null;
  at: string;
  prevHash: string | null;
  hash: string;
}
export function toAuditEvent(v: AuditEventDto | AuditEvent): AuditEvent {
  if (!("actorId" in v)) return v;
  return {
    id: v.id,
    at: v.at,
    actor: v.actorKind === "user" && v.actorId ? { uid: v.actorId, displayName: v.actorName } : null,
    actorKind: v.actorKind,
    action: v.action,
    entity: v.entity,
    entityId: v.entityId,
    after: v.after,
    hash: v.hash,
    prevHash: v.prevHash,
  };
}

export type TokenGetter = () => Promise<string | null>;

/**
 * REST adapter for the NestJS API (Cloud Functions `api`), same-origin under /api/v1
 * (Firebase Hosting rewrite in prod, Vite proxy in dev). Auth = Firebase ID token as Bearer.
 */
export function createHttpClient(getToken: TokenGetter, base = env.apiBase, fetchImpl: typeof fetch = fetch): ApiClient {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await getToken();
    const res = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) {
      let code = "internal_error";
      let message = res.statusText;
      let requestId: string | null = null;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string; requestId?: string | null } };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
        requestId = body.error?.requestId ?? null;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, code, message, requestId);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
  const enc = encodeURIComponent;

  return {
    getMe: () => request("/me"),
    listProjects: async (orgId) => {
      // Sprint 0: first page only (limit 100). Cursor paging comes with the virtualized list.
      const page = await request<{ items: Project[]; nextCursor: string | null }>(
        `/projects?orgId=${enc(orgId)}&limit=100`,
      );
      return page.items;
    },
    getProject: (id) => request(`/projects/${enc(id)}`),
    createProject: (input) => post("/projects", input),
    createUpload: (projectId, req) => post(`/projects/${enc(projectId)}/uploads`, req),
    finalizeUpload: (projectId, req) => post(`/projects/${enc(projectId)}/sheet-sets`, req),
    confirmSheet: (projectId, sheetId, req) => post(`/projects/${enc(projectId)}/sheets/${enc(sheetId)}/confirm`, req),
    saveSheetRegions: (projectId, sheetId, regions) =>
      request(`/projects/${enc(projectId)}/sheets/${enc(sheetId)}/regions`, { method: "PUT", body: JSON.stringify({ regions }) }),
    getTilesManifest: (projectId, sheetId, versionId, q) => {
      const qs = q ? `?z=${q.z}&x0=${q.x0}&x1=${q.x1}&y0=${q.y0}&y1=${q.y1}` : "";
      return request(`/projects/${enc(projectId)}/sheets/${enc(sheetId)}/versions/${enc(versionId)}/tiles-manifest${qs}`);
    },
    getOverlay: (projectId, sheetId, versionId) =>
      request(`/projects/${enc(projectId)}/sheets/${enc(sheetId)}/versions/${enc(versionId)}/overlay`),
    listLegendEntries: (projectId, q = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) qs.set(k, String(v));
      const s = qs.toString();
      return request(`/projects/${enc(projectId)}/legend-entries${s ? `?${s}` : ""}`);
    },
    patchLegendEntry: (projectId, entryId, req) =>
      request(`/projects/${enc(projectId)}/legend-entries/${enc(entryId)}`, { method: "PATCH", body: JSON.stringify(req) }),
    resolveUnknownCluster: (projectId, clusterId, req) =>
      post(`/projects/${enc(projectId)}/unknown-clusters/${enc(clusterId)}/resolve`, req),

    /* Sprint 3 — BOQ (contracts boq.ts; adapted to the app DTOs in types.ts) */
    buildBoq: async (projectId) => {
      const r = await post<{ build: { id: string }; jobId: string | null }>(`/projects/${enc(projectId)}/boq/build`, {});
      return { buildId: r.build.id, jobId: r.jobId };
    },
    // No GET-build route: the summary of GET …/boq carries the pending/latest build (the UI listens on Firestore).
    getBoqBuild: async (projectId, buildId) => {
      const v = await request<BoqViewDto>(`/projects/${enc(projectId)}/boq?limit=1`);
      if (!v.summary.build || v.summary.build.id !== buildId) throw new ApiError(404, "not_found", "Build not found");
      return v.summary.build;
    },
    listBoqLines: async (projectId) => {
      const items: BoqLine[] = [];
      let cursor: string | null = null;
      let summary: BoqViewDto["summary"] | null = null;
      for (let i = 0; i < 20; i++) {
        const v: BoqViewDto = await request(`/projects/${enc(projectId)}/boq?limit=500${cursor ? `&cursor=${enc(cursor)}` : ""}`);
        summary ??= v.summary;
        items.push(...v.items.map(normalizeLineDto));
        if (!v.nextCursor) break;
        cursor = v.nextCursor;
      }
      const sm = summary;
      return {
        items,
        boq: sm ? { latestBuildId: sm.latestBuildId, builtAt: sm.builtAt, stale: sm.stale } : null,
        blockExportOnRed: sm?.blockExportOnRed ?? false,
        calibration: sm?.calibration ?? sm?.build?.stats?.calibration ?? null,
      };
    },
    patchBoqLine: async (projectId, lineId, req) => {
      const r = await request<{ line: BoqLine }>(`/projects/${enc(projectId)}/boq/lines/${enc(lineId)}`, {
        method: "PATCH",
        body: JSON.stringify(req),
      });
      return normalizeLineDto(r.line);
    },
    getBoqLineEvidence: (projectId, lineId) => request(`/projects/${enc(projectId)}/boq/lines/${enc(lineId)}/evidence`),
    getBoqSheetEvidence: (projectId, sheetId, versionId) =>
      request(`/projects/${enc(projectId)}/boq/evidence?sheetId=${enc(sheetId)}&versionId=${enc(versionId)}`),
    exportBoq: async (projectId, req) => {
      const r = await post<{ url: string; fileName: string; expiresAt: string }>(`/projects/${enc(projectId)}/boq/export`, {
        ...(req.templateId ? { templateId: req.templateId } : {}),
        split: req.split,
        markDraft: req.draftNote,
      });
      return { url: r.url, filename: r.fileName, expiresAt: r.expiresAt };
    },

    /* Sprint 3 — org library / templates / rules (`?orgId=` scope, contracts library.ts) */
    listLibraryItems: (orgId, q = {}) => {
      const qs = new URLSearchParams({ orgId });
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
      return request(`/library/items?${qs.toString()}`);
    },
    patchLibraryItem: (orgId, itemId, req) =>
      request(`/library/items/${enc(itemId)}?orgId=${enc(orgId)}`, { method: "PATCH", body: JSON.stringify(req) }),
    createLibraryImport: async (orgId, req) => {
      const r = await post<{ import: { id: string }; storagePath: string; contentType: string }>(`/library/imports`, { orgId, ...req });
      // The finalize call is authorised by the session + import id; there is no separate upload token.
      return { importId: r.import.id, storagePath: r.storagePath, uploadToken: r.import.id, contentType: r.contentType };
    },
    startLibraryImport: async (orgId, importId) => toLibraryImport(await post(`/library/imports/${enc(importId)}/finalize`, { orgId })),
    getLibraryImport: async (orgId, importId) => toLibraryImport(await request(`/library/imports/${enc(importId)}?orgId=${enc(orgId)}`)),
    listBoqTemplates: async (orgId) => (await request<{ items: BoqTemplate[] }>(`/boq-templates?orgId=${enc(orgId)}`)).items,
    setDefaultBoqTemplate: (orgId, templateId) =>
      request(`/boq-templates/${enc(templateId)}?orgId=${enc(orgId)}`, { method: "PATCH", body: JSON.stringify({ default: true }) }),
    listBoqRules: async (orgId) => (await request<{ items: BoqRule[] }>(`/boq-rules?orgId=${enc(orgId)}`)).items,
    patchBoqRule: (orgId, ruleId, req) =>
      request(`/boq-rules/${enc(ruleId)}?orgId=${enc(orgId)}`, { method: "PATCH", body: JSON.stringify(req) }),

    /* Sprint 4 — corrections, review queue, room settings, find-similar (contracts corrections.ts) */
    listCorrections: async (projectId, q = {}) => {
      const items: Correction[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const qs = new URLSearchParams({ limit: "500" });
        if (q.sheetId) qs.set("sheetId", q.sheetId);
        if (cursor) qs.set("cursor", cursor);
        const page: { items: Correction[]; nextCursor: string | null } = await request(`/projects/${enc(projectId)}/corrections?${qs.toString()}`);
        items.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return { items };
    },
    createCorrection: async (projectId, req) =>
      (await post<{ correction: Correction }>(`/projects/${enc(projectId)}/corrections`, toCorrectionBody(req))).correction,
    createCorrectionsBatch: async (projectId, req) => {
      const r = await post<{ batch: { id: string }; items: Correction[] }>(`/projects/${enc(projectId)}/corrections/batch`, {
        items: req.corrections.map(toCorrectionBody),
        source: req.source ?? "other",
        similarSearchId: req.similarSearchId ?? null,
      });
      return { items: r.items, batchId: r.batch.id };
    },
    revertCorrection: async (projectId, id) =>
      (await post<{ correction: Correction }>(`/projects/${enc(projectId)}/corrections/${enc(id)}/revert`, {})).correction,
    revertCorrectionsBatch: async (projectId, batchId) => {
      const r = await post<{ reverted: number }>(`/projects/${enc(projectId)}/correction-batches/${enc(batchId)}/revert`, {});
      return { reverted: r.reverted };
    },
    getReviewQueue: async (projectId, filter) => {
      const items: ReviewQueueItem[] = [];
      let cursor: string | null = null;
      let total = 0;
      // The ranked list is paged (≤ 200 per page): the panel shows up to 1,000 items.
      for (let i = 0; i < 5; i++) {
        const qs = new URLSearchParams({ limit: "200" });
        if (filter) qs.set("kind", filter);
        if (cursor) qs.set("cursor", cursor);
        const page: ReviewQueuePageDto = await request(`/projects/${enc(projectId)}/review-queue?${qs.toString()}`);
        total = page.total;
        items.push(...page.items.map(toQueueItem));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return { items, total };
    },
    getRoomSettings: async (projectId, sheetId, roomId) =>
      toRoomSettings(await request(`/projects/${enc(projectId)}/rooms/${enc(sheetId)}/${enc(roomId)}/settings`)),
    putRoomSettings: async (projectId, sheetId, roomId, req) =>
      toRoomSettings(
        await request(`/projects/${enc(projectId)}/rooms/${enc(sheetId)}/${enc(roomId)}/settings`, { method: "PUT", body: JSON.stringify(toRoomSettingsBody(req)) }),
      ),
    findSimilar: async (projectId, req) => {
      const r = await post<{ search: SimilarSearchDto }>(`/projects/${enc(projectId)}/similar-searches`, {
        exemplar: { sheetId: req.exemplar.sheetId, versionId: req.exemplar.versionId, bboxMm: req.exemplar.bboxMm, class: req.exemplar.class },
        scope: req.scope,
        correctionId: req.correctionId ?? null,
      });
      return toSimilar(r.search, {});
    },
    getSimilarSearch: async (projectId, id) => {
      const v = await request<{ search: SimilarSearchDto; thumbUrls: Record<string, string> }>(`/projects/${enc(projectId)}/similar-searches/${enc(id)}`);
      return toSimilar(v.search, v.thumbUrls ?? {});
    },

    /* Sprint 5 */
    getLineHistory: (projectId, lineId) => request(`/projects/${enc(projectId)}/boq/lines/${enc(lineId)}/history`),
    listAudit: async (orgId, q = {}) => {
      const qs = new URLSearchParams();
      if (q.cursor) qs.set("cursor", q.cursor);
      if (q.entity) qs.set("entity", q.entity);
      if (q.action) qs.set("action", q.action);
      if (q.limit) qs.set("limit", String(q.limit));
      const s = qs.toString();
      const page = await request<{ items: AuditEventDto[]; nextCursor: string | null }>(`/orgs/${enc(orgId)}/audit${s ? `?${s}` : ""}`);
      return { items: page.items.map(toAuditEvent), nextCursor: page.nextCursor } satisfies AuditPage;
    },
    verifyAudit: (orgId) => request(`/orgs/${enc(orgId)}/audit/verify`),
    exportMarkedPdf: async (projectId, req) => {
      // contracts CreateMarkedPdfRequestSchema: { sheetIds, options: { floorSplit, hideTitleBlock } } (legend always on).
      const r = await post<{ exportId?: string; export?: { id: string } }>(`/projects/${enc(projectId)}/boq/export/marked-pdf`, {
        sheetIds: req.sheetIds,
        options: { floorSplit: req.floorSplit, hideTitleBlock: req.hideTitleBlock },
      });
      return { exportId: r.exportId ?? r.export?.id ?? "" };
    },
    getExport: async (projectId, exportId) => toExportDoc(await request(`/projects/${enc(projectId)}/exports/${enc(exportId)}`)),
    createShareLink: async (projectId, req) => {
      const r = await post<{ link: ShareLink; url: string; warnings?: CreateShareLinkResponse["warnings"] }>(`/projects/${enc(projectId)}/share-links`, req);
      return { link: toShareLink(r.link), url: r.url, warnings: r.warnings ?? [] };
    },
    listShareLinks: async (projectId) => {
      const r = await request<{ items: ShareLink[] } | ShareLink[]>(`/projects/${enc(projectId)}/share-links`);
      return (Array.isArray(r) ? r : r.items).map(toShareLink);
    },
    revokeShareLink: async (projectId, linkId) => {
      const r = await request<{ link?: ShareLink } | undefined>(`/projects/${enc(projectId)}/share-links/${enc(linkId)}`, { method: "DELETE" });
      return r?.link ? toShareLink(r.link) : null;
    },
    patchOrgSettings: async (orgId, req) => {
      const r = await request<{ settings: OrgSettings } | OrgSettings>(`/orgs/${enc(orgId)}/settings`, { method: "PATCH", body: JSON.stringify(req) });
      return "settings" in r ? r.settings : r;
    },
    startOffboardingExport: async (orgId) => toOffboardingExport(await post(`/orgs/${enc(orgId)}/offboarding/export`, { includeSources: true })),
    getOffboardingExport: async (orgId, id) => toOffboardingExport(await request(`/orgs/${enc(orgId)}/offboarding/export/${enc(id)}`)),
    offboardOrg: (orgId, req) => post(`/orgs/${enc(orgId)}/offboarding`, req),
  };
}
