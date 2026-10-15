import {
  ApiError,
  type Detection,
  type BoqBuild,
  type BoqEvidenceArtifact,
  type BoqEvidenceItem,
  type BoqLine,
  type BoqLineEvidence,
  type BoqLinesResponse,
  type BoqRule,
  type BoqSheetEvidence,
  type BoqTemplate,
  type BuildBoqResponse,
  type CreateLibraryImportResponse,
  type DetectionsArtifact,
  type ExportBoqRequest,
  type ExportBoqResponse,
  type LibraryImport,
  type LibraryItem,
  type LibraryItemPage,
  type LinksArtifact,
  type ListLibraryQuery,
  type PatchBoqLineRequest,
  type PatchLibraryItemRequest,
  type ProjectBoqState,
  type Correction,
  type Role,
  type RoomSettings,
  type RoomsArtifact,
  type SheetRow,
} from "./types";
import { computeBoq, synthesizeLinks, type EngineSheet } from "./mockBoqEngine";
import { applyCorrectionDeltas, applyRoomSettingsDeltas, computePlumbing, computeTiling, type S4Sheet } from "./mockSprint4Engine";
import { applyCorrections, applyLinkCorrections } from "@/features/corrections/model";
import { fetchArtifact } from "@/features/understanding/artifacts";
import { allowedTransitions } from "@/features/boq/model";
import { DEFAULT_TEMPLATE, SECOND_TEMPLATE, defaultRules, libraryItems } from "@/test/fixtures/boq";

/**
 * Mock Sprint-3 backend: BOQ builds (simulated progress), lines (overrides/statuses preserved across rebuilds),
 * evidence, export (no file — the UI shows a toast), org library + import, templates, rules.
 *
 * Data sources for lines and links, in dev (`vite dev` + /dev-artifacts):
 *  - Worker-BOQ's local lines: a dev-index pointer (`boqLines` | `boq_lines` | `boq.lines`) or `/dev-artifacts/boq-lines.json`
 *    (`{lines|items: BoqLine[]}` or an array) + optional evidence file (kamutan.boq-evidence/1);
 *  - Worker-A's links: `links` (top-level or under `artifacts`) per dev-index sheet entry (kamutan.links/1).
 * The dev index is polled; otherwise (and always in tests) the mock engine aggregates the overlay detections.
 */

export interface BoqMockDeps {
  rows(projectId: string): SheetRow[];
  detections(row: SheetRow): Promise<DetectionsArtifact | null>;
  emit(): void;
  role(): Role;
  tickMs: number;
  blockExportOnRed: boolean;
  /** dev only: poll /dev-artifacts for Worker-BOQ lines + Worker-A links. */
  devBase: string | null;
  /** dev only: ignore Worker-BOQ's lines and always use the mock engine (`?mockBoq=engine`). */
  engineOnly?: boolean;
  /* Sprint 4 */
  rooms?(row: SheetRow): Promise<RoomsArtifact | null>;
  corrections?(projectId: string): readonly Correction[];
  roomSettings?(projectId: string): ReadonlyMap<string, RoomSettings>;
}

const COMPOSITE = new Set(["4.09", "4.10", "4.11", "4.12", "4.14", "4.15", "4.16"]);

interface ProjectBoq {
  state: ProjectBoqState | null;
  builds: Map<string, BoqBuild>;
  lines: Map<string, BoqLine>;
  evidence: Record<string, BoqEvidenceItem[]>;
  links: Map<string, LinksArtifact>;
  /** Sprint 4: automatic lines before plumbing/tiling + human corrections are layered on (see `derive`). */
  base: { lines: BoqLine[]; evidence: Record<string, BoqEvidenceItem[]> } | null;
}

type DevBoq = { lines: BoqLine[]; evidence: Record<string, BoqEvidenceItem[]>; sig: string };

const dataUrl = (doc: unknown) => `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(doc))}`;
const now = () => new Date().toISOString();

