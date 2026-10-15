import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DocIdSchema, storagePaths, type BBoxMm, type ConfidenceLevel } from '@kamutan/contracts';
import { ARTIFACT_READER, ArtifactTooLargeError, type ArtifactReader } from '../understanding/artifact-reader';

/**
 * Lenient, minimal views of the worker artifacts the review queue / room settings need. Worker output is untrusted:
 * every field is type-checked, malformed items are skipped (never fail a request), strings are length-capped.
 */
export interface DetView {
  id: string;
  class: string;
  centerMm: { x: number; y: number };
  bboxMm: BBoxMm;
  score: number;
  level: ConfidenceLevel;
  reasons: string[];
  floor: string | null;
  clusterId: string | null;
  legendEntryId: string | null;
  signature: string | null;
  roomId: string | null;
}
export interface ClusterView {
  id: string;
  signature: string;
  count: number;
  exemplarBboxMm: BBoxMm;
  thumb: boolean;
}
export interface RoomView {
  id: string;
  name: string | null;
  floor: string | null;
  areaM2: number;
  perimeterM: number;
  confidence: number;
  level: ConfidenceLevel;
  reasons: string[];
  type: string | null;
  wet: boolean | null;
  walls: Array<{ id: string; lengthM: number; exterior: boolean }>;
  openings: Array<{ id: string; kind: string; wallId: string; widthM: number; heightM: number | null }>;
  externalCorners: number | null;
  bboxMm: BBoxMm | null;
  ceilingHeightM: number | null;
  niche: boolean;
}
export interface LinkGroupView {
  id: string;
  kind: string | null;
  level: ConfidenceLevel;
  confidence: number;
  reasons: string[];
  floor: string | null;
  switchIds: string[];
  luminaireIds: string[];
}

const LEVELS = ['green', 'yellow', 'red'] as const;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const s = (v: unknown, max = 128): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
const lvl = (v: unknown): ConfidenceLevel | null => ((LEVELS as readonly string[]).includes(v as string) ? (v as ConfidenceLevel) : null);
const strs = (v: unknown, maxItems = 32, maxLen = 200): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= maxLen).slice(0, maxItems) : [];
const pt = (v: unknown) => (isObj(v) && fin(v.x) && fin(v.y) ? { x: v.x, y: v.y } : null);
const box = (v: unknown): BBoxMm | null => (isObj(v) && fin(v.x) && fin(v.y) && fin(v.w) && fin(v.h) && v.w >= 0 && v.h >= 0 ? { x: v.x, y: v.y, w: v.w, h: v.h } : null);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function detectionsView(raw: unknown): { detections: DetView[]; clusters: ClusterView[] } {
  const out: DetView[] = [];
  const clusters: ClusterView[] = [];
  if (!isObj(raw)) return { detections: out, clusters };
  for (const d of Array.isArray(raw.detections) ? raw.detections.slice(0, 50_000) : []) {
    if (!isObj(d)) continue;
    const id = s(d.id);
    const cls = s(d.class, 64);
    const c = pt(d.centerMm);
    const b = box(d.bboxMm);
    const level = lvl(d.level);
    if (!id || !cls || !c || !b || !level || !fin(d.score)) continue;
    out.push({
      id,
      class: cls,
      centerMm: c,
      bboxMm: b,
      score: clamp01(d.score),
      level,
      reasons: strs(d.reasons, 16),
      floor: s(d.floor, 32),
      clusterId: s(d.clusterId),
      legendEntryId: s(d.legendEntryId),
      signature: s(d.signature),
      roomId: s(d.roomId),
    });
  }
  for (const u of Array.isArray(raw.unknownClusters) ? raw.unknownClusters.slice(0, 2000) : []) {
    if (!isObj(u)) continue;
    const id = s(u.id);
    const b = box(u.exemplarBboxMm);
    if (!id || !/^u_[A-Za-z0-9_-]+$/.test(id) || !b || !Number.isInteger(u.count) || (u.count as number) < 1) continue;
    clusters.push({ id, signature: s(u.signature) ?? '', count: u.count as number, exemplarBboxMm: b, thumb: u.thumb === `unknown/${id}.webp` });
  }
  return { detections: out, clusters };
}

