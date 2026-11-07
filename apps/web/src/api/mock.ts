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
  type OrgMember,
  type Role,
  MAX_SHEETS_PER_PROJECT,
  VAT_RATE_DEFAULT,
} from "./types";
import {
  PRICE_ADJUSTMENT_MAX_PCT,
  PRICE_ADJUSTMENT_MIN_PCT,
  PROJECT_DELETE_MISMATCH_HE,
  SHEET_LIMIT_ERROR,
  SHEET_SET_DELETE_BUSY_HE,
  SHEET_SET_DELETE_BUSY_MS,
  deleteConfirmationMatches,
  sheetLimitMessageHe,
} from "@kamutan/contracts";
import { DEV_ARTIFACTS_BASE, SAMPLE_FOR_UPLOAD, guessClassification, pageOf, rowFromDevIndex, sampleTiles, seedNoah, type DevIndexEntry } from "./mockSheets";
import { createUnderstandingMock } from "./mockUnderstanding";
import { createBoqMock } from "./mockBoq";
import { createReviewMock } from "./mockReview";
import { createSprint5Mock, MOCK_ACTOR } from "./mockSprint5";
import { buildBoqDocument } from "./mockSprint7";
import { baseCorrection } from "@/features/corrections/model";
import { getAuthService, hasRecentLogin } from "@/features/auth/authService";

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
  /** Sprint 4: delay of the mock find-similar job (ms). Default 600 (0 in tests → done at once). */
  similarMs?: number;
  /** Sprint 5: seed the demo share links on p-noah (default true). */
  seedShareLinks?: boolean;
  /** Sprint 5 (tests): start with a broken audit hash chain. */
  auditBroken?: boolean;
  /** Security gate F-3 (tests): title-block detection per sheet (default: mock rule). */
  titleBlockDetected?: (sheetId: string) => boolean;
  /** Stage 10 (A-LIVE-01): the org's item library — imported (default) / shipped default / none (`?mockLibrary=`). */
  libraryMode?: "imported" | "default" | "none";
  /** Stage 10: seed members of the demo org (default: the signed-in admin + 3 others + 1 pending invitation). */
  members?: OrgMember[];
  /** Sprint 7: per-project storage quota of the demo org (default 2 GB; `?mockQuotaMb=` in dev / e2e). */
  projectQuotaBytes?: number;
  /** Sprint 8: max sheets per project (default 100 = MAX_SHEETS_PER_PROJECT; `?mockSheetLimit=` in dev / e2e). */
  sheetLimit?: number;
  /** Sprint 8: seed the org price list (default true). */
  seedPrices?: boolean;
}

