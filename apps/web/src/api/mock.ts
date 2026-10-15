import {
  INGEST_STAGES,
  ApiError,
  UploadCanceledError,
  type Backend,
  type Job,
  type MeResponse,
  type Project,
  type Sheet,
  type SheetSet,
  type SheetRow,
  type SheetVersion,
  type IngestStage,
} from "./types";
import { DEV_ARTIFACTS_BASE, SAMPLE_FOR_UPLOAD, guessClassification, pageOf, rowFromDevIndex, sampleTiles, seedNoah, type DevIndexEntry } from "./mockSheets";
import { createUnderstandingMock } from "./mockUnderstanding";
import { createBoqMock } from "./mockBoq";

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
  /** Seed the demo project (p-noah) with classified sample sheets. Default true. */
  seedSheets?: boolean;
  /** Sprint 2: attach the synthetic legend/detections/rooms fixture to two sample sheets. Default true. */
  understandingFixture?: boolean;
  /** Override the number of detections on the electrical fixture sheet (performance demos, e.g. 2000). */
  fixtureDetections?: number;
  /**
   * Read /dev-artifacts/dev-index.json (vite dev server) and use the worker's REAL understanding artifacts when
   * present (they replace the fixture). Default: on in the browser outside tests.
   */
  devIndex?: boolean;
  /** Sprint 3: org policy "block export while red lines remain". Default false (`?mockBlockExport=1` in dev). */
  blockExportOnRed?: boolean;
  /** Sprint 3: run a BOQ build at startup (tests / screenshots). Default false → empty state "בנה כתב כמויות". */
  boqPrebuilt?: boolean;
  /** Sprint 3: simulated build / import tick (ms). Defaults to jobTickMs. */
  boqTickMs?: number;
  /** Sprint 3 (dev): ignore Worker-BOQ's local lines, always aggregate with the mock engine. */
  boqEngineOnly?: boolean;
}

export const DEMO_ORG_ID = "org-demo";
/** Worker stages in order (brief: progress.stage). */
export const MOCK_STAGES = INGEST_STAGES.filter((st) => st !== "done") as Exclude<IngestStage, "done">[];
/** Upper bound (pct) of each stage, for the simulated worker. */
const STAGE_END: Record<Exclude<IngestStage, "done">, number> = { ingest: 8, render: 30, ocr: 48, classify: 60, scale: 68, legend: 78, detect: 92, rooms: 99 };
const MAX_TILE_BATCH = 256;

/** Same structural checks as contracts RegionListSchema (+ ≥ 3 points). */
function validateRegions(regions: { id: string; polygonMm: { x: number; y: number }[] }[]) {
  const ids = new Set<string>();
  if (regions.length > 8) throw new ApiError(400, "validation_failed", "too many regions");
  for (const r of regions) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(r.id) || ids.has(r.id)) throw new ApiError(400, "validation_failed", "bad region id");
    if (r.polygonMm.length < 3 || r.polygonMm.length > 256) throw new ApiError(400, "validation_failed", "bad polygon");
    ids.add(r.id);
  }
}

