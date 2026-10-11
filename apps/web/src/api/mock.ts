import { ApiError, type ApiClient, type Project, type SheetSet } from "./types";

export interface MockOptions {
  /** Seed projects. Defaults to one demo project. Pass [] to see the empty state. */
  projects?: Project[];
  /** Simulated latency in ms (0 in tests). */
  latencyMs?: number;
  /** Upload tick interval in ms. */
  uploadTickMs?: number;
}

export const demoProjects = (): Project[] => [
  {
    id: "p-noah",
    name: "בית משפחת נח",
    address: "רחוב הדקל 12, רמת השרון",
    status: "review",
    verifiedPct: 87,
    sheetsCount: 15,
    toReviewCount: 23,
    updatedAt: "2026-10-11T11:32:00.000Z",
  },
  {
    id: "p-levi",
    name: "דירת לוי — שיפוץ מטבח ורחצה",
    address: "שדרות ירושלים 40, תל אביב-יפו",
    status: "draft",
    verifiedPct: 0,
    sheetsCount: 0,
    toReviewCount: 0,
    updatedAt: "2026-10-08T07:05:00.000Z",
  },
];

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** In-memory adapter so the web app runs standalone (VITE_USE_MOCKS=true) and in tests. */
export function createMockClient(opts: MockOptions = {}): ApiClient {
  const latency = opts.latencyMs ?? 250;
  const tick = opts.uploadTickMs ?? 120;
  const projects = new Map<string, Project>((opts.projects ?? demoProjects()).map((p) => [p.id, { ...p }]));
  const sheetSets = new Map<string, SheetSet[]>();
  const uploads = new Map<string, { projectId: string; name: string }>();

  const delay = <T>(value: T): Promise<T> =>
    latency > 0 ? new Promise((r) => setTimeout(() => r(value), latency)) : Promise.resolve(value);

  const mustGet = (id: string) => {
    const p = projects.get(id);
    if (!p) throw new ApiError(404, "not_found", "Project not found");
    return p;
  };

  return {
    listProjects: () =>
      delay([...projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((p) => ({ ...p }))),
    getProject: async (id) => delay({ ...mustGet(id) }),
    createProject: async (input) => {
      const name = input.name.trim();
      if (!name) throw new ApiError(422, "validation", "name is required");
      const p: Project = {
        id: nextId("p"),
        name,
        address: input.address?.trim() || null,
        status: "draft",
        verifiedPct: 0,
        sheetsCount: 0,
        toReviewCount: 0,
        updatedAt: new Date().toISOString(),
      };
      projects.set(p.id, p);
      return delay({ ...p });
    },
    listSheetSets: async (projectId) => {
      mustGet(projectId);
      return delay([...(sheetSets.get(projectId) ?? [])]);
    },
    createUpload: async (projectId, req) => {
      mustGet(projectId);
      const uploadId = nextId("u");
      uploads.set(uploadId, { projectId, name: req.fileName });
      return delay({
        uploadId,
        url: `mock://quarantine/${uploadId}`,
        method: "PUT" as const,
        headers: {},
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    },
    uploadFile: (_target, file, onProgress, signal) =>
      new Promise<void>((resolve, reject) => {
        const total = Math.max(file.size, 1);
        const steps = 8;
        let i = 0;
        // Demo affordance: a file whose name contains "fail" simulates a network error at 50%.
        const shouldFail = /fail/i.test(file.name);
        const timer = setInterval(() => {
          i += 1;
          onProgress(Math.min(total, Math.round((total * i) / steps)), total);
          if (shouldFail && i === steps / 2) {
            clearInterval(timer);
            reject(new ApiError(0, "network_error", "Simulated network error"));
          } else if (i >= steps) {
            clearInterval(timer);
            resolve();
          }
        }, tick);
        signal?.addEventListener(
          "abort",
          () => {
            clearInterval(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      }),
    createSheetSet: async (projectId, uploadIds, name) => {
      const p = mustGet(projectId);
      const set: SheetSet = {
        id: nextId("s"),
        projectId,
        name,
        fileCount: uploadIds.length,
        createdAt: new Date().toISOString(),
      };
      sheetSets.set(projectId, [...(sheetSets.get(projectId) ?? []), set]);
      projects.set(projectId, {
        ...p,
        status: p.status === "draft" ? "processing" : p.status,
        updatedAt: set.createdAt,
      });
      return delay(set);
    },
  };
}
