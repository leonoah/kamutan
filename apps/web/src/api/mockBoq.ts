import {
  ApiError,
  CONSERVATIVE_REASON,
  type Detection,
  type BoqBuild,
  type BoqEvidenceArtifact,
  type BoqEvidenceItem,
  type BoqLine,
  type BoqLineEvidence,
  type BoqLineStatus,
  type BatchStatusRequest,
  type BatchStatusResponse,
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
  isQtyChangedReason,
  needsReapproval,
  qtyChangedReason,
} from "./types";
import { computeBoq, synthesizeLinks, type EngineSheet } from "./mockBoqEngine";
import { applyCorrectionDeltas, applyRoomSettingsDeltas, computePlumbing, computeTiling, type S4Sheet } from "./mockSprint4Engine";
import { applySprint6, finalizeSprint6 } from "./mockSprint6";
import { upsertLibraryWording, validateDescriptionPatch } from "./mockSprint7";
import { compareSnapshots, comparisonSpreadsheet, demoPriceFile, libraryPriceOf, priceLine, runPriceImport, seedLibraryPrices, seedPreviousSnapshot, snapshotOf } from "./mockSprint8";
import { COMPARE_NO_EXPORT_HE, COMPARE_NO_PREVIOUS_HE, PRICE_MAX, computeBoqTotals, type BoqLinesSnapshot } from "@kamutan/contracts";
import type { ApplyPriceImportResponse, BoqBuildSummary, BoqComparison, BoqCompareExportResponse, BoqCompareQuery, BoqTotals, BulkPriceRequest, BulkPriceResponse, ItemPrice } from "./types";
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


/** Sprint 5: calibration reported by the mock worker (conservative until 30 GT projects exist). */
export const MOCK_CALIBRATION = { mode: "conservative", version: "cal-2026.10-mock" } as const;
/** Yellow lines carry the conservative-calibration reason (the real worker writes it on capped items). */
function withConservative(l: BoqLine): string[] {
  const r = l.reasons ?? [];
  return l.level === "yellow" && !r.includes(CONSERVATIVE_REASON) ? [...r, CONSERVATIVE_REASON] : [...r];
}

export interface BoqMockDeps {
  rows(projectId: string): SheetRow[];
  detections(row: SheetRow): Promise<DetectionsArtifact | null>;
  emit(): void;
  role(): Role;
  tickMs: number;
  blockExportOnRed: boolean | (() => boolean);
  /** dev only: poll /dev-artifacts for Worker-BOQ lines + Worker-A links. */
  devBase: string | null;
  /** dev only: ignore Worker-BOQ's lines and always use the mock engine (`?mockBoq=engine`). */
  engineOnly?: boolean;
  /* Sprint 4 */
  rooms?(row: SheetRow): Promise<RoomsArtifact | null>;
  corrections?(projectId: string): readonly Correction[];
  roomSettings?(projectId: string): ReadonlyMap<string, RoomSettings>;
  /**
   * Stage 10 (A-LIVE-01): which library the org has — `imported` (the fixture, default), `default` (the shipped
   * default library, items `source: "default"`) or `none` (empty library). Dev: `?mockLibrary=default|none`.
   */
  libraryMode?: "imported" | "default" | "none";
  /** Stage 10: a rebuild dropped an approved line to "נבדק" (the API/worker audit `boqLines/approval_invalidated`). */
  onApprovalInvalidated?(projectId: string, line: BoqLine, from: number, to: number): void;
  /** Sprint 6: add the text / geometry / suggested lines (default on; off reproduces the Sprint-5 BOQ). */
  sprint6?: boolean;
  /** Sprint 8: seed the org price list (imported library only; default on). */
  seedPrices?: boolean;
  /** Sprint 8: a library price changed (audit `itemLibrary · price`). */
  onLibraryPrice?(item: LibraryItem, before: ItemPrice | null, after: ItemPrice | null, batchId?: string): void;
  /** Sprint 8: signed-in user's uid (price `by`). */
  actorUid?(): string;
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
  /** Sprint 6: quantities confirmed through a line's `confirm` quick action (lineId → qty). */
  confirmed: Map<string, number>;
  /** Sprint 8: `kamutan.boq-lines/1` per succeeded build (oldest first) + when a BOQ Excel was exported from it. */
  snapshots: Map<string, { snap: BoqLinesSnapshot; at: string; exportedAt: string | null }>;
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
  const blockOnRed = () => (typeof deps.blockExportOnRed === "function" ? deps.blockExportOnRed() : deps.blockExportOnRed);
  const projects = new Map<string, ProjectBoq>();
  const libraryMode = deps.libraryMode ?? "imported";
  const library = new Map(
    libraryMode === "none"
      ? []
      : libraryItems().map((i) => [i.id, libraryMode === "default" ? { ...i, source: "default" as const, defaultsVersion: 1, sourceRef: null } : i]),
  );
  // Sprint 8: the imported library carries the org's prices (the shipped default library has none — contracts).
  if (libraryMode === "imported" && deps.seedPrices !== false) seedLibraryPrices(library.values(), "2026-10-20T09:00:00.000Z");
  else for (const i of library.values()) i.price ??= null;
  const priceOf = (code: string): number | null => libraryPriceOf(code, library.values());
  const templates = new Map<string, BoqTemplate>([DEFAULT_TEMPLATE, SECOND_TEMPLATE].map((t) => [t.id, structuredClone(t)]));
  const rules = new Map(defaultRules().map((r) => [r.id, r]));
  const imports = new Map<string, LibraryImport & { token: string; uploaded: boolean; orgId: string }>();
  let dev: DevBoq | null = null;
  const devLinks = new Map<string, LinksArtifact>(); // sheetId → Worker-A links
  let seq = 0;

