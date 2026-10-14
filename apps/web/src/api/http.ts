import { env } from "@/lib/env";
import { ApiError, type ApiClient, type Project, type SheetSet, type UploadTarget } from "./types";

export type TokenGetter = () => Promise<string | null>;

/** REST adapter for the NestJS API (`/v1`, Bearer = Firebase ID token). */
export function createHttpClient(getToken: TokenGetter, baseUrl = env.apiUrl): ApiClient {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await getToken();
    const res = await fetch(`${baseUrl}/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) {
      let code = "http_error";
      let message = res.statusText;
      try {
        const body = (await res.json()) as { code?: string; message?: string };
        code = body.code ?? code;
        message = body.message ?? message;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, code, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** The API scopes projects to an org: use the user's first org, creating a personal one on first use. */
  async function resolveOrgId(): Promise<string> {
    const { items } = await request<{ items: { id: string; role: string }[] }>("/orgs");
    const usable = items.find((o) => o.role === "editor" || o.role === "admin") ?? items[0];
    if (usable) return usable.id;
    const slug = `org-${crypto.randomUUID().slice(0, 8)}`;
    return (await request<{ id: string }>("/orgs", { method: "POST", body: JSON.stringify({ name: slug, slug }) })).id;
  }

  return {
    listProjects: async () => (await request<{ items: Project[] }>("/projects")).items,
    getProject: (id) => request<Project>(`/projects/${encodeURIComponent(id)}`),
    createProject: async ({ name, address }) =>
      request<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({ orgId: await resolveOrgId(), name, address }),
      }),
    listSheetSets: async (projectId) =>
      (
        await request<{ items: { id: string; projectId: string; name: string; createdAt: string }[] }>(
          `/projects/${encodeURIComponent(projectId)}/sheet-sets`,
        )
      ).items.map((s) => ({ id: s.id, projectId: s.projectId, name: s.name, fileCount: 1, createdAt: s.createdAt })),
    createUpload: (projectId, req) =>
      request<UploadTarget>(`/projects/${encodeURIComponent(projectId)}/uploads`, {
        method: "POST",
        body: JSON.stringify(req),
      }),
    createSheetSet: (projectId, uploadIds, name) =>
      request<SheetSet>(`/projects/${encodeURIComponent(projectId)}/sheet-sets`, {
        method: "POST",
        body: JSON.stringify({ uploadIds, name }),
      }),
    uploadFile: (target, file, onProgress, signal) =>
      new Promise<void>((resolve, reject) => {
        // XHR (not fetch) because fetch has no upload progress events.
        // TODO(sprint-1): switch to resumable uploads (Firebase Storage) per 04_architecture.
        const xhr = new XMLHttpRequest();
        xhr.open(target.method, target.url);
        for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new ApiError(xhr.status, "upload_failed", xhr.statusText));
        xhr.onerror = () => reject(new ApiError(0, "network_error", "Network error"));
        xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(file);
      }),
  };
}