/** Stage 10 demo members of org-demo (A-API-01). The signed-in user is added as admin on first read. */
export const demoMembers = (): OrgMember[] => [
  { id: "uid-lea", uid: "uid-lea", email: "lea@example.com", displayName: "לאה לוי", role: "editor", status: "active", addedBy: "mock-user", createdAt: "2026-10-11T08:05:00.000Z" },
  { id: "uid-yossi", uid: "uid-yossi", email: "yossi@example.com", displayName: "יוסי מזרחי", role: "reviewer", status: "active", addedBy: "mock-user", createdAt: "2026-10-12T09:30:00.000Z" },
  { id: "uid-client", uid: "uid-client", email: "client@example.com", displayName: null, role: "viewer", status: "active", addedBy: "uid-lea", createdAt: "2026-10-20T14:10:00.000Z" },
  { id: "inv-1", uid: null, email: "new.estimator@example.com", displayName: null, role: "editor", status: "pending", addedBy: "mock-user", createdAt: "2026-10-30T10:00:00.000Z", expiresAt: "2026-11-13T10:00:00.000Z" },
];
const ROLES: readonly Role[] = ["admin", "editor", "reviewer", "viewer"];

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
    // Sprint 7: the 15 Noah PDFs + their tiles / artifacts (mock figure).
    storageBytes: 48_600_000,
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
    storageBytes: 0,
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
  /** A-UI-12: the signed-in user acts (history / audit "who"); no session (backend unit tests) → the demo actor. */
  const actor = () => {
    const ses = getAuthService().getSession();
    return ses ? { uid: ses.uid, displayName: ses.displayName ?? ses.email ?? null } : MOCK_ACTOR;
  };
  /** Stage 10 (A-API-02): admin settings / templates / rules / members need a sign-in from the last 10 minutes (+MFA). */
  const requireRecentAuth = async () => {
    const a = getAuthService();
    if (a.getSession() && !(await hasRecentLogin(a))) throw new ApiError(403, "recent_auth_required", "sign in again (within the last 10 minutes) to do this");
  };
  const requireAdmin = () => {
    if ((orgs[0]?.role ?? "viewer") !== "admin") throw new ApiError(403, "forbidden", "admins only");
  };
  const members = new Map<string, OrgMember>((opts.members ?? demoMembers()).map((m) => [m.id, structuredClone(m)]));
  const memberList = (): OrgMember[] => {
    const me = actor();
    if (!members.has(me.uid) && ![...members.values()].some((m) => m.uid === me.uid)) {
      const ses = getAuthService().getSession();
      members.set(me.uid, { id: me.uid, uid: me.uid, email: ses?.email ?? null, displayName: me.displayName, role: orgs[0]?.role ?? "admin", status: "active", addedBy: null, createdAt: "2026-10-11T08:00:00.000Z" });
    }
    return [...members.values()].sort((a, b) => Number(a.status === "pending") - Number(b.status === "pending") || a.createdAt.localeCompare(b.createdAt));
  };
  const activeAdmins = () => memberList().filter((m) => m.status === "active" && m.role === "admin");

  const boq = createBoqMock({
    libraryMode: opts.libraryMode ?? "imported",
    ...(opts.seedPrices === false ? { seedPrices: false } : {}),
    actorUid: () => actor().uid,
    // Sprint 8: "history in audit" — every price change of the org price list is one event.
    // API (boq-docs planLibraryItemPatch): `itemLibrary/update {fields, active, code, price {from, to, source}, batchId?}`
    onLibraryPrice: (item, before, after, batchId) =>
      s5.appendAudit(
        {
          action: "update",
          entity: "itemLibrary",
          entityId: item.id,
          projectId: null,
          after: { fields: ["price"], active: null, code: item.code, price: { from: before?.amount ?? null, to: after?.amount ?? null, source: after?.source ?? "manual" }, ...(batchId ? { batchId } : {}), ...(after?.importId ? { importId: after.importId } : {}) },
        },
        orgs[0]?.id ?? DEMO_ORG_ID,
      ),
    onApprovalInvalidated: (projectId, line, from, to) => {
      s5.appendAudit({ actor: null, actorKind: "system", action: "approval_invalidated", entity: "boqLines", entityId: line.id, projectId, before: { status: "approved", qty: from }, after: { status: "reviewed", qty: to }, meta: { kind: "status", reason: line.reasons?.[0] ?? null } }, projects.get(projectId)?.orgId ?? DEMO_ORG_ID);
    },
    rows: (projectId) => sheets.get(projectId) ?? [],
    detections: (row) => understanding.detections(row),
    emit: () => emit(),
    role: () => orgs[0]?.role ?? "viewer",
    tickMs: opts.boqTickMs ?? jobTick,
    blockExportOnRed: () => s5.blockExportOnRed(orgs[0]?.id ?? DEMO_ORG_ID),
    devBase: useDevIndex ? DEV_ARTIFACTS_BASE : null,
    engineOnly: opts.boqEngineOnly ?? false,
    rooms: async (row) => (await understanding.artifacts(row)).rooms,
    corrections: (projectId) => review.active(projectId),
    roomSettings: (projectId) => review.roomSettingsMap(projectId),
  });
  const review = createReviewMock({
    rows: (projectId) => sheets.get(projectId) ?? [],
    understanding,
    boq: () => boq,
    emit: () => emit(),
    similarMs: opts.similarMs ?? (latency > 0 ? 600 : 0),
    actorUid: () => actor().uid,
  });
  const s5 = createSprint5Mock({
    projects: () => projects,
    rows: (projectId) => sheets.get(projectId) ?? [],
    boq: {
      listLines: (projectId) => boq.listLines(projectId),
      state: (projectId) => boq.state(projectId),
      evidence: (projectId, lineId) => boq.evidence(projectId, lineId),
      sheetEvidence: (projectId, sheetId, versionId) => boq.sheetEvidence(projectId, sheetId, versionId),
      links: (projectId, sheetId) => boq.links(projectId, sheetId),
    },
    artifacts: (row) => understanding.artifacts(row),
    corrections: (projectId) => review.active(projectId),
    orgs: () => orgs,
    role: () => orgs[0]?.role ?? "viewer",
    emit: () => emit(),
    tickMs: opts.boqTickMs ?? jobTick,
    devBase: DEV_ARTIFACTS_BASE,
    seedLinks: opts.seedShareLinks ?? true,
    auditBroken: opts.auditBroken ?? false,
    ...(opts.titleBlockDetected ? { titleBlockDetected: opts.titleBlockDetected } : {}),
    // F-7: the mock checks the signed-in user's auth_time like the API (MFA is not modelled).
    // (No signed-in user = backend unit tests: not modelled.)
    recentAuth: async () => {
      const a = getAuthService();
      return a.getSession() ? hasRecentLogin(a) : true;
    },
    actor,
  });
  if (opts.blockExportOnRed) s5.setBlockExportOnRed(orgs[0]?.id ?? DEMO_ORG_ID, true);
  if (opts.projectQuotaBytes) s5.setProjectQuota(orgs[0]?.id ?? DEMO_ORG_ID, opts.projectQuotaBytes);
  if (opts.boqPrebuilt && sheets.has("p-noah")) queueMicrotask(() => boq.buildBoq("p-noah"));
  // Sprint 8: bytes per sheet set (released by a delete). The seeded Noah sets share the project's mock figure.
  const setBytes = new Map<string, number>();
  /** Bytes of a set: counted on finalize; sets that came from the dev index share the project's figure evenly. */
  const bytesOf = (projectId: string, setId: string): number => {
    const known = setBytes.get(setId);
    if (known !== undefined) return known;
    const list = sheetSets.get(projectId) ?? [];
    const counted = list.reduce((s, x) => s + (setBytes.get(x.id) ?? 0), 0);
    const unknown = list.filter((x) => !setBytes.has(x.id)).length;
    return Math.max(0, Math.round(((projects.get(projectId)?.storageBytes ?? 0) - counted) / Math.max(1, unknown)));
  };
  const sheetLimit = opts.sheetLimit ?? MAX_SHEETS_PER_PROJECT;
  const jobs: Job[] = [];
  const tokens = new Map<string, { projectId: string; filename: string; kind: SheetSet["fileKind"]; uploaded: boolean; sizeBytes: number }>();
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
    // Sprint 7 (error mapping only): "eicar" / "infected" in the name → the job fails with `file_infected`.
    const infected = /eicar|infected/i.test(filename);
    const failPage = /broken/i.test(filename) ? 1 : -1;
    const timer = setInterval(() => {
      step += 1;
      const now = new Date().toISOString();
      set.status = "splitting";
      if (infected && step >= 1) {
        clearInterval(timer);
        const error = { code: "file_infected", message: "הקובץ נחסם: זוהה תוכן זדוני" };
        Object.assign(job, { status: "failed", stage: "ingest", error, updatedAt: now });
        set.status = "failed";
        for (const r of rows) if (r.version) Object.assign(r.version, { status: "failed", error, progress: { stage: "ingest", pct: 0 }, updatedAt: now });
        emit();
        return;
      }
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

  /**
   * A-UI-11 / A-LIVE-02 (mock side): once a BOQ is built, the project card's counts come from the same lines as the
   * hub (the API writes them on the project doc after each build).
   */
  const withLiveStats = (p0: Project): Project => {
    // Sprint 8: sheet count + the per-project limit on every project read
    const p: Project = { ...p0, sheetCount: (sheets.get(p0.id) ?? []).length, sheetLimit };
    if (!boq.state(p.id)?.latestBuildId) return p;
    const lines = boq.listLines(p.id).items;
    if (!lines.length) return p;
    const by = (lv: string) => lines.filter((l) => l.level === lv).length;
    const ready = (sheets.get(p.id) ?? []).filter((r) => r.version?.status === "ready").length;
    return { ...p, stats: { sheets: Math.max(p.stats?.sheets ?? 0, ready), boqLines: lines.length, green: by("green"), yellow: by("yellow"), red: by("red"), reviewOpen: lines.filter((l) => l.status !== "approved" && l.level !== "green").length } };
  };

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
          orgs: orgs.map((o) => ({ ...o, ...s5.orgPatch(o.id) })),
        }),
      listProjects: (orgId) =>
        delay(
          [...projects.values()]
            .filter((p) => p.orgId === orgId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((p) => withLiveStats(structuredClone(p))),
        ),
      getProject: async (id) => delay(withLiveStats(structuredClone(mustGet(id)))),
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
      updateProject: async (id, patch) => {
        const p = mustGet(id);
        if (patch.name !== undefined) {
          const name = patch.name.trim();
          if (!name) throw new ApiError(400, "validation_failed", "name is required");
          p.name = name;
        }
        if (patch.address !== undefined) {
          const address = patch.address.trim();
          if (address) p.address = address;
          else delete p.address;
        }
        if (patch.status !== undefined) p.status = patch.status;
        return delay(withLiveStats(structuredClone(p)));
      },
      createUpload: async (projectId, req) => {
        const p = mustGet(projectId);
        const ext = req.filename.split(".").pop()?.toLowerCase();
        if (!ext || !["pdf", "dwg", "dxf", "png"].includes(ext)) {
          throw new ApiError(415, "unsupported_file_type", "unsupported");
        }
        // Sprint 7: per-project storage quota (org setting, default 2 GB) → 413 with a Hebrew message.
        const quota = s5.projectQuota(p.orgId);
        if ((p.storageBytes ?? 0) + req.sizeBytes > quota) {
          throw new ApiError(413, "quota_exceeded", "אין מספיק מקום בפרויקט: הקובץ חורג ממכסת האחסון של הפרויקט.");
        }
        const fileId = nextId("f");
        const uploadToken = `mock-token-${fileId}-xxxxxxxx`;
        const kind = ext as SheetSet["fileKind"];
        tokens.set(uploadToken, { projectId, filename: req.filename, kind, uploaded: false, sizeBytes: req.sizeBytes });
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
        // Stage 10 (A-API-05): a revision replaces an existing set of this project.
        const replaced = req.replacesSheetSetId ? (sheetSets.get(projectId) ?? []).find((x) => x.id === req.replacesSheetSetId) : null;
        if (req.replacesSheetSetId && !replaced) throw new ApiError(404, "not_found", "Sheet set to replace not found");
        if (replaced?.supersededBySetId) throw new ApiError(409, "already_superseded", "this set was already replaced");
        // Sprint 8: at most 100 sheets per project (a replacement frees its old set's sheets first).
        const pagesOf = t.kind === "pdf" ? 2 : 1;
        const freed = replaced ? (sheets.get(projectId) ?? []).filter((r) => r.sheet.sheetSetId === replaced.id).length : 0;
        if ((sheets.get(projectId) ?? []).length - freed + pagesOf > sheetLimit)
          throw new ApiError(409, SHEET_LIMIT_ERROR, sheetLimitMessageHe((sheets.get(projectId) ?? []).length - freed, sheetLimit));
        tokens.delete(req.uploadToken);
        // Sprint 7: storage accounting on finalize (a refused `file_infected` file is not counted, see runJob).
        const counted = !/eicar|infected/i.test(t.filename);
        if (counted) p.storageBytes = (p.storageBytes ?? 0) + t.sizeBytes;
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
          uploadedBy: actor().uid,
          createdAt: now,
          ...(replaced ? { replacesSheetSetId: replaced.id } : {}),
        };
        if (replaced) {
          // The old set's sheets become superseded (the new sheets carry the current versions); the BOQ uses only these.
          replaced.supersededBySetId = set.id;
          replaced.supersededAt = now;
          replaced.status = "superseded";
          sheets.set(projectId, (sheets.get(projectId) ?? []).filter((r) => r.sheet.sheetSetId !== replaced.id));
          for (const j of jobs) if (j.sheetSetId === replaced.id && j.status === "failed") j.status = "cancelled";
          s5.appendAudit({ action: "supersede", entity: "sheetSets", entityId: replaced.id, projectId, after: { supersededBySetId: set.id } }, p.orgId);
          boq.markStale(projectId);
        }
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
        if (counted) setBytes.set(set.id, t.sizeBytes);
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
        const p = mustGet(projectId);
        // Sprint 8 (contracts BoqSummary.totals): over ALL lines, project discount, org VAT
        const res = boq.listLines(projectId);
        return delay(res.boq ? { ...res, totals: boq.totals(projectId, s5.orgPatch(p.orgId).settings.vatRate ?? VAT_RATE_DEFAULT, p.pricing?.adjustmentPct ?? null) } : res);
      },
      patchBoqLine: async (projectId, lineId, req) => {
        s5.assertProjectActive(projectId);
        // Sprint 7: "עדכן גם בספריית הסעיפים" follows the library-edit rules (recent sign-in, like templates / rules);
        // refused as a whole, so a retry after re-authentication is safe.
        if (req.alsoUpdateLibrary) await requireRecentAuth();
        const before = boq.listLines(projectId).items.find((l) => l.id === lineId);
        const after = boq.patchLine(projectId, lineId, req, actor().uid);
        if (before) s5.recordLinePatch(projectId, before, after, req);
        return delay(after);
      },
      getBoqLineEvidence: async (projectId, lineId) => delay(boq.evidence(projectId, lineId)),
      batchBoqLineStatus: async (projectId, req) => {
        s5.assertProjectActive(projectId);
        if ((orgs[0]?.role ?? "viewer") === "viewer") throw new ApiError(403, "forbidden", "viewers cannot change statuses");
        const before = new Map(boq.listLines(projectId).items.map((l) => [l.id, l]));
        const res = boq.batchStatus(projectId, req, actor().uid);
        for (const l of res.updated) {
          const b = before.get(l.id);
          if (b) s5.recordLinePatch(projectId, b, l, { status: req.to });
        }
        return delay(res);
      },
      // Sprint 6 (mirrors the API brief): a measure / count is stored as a correction bound to the line's item code,
      // a confirm as the confirmed quantity; then the BOQ is re-derived and the line returned.
      quickMeasureBoqLine: async (projectId, lineId, req) => {
        s5.assertProjectActive(projectId);
        if ((orgs[0]?.role ?? "viewer") === "viewer") throw new ApiError(403, "forbidden", "viewers cannot change quantities");
        const line = boq.listLines(projectId).items.find((l) => l.id === lineId);
        if (!line) throw new ApiError(404, "not_found", "Line not found");
        if (!Number.isFinite(req.quantity) || req.quantity <= 0) throw new ApiError(400, "validation_failed", "quantity must be > 0");
        let correction = null;
        if (req.kind === "confirm") await boq.confirmLine(projectId, lineId, req.quantity);
        else {
          if (!req.sheetId || !req.geometry?.mm.length) throw new ApiError(400, "validation_failed", "sheetId + geometry required");
          const row = (sheets.get(projectId) ?? []).find((r) => r.sheet.id === req.sheetId);
          const c = baseCorrection(
            req.kind === "count" ? "count" : "measure",
            { sheetId: req.sheetId, versionId: req.versionId ?? row?.version?.id ?? "v1", anchorMm: req.geometry.mm[0]! },
            { itemCode: line.code, quantity: req.quantity, unit: req.unit, geometry: req.geometry, floor: req.floor, reason: "quick_measure" },
          );
          const { id: _id, batchId: _b, ...body } = c;
          correction = await review.create(projectId, body);
          s5.recordCorrection(projectId, body);
        }
        const after = boq.listLines(projectId).items.find((l) => l.id === lineId) ?? line;
        if (after.qty !== line.qty) s5.recordLinePatch(projectId, line, after, { note: "quick_measure" });
        return delay({ line: after, correction });
      },
      getBoqSheetEvidence: async (projectId, sheetId, versionId) => delay(boq.sheetEvidence(projectId, sheetId, versionId)),
      exportBoq: async (projectId, req) => delay(boq.exportBoq(projectId, req)),
      // Sprint 7: the export model (same layout as the Excel) for the preview.
      getBoqDocument: async (projectId, q) => {
        const p = mustGet(projectId);
        const res = boq.listLines(projectId);
        if (!res.boq?.latestBuildId) throw new ApiError(409, "boq_not_built", "Build the BOQ first");
        const tpl = boq.templates().find((x) => x.default) ?? boq.templates()[0]!;
        const settings = s5.orgPatch(p.orgId).settings;
        return delay(
          buildBoqDocument({
            projectName: p.name,
            address: p.address ?? null,
            orgName: orgs.find((o) => o.id === p.orgId)?.name ?? null,
            template: tpl,
            lines: res.items,
            q,
            vatRate: settings.vatRate ?? 0.18,
            blockOnRed: settings.blockExportOnRed,
            adjustmentPct: p.pricing?.adjustmentPct ?? null,
          }),
        );
      },
      listLibraryItems: async (_orgId, q = {}) => delay(boq.listItems(q)),
      patchLibraryItem: async (_orgId, itemId, req) => delay(boq.patchItem(itemId, req)),
      createLibraryImport: async (orgId, req) => {
        if (req.sizeBytes > 20 * 1024 * 1024) throw new ApiError(413, "file_too_large", "max 20MB");
        return delay(boq.createImport(orgId, req.filename, req.mode ?? "library", req.overwriteManualPrices ?? false, req.dryRun ?? false));
      },
      startLibraryImport: async (_orgId, importId, uploadToken) => delay(boq.startImport(importId, uploadToken)),
      getLibraryImport: async (_orgId, importId) => delay(boq.getImport(importId)),
      listBoqTemplates: async () => delay(boq.templates()),
      setDefaultBoqTemplate: async (_orgId, templateId) => {
        await requireRecentAuth();
        return delay(boq.setDefault(templateId));
      },
      listBoqRules: async () => delay(boq.rules()),
      patchBoqRule: async (_orgId, ruleId, req) => {
        await requireRecentAuth();
        return delay(boq.patchRule(ruleId, req.enabled, [...projects.keys()]));
      },

      /* ---------- Sprint 4: corrections, queue, room settings, find-similar ---------- */
      listCorrections: async (projectId, q = {}) => delay(await review.listCorrections(projectId, q.sheetId)),
      createCorrection: async (projectId, req) => {
        mustGet(projectId);
        const c = await review.create(projectId, req);
        s5.recordCorrection(projectId, req);
        return delay(c);
      },
      createCorrectionsBatch: async (projectId, req) => {
        mustGet(projectId);
        return delay(await review.createBatch(projectId, req));
      },
      revertCorrection: async (projectId, id) => delay(await review.revert(projectId, id)),
      revertCorrectionsBatch: async (projectId, batchId) => delay(await review.revertBatch(projectId, batchId)),
      getReviewQueue: async (projectId, filter) => {
        mustGet(projectId);
        return delay(await review.reviewQueue(projectId, filter));
      },
      getRoomSettings: async (projectId, sheetId, roomId) => delay(await review.getRoomSettings(projectId, sheetId, roomId)),
      putRoomSettings: async (projectId, sheetId, roomId, req) => delay(await review.putRoomSettings(projectId, sheetId, roomId, req)),
      findSimilar: async (projectId, req) => delay(await review.findSimilar(projectId, req)),
      getSimilarSearch: async (projectId, id) => delay(await review.getSimilar(projectId, id)),

      /* ---------- Sprint 5 ---------- */
      getLineHistory: async (projectId, lineId) => delay(s5.lineHistory(projectId, lineId)),
      listAudit: async (orgId, q) => delay(s5.listAudit(orgId, q)),
      verifyAudit: async (orgId) => delay(s5.verifyAudit(orgId)),
      exportMarkedPdf: async (projectId, req) => {
        mustGet(projectId);
        return delay(s5.exportMarkedPdf(projectId, req));
      },
      getExport: async (projectId, exportId) => delay(s5.getExport(projectId, exportId)),
      createShareLink: async (projectId, req) => {
        mustGet(projectId);
        return delay(s5.createShareLink(projectId, req, typeof location !== "undefined" ? location.origin : "https://kamutan.app"));
      },
      listShareLinks: async (projectId) => delay(s5.listShareLinks(projectId)),
      revokeShareLink: async (projectId, linkId) => delay(s5.revokeShareLink(projectId, linkId)),
      patchOrgSettings: async (orgId, req) => {
        await requireRecentAuth();
        return delay(s5.patchOrgSettings(orgId, req));
      },
      startOffboardingExport: async (orgId) => delay(s5.startOffboardingExport(orgId)),
      getOffboardingExport: async (orgId, id) => delay(await s5.getOffboardingExport(orgId, id)),
      offboardOrg: async (orgId, req) => delay(s5.offboardOrg(orgId, req.confirm)),

      /* ---------- Stage 10: members (A-API-01) ---------- */
      listMembers: async () => {
        requireAdmin();
        return delay({ members: memberList().map((m) => ({ ...m })) });
      },
      inviteMember: async (orgId, req) => {
        requireAdmin();
        await requireRecentAuth();
        const email = req.email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "validation_failed", "invalid email");
        if (!ROLES.includes(req.role)) throw new ApiError(400, "validation_failed", "invalid role");
        if (memberList().some((m) => m.email?.toLowerCase() === email)) throw new ApiError(409, "already_member", "already a member or invited");
        const m: OrgMember = { id: nextId("inv"), uid: null, email, displayName: null, role: req.role, status: "pending", addedBy: actor().uid, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString() };
        members.set(m.id, m);
        s5.appendAudit({ action: "invite", entity: "members", entityId: m.id, projectId: null, after: { email, role: req.role } }, orgId);
        const origin = typeof location !== "undefined" ? location.origin : "https://kamutan.app";
        // contracts: url = `${PUBLIC_APP_ORIGIN}/invite/{inviteId}`
        return delay({ member: { ...m }, inviteUrl: `${origin}/invite/${m.id}` });
      },
      patchMember: async (orgId, memberId, req) => {
        requireAdmin();
        await requireRecentAuth();
        const m = members.get(memberId);
        if (!m) throw new ApiError(404, "not_found", "Member not found");
        if (!ROLES.includes(req.role)) throw new ApiError(400, "validation_failed", "invalid role");
        if (m.role === "admin" && req.role !== "admin" && m.status === "active" && activeAdmins().length <= 1) throw new ApiError(409, "last_admin", "the organisation needs at least one admin");
        const before = m.role;
        m.role = req.role;
        s5.appendAudit({ action: "update_role", entity: "members", entityId: m.id, projectId: null, before: { role: before }, after: { role: req.role } }, orgId);
        return delay({ ...m });
      },
      removeMember: async (orgId, memberId) => {
        requireAdmin();
        await requireRecentAuth();
        const m = members.get(memberId);
        if (!m) throw new ApiError(404, "not_found", "Member not found");
        if (m.role === "admin" && m.status === "active" && activeAdmins().length <= 1) throw new ApiError(409, "last_admin", "the organisation needs at least one admin");
        members.delete(memberId);
        s5.appendAudit({ action: m.status === "pending" ? "revoke" : "remove", entity: m.status === "pending" ? "invites" : "members", entityId: m.id, projectId: null, before: { email: m.email, role: m.role } }, orgId);
        return delay(undefined);
      },
      acceptInvite: async () => delay({ orgId: orgs[0]?.id ?? DEMO_ORG_ID, role: orgs[0]?.role ?? "viewer", alreadyMember: true }),

      /* ---------- Sprint 8 (contracts prices.ts / compare.ts / housekeeping.ts) ---------- */
      bulkPatchPrices: async (_orgId, req) => delay(boq.bulkPrices(req)),
      applyPriceImport: async (_orgId, importId, req) => {
        const r = boq.applyPriceImport(importId, req.overwriteItemIds);
        emit();
        return delay(r);
      },
      patchProjectPricing: async (projectId, adjustmentPct) => {
        const p = mustGet(projectId);
        s5.assertProjectActive(projectId);
        const role = orgs[0]?.role ?? "viewer";
        if (role !== "admin" && role !== "editor") throw new ApiError(403, "forbidden", "editors only");
        if (adjustmentPct !== null && (!Number.isFinite(adjustmentPct) || adjustmentPct < PRICE_ADJUSTMENT_MIN_PCT || adjustmentPct > PRICE_ADJUSTMENT_MAX_PCT))
          throw new ApiError(400, "validation_failed", "adjustmentPct out of range");
        const before = p.pricing?.adjustmentPct ?? null;
        // null (or 0) removes the discount / markup
        p.pricing = { adjustmentPct: adjustmentPct ?? 0, updatedBy: actor().uid, updatedAt: new Date().toISOString() };
        s5.appendAudit({ action: "update_pricing", entity: "projects", entityId: projectId, projectId, before: { adjustmentPct: before }, after: { adjustmentPct: p.pricing.adjustmentPct } }, p.orgId);
        emit();
        return delay({ projectId, pricing: { ...p.pricing } });
      },
      listBoqBuilds: async (projectId) => {
        mustGet(projectId);
        return delay(boq.listBuilds(projectId));
      },
      compareBoqBuilds: async (projectId, q) => {
        mustGet(projectId);
        return delay(boq.compare(projectId, q));
      },
      exportBoqComparison: async (projectId, q) => {
        const p = mustGet(projectId);
        const role = orgs[0]?.role ?? "viewer";
        if (role !== "admin" && role !== "editor") throw new ApiError(403, "forbidden", "editors only");
        const r = boq.exportCompare(projectId, q, `תוספות ושינויים — ${p.name}`);
        s5.appendAudit({ action: "create", entity: "exports", entityId: r.exportId, projectId, after: { purpose: "comparison", fromBuildId: r.fromBuildId, toBuildId: r.toBuildId } }, p.orgId);
        return delay(r);
      },
      deleteSheetSet: async (projectId, sheetSetId) => {
        const p = mustGet(projectId);
        s5.assertProjectActive(projectId);
        const role = orgs[0]?.role ?? "viewer";
        if (role !== "admin" && role !== "editor") throw new ApiError(403, "forbidden", "editors only");
        const list = sheetSets.get(projectId) ?? [];
        const set = list.find((x) => x.id === sheetSetId);
        if (!set) throw new ApiError(404, "not_found", "Sheet set not found");
        // contracts: 409 while the set is still being processed (younger than SHEET_SET_DELETE_BUSY_MS)
        if ((set.status === "uploaded" || set.status === "queued" || set.status === "splitting") && Date.now() - Date.parse(set.createdAt) < SHEET_SET_DELETE_BUSY_MS)
          throw new ApiError(409, "conflict", SHEET_SET_DELETE_BUSY_HE);
        const gone = (sheets.get(projectId) ?? []).filter((r) => r.sheet.sheetSetId === sheetSetId);
        const goneIds = new Set(gone.map((r) => r.sheet.id));
        const releasedBytes = bytesOf(projectId, sheetSetId);
        sheets.set(projectId, (sheets.get(projectId) ?? []).filter((r) => r.sheet.sheetSetId !== sheetSetId));
        sheetSets.set(projectId, list.filter((x) => x.id !== sheetSetId));
        for (const j of jobs) if (j.sheetSetId === sheetSetId && (j.status === "queued" || j.status === "running" || j.status === "failed")) j.status = "cancelled";
        setBytes.delete(sheetSetId);
        p.storageBytes = Math.max(0, (p.storageBytes ?? 0) - releasedBytes);
        const revokedShareLinks = s5.revokeLinksFor(projectId, goneIds);
        s5.appendAudit({ action: "delete", entity: "sheetSets", entityId: sheetSetId, projectId, after: { sheets: gone.length, releasedBytes, revokedShareLinks } }, p.orgId);
        if (gone.length) boq.markStale(projectId);
        emit();
        return delay({
          sheetSetId,
          deleted: { sheets: gone.length, versions: gone.length, docs: 0, objects: 1 + gone.length },
          releasedBytes,
          storageBytes: p.storageBytes,
          storageQuotaBytes: p.storageQuotaBytes ?? s5.projectQuota(p.orgId),
          revokedShareLinks,
        });
      },
      deleteProject: async (projectId, req) => {
        const p = mustGet(projectId);
        requireAdmin();
        await requireRecentAuth();
        if (!deleteConfirmationMatches(req.confirmName ?? "", p.name)) throw new ApiError(400, "validation_failed", PROJECT_DELETE_MISMATCH_HE);
        const releasedBytes = p.storageBytes ?? 0;
        const revokedShareLinks = s5.revokeLinksFor(projectId);
        const docs = (sheets.get(projectId) ?? []).length * 2 + (sheetSets.get(projectId) ?? []).length + 1;
        projects.delete(projectId);
        for (const x of sheetSets.get(projectId) ?? []) setBytes.delete(x.id);
        sheetSets.delete(projectId);
        sheets.delete(projectId);
        for (const j of jobs) if (j.projectId === projectId && (j.status === "queued" || j.status === "running")) j.status = "cancelled";
        boq.dropProject(projectId);
        s5.appendAudit({ action: "delete", entity: "projects", entityId: projectId, projectId, after: { name: p.name, releasedBytes, revokedShareLinks } }, p.orgId);
        emit();
        return delay({ projectId, deleted: { docs, objects: docs }, releasedBytes, revokedShareLinks });
      },
    },

    publicShare: {
      getMeta: async (token) => delay(await s5.publicShare.getMeta(token)),
      getBoq: async (token) => delay(await s5.publicShare.getBoq(token)),
      getOverlay: async (token, sheetId) => delay(await s5.publicShare.getOverlay(token, sheetId)),
      tileUrl: (token, sheetId, z, x, y) => s5.publicShare.tileUrl(token, sheetId, z, x, y),
      pdfUrl: (token) => s5.publicShare.pdfUrl(token),
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
        listen(() => onData((sheetSets.get(projectId) ?? []).map((s) => ({ ...s, storageBytes: bytesOf(projectId, s.id) })))),
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
