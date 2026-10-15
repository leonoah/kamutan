import { env } from "@/lib/env";
import { ApiError, type ApiClient, type BoqBuild, type BoqLine, type BoqRule, type BoqTemplate, type LibraryImport, type Project } from "./types";

/** GET /v1/projects/:pid/boq (contracts BoqView). */
interface BoqViewDto {
  summary: {
    latestBuildId: string | null;
    builtAt: string | null;
    stale: boolean;
    build: BoqBuild | null;
    blockExportOnRed: boolean;
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
  };
}