export function roomsView(raw: unknown): RoomView[] {
  const out: RoomView[] = [];
  if (!isObj(raw)) return out;
  for (const r of Array.isArray(raw.rooms) ? raw.rooms.slice(0, 2000) : []) {
    if (!isObj(r)) continue;
    const id = s(r.id);
    const level = lvl(r.level);
    if (!id || !/^r_[A-Za-z0-9_-]+$/.test(id) || !level) continue;
    const poly = Array.isArray(r.polygonMm) ? r.polygonMm.map(pt).filter((p): p is { x: number; y: number } => p !== null) : [];
    let bboxMm: BBoxMm | null = null;
    if (poly.length) {
      const xs = poly.map((p) => p.x);
      const ys = poly.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      bboxMm = { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    const walls = (Array.isArray(r.walls) ? r.walls.slice(0, 512) : [])
      .filter(isObj)
      .map((w) => ({ id: s(w.id), lengthM: fin(w.lengthM) && w.lengthM >= 0 ? w.lengthM : null, exterior: w.exterior === true }))
      .filter((w): w is { id: string; lengthM: number; exterior: boolean } => !!w.id && w.lengthM !== null);
    const openings = (Array.isArray(r.openings) ? r.openings.slice(0, 256) : [])
      .filter(isObj)
      .map((o) => ({ id: s(o.id), kind: s(o.kind, 16) ?? 'opening', wallId: s(o.wallId), widthM: fin(o.widthM) && o.widthM >= 0 ? o.widthM : null, heightM: fin(o.heightM) && o.heightM >= 0 ? o.heightM : null }))
      .filter((o): o is { id: string; kind: string; wallId: string; widthM: number; heightM: number | null } => !!o.id && !!o.wallId && o.widthM !== null);
    out.push({
      id,
      name: s(r.name, 100),
      floor: s(r.floor, 32),
      areaM2: fin(r.areaM2) && r.areaM2 >= 0 ? r.areaM2 : 0,
      perimeterM: fin(r.perimeterM) && r.perimeterM >= 0 ? r.perimeterM : 0,
      confidence: fin(r.confidence) ? clamp01(r.confidence) : 0.5,
      level,
      reasons: strs(r.reasons, 16),
      type: s(r.type, 32),
      wet: typeof r.wet === 'boolean' ? r.wet : null,
      walls,
      openings,
      externalCorners: Number.isInteger(r.externalCorners) && (r.externalCorners as number) >= 0 ? (r.externalCorners as number) : null,
      bboxMm,
      ceilingHeightM: fin(r.ceilingHeightM) && r.ceilingHeightM > 0 && r.ceilingHeightM <= 10 ? r.ceilingHeightM : null,
      niche: r.niche === true,
    });
  }
  return out;
}

export function linksView(raw: unknown): LinkGroupView[] {
  const out: LinkGroupView[] = [];
  if (!isObj(raw)) return out;
  for (const g of Array.isArray(raw.groups) ? raw.groups.slice(0, 5000) : []) {
    if (!isObj(g)) continue;
    const id = s(g.id);
    const level = lvl(g.level);
    if (!id || !level) continue;
    out.push({
      id,
      kind: s(g.kind, 32),
      level,
      confidence: fin(g.confidence) ? clamp01(g.confidence) : 0.5,
      reasons: strs(g.reasons, 16),
      floor: s(g.floor, 32),
      switchIds: strs(g.switchIds, 16, 128),
      luminaireIds: strs(g.luminaireIds, 256, 128),
    });
  }
  return out;
}

export interface VersionArtifacts {
  detections: DetView[];
  clusters: ClusterView[];
  rooms: RoomView[];
  links: LinkGroupView[];
}

/**
 * Reads + caches the views per sheet version (artifacts are immutable per version id). Missing / oversized / invalid
 * artifacts → empty lists.
 */
@Injectable()
export class ReviewArtifacts {
  private readonly logger = new Logger('ReviewArtifacts');
  private readonly cache = new Map<string, Promise<VersionArtifacts>>();
  private static readonly MAX = 256;

  constructor(@Optional() @Inject(ARTIFACT_READER) private readonly reader?: ArtifactReader) {}

  private async read(path: string): Promise<unknown> {
    if (!this.reader) return null;
    try {
      return await this.reader.readJson(path);
    } catch (err) {
      if (err instanceof ArtifactTooLargeError || err instanceof SyntaxError) {
        this.logger.warn({ path, err: (err as Error).message }, 'artifact rejected');
        return null;
      }
      throw err;
    }
  }

  of(orgId: string, projectId: string, sheetId: string, versionId: string): Promise<VersionArtifacts> {
    if (!DocIdSchema.safeParse(sheetId).success || !DocIdSchema.safeParse(versionId).success) return Promise.resolve({ detections: [], clusters: [], rooms: [], links: [] });
    const key = `${orgId}/${projectId}/${sheetId}/${versionId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const p = (async () => {
      const [det, rooms, links] = await Promise.all([
        this.read(storagePaths.detections(orgId, projectId, sheetId, versionId)),
        this.read(storagePaths.rooms(orgId, projectId, sheetId, versionId)),
        this.read(storagePaths.links(orgId, projectId, sheetId, versionId)),
      ]);
      return { ...detectionsView(det), rooms: roomsView(rooms), links: linksView(links) };
    })();
    this.cache.set(key, p);
    p.catch(() => this.cache.delete(key));
    while (this.cache.size > ReviewArtifacts.MAX) this.cache.delete(this.cache.keys().next().value as string);
    return p;
  }
}
