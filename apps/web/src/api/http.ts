import { env } from "@/lib/env";
import { ApiError, type ApiClient, type Project } from "./types";

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
  };
}
