import {
  ApiError,
  type DetectionsArtifact,
  type LegendArtifact,
  type LegendEntry,
  type OverlayManifest,
  type PatchLegendEntryRequest,
  type ResolveUnknownClusterRequest,
  type ResolveUnknownClusterResponse,
  type RoomsArtifact,
  type SheetRow,
  type VersionStats,
} from "./types";
import { applyClusterResolution, applyLegendClass, levelKeyOf } from "@/features/understanding/model";
import { className, isSymbolClass } from "@/features/understanding/taxonomy";
import { fetchArtifact } from "@/features/understanding/artifacts";
import { ELECTRICAL_SPEC, LIGHTING_SPEC, makeUnderstandingFixture, type UnderstandingFixture } from "@/test/fixtures/understanding";

/**
 * Mock "understanding" backend (Sprint 2): overlay manifest, legend entries, unknown-cluster resolve.
 *
 * Data sources, per sheet version:
 *  - REAL: the worker's local artifacts (legend/detections/rooms .json.gz + crops) listed in
 *    /dev-artifacts/dev-index.json — served by the dev-artifacts vite plugin (dev server only);
 *  - FIXTURE: a deterministic synthetic set (src/test/fixtures/understanding.ts) for two sheets, used in tests and
 *    in dev until real artifacts exist.
 * The mock keeps the user's answers (legend class, "מה זה?") and serves the patched docs as data: URLs, the way
 * the real API serves signed URLs.
 */
export const DEV_BASE = "/dev-artifacts";

type Source =
  | { kind: "fixture"; fixture: UnderstandingFixture }
  | { kind: "real"; prefix: string; paths: { legend?: string; detections?: string; rooms?: string } };

interface Loaded {
  legend: LegendArtifact | null;
  detections: DetectionsArtifact | null;
  rooms: RoomsArtifact | null;
  thumbs: Record<string, string>;
}

const versionPrefix = (row: SheetRow) => row.version?.artifacts?.tiles?.prefix.replace(/\/tiles$/, "") ?? "";
const dataUrl = (doc: unknown) => `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(doc))}`;

export function statsOf(det: DetectionsArtifact | null, legend: LegendArtifact | null, rooms: RoomsArtifact | null): Partial<VersionStats> {
  const byClass: Record<string, number> = {};
  const s = { total: 0, green: 0, yellow: 0, red: 0, unknown: 0, byClass };
  for (const d of det?.detections ?? []) {
    s.total++;
    s[d.level]++;
    if (levelKeyOf(d) === "unknown") s.unknown++;
    byClass[d.class] = (byClass[d.class] ?? 0) + 1;
  }
  return { detections: s, rooms: rooms?.rooms.length ?? 0, legendEntries: legend?.entries.length ?? 0 };
}

export interface UnderstandingMock {
  /** Attach understanding sources to seeded rows (fixture), mutating the version docs like the worker would. */
  seedFixture(rows: SheetRow[], opts?: { electricalDetections?: number }): void;
  /** Forget the synthetic sources (real artifacts arrived): strips the fixture paths from those versions. */
  dropFixtures(rows: SheetRow[]): void;
  /** Use the worker's real artifacts for this sheet (dev-index entry). */
  useReal(row: SheetRow, paths: { legend?: string; detections?: string; rooms?: string }): void;
  getOverlay(row: SheetRow): Promise<OverlayManifest>;
  /** Detections of a sheet with the user's answers applied (Sprint 3: the mock BOQ engine aggregates them). */
  detections(row: SheetRow): Promise<DetectionsArtifact | null>;
  listLegendEntries(rows: SheetRow[], q: { sheetId?: string; status?: string }): Promise<LegendEntry[]>;
  patchLegendEntry(entryId: string, req: PatchLegendEntryRequest): Promise<{ entry: LegendEntry; mapping: unknown }>;
  resolveUnknownCluster(rows: SheetRow[], clusterId: string, req: ResolveUnknownClusterRequest): Promise<ResolveUnknownClusterResponse>;
}