const stageAt = (pct: number): IngestStage =>
  pct >= 100 ? "done" : (MOCK_STAGES.find((st) => pct < STAGE_END[st]) ?? "rooms");

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
  const sheets = new Map<string, SheetRow[]>();
  if ((opts.seedSheets ?? true) && projects.has("p-noah")) {
    const seed = seedNoah("2026-10-11T11:40:00.000Z");
    sheetSets.set("p-noah", seed.sets);
    sheets.set("p-noah", seed.rows);
  }
  const understanding = createUnderstandingMock();
  if ((opts.understandingFixture ?? true) && sheets.has("p-noah")) {
    understanding.seedFixture(sheets.get("p-noah")!, opts.fixtureDetections ? { electricalDetections: opts.fixtureDetections } : {});
  }
  const useDevIndex = opts.devIndex ?? (typeof window !== "undefined" && import.meta.env.MODE !== "test");
  if (useDevIndex && sheets.has("p-noah")) {
    // Real worker artifacts (dev only): merge understanding paths (+ sheets missing from the seeds) and re-emit.
    void fetch(`${DEV_ARTIFACTS_BASE}/dev-index.json`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<DevIndexEntry[]>) : []))
      .then((index) => {
        const rows = sheets.get("p-noah")!;
        const paths = (e: DevIndexEntry) => ({
          legend: e.legend ?? e.artifacts?.legend,
          detections: e.detections ?? e.artifacts?.detections,
          rooms: e.rooms ?? e.artifacts?.rooms,
        });
        const real = index.filter((e) => paths(e).detections || paths(e).legend);
        if (real.length === 0) return;
        understanding.dropFixtures(rows);
        for (const e of real) {
          let row = rows.find((r) => r.sheet.id === e.sheetId);
          if (!row) {
            const made = rowFromDevIndex(e, "2026-10-11T11:40:00.000Z");
            if (!made) continue;
            rows.push(made.row);
            sheetSets.get("p-noah")?.push(made.set);
            row = made.row;
          }
          const p = paths(e);
          if (row.version) {
            row.version.artifacts = { ...row.version.artifacts, ...p };
            if (e.stats) row.version.stats = { ...row.version.stats, ...e.stats };
          }
          understanding.useReal(row, p);
        }
        emit();
      })
      .catch(() => {
        /* no dev server / no index → keep the fixture */
      })
      .finally(() => boq.startDevPolling());
  }
  const boq = createBoqMock({
    rows: (projectId) => sheets.get(projectId) ?? [],
    detections: (row) => understanding.detections(row),
    emit: () => emit(),
    role: () => orgs[0]?.role ?? "viewer",
    tickMs: opts.boqTickMs ?? jobTick,
    blockExportOnRed: opts.blockExportOnRed ?? false,
    devBase: useDevIndex ? DEV_ARTIFACTS_BASE : null,
    engineOnly: opts.boqEngineOnly ?? false,
  });
  if (opts.boqPrebuilt && sheets.has("p-noah")) queueMicrotask(() => boq.buildBoq("p-noah"));
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

  /**
   * Simulated drawing worker (brief: one file = one sheetSet; page i → sheet `${setId}-p${i}` with a
   * version whose status/progress.stage/pct is pushed live like Firestore would).
   * Demo affordances: a filename containing "encrypted" fails the whole set at ingest; "broken" fails page 2.
   */
  function runJob(job: Job, set: SheetSet, rows: SheetRow[], filename: string) {
    let step = 0;
    const total = 18;
    const lag = 2; // pages start staggered, like a worker processing them in order
    const failSet = /encrypted/i.test(filename);
    const failPage = /broken/i.test(filename) ? 1 : -1;
    const timer = setInterval(() => {
      step += 1;
      const now = new Date().toISOString();
      set.status = "splitting";
      if (failSet && step >= 2) {
        clearInterval(timer);
        const error = { code: "pdf_encrypted", message: "PDF is encrypted" };
        Object.assign(job, { status: "failed", stage: "ingest", error, updatedAt: now });
        set.status = "failed";
        for (const r of rows) if (r.version) Object.assign(r.version, { status: "failed", error, progress: { stage: "ingest", pct: 5 }, updatedAt: now });
        emit();
        return;
      }
      let sum = 0;
      let allDone = true;
      rows.forEach((r, i) => {
        const v = r.version;
        if (!v || v.status === "ready" || v.status === "failed") {
          sum += 100;
          return;
        }
        const pct = Math.max(0, Math.min(100, Math.round(((step - i * lag) / total) * 100)));
        if (pct === 0) {
          allDone = false;
          return;
        }
        const stage = stageAt(pct);
        if (i === failPage && stage === "ocr") {
          Object.assign(v, { status: "failed", progress: { stage, pct }, error: { code: "render_failed", message: "render failed" }, updatedAt: now });
          sum += 100;
          return;
        }
        Object.assign(v, { status: pct >= 100 ? "ready" : "processing", progress: { stage, pct }, updatedAt: now });
        if (pct >= 100) {
          const c = guessClassification(`${filename} ${rows.length > 1 ? `p${i + 1}` : ""}`);
          const tiles = sampleTiles(SAMPLE_FOR_UPLOAD, false);
          Object.assign(r.sheet, {
            title: c.sheetTitle,
            discipline: c.discipline,
            floors: c.floors,
            scaleDenominator: 50,
            classification: c,
            confirmed: false,
            updatedAt: now,
          });
          Object.assign(v, {
            page: pageOf(tiles),
            artifacts: { tiles, thumbnail: tiles.prefix.replace(/\/tiles$/, "/thumbnail.webp") },
            regions: [],
            stats: { paths: 40000, segments: 170000, textLines: 0, glyphs: 2100 },
            workerVersion: "mock",
          });
        } else allDone = false;
        sum += pct;
      });
      const pct = Math.round(sum / Math.max(1, rows.length));
      const slowest = rows.map((r) => r.version?.progress?.stage).find((st) => st && st !== "done") ?? "done";
      Object.assign(job, { status: "running", progress: Math.min(99, pct), stage: slowest === "done" ? "rooms" : slowest, updatedAt: now });
      if (allDone) {
        clearInterval(timer);
        const ok = rows.some((r) => r.version?.status === "ready");
        Object.assign(job, { status: ok ? "succeeded" : "failed", progress: 100 });
        set.status = ok ? "ready" : "failed";
        const p = projects.get(set.projectId);
        if (p?.stats) p.stats.sheets += rows.filter((r) => r.version?.status === "ready").length;
        if (ok) boq.markStale(set.projectId);
      }
      emit();
    }, jobTick);
  }

  const findRow = (projectId: string, sheetId: string) => {
    const row = (sheets.get(projectId) ?? []).find((r) => r.sheet.id === sheetId);
    if (!row) throw new ApiError(404, "not_found", "Sheet not found");
    return row;
  };

  return {
    emit,
    api: {
      getMe: () =>
        delay({
          uid: "mock-user",
          mfa: false,
          orgs: orgs.map((o) => ({ ...o, settings: { blockExportOnRed: opts.blockExportOnRed ?? false } })),
        }),
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
        // Mock "split": a PDF becomes 2 sheets (pages), other kinds 1.
        const pages = t.kind === "pdf" ? 2 : 1;
        const rows: SheetRow[] = Array.from({ length: pages }, (_, i) => {
          const sheet: Sheet = { id: `${set.id}-p${i}`, sheetSetId: set.id, pageIndex: i, currentVersionId: "v1", confirmed: false };
          const version: SheetVersion = {
            id: "v1",
            sheetId: sheet.id,
            versionNo: 1,
            status: "queued",
            createdAt: now,
            progress: { stage: "ingest", pct: 0 },
          };
          return { sheet, version };
        });
        const { sheet, version } = rows[0]!;
        const job: Job = {
          id: nextId("j"),
          orgId: p.orgId,
          projectId,
          sheetSetId: set.id,
          versionId: version!.id,
          type: "ingest.sheet_version",
          status: "queued",
          progress: 0,
          createdAt: now,
        };
        sheetSets.set(projectId, [set, ...(sheetSets.get(projectId) ?? [])]);
        sheets.set(projectId, [...(sheets.get(projectId) ?? []), ...rows]);
        jobs.unshift(job);
        emit();
        runJob(job, set, rows, t.filename);
        return delay({ sheetSet: { ...set }, sheet: { ...sheet }, sheetVersion: { ...version! }, deduplicated: false, jobId: job.id });
      },
      confirmSheet: async (projectId, sheetId, req) => {
        mustGet(projectId);
        const { sheet, version } = findRow(projectId, sheetId);
        const sd = req.scaleDenominator;
        if (!req.discipline || (sd !== null && !(Number.isInteger(sd) && sd >= 1 && sd <= 10_000))) {
          throw new ApiError(400, "validation_failed", "invalid confirm body");
        }
        if (req.regions) {
          validateRegions(req.regions);
          if (version) version.regions = structuredClone(req.regions);
        }
        Object.assign(sheet, {
          discipline: req.discipline,
          floors: [...req.floors],
          scaleDenominator: sd,
          confirmed: true,
          confirmedBy: "mock-user",
          confirmedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        boq.markStale(projectId);
        return delay(structuredClone(sheet));
      },
      saveSheetRegions: async (projectId, sheetId, regions) => {
        mustGet(projectId);
        const { version } = findRow(projectId, sheetId);
        if (!version) throw new ApiError(409, "version_not_ready", "No current version");
        validateRegions(regions);
        version.regions = structuredClone(regions);
        boq.markStale(projectId);
        return delay({ sheetId, versionId: version.id, regions: structuredClone(regions) });
      },
      getTilesManifest: async (projectId, sheetId, versionId, q) => {
        mustGet(projectId);
        const { version } = findRow(projectId, sheetId);
        const tiles = version?.id === versionId ? version.artifacts?.tiles : undefined;
        if (!tiles || !version) throw new ApiError(409, "tiles_not_ready", "Tiles are not ready");
        const { prefix, ...meta } = tiles;
        const base = `${DEV_ARTIFACTS_BASE}/${prefix}`;
        const levelGrid = Array.from({ length: tiles.levels }, (_, z) => {
          const down = 2 ** (tiles.levels - 1 - z);
          const widthPx = Math.ceil(tiles.widthPx / down);
          const heightPx = Math.ceil(tiles.heightPx / down);
          return { z, widthPx, heightPx, cols: Math.ceil(widthPx / tiles.tileSize), rows: Math.ceil(heightPx / tiles.tileSize), mmPerPx: (25.4 / tiles.dpi) * down };
        });
        const urls: Record<string, string> = {};
        if (q) {
          const g = levelGrid[q.z];
          if (!g) throw new ApiError(400, "validation_failed", "z out of range");
          const x1 = Math.min(q.x1, g.cols - 1);
          const y1 = Math.min(q.y1, g.rows - 1);
          if ((x1 - q.x0 + 1) * (y1 - q.y0 + 1) > MAX_TILE_BATCH) throw new ApiError(400, "too_many_tiles", "window too large");
          for (let y = q.y0; y <= y1; y++) for (let x = q.x0; x <= x1; x++) urls[`${q.z}/${x}_${y}`] = `${base}/${q.z}/${x}_${y}.webp`;
        }
        return delay({
          sheetId,
          versionId,
          page: version.page ?? null,
          tiles: meta,
          levelGrid,
          thumbnailUrl: `${base.replace(/\/tiles$/, "")}/thumbnail.webp`,
          urls,
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          maxBatch: MAX_TILE_BATCH,
        });
      },
      getOverlay: async (projectId, sheetId, versionId) => {
        mustGet(projectId);
        const row = findRow(projectId, sheetId);
        if (row.version?.id !== versionId || row.version.status !== "ready") throw new ApiError(409, "version_not_ready", "Version is not ready");
        const manifest = await understanding.getOverlay(row);
        const links = boq.linksUrl(row);
        return delay({ ...manifest, links: links ? { url: links } : null });
      },
      listLegendEntries: async (projectId, q = {}) => {
        mustGet(projectId);
        const items = await understanding.listLegendEntries(sheets.get(projectId) ?? [], q);
        return delay({ items, nextCursor: null, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      },
      patchLegendEntry: async (projectId, entryId, req) => {
        mustGet(projectId);
        const res = await understanding.patchLegendEntry(entryId, req);
        boq.markStale(projectId);
        const { thumbUrl: _t, ...entry } = res.entry;
        return delay({ entry, mapping: res.mapping });
      },
      resolveUnknownCluster: async (projectId, clusterId, req) => {
        mustGet(projectId);
        const res = await understanding.resolveUnknownCluster(sheets.get(projectId) ?? [], clusterId, req);
        boq.markStale(projectId);
        return delay(res);
      },

      /* ---------- Sprint 3: BOQ ---------- */
      buildBoq: async (projectId) => {
        mustGet(projectId);
        return delay(boq.buildBoq(projectId));
      },
      getBoqBuild: async (projectId, buildId) => delay(boq.getBuild(projectId, buildId)),
      listBoqLines: async (projectId) => {
        mustGet(projectId);
        return delay(boq.listLines(projectId));
      },
      patchBoqLine: async (projectId, lineId, req) => delay(boq.patchLine(projectId, lineId, req, "mock-user")),
      getBoqLineEvidence: async (projectId, lineId) => delay(boq.evidence(projectId, lineId)),
      getBoqSheetEvidence: async (projectId, sheetId, versionId) => delay(boq.sheetEvidence(projectId, sheetId, versionId)),
      exportBoq: async (projectId, req) => delay(boq.exportBoq(projectId, req)),
      listLibraryItems: async (_orgId, q = {}) => delay(boq.listItems(q)),
      patchLibraryItem: async (_orgId, itemId, req) => delay(boq.patchItem(itemId, req)),
      createLibraryImport: async (orgId, req) => {
        if (req.sizeBytes > 20 * 1024 * 1024) throw new ApiError(413, "file_too_large", "max 20MB");
        return delay(boq.createImport(orgId, req.filename));
      },
      startLibraryImport: async (_orgId, importId, uploadToken) => delay(boq.startImport(importId, uploadToken)),
      getLibraryImport: async (_orgId, importId) => delay(boq.getImport(importId)),
      listBoqTemplates: async () => delay(boq.templates()),
      setDefaultBoqTemplate: async (_orgId, templateId) => delay(boq.setDefault(templateId)),
      listBoqRules: async () => delay(boq.rules()),
      patchBoqRule: async (_orgId, ruleId, req) => delay(boq.patchRule(ruleId, req.enabled, [...projects.keys()])),
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
      boqState: (_orgId, projectId, onData) => listen(() => onData(boq.state(projectId))),
      boqBuild: (_orgId, projectId, buildId, onData) => listen(() => onData(boq.build(projectId, buildId))),
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
