import {
  ApiError,
  UploadCanceledError,
  type Backend,
  type Job,
  type MeResponse,
  type Project,
  type Sheet,
  type SheetSet,
  type SheetVersion,
} from "./types";

export interface MockOptions {
  /** Seed projects. Defaults to two demo projects. Pass [] to see the empty state. */
  projects?: Project[];
  /** Orgs of the signed-in user. Pass [] to see the "no organisation" screen. */
  orgs?: MeResponse["orgs"];
  /** Simulated API latency (ms). 0 in tests. */
  latencyMs?: number;
  /** Upload progress tick (ms). */
  uploadTickMs?: number;
  /** Ingest job progress tick (ms). */
  jobTickMs?: number;
}

export const DEMO_ORG_ID = "org-demo";
export const MOCK_STAGES = ["split", "titleblock", "legend", "rooms", "links", "quantities"] as const;

export const demoProjects = (): Project[] => [
  {
    id: "p-noah",
    orgId: DEMO_ORG_ID,
    name: "בית משפחת נח",
    address: "רחוב הדקל 12, רמת השרון",
    floors: [],
    stats: { sheets: 15, reviewOpen: 23, boqLines: 119, red: 4, yellow: 11, green: 104 },
    status: "active",
    createdBy: "mock-user",
    createdAt: "2026-10-11T11:32:00.000Z",
  },
  {
    id: "p-levi",
    orgId: DEMO_ORG_ID,
    name: "דירת לוי — שיפוץ מטבח ורחצה",
    address: "שדרות ירושלים 40, תל אביב-יפו",
    floors: [],
    stats: { sheets: 0, reviewOpen: 0, boqLines: 0, red: 0, yellow: 0, green: 0 },
    status: "active",
    createdBy: "mock-user",
    createdAt: "2026-10-08T07:05:00.000Z",
  },
];

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`;
const fakeSha = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

type Listener = () => void;

/**
 * Fully in-memory backend (API + Storage + Firestore listeners) so the web app runs
 * standalone with VITE_USE_MOCKS=true and in tests. Finalizing an upload starts a
 * simulated ingest job whose progress is pushed to listeners like Firestore would.
 */
export function createMockBackend(opts: MockOptions = {}): Backend & { emit(): void } {
  const latency = opts.latencyMs ?? 250;
  const uploadTick = opts.uploadTickMs ?? 120;
  const jobTick = opts.jobTickMs ?? 700;
  const orgs = opts.orgs ?? [{ id: DEMO_ORG_ID, name: "סטודיו נח לעיצוב פנים", role: "admin" as const }];

  const projects = new Map((opts.projects ?? demoProjects()).map((p) => [p.id, structuredClone(p)]));
  const sheetSets = new Map<string, SheetSet[]>(); // projectId → sets
  const sheets = new Map<string, { sheet: Sheet; version: SheetVersion | null }[]>();
  const jobs: Job[] = [];
  const tokens = new Map<string, { projectId: string; filename: string; kind: SheetSet["fileKind"]; uploaded: boolean }>();
  const uploadedPaths = new Set<string>();
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l());
  const listen = (fn: Listener) => {
    listeners.add(fn);
    queueMicrotask(() => listeners.has(fn) && fn());
    return () => void listeners.delete(fn);
  };

  const delay = <T>(value: T): Promise<T> =>
    latency > 0 ? new Promise((r) => setTimeout(() => r(value), latency)) : Promise.resolve(value);
  const mustGet = (id: string) => {
    const p = projects.get(id);
    if (!p) throw new ApiError(404, "not_found", "Project not found");
    return p;
  };

  function runJob(job: Job, set: SheetSet, row: { sheet: Sheet; version: SheetVersion | null }) {
    let step = 0;
    const total = MOCK_STAGES.length * 3;
    const timer = setInterval(() => {
      step += 1;
      const now = new Date().toISOString();
      Object.assign(job, {
        status: "running",
        progress: Math.min(100, Math.round((step / total) * 100)),
        stage: MOCK_STAGES[Math.min(MOCK_STAGES.length - 1, Math.floor((step - 1) / 3))],
        updatedAt: now,
      });
      set.status = "splitting";
      if (row.version) row.version.status = "processing";
      if (step >= total) {
        clearInterval(timer);
        Object.assign(job, { status: "succeeded", progress: 100 });
        set.status = "ready";
        if (row.version) row.version.status = "ready";
        const p = projects.get(set.projectId);
        if (p?.stats) p.stats.sheets += 1;
      }
      emit();
    }, jobTick);
  }

  return {
    emit,
    api: {
      getMe: () => delay({ uid: "mock-user", mfa: false, orgs: structuredClone(orgs) }),
      listProjects: (orgId) =>
        delay(
          [...projects.values()]
            .filter((p) => p.orgId === orgId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((p) => structuredClone(p)),
        ),
      getProject: async (id) => delay(structuredClone(mustGet(id))),
      createProject: async (input) => {
        const name = input.name.trim();
        if (!name) throw new ApiError(400, "validation_failed", "name is required");
        const p: Project = {
          id: nextId("p"),
          orgId: input.orgId,
          name,
          ...(input.address?.trim() ? { address: input.address.trim() } : {}),
          floors: [],
          stats: { sheets: 0, reviewOpen: 0, boqLines: 0, red: 0, yellow: 0, green: 0 },
          status: "active",
          createdBy: "mock-user",
          createdAt: new Date().toISOString(),
        };
        projects.set(p.id, p);
        return delay(structuredClone(p));
      },
      createUpload: async (projectId, req) => {
        const p = mustGet(projectId);
        const ext = req.filename.split(".").pop()?.toLowerCase();
        if (!ext || !["pdf", "dwg", "dxf", "png"].includes(ext)) {
          throw new ApiError(415, "unsupported_file_type", "unsupported");
        }
        const fileId = nextId("f");
        const uploadToken = `mock-token-${fileId}-xxxxxxxx`;
        const kind = ext as SheetSet["fileKind"];
        tokens.set(uploadToken, { projectId, filename: req.filename, kind, uploaded: false });
        return delay({
          fileId,
          storagePath: `orgs/${p.orgId}/uploads/mock-user/${fileId}`,
          uploadToken,
          contentType: { pdf: "application/pdf", png: "image/png", dxf: "application/dxf", dwg: "application/acad" }[kind],
          fileKind: kind,
          maxBytes: 100 * 1024 * 1024,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
      },
      finalizeUpload: async (projectId, req) => {
        const p = mustGet(projectId);
        const t = tokens.get(req.uploadToken);
        if (!t || t.projectId !== projectId) throw new ApiError(410, "upload_expired", "token unknown");
        const fileId = req.uploadToken.replace(/^mock-token-|-x+$/g, "");
        if (!uploadedPaths.has(`orgs/${p.orgId}/uploads/mock-user/${fileId}`)) {
          throw new ApiError(404, "upload_missing", "object not found");
        }
        tokens.delete(req.uploadToken);
        const now = new Date().toISOString();
        const set: SheetSet = {
          id: nextId("s"),
          orgId: p.orgId,
          projectId,
          fileKind: t.kind,
          sha256: fakeSha(),
          storagePath: `orgs/${p.orgId}/projects/${projectId}/sources/x.${t.kind}`,
          status: "uploaded",
          name: req.name ?? t.filename,
          uploadedBy: "mock-user",
          createdAt: now,
        };
        const sheet: Sheet = { id: nextId("sh"), logicalKey: t.filename, sheetSetId: set.id, currentVersionId: null };
        const version: SheetVersion = { id: nextId("v"), sheetId: sheet.id, versionNo: 1, status: "queued", createdAt: now };
        sheet.currentVersionId = version.id;
        const row = { sheet, version };
        const job: Job = {
          id: nextId("j"),
          orgId: p.orgId,
          projectId,
          versionId: version.id,
          type: "ingest.sheet_version",
          status: "queued",
          progress: 0,
          createdAt: now,
        };
        sheetSets.set(projectId, [set, ...(sheetSets.get(projectId) ?? [])]);
        sheets.set(projectId, [...(sheets.get(projectId) ?? []), row]);
        jobs.unshift(job);
        emit();
        runJob(job, set, row);
        return delay({ sheetSet: { ...set }, sheet: { ...sheet }, sheetVersion: { ...version }, deduplicated: false, jobId: job.id });
      },
    },

    uploads: {
      start(storagePath, file, _contentType, onProgress) {
        const total = Math.max(file.size, 1);
        const steps = 10;
        let i = 0;
        let paused = false;
        let finished = false;
        let timer: ReturnType<typeof setInterval> | undefined;
        let resolve!: () => void;
        let reject!: (e: Error) => void;
        const done = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        // Demo affordance: a file whose name contains "fail" simulates a network error at 50%.
        const shouldFail = /fail/i.test((file as File).name ?? "");
        const tick = () => {
          i += 1;
          onProgress(Math.min(total, Math.round((total * i) / steps)), total, "running");
          if (shouldFail && i === steps / 2) {
            stop();
            reject(Object.assign(new Error("Simulated network error"), { code: "storage/retry-limit-exceeded" }));
          } else if (i >= steps) {
            stop();
            uploadedPaths.add(storagePath);
            resolve();
          }
        };
        const stop = () => {
          finished = true;
          clearInterval(timer);
        };
        timer = setInterval(tick, uploadTick);
        return {
          done,
          pause() {
            if (finished || paused) return false;
            paused = true;
            clearInterval(timer);
            onProgress(Math.round((total * i) / steps), total, "paused");
            return true;
          },
          resume() {
            if (finished || !paused) return false;
            paused = false;
            onProgress(Math.round((total * i) / steps), total, "running");
            timer = setInterval(tick, uploadTick);
            return true;
          },
          cancel() {
            if (finished) return false;
            stop();
            reject(new UploadCanceledError());
            return true;
          },
        };
      },
    },

    realtime: {
      jobs: (orgId, projectId, onData) =>
        listen(() =>
          onData(
            jobs
              .filter((j) => j.orgId === orgId && (!projectId || j.projectId === projectId))
              .map((j) => ({ ...j })),
          ),
        ),
      sheetSets: (_orgId, projectId, onData) =>
        listen(() => onData((sheetSets.get(projectId) ?? []).map((s) => ({ ...s })))),
      sheets: (_orgId, projectId, onData) =>
        listen(() =>
          onData(
            (sheets.get(projectId) ?? []).map((r) => ({
              sheet: { ...r.sheet },
              version: r.version ? { ...r.version } : null,
            })),
          ),
        ),
    },
  };
}