/** Tolerant normaliser for Worker-BOQ's local lines (fills Sprint-3 fields the file may omit). */
export function normalizeLine(raw: Record<string, unknown>, i: number): BoqLine | null {
  const code = raw.code ?? raw.itemCode;
  if (typeof code !== "string" && typeof code !== "number") return null;
  const c = String(code);
  const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const level = raw.level === "green" || raw.level === "yellow" || raw.level === "red" ? raw.level : "yellow";
  const status = raw.status === "reviewed" || raw.status === "approved" ? raw.status : "draft";
  const byFloor = (raw.byFloor && typeof raw.byFloor === "object" ? raw.byFloor : raw.floor ? { [String(raw.floor)]: num(raw.qty) } : {}) as Record<string, number>;
  return {
    id: String(raw.id ?? raw.lineId ?? `bl_${c.replace(/[^0-9A-Za-z]/g, "_")}_${i}`),
    chapter: String(raw.chapter ?? c.split(".")[0]!.padStart(2, "0")),
    chapterTitle: (raw.chapterTitle as string | undefined) ?? null,
    code: c,
    description: String(raw.description ?? ""),
    qty: num(raw.qty ?? raw.quantity),
    qtyOverride: typeof raw.qtyOverride === "number" ? raw.qtyOverride : null,
    unit: String(raw.unit ?? "יחידה"),
    level,
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String) : [],
    evidenceRef: (raw.evidenceRef as string | undefined) ?? null,
    status,
    note: (raw.note as string | undefined) ?? null,
    byFloor,
    evidenceCount: num(raw.evidenceCount, Array.isArray(raw.evidence) ? raw.evidence.length : 0),
    ruleId: (raw.ruleId as string | undefined) ?? null,
    sourceVersions: Array.isArray(raw.sourceVersions) ? (raw.sourceVersions as BoqLine["sourceVersions"]) : [],
    computedAt: (raw.computedAt as string | undefined) ?? null,
    ...(typeof raw.order === "number" ? { order: raw.order } : {}),
    // Sprint 4 (Worker-BOQ): order quantity / waste, manual items, per-room breakdown.
    ...(typeof raw.orderQty === "number" ? { orderQty: raw.orderQty } : {}),
    ...(typeof raw.wasteFactor === "number" ? { wasteFactor: raw.wasteFactor } : {}),
    ...(typeof raw.manualCount === "number" ? { manualCount: raw.manualCount } : {}),
    ...(Array.isArray(raw.breakdown) ? { breakdown: raw.breakdown as BoqLine["breakdown"] } : {}),
  };
}