export function createUnderstandingMock(): UnderstandingMock {
  const sources = new Map<string, Source>(); // sheetId → source
  const loaded = new Map<string, Promise<Loaded>>();
  const resolutions = new Map<string, Map<string, string | null>>(); // sheetId → clusterId → class|null
  const legendClass = new Map<string, string>(); // entryId → class
  const entries = new Map<string, LegendEntry>();
  const entriesSeeded = new Set<string>();

  function load(sheetId: string): Promise<Loaded> {
    const hit = loaded.get(sheetId);
    if (hit) return hit;
    const src = sources.get(sheetId);
    let p: Promise<Loaded>;
    if (!src) p = Promise.resolve({ legend: null, detections: null, rooms: null, thumbs: {} });
    else if (src.kind === "fixture") {
      const f = src.fixture;
      p = Promise.resolve({ legend: f.legend, detections: f.detections, rooms: f.rooms, thumbs: f.thumbs });
    } else {
      const get = <T extends { schema: string }>(path: string | undefined, schema: T["schema"]) =>
        path ? fetchArtifact<T>(`${DEV_BASE}/${path}`, schema).catch(() => null) : Promise.resolve(null);
      p = Promise.all([
        get<LegendArtifact>(src.paths.legend, "kamutan.legend/1"),
        get<DetectionsArtifact>(src.paths.detections, "kamutan.detections/1"),
        get<RoomsArtifact>(src.paths.rooms, "kamutan.rooms/1"),
      ]).then(([legend, detections, rooms]) => {
        const thumbs: Record<string, string> = {};
        for (const e of legend?.entries ?? []) if (e.thumb) thumbs[e.id] = `${DEV_BASE}/${src.prefix}/${e.thumb}`;
        for (const c of detections?.unknownClusters ?? []) if (c.thumb) thumbs[c.id] = `${DEV_BASE}/${src.prefix}/${c.thumb}`;
        return { legend, detections, rooms, thumbs };
      });
    }
    loaded.set(sheetId, p);
    return p;
  }

  /** Detections with the user's answers applied. */
  function patched(sheetId: string, det: DetectionsArtifact | null): DetectionsArtifact | null {
    if (!det) return null;
    let out = det;
    for (const [entryId, cls] of legendClass) if (entryId.startsWith(`le_${sheetId}_`)) out = applyLegendClass(out, entryId, cls);
    for (const [cid, cls] of resolutions.get(sheetId) ?? []) out = applyClusterResolution(out, cid, cls);
    return out;
  }

  async function seedEntries(row: SheetRow) {
    const sheetId = row.sheet.id;
    if (entriesSeeded.has(sheetId) || !sources.has(sheetId)) return;
    entriesSeeded.add(sheetId);
    const l = await load(sheetId);
    const prefix = versionPrefix(row);
    for (const e of l.legend?.entries ?? []) {
      if (entries.has(e.id)) continue;
      entries.set(e.id, {
        id: e.id,
        sheetId,
        versionId: row.version?.id ?? "v1",
        label: e.label,
        labelConfidence: e.labelConfidence,
        suggestedClass: e.suggestedClass,
        class: null,
        itemCode: null,
        signature: e.signature,
        thumbPath: e.thumb ? `${prefix}/${e.thumb}` : null,
        status: "suggested",
        updatedAt: null,
        thumbUrl: l.thumbs[e.id] ?? null,
        classConfidence: e.classConfidence,
      });
    }
  }

  return {
    seedFixture(rows, opts = {}) {
      for (const spec of [ELECTRICAL_SPEC, LIGHTING_SPEC]) {
        const row = rows.find((r) => r.sheet.id === spec.sheetId);
        if (!row?.version) continue;
        const fixture = makeUnderstandingFixture(
          spec === ELECTRICAL_SPEC && opts.electricalDetections ? { ...spec, detections: opts.electricalDetections } : spec,
        );
        sources.set(spec.sheetId, { kind: "fixture", fixture });
        const prefix = versionPrefix(row);
        row.version.artifacts = {
          ...row.version.artifacts,
          legend: `${prefix}/legend.json.gz`,
          detections: `${prefix}/detections.json.gz`,
          rooms: `${prefix}/rooms.json.gz`,
        };
        row.version.stats = { ...row.version.stats, ...statsOf(fixture.detections, fixture.legend, fixture.rooms) };
      }
    },
    dropFixtures(rows) {
      for (const [sheetId, src] of sources) {
        if (src.kind !== "fixture") continue;
        sources.delete(sheetId);
        loaded.delete(sheetId);
        const v = rows.find((r) => r.sheet.id === sheetId)?.version;
        if (v?.artifacts) {
          const { legend: _l, detections: _d, rooms: _r, ...rest } = v.artifacts;
          v.artifacts = rest;
        }
        if (v?.stats) {
          const { detections: _d, rooms: _r, legendEntries: _e, ...rest } = v.stats;
          v.stats = rest;
        }
      }
    },
    useReal(row, paths) {
      sources.set(row.sheet.id, { kind: "real", prefix: versionPrefix(row), paths });
      loaded.delete(row.sheet.id);
    },
    async getOverlay(row) {
      const sheetId = row.sheet.id;
      const l = await load(sheetId);
      const det = patched(sheetId, l.detections);
      return {
        sheetId,
        versionId: row.version?.id ?? "v1",
        legend: l.legend ? { url: dataUrl(l.legend) } : null,
        detections: det ? { url: dataUrl(det) } : null,
        rooms: l.rooms ? { url: dataUrl(l.rooms) } : null,
        thumbs: { ...l.thumbs },
        stats: { ...(row.version?.stats ?? {}), ...statsOf(det, l.legend, l.rooms) },
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      };
    },
    async detections(row) {
      const l = await load(row.sheet.id);
      return patched(row.sheet.id, l.detections);
    },
    async listLegendEntries(rows, q) {
      await Promise.all(rows.map(seedEntries));
      return [...entries.values()]
        .filter((e) => (!q.sheetId || e.sheetId === q.sheetId) && (!q.status || e.status === q.status))
        .map((e) => ({ ...e }));
    },
    async patchLegendEntry(entryId, req) {
      const e = entries.get(entryId);
      if (!e) throw new ApiError(404, "not_found", "Legend entry not found");
      const now = new Date().toISOString();
      if (req.action === "ignore") {
        Object.assign(e, { status: "ignored", confirmedBy: "mock-user", confirmedAt: now, updatedAt: now });
        legendClass.delete(entryId);
        return { entry: { ...e }, mapping: null };
      }
      const cls = req.class ?? (isSymbolClass(e.suggestedClass) ? e.suggestedClass : null);
      if (!cls || !isSymbolClass(cls)) throw new ApiError(400, "validation_failed", "class is required");
      if (req.label !== undefined && req.label.length > 300) throw new ApiError(400, "validation_failed", "label too long");
      Object.assign(e, {
        status: "confirmed",
        class: cls,
        itemCode: req.itemCode ?? e.itemCode,
        ...(req.label !== undefined ? { label: req.label } : {}),
        confirmedBy: "mock-user",
        confirmedAt: now,
        updatedAt: now,
      });
      if (cls !== e.suggestedClass || legendClass.has(entryId)) legendClass.set(entryId, cls);
      return { entry: { ...e }, mapping: { signature: e.signature, class: cls, itemCode: e.itemCode, label: e.label, uses: 1 } };
    },
    async resolveUnknownCluster(rows, clusterId, req) {
      const row = rows.find((r) => r.sheet.id === req.sheetId);
      if (!row) throw new ApiError(404, "not_found", "Sheet not found");
      const l = await load(req.sheetId);
      const cluster = patched(req.sheetId, l.detections)?.unknownClusters.find((c) => c.id === clusterId);
      if (!cluster) throw new ApiError(404, "not_found", "Cluster not found");
      const cls = req.ignore ? null : (req.class ?? null);
      if (!req.ignore && !isSymbolClass(cls)) throw new ApiError(400, "validation_failed", "class or ignore is required");
      const m = resolutions.get(req.sheetId) ?? new Map();
      m.set(clusterId, cls);
      resolutions.set(req.sheetId, m);
      const now = new Date().toISOString();
      let legendEntry: LegendEntry | null = null;
      if (cls && req.createLegendEntry) {
        legendEntry = {
          id: `le_${req.sheetId}_${clusterId}`,
          sheetId: req.sheetId,
          versionId: req.versionId,
          label: className(cls),
          labelConfidence: 1,
          suggestedClass: cls,
          class: cls,
          itemCode: req.itemCode ?? null,
          signature: cluster.signature,
          thumbPath: cluster.thumb ? `${versionPrefix(row)}/${cluster.thumb}` : null,
          status: "confirmed",
          confirmedBy: "mock-user",
          confirmedAt: now,
          updatedAt: now,
          thumbUrl: l.thumbs[clusterId] ?? null,
          classConfidence: 1,
        };
        entries.set(legendEntry.id, legendEntry);
      }
      return {
        clusterId,
        signature: cluster.signature,
        mapping: cls ? { signature: cluster.signature, class: cls, itemCode: req.itemCode ?? null, label: className(cls), uses: 1 } : null,
        legendEntry,
        reprocess: [{ sheetId: req.sheetId, status: "skipped", reason: "mock", versionId: req.versionId, jobId: null }],
      };
    },
  };
}