  const proj = (projectId: string): ProjectBoq => {
    let p = projects.get(projectId);
    if (!p) {
      p = { state: null, builds: new Map(), lines: new Map(), evidence: {}, links: new Map(), base: null, confirmed: new Map(), snapshots: new Map() };
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
    if (!lines.some((l) => l.chapter === "05")) {
      const tl = computeTiling(sheets, settings, lib, at);
      lines = [...lines, ...tl];
      // Like the worker (units.room_det): a room-derived line's evidence is the ROOM id, one item per room.
      const versionOf = new Map(sheets.map((s) => [s.row.sheet.id, s.row.version?.id ?? "v1"]));
      for (const l of tl) {
        const seen = new Set<string>();
        evidence[l.id] = (l.breakdown ?? []).flatMap((b) => {
          const key = `${b.sheetId}/${b.roomId}`;
          if (!b.sheetId || !b.roomId || seen.has(key)) return [];
          seen.add(key);
          const floor = l.byFloor && Object.keys(l.byFloor).length === 1 ? (Object.keys(l.byFloor)[0] ?? null) : null;
          return [{ sheetId: b.sheetId, versionId: versionOf.get(b.sheetId) ?? "v1", detectionId: b.roomId, roomId: b.roomId, linkGroupId: null, floor, quantity: b.qty }];
        });
      }
    } else lines = applyRoomSettingsDeltas(lines, sheets, settings, lib, at);
    if (deps.sprint6 !== false) ({ lines, evidence } = applySprint6({ lines, evidence }, { sheets, library: lib, at }));
    const out = applyCorrectionDeltas({ lines, evidence }, perSheet, corrections, lib, at);
    installDerived(p, deps.sprint6 !== false ? finalizeSprint6(out.lines, p.confirmed) : out.lines, out.evidence, projectId);
  }

  /** Re-derive after a correction / room-settings change (built BOQs only) — "the BOQ updates immediately". */
  async function recompute(projectId: string) {
    const p = projects.get(projectId);
    if (!p?.state || !p.base) return;
    await derive(projectId, p);
    deps.emit();
  }

  /**
   * Keep overrides / statuses / notes of lines that survive a rebuild (brief: never overwritten).
   * Stage 10 (contracts `applyRebuild`): an APPROVED line whose computed qty moved away from the approved baseline drops
   * to "נבדק" with `qtyChangedReason(X, Y)` and must be re-approved.
   */
  function installDerived(p: ProjectBoq, lines: BoqLine[], evidence: Record<string, BoqEvidenceItem[]>, projectId?: string) {
    const prev = p.lines;
    const dropped: [BoqLine, number, number][] = [];
    p.lines = new Map(
      lines.map((l) => {
        const o = prev.get(l.id);
        if (!o) return [l.id, l];
        const kept: BoqLine = {
          ...l,
          qtyOverride: o.qtyOverride ?? null,
          qtyOverrideReason: o.qtyOverrideReason ?? null,
          status: o.status,
          note: o.note ?? null,
          reviewedBy: o.reviewedBy ?? null,
          reviewedAt: o.reviewedAt ?? null,
          approvedBy: o.approvedBy ?? null,
          approvedAt: o.approvedAt ?? null,
          // Sprint 7: a renamed line keeps its wording across rebuilds (like qtyOverride; Worker-BOQ never writes it).
          descriptionOverride: o.descriptionOverride ?? null,
          descriptionOverrideBy: o.descriptionOverrideBy ?? null,
          descriptionOverrideAt: o.descriptionOverrideAt ?? null,
          descriptionOverrideReason: o.descriptionOverrideReason ?? null,
          // Sprint 8: the project's own price survives rebuilds too (Worker-BOQ preserves `priceOverride*`).
          priceOverride: o.priceOverride ?? null,
          priceOverrideBy: o.priceOverrideBy ?? null,
          priceOverrideAt: o.priceOverrideAt ?? null,
          priceOverrideReason: o.priceOverrideReason ?? null,
        };
        const ownReasons = (l.reasons ?? []).filter((r) => !isQtyChangedReason(r));
        // the chip of an earlier drop stays until a human re-approves (or the qty goes back)
        const carried = o.status === "reviewed" ? (o.reasons ?? []).filter(isQtyChangedReason) : [];
        kept.reasons = [...carried, ...ownReasons];
        if (o.status === "approved") {
          const base = typeof o.approvedQty === "number" ? o.approvedQty : o.qty;
          if (base !== l.qty) {
            Object.assign(kept, { status: "reviewed", approvedBy: null, approvedAt: null, approvedQty: null, approvedQtyAt: null, reasons: [qtyChangedReason(base, l.qty), ...ownReasons] });
            dropped.push([kept, base, l.qty]);
          } else Object.assign(kept, { approvedQty: base, approvedQtyAt: o.approvedQtyAt ?? o.approvedAt ?? null });
        }
        return [l.id, kept];
      }),
    );
    p.evidence = evidence;
    if (projectId) for (const [l, from, to] of dropped) deps.onApprovalInvalidated?.(projectId, l, from, to);
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
          stats: { lines: p.lines.size, evidence: Object.values(p.evidence).reduce((s, e) => s + e.length, 0), sheets: deps.rows(projectId).length, groups: [...p.links.values()].reduce((s, l) => s + l.groups.length, 0), calibration: { ...MOCK_CALIBRATION } },
        });
        p.state = { latestBuildId: build.id, builtAt: build.finishedAt, stale: false };
        // Sprint 8 (Worker-BOQ: boq/{buildId}/lines.json.gz): the lines of this build; the first build also gets a
        // mock "previous, exported" build so the comparison has something to show.
        takeSnapshot(projectId, p, build.id, build.finishedAt!);
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
      const nextId = typeof bid === "string" ? bid : `dev-${sig.length}`;
      // Sprint 8: Worker-BOQ's lines replace the latest build's — its snapshot is re-taken under the new id
      const old = p.state?.latestBuildId;
      if (old && old !== nextId) p.snapshots.delete(old);
      p.state = { latestBuildId: nextId, builtAt: now(), stale: false };
      takeSnapshot("p-noah", p, nextId, p.state.builtAt!);
      deps.emit();
    } catch {
      /* no dev server / malformed file → keep the mock engine */
    }
  }
  let polling = false;
  /** GET boq line DTOs: the API derives `unitPrice` / `unitPriceSource` / `lineTotal` on read (never stored). */
  function pricedLines(p: ProjectBoq): BoqLine[] {
    return [...p.lines.values()].map((l) => priceLine({ ...l, byFloor: { ...l.byFloor }, reasons: withConservative(l) }, priceOf(l.code)));
  }
  /**
   * Worker-BOQ writes `lines.json.gz` for every succeeded build (effective qty / price AT BUILD TIME). The first build of
   * a project also gets a mock "previous build, exported to Excel" so "מה השתנה" has something to show.
   */
  function takeSnapshot(projectId: string, p: ProjectBoq, buildId: string, at: string) {
    const snap = snapshotOf(projectId, buildId, at, pricedLines(p), deps.rows(projectId));
    if (p.snapshots.size === 0) {
      const prevAt = new Date(Date.parse(at) - 3 * 86_400_000).toISOString();
      p.snapshots.set("b0-history", { snap: seedPreviousSnapshot(snap, "b0-history", prevAt), at: prevAt, exportedAt: new Date(Date.parse(prevAt) + 3_600_000).toISOString() });
    }
    p.snapshots.set(buildId, { snap, at, exportedAt: null });
  }
  /** API semantics: `to` = latest build; `from` explicit, else the build before `to` (base previous) or of the latest export. */
  function resolveCompare(projectId: string, p: ProjectBoq, q: BoqCompareQuery): { from: string; to: string; base: BoqComparison["base"] } {
    const latest = p.state?.latestBuildId ?? null;
    if (latest && !p.snapshots.has(latest)) takeSnapshot(projectId, p, latest, p.state?.builtAt ?? now());
    const ids = [...p.snapshots.keys()];
    const to = q.to ?? latest ?? "";
    if (!to) throw new ApiError(409, "not_ready", COMPARE_NO_PREVIOUS_HE);
    if (!p.snapshots.has(to)) throw new ApiError(404, "not_found", "Build not found");
    if (q.from) {
      if (!p.snapshots.has(q.from)) throw new ApiError(404, "not_found", "Build not found");
      return { from: q.from, to, base: "explicit" };
    }
    if (q.base === "export") {
      const ex = [...p.snapshots.entries()].filter(([, v]) => v.exportedAt).sort(([, a], [, b]) => (a.exportedAt ?? "").localeCompare(b.exportedAt ?? "")).pop();
      if (!ex) throw new ApiError(409, "not_ready", COMPARE_NO_EXPORT_HE);
      return { from: ex[0], to, base: "export" };
    }
    const prev = ids[ids.indexOf(to) - 1];
    if (!prev) throw new ApiError(409, "not_ready", COMPARE_NO_PREVIOUS_HE);
    return { from: prev, to, base: "previous" };
  }
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
    /** Sprint 6: a `confirm` quick action (the quantity of a suggested קומפלט / unit line), then re-derive. */
    async confirmLine(projectId: string, lineId: string, qty: number) {
      const p = projects.get(projectId);
      if (!p?.lines.has(lineId)) throw new ApiError(404, "not_found", "Line not found");
      p.confirmed.set(lineId, qty);
      await recompute(projectId);
    },
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
        items: pricedLines(p),
        boq: p.state ? { ...p.state } : null,
        chapters: (templates.get([...templates.values()].find((t) => t.default)?.id ?? "") ?? DEFAULT_TEMPLATE).chapters,
        blockExportOnRed: blockOnRed(),
        // Sprint 5: the mock runs the conservative calibration like the worker (brief §1).
        calibration: p.state ? MOCK_CALIBRATION : null,
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
        // Stage 10: the approval baseline is the computed qty at this moment; a re-approval clears the qty-changed chip.
        if (req.status === "approved") Object.assign(l, { approvedBy: uid, approvedAt: at, approvedQty: l.qty, approvedQtyAt: at, reasons: (l.reasons ?? []).filter((r) => !isQtyChangedReason(r)) });
        if (req.status === "draft") Object.assign(l, { reviewedBy: null, reviewedAt: null, approvedBy: null, approvedAt: null });
        l.status = req.status;
      }
      if (req.qtyOverride !== undefined) {
        if (role === "viewer") throw new ApiError(403, "forbidden", "viewer");
        if (req.qtyOverride !== null && (!Number.isFinite(req.qtyOverride) || req.qtyOverride < 0)) throw new ApiError(400, "validation_failed", "qtyOverride");
        if (req.qtyOverride !== null && !req.reason?.trim()) throw new ApiError(400, "validation_failed", "a reason is required to override a quantity");
        l.qtyOverride = req.qtyOverride;
        // Sprint-3 decision (kept in Sprint 5): an override on an approved line re-opens it as "נבדק".
        if (l.status === "approved") Object.assign(l, { status: "reviewed", approvedBy: null, approvedAt: null });
        Object.assign(l, req.qtyOverride === null ? { qtyOverrideReason: null, qtyOverrideBy: null, qtyOverrideAt: null } : { qtyOverrideReason: req.reason!.trim(), qtyOverrideBy: uid, qtyOverrideAt: now() });
      } else if (req.reason !== undefined && req.description === undefined && req.priceOverride === undefined) throw new ApiError(400, "validation_failed", "reason is only allowed with qtyOverride, priceOverride or description");
      if (req.description !== undefined) {
        // Sprint 7: rename (editor+); `null` restores the original wording. Never touched by a rebuild.
        if (role !== "admin" && role !== "editor") throw new ApiError(403, "forbidden", "editors only");
        const d = validateDescriptionPatch(req.description);
        const value = d !== null && d === l.description.replace(/\s+/g, " ").trim() ? null : d;
        Object.assign(
          l,
          value === null
            ? { descriptionOverride: null, descriptionOverrideBy: null, descriptionOverrideAt: null, descriptionOverrideReason: null }
            : { descriptionOverride: value, descriptionOverrideBy: uid, descriptionOverrideAt: now(), descriptionOverrideReason: req.reason?.trim() || null },
        );
        if (req.alsoUpdateLibrary) upsertLibraryWording(library, l, value ?? l.description, now());
      }
      if (req.priceOverride !== undefined) {
        // Sprint 8 (contracts PriceAmountSchema): the line's own unit price (editor+); null restores the library price.
        if (role !== "admin" && role !== "editor") throw new ApiError(403, "forbidden", "editors only");
        if (req.priceOverride !== null && (!Number.isFinite(req.priceOverride) || req.priceOverride < 0 || req.priceOverride > PRICE_MAX))
          throw new ApiError(400, "validation_failed", "priceOverride must be within 0..PRICE_MAX");
        Object.assign(
          l,
          req.priceOverride === null
            ? { priceOverride: null, priceOverrideBy: null, priceOverrideAt: null, priceOverrideReason: null }
            : { priceOverride: req.priceOverride, priceOverrideBy: uid, priceOverrideAt: now(), priceOverrideReason: req.reason?.trim() || null },
        );
      }
      if (req.note !== undefined) l.note = req.note;
      deps.emit();
      // the PATCH answer is a priced line (API: "Response line is priced")
      return priceLine({ ...l }, priceOf(l.code));
    },
    /**
     * Sprint 6 (owner feedback): one status for many lines. Walks the legal path of the state machine (draft → reviewed
     * → approved and back), each step role-checked like a PATCH; red lines are skipped unless `includeRed` (moving back
     * to draft never needs it); a line still "להשלמה ידנית" is never marked checked / approved.
     */
    batchStatus(projectId: string, req: BatchStatusRequest, uid: string): BatchStatusResponse {
      const p = proj(projectId);
      const order: BoqLineStatus[] = ["draft", "reviewed", "approved"];
      const role = deps.role();
      const updated: BoqLine[] = [];
      const skipped: BatchStatusResponse["skipped"] = [];
      for (const id of new Set(req.lineIds)) {
        const l = p.lines.get(id);
        if (!l) {
          skipped.push({ lineId: id, reason: "not_found" });
          continue;
        }
        if (l.status === req.to) {
          skipped.push({ lineId: id, reason: "already" });
          continue;
        }
        const forward = order.indexOf(req.to) > order.indexOf(l.status);
        if (forward && l.needsInput && l.qtyOverride == null) {
          skipped.push({ lineId: id, reason: "needs_input" });
          continue;
        }
        if (forward && l.level === "red" && !req.includeRed) {
          skipped.push({ lineId: id, reason: "red" });
          continue;
        }
        const path: BoqLineStatus[] = [];
        for (let i = order.indexOf(l.status); i !== order.indexOf(req.to); ) {
          i += forward ? 1 : -1;
          path.push(order[i]!);
        }
        let from = l.status;
        if (!path.every((to) => allowedTransitions(role, from).includes(to) && ((from = to), true))) {
          skipped.push({ lineId: id, reason: "forbidden" });
          continue;
        }
        for (const to of path) this.patchLine(projectId, id, { status: to }, uid);
        updated.push({ ...p.lines.get(id)! });
      }
      return { updated, skipped };
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
      // Stage 10 (contracts exportBlockingLines): red lines not approved + approved lines whose qty changed since.
      const reds = [...p.lines.values()].filter((l) => needsReapproval(l) || (l.level === "red" && l.status !== "approved")).length;
      if (blockOnRed() && reds > 0) throw new ApiError(409, "export_blocked", `${reds} red lines`);
      const filename = `boq-${projectId}-${req.split}.xlsx`;
      // Sprint 8: "since last export" (base=export) compares against the build this Excel was made from.
      const latest = p.state.latestBuildId;
      if (latest && !p.snapshots.has(latest)) takeSnapshot(projectId, p, latest, p.state.builtAt ?? now());
      const s8 = latest ? p.snapshots.get(latest) : undefined;
      if (s8) s8.exportedAt = now();
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
      const { price, ...rest } = req;
      Object.assign(i, rest, { source: i.source, updatedAt: now() });
      if (price !== undefined) this.setPrice(i, price, "manual");
      return { ...i };
    },
    /** Sprint 8: one item's price (contracts ItemPrice, validated, audited). Returns whether it changed. */
    setPrice(i: LibraryItem, amount: number | null, source: "manual" | "import", batchId?: string, importId?: string): boolean {
      if (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > PRICE_MAX)) throw new ApiError(400, "validation_failed", "price must be within 0..PRICE_MAX");
      const before = i.price ?? null;
      if ((before?.amount ?? null) === amount && (amount === null || before?.source === source)) return false;
      i.price = amount === null ? null : { amount, currency: "ILS", updatedAt: now(), by: deps.actorUid?.() ?? "mock-user", source, importId: importId ?? null };
      i.updatedAt = now();
      deps.onLibraryPrice?.(i, before, i.price, batchId);
      // prices are resolved on read (`pricedLines`): every BOQ shows the new price at once
      deps.emit();
      return true;
    },
    /** POST /library/prices (contracts BulkLibraryPrice*): ≤ 500 unique items; `updated` / `skipped` in request order. */
    bulkPrices(req: BulkPriceRequest): BulkPriceResponse {
      if (deps.role() === "viewer" || deps.role() === "reviewer") throw new ApiError(403, "forbidden", "editors only");
      if (!req.items.length || req.items.length > 500 || new Set(req.items.map((x) => x.itemId)).size !== req.items.length) throw new ApiError(400, "validation_failed", "1..500 unique items");
      for (const x of req.items) if (x.amount !== null && (!Number.isFinite(x.amount) || x.amount < 0 || x.amount > PRICE_MAX)) throw new ApiError(400, "validation_failed", "amount within 0..PRICE_MAX");
      const batchId = `bp_${(++seq).toString(36)}${Date.now().toString(36)}`;
      const res: BulkPriceResponse = { batchId, updated: [], skipped: [] };
      for (const x of req.items) {
        const i = library.get(x.itemId);
        if (!i) {
          res.skipped.push({ itemId: x.itemId, reason: "not_found" });
          continue;
        }
        const from = i.price?.amount ?? null;
        if (from === x.amount) {
          res.skipped.push({ itemId: x.itemId, reason: "unchanged" });
          continue;
        }
        this.setPrice(i, x.amount, "manual", batchId);
        res.updated.push({ itemId: i.id, code: i.code, from, to: x.amount });
      }
      return res;
    },

    /**
     * Integration: POST /library/imports/:id/apply-prices — a SUCCEEDED dry run, once: writes every `planned` item +
     * the `manual_price` conflicts listed in `overwriteItemIds`; each item re-checked (gone → not_found, same → unchanged,
     * became manual and not listed → manual_kept).
     */
    applyPriceImport(importId: string, overwriteItemIds: readonly string[]): ApplyPriceImportResponse {
      if (deps.role() === "viewer" || deps.role() === "reviewer") throw new ApiError(403, "forbidden", "editors only");
      const im = imports.get(importId);
      if (!im) throw new ApiError(404, "not_found", "Import not found");
      const rep = im.result?.prices;
      if (im.status !== "succeeded" || !im.dryRun || !rep?.planned || im.pricesAppliedAt) throw new ApiError(409, "conflict", "not an unapplied dry-run price import");
      const over = new Set(overwriteItemIds);
      const res: ApplyPriceImportResponse = { importId: im.id, applied: 0, overwritten: 0, kept: 0, skipped: [], appliedAt: now() };
      const write = (itemId: string, amount: number, overwrite: boolean) => {
        const it = library.get(itemId);
        if (!it || !it.active) return void res.skipped.push({ itemId, reason: "not_found" });
        if (it.price?.amount === amount) return void res.skipped.push({ itemId, reason: "unchanged" });
        if (it.price?.source === "manual" && !over.has(itemId)) return void res.skipped.push({ itemId, reason: "manual_kept" });
        this.setPrice(it, amount, "import", undefined, im.id);
        res.applied++;
        if (overwrite) res.overwritten++;
      };
      for (const w of rep.planned) write(w.itemId, w.amount, false);
      for (const c of rep.conflictRows)
        if (c.reason === "manual_price" && c.itemId) {
          if (over.has(c.itemId)) write(c.itemId, c.incoming, true);
          else res.kept++;
        }
      im.pricesAppliedAt = res.appliedAt;
      return res;
    },

    /* ---------- Sprint 8: comparison (contracts compare.ts) ---------- */
    /** Integration: GET …/boq/builds (newest first, the compare picker). */
    listBuilds(projectId: string): BoqBuildSummary[] {
      const p = proj(projectId);
      const latest = p.state?.latestBuildId ?? null;
      if (latest && !p.snapshots.has(latest)) takeSnapshot(projectId, p, latest, p.state?.builtAt ?? now());
      return [...p.snapshots.entries()]
        .map(([id, v]): BoqBuildSummary => ({
          buildId: id,
          status: "succeeded",
          trigger: "manual",
          createdAt: v.at,
          finishedAt: v.at,
          lineCount: v.snap.lines.length,
          hasSnapshot: true,
          exportedAt: v.exportedAt,
          exportId: v.exportedAt ? `x_${id}` : null,
          latest: id === latest,
        }))
        .reverse();
    },
    compare(projectId: string, q: BoqCompareQuery): BoqComparison {
      const p = proj(projectId);
      const { from, to, base } = resolveCompare(projectId, p, q);
      const a = p.snapshots.get(from)!;
      // Integration: without an explicit `to` the "to" side is LIVE (today's lines and prices), `live: true`
      const live = !q.to;
      const b = live ? { snap: snapshotOf(projectId, to, now(), pricedLines(p), deps.rows(projectId)), at: p.snapshots.get(to)?.at ?? now() } : p.snapshots.get(to)!;
      const c = compareSnapshots(a.snap, b.snap, base, { fromAt: a.at, toAt: b.at, exportedAt: a.exportedAt });
      return live ? { ...c, to: { ...c.to, live: true } } : c;
    },
    exportCompare(projectId: string, q: BoqCompareQuery, title: string): BoqCompareExportResponse {
      const c = this.compare(projectId, q);
      const fileName = `boq-changes-${projectId}.xls`;
      const body = comparisonSpreadsheet(c, title);
      const url =
        typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined"
          ? URL.createObjectURL(new Blob([body], { type: "application/vnd.ms-excel" }))
          : `https://mock.invalid/exports/${fileName}`;
      return { exportId: `xc${(++seq).toString(36)}`, url, expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(), fileName, fromBuildId: c.from.buildId, toBuildId: c.to.buildId };
    },
    /** Sprint 8: contracts BoqTotals over ALL lines (effective prices, project discount, org VAT). */
    totals(projectId: string, vatRate: number, adjustmentPct: number | null): BoqTotals {
      const ls = pricedLines(proj(projectId));
      return computeBoqTotals({ linesTotal: ls.reduce((x, l) => x + (l.lineTotal ?? 0), 0), adjustmentPct, vatRate, pricedLines: ls.filter((l) => l.unitPrice !== null).length, unpricedLines: ls.filter((l) => l.unitPrice === null).length });
    },
    /** Sprint 8 (deletes): drop a project's BOQ state (project deleted). */
    dropProject(projectId: string) {
      projects.delete(projectId);
    },
    createImport(orgId: string, filename: string, mode: "library" | "prices" = "library", overwriteManualPrices = false, dryRun = false): CreateLibraryImportResponse {
      if (dryRun && mode !== "prices") throw new ApiError(400, "validation_failed", "dryRun needs mode 'prices'");
      const ext = filename.toLowerCase().endsWith(".xlsx") ? "xlsx" : filename.toLowerCase().endsWith(".xls") ? "xls" : null;
      if (!ext) throw new ApiError(400, "unsupported_file", "xls/xlsx only");
      // API: randomUUID (contracts ItemPrice.importId is a uuid)
      const id = `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
      const token = `tok-${id}`;
      imports.set(id, { id, filename, mode, overwriteManualPrices, dryRun, pricesAppliedAt: null, status: "uploaded", progress: 0, jobId: null, result: null, error: null, token, uploaded: false, orgId });
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
        if (im.mode === "prices") {
          // Sprint 8 (Worker-BOQ, contracts planPriceImport): prices only; a MANUAL price is kept unless
          // `overwriteManualPrices` (reported as a `manual_price` conflict); `stats.prices` = the report.
          const lib = [...library.values()];
          const { writes, report } = runPriceImport(lib, /noprice/i.test(im.filename) ? [] : demoPriceFile(lib), Boolean(im.overwriteManualPrices));
          if (im.dryRun) {
            // Integration: the report only — `planned` = what apply-prices will write (with each item's current price)
            report.dryRun = true;
            report.planned = writes.map((w) => {
              const it = library.get(w.itemId)!;
              return { itemId: w.itemId, code: it.code, amount: w.amount, current: it.price?.amount ?? null, currentSource: it.price?.source ?? null };
            });
          } else {
            report.dryRun = false; // contracts: a direct report says so and has no `planned`
            for (const w of writes) {
              const it = library.get(w.itemId);
              if (it) this.setPrice(it, w.amount, "import", undefined, im.id);
            }
          }
          Object.assign(im, { status: "succeeded", progress: 100, result: { itemsAdded: 0, itemsUpdated: 0, chapters: 0, templateCreated: null, ambiguousCodes: [], prices: report } });
          return;
        }
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