export function createBoqMock(deps: BoqMockDeps) {
  const projects = new Map<string, ProjectBoq>();
  const library = new Map(libraryItems().map((i) => [i.id, i]));
  const templates = new Map<string, BoqTemplate>([DEFAULT_TEMPLATE, SECOND_TEMPLATE].map((t) => [t.id, structuredClone(t)]));
  const rules = new Map(defaultRules().map((r) => [r.id, r]));
  const imports = new Map<string, LibraryImport & { token: string; uploaded: boolean; orgId: string }>();
  let dev: DevBoq | null = null;
  const devLinks = new Map<string, LinksArtifact>(); // sheetId → Worker-A links
  let seq = 0;

  const proj = (projectId: string): ProjectBoq => {
    let p = projects.get(projectId);
    if (!p) {
      p = { state: null, builds: new Map(), lines: new Map(), evidence: {}, links: new Map(), base: null };
      projects.set(projectId, p);
    }
    return p;
  };

  /** Automatic lines of a build (before Sprint-4 layers): remembered, then derived. */
  function install(p: ProjectBoq, lines: BoqLine[], evidence: Record<string, BoqEvidenceItem[]>) {
    p.base = { lines, evidence };
    installDerived(p, lines, evidence);
  }

  /**
   * Sprint 4 layers on top of the automatic lines (mock stand-in for Worker-BOQ): plumbing (03) and tiling (05)
   * when the base has none, then human corrections (adds / rejects / reclassifies / counts / measures).
   */
  async function derive(projectId: string, p: ProjectBoq) {
    if (!p.base) return;
    const rows = deps.rows(projectId).filter((r) => r.version?.status === "ready");
    const corrections = deps.corrections?.(projectId) ?? [];
    const sheets: S4Sheet[] = [];
    const perSheet = new Map<string, { row: SheetRow; raw: Detection[]; corrected: Detection[] }>();
    for (const row of rows) {
      const det = await deps.detections(row);
      const rooms = (await deps.rooms?.(row))?.rooms ?? [];
      const raw = det?.detections ?? [];
      const corrected = applyCorrections(raw, corrections, row.sheet.id).detections;
      sheets.push({ row, detections: raw, rooms });
      if (raw.length || corrections.some((c) => c.sheetId === row.sheet.id)) perSheet.set(row.sheet.id, { row, raw, corrected });
    }
    const at = now();
    const lib = [...library.values()];
    let lines = [...p.base.lines];
    let evidence = { ...p.base.evidence };
    if (!lines.some((l) => l.chapter === "03")) {
      const pl = computePlumbing(sheets, lib, at);
      lines = [...lines, ...pl.lines];
      evidence = { ...evidence, ...pl.evidence };
    }
    const settings = deps.roomSettings?.(projectId) ?? new Map();
    if (!lines.some((l) => l.chapter === "05")) lines = [...lines, ...computeTiling(sheets, settings, lib, at)];
    else lines = applyRoomSettingsDeltas(lines, sheets, settings, lib, at);
    const out = applyCorrectionDeltas({ lines, evidence }, perSheet, corrections, lib, at);
    installDerived(p, out.lines, out.evidence);
  }

  /** Re-derive after a correction / room-settings change (built BOQs only) — "the BOQ updates immediately". */
  async function recompute(projectId: string) {
    const p = projects.get(projectId);
    if (!p?.state || !p.base) return;
    await derive(projectId, p);
    deps.emit();
  }

  /** Keep overrides / statuses / notes of lines that survive a rebuild (brief: never overwritten). */
  function installDerived(p: ProjectBoq, lines: BoqLine[], evidence: Record<string, BoqEvidenceItem[]>) {
    const prev = p.lines;
    p.lines = new Map(
      lines.map((l) => {
        const o = prev.get(l.id);
        return [
          l.id,
          o
            ? { ...l, qtyOverride: o.qtyOverride ?? null, qtyOverrideReason: o.qtyOverrideReason ?? null, status: o.status, note: o.note ?? null, reviewedBy: o.reviewedBy ?? null, reviewedAt: o.reviewedAt ?? null, approvedBy: o.approvedBy ?? null, approvedAt: o.approvedAt ?? null }
            : l,
        ];
      }),
    );
    p.evidence = evidence;
  }

  /**
   * MOCK-ONLY fallback while Worker-A's links.json.gz is missing: synthesize a link graph for the lighting sheets
   * that Worker-BOQ's composite lines point at, and tag their evidence with those group ids, so the arcs can be
   * shown. Real links (dev-index `links`) always win.
   */
  async function attachLinks(projectId: string, p: ProjectBoq) {
    p.links = new Map(devLinks);
    const rows = deps.rows(projectId);
    const sheetsNeeding = new Set<string>();
    for (const l of p.lines.values())
      if (COMPOSITE.has(l.code)) for (const e of p.evidence[l.id] ?? []) if (!e.linkGroupId && !devLinks.has(e.sheetId)) sheetsNeeding.add(e.sheetId);
    for (const sheetId of sheetsNeeding) {
      const row = rows.find((r) => r.sheet.id === sheetId);
      const det = row ? await deps.detections(row) : null;
      if (!det) continue;
      const g = synthesizeLinks(det.detections);
      p.links.set(sheetId, g);
      const groupOf = new Map<string, string>();
      for (const x of g.groups) for (const id of [...x.switchIds, ...x.luminaireIds]) groupOf.set(id, x.id);
      for (const l of p.lines.values())
        if (COMPOSITE.has(l.code))
          for (const e of p.evidence[l.id] ?? []) if (e.sheetId === sheetId && !e.linkGroupId) e.linkGroupId = groupOf.get(e.detectionId) ?? null;
    }
  }

  async function compute(projectId: string, p: ProjectBoq, buildId: string) {
    if (dev && projectId === "p-noah") {
      install(p, dev.lines, structuredClone(dev.evidence));
      await attachLinks(projectId, p);
      await derive(projectId, p);
      return;
    }
    const rows = deps.rows(projectId).filter((r) => r.version?.status === "ready");
    const sheets: EngineSheet[] = [];
    for (const row of rows) {
      const det = await deps.detections(row);
      if (det) sheets.push({ row, detections: det.detections, links: devLinks.get(row.sheet.id) ?? null });
    }
    const res = computeBoq(sheets, [...library.values()], now());
    // Demo seed (first build only): one manual override, so the receipt "16 = 14 שזוהו + 2 ידני" is visible.
    const first = p.lines.size === 0;
    install(p, res.lines, res.evidence);
    if (first) {
      const l = p.lines.get("bl_4_01");
      if (l) Object.assign(l, { qtyOverride: l.qty + 2, qtyOverrideReason: "2 שקעים נוספים לפי שיחה עם הלקוח" });
    }
    p.links = res.links;
    await derive(projectId, p);
    // derive() rebuilt the line objects: re-seed the demo override on the first build.
    if (first) {
      const l = p.lines.get("bl_4_01");
      if (l && l.qtyOverride == null) Object.assign(l, { qtyOverride: l.qty + 2, qtyOverrideReason: "2 שקעים נוספים לפי שיחה עם הלקוח" });
    }
    void buildId;
  }

  function runBuild(projectId: string, p: ProjectBoq, build: BoqBuild) {
    const steps = [10, 35, 60, 85];
    let i = 0;
    const tick = async () => {
      if (i < steps.length) {
        Object.assign(build, { status: "running", progress: steps[i], startedAt: build.startedAt ?? now() });
        i++;
        deps.emit();
        setTimeout(() => void tick(), deps.tickMs);
        return;
      }
      try {
        await compute(projectId, p, build.id);
        Object.assign(build, {
          status: "succeeded",
          progress: 100,
          finishedAt: now(),
          stats: { lines: p.lines.size, evidence: Object.values(p.evidence).reduce((s, e) => s + e.length, 0), sheets: deps.rows(projectId).length, groups: [...p.links.values()].reduce((s, l) => s + l.groups.length, 0) },
        });
        p.state = { latestBuildId: build.id, builtAt: build.finishedAt, stale: false };
      } catch (e) {
        Object.assign(build, { status: "failed", finishedAt: now(), error: { code: "build_failed", message: String(e) } });
      }
      deps.emit();
    };
    setTimeout(() => void tick(), deps.tickMs);
  }

  /* ---------------- dev artifacts (Worker-BOQ lines, Worker-A links) ---------------- */
  async function pollDev(base: string) {
    try {
      const res = await fetch(`${base}/dev-index.json`, { cache: "no-store" });
      const index = res.ok ? ((await res.json()) as unknown) : [];
      const entries = (Array.isArray(index) ? index : [index, ...((index as { sheets?: unknown[] })?.sheets ?? [])]) as Record<string, unknown>[];
      // Links per sheet (Worker-A) — re-read every poll; a real graph replaces the synthetic fallback.
      let linksChanged = false;
      for (const e of entries) {
        const arts = (e.artifacts ?? {}) as Record<string, unknown>;
        const path = (e.links ?? arts.links) as string | undefined;
        if (typeof path !== "string" || typeof e.sheetId !== "string") continue;
        const doc = await fetchArtifact<LinksArtifact>(`${base}/${path}`, "kamutan.links/1").catch(() => null);
        if (!doc) continue;
        const prev = devLinks.get(e.sheetId);
        if (!prev || JSON.stringify(prev).length !== JSON.stringify(doc).length) {
          devLinks.set(e.sheetId, doc);
          linksChanged = true;
        }
      }
      if (linksChanged) {
        const p = projects.get("p-noah");
        if (p?.state && dev && !deps.engineOnly) {
          install(p, dev.lines, structuredClone(dev.evidence));
          await attachLinks("p-noah", p);
          await derive("p-noah", p);
          deps.emit();
        } else if (p?.state) markStaleLocal("p-noah");
      }
      // Lines (Worker-BOQ): pointer in the index, else a well-known file.
      let linesPath: string | null = null;
      let evidencePath: string | null = null;
      for (const e of [...entries, index as Record<string, unknown>]) {
        if (!e || typeof e !== "object") continue;
        const b = (e.boq ?? {}) as Record<string, unknown>;
        const lp = e.boqLines ?? e.boq_lines ?? b.lines;
        const ep = e.boqEvidence ?? e.boq_evidence ?? b.evidence;
        if (typeof lp === "string") linesPath = lp;
        if (typeof ep === "string") evidencePath = ep;
      }
      const lr = await fetch(`${base}/${linesPath ?? "boq-lines.json"}`, { cache: "no-store" }).catch(() => null);
      if (deps.engineOnly || !lr?.ok || !(lr.headers.get("content-type") ?? "").includes("json")) return;
      const text = await lr.text();
      const sig = `${text.length}:${text.slice(0, 64)}:${text.slice(-64)}`;
      if (dev?.sig === sig) return;
      const raw = JSON.parse(text) as unknown;
      const list = (Array.isArray(raw) ? raw : ((raw as { lines?: unknown[]; items?: unknown[] }).lines ?? (raw as { items?: unknown[] }).items ?? [])) as Record<string, unknown>[];
      const lines = list.map(normalizeLine).filter((l): l is BoqLine => l !== null);
      let evidence: Record<string, BoqEvidenceItem[]> = {};
      const evPath = evidencePath ?? (raw as { evidence?: string }).evidence;
      if (typeof evPath === "string") {
        const ev = await fetchArtifact<BoqEvidenceArtifact>(`${base}/${evPath}`, "kamutan.boq-evidence/1").catch(() => null);
        if (ev) evidence = ev.lines;
      } else if ((raw as { evidence?: unknown }).evidence && typeof (raw as { evidence?: unknown }).evidence === "object") {
        evidence = (raw as { evidence: Record<string, BoqEvidenceItem[]> }).evidence;
      }
      if (!lines.length) return;
      dev = { lines, evidence, sig };
      const p = proj("p-noah");
      install(p, lines, structuredClone(evidence));
      await attachLinks("p-noah", p);
      await derive("p-noah", p);
      const bid = (raw as { buildId?: unknown }).buildId;
      p.state = { latestBuildId: typeof bid === "string" ? bid : `dev-${sig.length}`, builtAt: now(), stale: false };
      deps.emit();
    } catch {
      /* no dev server / malformed file → keep the mock engine */
    }
  }
  let polling = false;
  function markStaleLocal(projectId: string) {
    const p = projects.get(projectId);
    if (p?.state) p.state = { ...p.state, stale: true };
    deps.emit();
  }

  return {
    /** dev only: start polling the dev index (called once the understanding artifacts are wired). */
    startDevPolling() {
      if (!deps.devBase || polling) return;
      polling = true;
      const base = deps.devBase;
      void pollDev(base);
      setInterval(() => void pollDev(base), 15_000);
    },
    /* ---------- realtime ---------- */
    state: (projectId: string): ProjectBoqState | null => (projects.get(projectId)?.state ? { ...projects.get(projectId)!.state! } : null),
    build: (projectId: string, buildId: string): BoqBuild | null => {
      const b = projects.get(projectId)?.builds.get(buildId);
      return b ? { ...b } : null;
    },
    /** A sheet / mapping / rule changed → the BOQ is stale (only once built). */
    markStale(projectId?: string) {
      for (const [id, p] of projects) if ((!projectId || id === projectId) && p.state) p.state = { ...p.state, stale: true };
      deps.emit();
    },
    recompute,
    /** Link graph of a sheet (real, synthesized or none) with the hand-made link edits applied. */
    links(projectId: string, sheetId: string): LinksArtifact | null {
      const raw = projects.get(projectId)?.links.get(sheetId) ?? devLinks.get(sheetId) ?? null;
      return applyLinkCorrections(raw, deps.corrections?.(projectId) ?? [], sheetId);
    },
    linksUrl(row: SheetRow): string | null {
      for (const p of projects.values()) {
        const l = p.links.get(row.sheet.id);
        if (l) return dataUrl(l);
      }
      const d = devLinks.get(row.sheet.id);
      return d ? dataUrl(d) : null;
    },

    /* ---------- BOQ ---------- */
    buildBoq(projectId: string): BuildBoqResponse {
      const p = proj(projectId);
      const running = [...p.builds.values()].find((b) => b.status === "queued" || b.status === "running");
      if (running) return { buildId: running.id, jobId: `job-${running.id}` };
      const id = `b${++seq}-${Date.now().toString(36)}`;
      const b: BoqBuild = { id, status: "queued", startedAt: null, finishedAt: null, progress: 0, stats: null, error: null };
      p.builds.set(id, b);
      deps.emit();
      runBuild(projectId, p, b);
      return { buildId: id, jobId: `job-${id}` };
    },
    getBuild(projectId: string, buildId: string): BoqBuild {
      const b = projects.get(projectId)?.builds.get(buildId);
      if (!b) throw new ApiError(404, "not_found", "Build not found");
      return { ...b };
    },
    listLines(projectId: string): BoqLinesResponse {
      const p = proj(projectId);
      return {
        items: [...p.lines.values()].map((l) => ({ ...l, byFloor: { ...l.byFloor } })),
        boq: p.state ? { ...p.state } : null,
        chapters: (templates.get([...templates.values()].find((t) => t.default)?.id ?? "") ?? DEFAULT_TEMPLATE).chapters,
        blockExportOnRed: deps.blockExportOnRed,
      };
    },
    patchLine(projectId: string, lineId: string, req: PatchBoqLineRequest, uid: string): BoqLine {
      const p = proj(projectId);
      const l = p.lines.get(lineId);
      if (!l) throw new ApiError(404, "not_found", "Line not found");
      const role = deps.role();
      if (req.status && req.status !== l.status) {
        if (!allowedTransitions(role, l.status).includes(req.status)) throw new ApiError(403, "forbidden_transition", `${l.status} → ${req.status} not allowed for ${role}`);
        const at = now();
        if (req.status === "reviewed") Object.assign(l, { reviewedBy: uid, reviewedAt: at });
        if (req.status === "approved") Object.assign(l, { approvedBy: uid, approvedAt: at });
        if (req.status === "draft") Object.assign(l, { reviewedBy: null, reviewedAt: null, approvedBy: null, approvedAt: null });
        l.status = req.status;
      }
      if (req.qtyOverride !== undefined) {
        if (role === "viewer") throw new ApiError(403, "forbidden", "viewer");
        if (req.qtyOverride !== null && (!Number.isFinite(req.qtyOverride) || req.qtyOverride < 0)) throw new ApiError(400, "validation_failed", "qtyOverride");
        if (req.qtyOverride !== null && !req.reason?.trim()) throw new ApiError(400, "validation_failed", "a reason is required to override a quantity");
        l.qtyOverride = req.qtyOverride;
        Object.assign(l, req.qtyOverride === null ? { qtyOverrideReason: null, qtyOverrideBy: null, qtyOverrideAt: null } : { qtyOverrideReason: req.reason!.trim(), qtyOverrideBy: uid, qtyOverrideAt: now() });
      } else if (req.reason !== undefined) throw new ApiError(400, "validation_failed", "reason is only allowed with qtyOverride");
      if (req.note !== undefined) l.note = req.note;
      deps.emit();
      return { ...l };
    },
    evidence(projectId: string, lineId: string): BoqLineEvidence {
      const p = proj(projectId);
      if (!p.lines.has(lineId)) throw new ApiError(404, "not_found", "Line not found");
      return { lineId, items: (p.evidence[lineId] ?? []).map((e) => ({ ...e })) };
    },
    sheetEvidence(projectId: string, sheetId: string, versionId: string): BoqSheetEvidence {
      const p = proj(projectId);
      const detections: Record<string, string[]> = {};
      const linkGroups: Record<string, string[]> = {};
      const add = (m: Record<string, string[]>, k: string, line: string) => {
        const cur = (m[k] ??= []);
        if (!cur.includes(line)) cur.push(line);
      };
      for (const [lineId, items] of Object.entries(p.evidence))
        for (const e of items)
          if (e.sheetId === sheetId) {
            add(detections, e.detectionId, lineId);
            if (e.linkGroupId) add(linkGroups, e.linkGroupId, lineId);
          }
      return { sheetId, versionId, buildId: p.state?.latestBuildId ?? null, detections, linkGroups };
    },
    exportBoq(projectId: string, req: ExportBoqRequest): ExportBoqResponse {
      const p = proj(projectId);
      if (!p.state) throw new ApiError(409, "boq_not_built", "Build the BOQ first");
      const reds = [...p.lines.values()].filter((l) => l.level === "red" && l.status !== "approved").length;
      if (deps.blockExportOnRed && reds > 0) throw new ApiError(409, "export_blocked", `${reds} red lines`);
      const filename = `boq-${projectId}-${req.split}.xlsx`;
      return { url: `mock://exports/${filename}`, filename, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    },

    /* ---------- library ---------- */
    listItems(q: ListLibraryQuery): LibraryItemPage {
      const needle = (q.q ?? "").trim();
      const items = [...library.values()]
        .filter((i) => (!q.chapter || i.chapter === q.chapter) && (!needle || i.code.includes(needle) || i.description.includes(needle)))
        .sort((a, b) => a.chapter.localeCompare(b.chapter) || a.code.localeCompare(b.code, undefined, { numeric: true }));
      return { items: items.map((i) => ({ ...i, tags: [...i.tags] })), nextCursor: null };
    },
    patchItem(itemId: string, req: PatchLibraryItemRequest): LibraryItem {
      const i = library.get(itemId);
      if (!i) throw new ApiError(404, "not_found", "Item not found");
      if (deps.role() === "viewer" || deps.role() === "reviewer") throw new ApiError(403, "forbidden", "editors only");
      Object.assign(i, req, { source: i.source, updatedAt: now() });
      return { ...i };
    },
    createImport(orgId: string, filename: string): CreateLibraryImportResponse {
      const ext = filename.toLowerCase().endsWith(".xlsx") ? "xlsx" : filename.toLowerCase().endsWith(".xls") ? "xls" : null;
      if (!ext) throw new ApiError(400, "unsupported_file", "xls/xlsx only");
      const id = `imp${++seq}`;
      const token = `tok-${id}`;
      imports.set(id, { id, filename, status: "uploaded", progress: 0, jobId: null, result: null, error: null, token, uploaded: false, orgId });
      return {
        importId: id,
        storagePath: `orgs/${orgId}/imports/${id}.${ext}`,
        uploadToken: token,
        contentType: ext === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/vnd.ms-excel",
      };
    },
    startImport(importId: string, token: string): LibraryImport {
      const im = imports.get(importId);
      if (!im || im.token !== token) throw new ApiError(404, "not_found", "Import not found");
      Object.assign(im, { status: "queued", jobId: `job-${importId}` });
      let pct = 0;
      const fail = /corrupt/i.test(im.filename); // demo: "corrupt" in the name → the parser finds no BOQ sheet
      const timer = setInterval(() => {
        pct += 25;
        if (fail && pct >= 50) {
          clearInterval(timer);
          Object.assign(im, { status: "failed", error: { code: "no_boq_sheet", message: "לא נמצא גיליון כמויות בקובץ" } });
          return;
        }
        if (pct < 100) return void Object.assign(im, { status: "running", progress: pct });
        clearInterval(timer);
        const hadDefault = [...templates.values()].some((t) => t.default);
        const added = ["4.25", "4.26", "4.27"].filter((c) => ![...library.values()].some((i) => i.code === c));
        const desc: Record<string, string> = { "4.25": "אספקה והתקנת לוח תקשורת ביחידת דיור", "4.26": "החלפת מפסק דוד קיים למפסק טיימר", "4.27": "צינור קוברה 50 מ\"מ למקרן תקרה" };
        for (const code of added)
          library.set(`it_${code.replace(".", "_")}`, {
            id: `it_${code.replace(".", "_")}`,
            code,
            chapter: "04",
            chapterTitle: "פרק 04 – עבודות חשמל",
            description: desc[code]!,
            unit: "יחידה",
            tags: [],
            source: "import",
            sourceRef: im.filename,
            active: true,
            updatedAt: now(),
          });
        Object.assign(im, {
          status: "succeeded",
          progress: 100,
          result: {
            itemsAdded: added.length,
            itemsUpdated: 2,
            chapters: 8,
            templateCreated: hadDefault ? null : { id: DEFAULT_TEMPLATE.id, name: DEFAULT_TEMPLATE.name },
            ambiguousCodes: [{ code: "1.01", descriptions: ["פירוק ופינוי מחיצות פנים וחוץ בהתאם לתכנית הריסה", "פירוק ריצוף קיים"] }],
          },
        });
      }, deps.tickMs);
      return strip(im);
    },
    getImport(importId: string): LibraryImport {
      const im = imports.get(importId);
      if (!im) throw new ApiError(404, "not_found", "Import not found");
      return strip(im);
    },
    templates: (): BoqTemplate[] => [...templates.values()].map((t) => structuredClone(t)),
    setDefault(templateId: string): BoqTemplate {
      const t = templates.get(templateId);
      if (!t) throw new ApiError(404, "not_found", "Template not found");
      if (deps.role() !== "admin") throw new ApiError(403, "forbidden", "admin only");
      for (const x of templates.values()) x.default = x.id === templateId;
      return structuredClone(t);
    },
    rules: (): BoqRule[] => [...rules.values()].sort((a, b) => a.priority - b.priority).map((r) => ({ ...r })),
    patchRule(ruleId: string, enabled: boolean, projectIds: string[]): BoqRule {
      const r = rules.get(ruleId);
      if (!r) throw new ApiError(404, "not_found", "Rule not found");
      if (deps.role() !== "admin") throw new ApiError(403, "forbidden", "admin only");
      Object.assign(r, { enabled, updatedAt: now() });
      for (const id of projectIds) this.markStale(id);
      return { ...r };
    },
  };
}

function strip(im: LibraryImport & { token?: string; uploaded?: boolean; orgId?: string }): LibraryImport {
  const { token: _t, uploaded: _u, orgId: _o, ...rest } = im;
  return structuredClone(rest);
}

export type BoqMock = ReturnType<typeof createBoqMock>;
