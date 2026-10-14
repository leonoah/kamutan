import type { BoqEvidenceItem, BoqLine, DbLevel, Detection, LibraryItem, LinkGroup, LinksArtifact, SheetRow } from "./types";
import { CLASS_TO_CODE, COMPOSITE_CODES } from "@/test/fixtures/boq";

/**
 * MOCK ONLY — a small stand-in for Worker-BOQ (workers/drawing boq/) so the web app can demo the whole flow
 * without the worker: authority per discipline (sockets/comms/feeds from electrical sheets, switches/luminaires
 * from lighting sheets), one sheet per (discipline, floor), socket lines by class, composite lighting lines from
 * the switch↔luminaire link graph (the worker's links.json.gz when present, else a synthetic graph), the lighting
 * install line, per-floor breakdown, line level = lowest evidence level, reasons = union.
 */

export interface EngineSheet {
  row: SheetRow;
  detections: Detection[];
  /** Worker-A link graph for this version, if any. */
  links: LinksArtifact | null;
}
export interface EngineResult {
  lines: BoqLine[];
  evidence: Record<string, BoqEvidenceItem[]>;
  /** Link graph per sheet id (real or synthesized). */
  links: Map<string, LinksArtifact>;
}

const LUMINAIRES = new Set(["luminaire_ceiling", "luminaire_wall", "luminaire_pendant", "luminaire_strip", "luminaire_outdoor"]);
const LEVEL_RANK: Record<DbLevel, number> = { green: 2, yellow: 1, red: 0 };
const minLevel = (ls: Iterable<DbLevel>): DbLevel => {
  let out: DbLevel = "green";
  for (const l of ls) if (LEVEL_RANK[l] < LEVEL_RANK[out]) out = l;
  return out;
};
const dist = (a: Detection, b: Detection) => Math.hypot(a.centerMm.x - b.centerMm.x, a.centerMm.y - b.centerMm.y);
const UNSURE_FLOOR = "קומה לא ודאית";
const SWITCH_LINK = "קישור מפסק לא ודאי";
const DEFAULT_RULE = "שיוך לפריט לפי כלל ברירת מחדל";

/** Deterministic 0..1 from a string (FNV-1a). */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Synthetic link graph (when Worker-A's links.json.gz is absent): two-way switches are paired (nearest partner,
 * same floor, same room first, ≤ 140 mm); each switch takes its nearest free lights (same floor, same room first, ≤ 150 mm); leftover
 * lights join the nearest point (≤ 60 mm, "one point = several luminaires") or become a sensor point.
 */
export function synthesizeLinks(dets: readonly Detection[]): LinksArtifact {
  const live = dets.filter((d) => d.lifecycle !== "demolish").sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const lums = live.filter((d) => LUMINAIRES.has(d.class));
  const free = new Set(lums);
  const groups: LinkGroup[] = [];
  const near = (from: Detection, pool: Iterable<Detection>, max: number) =>
    [...pool]
      .filter((x) => x !== from && x.floor === from.floor && dist(from, x) <= max)
      .sort((a, b) => Number(a.roomId !== from.roomId) - Number(b.roomId !== from.roomId) || dist(from, a) - dist(from, b));
  const take = (from: Detection, k: number) => {
    const picked = near(from, free, 150).slice(0, k);
    picked.forEach((p) => free.delete(p));
    return picked;
  };
  const push = (switches: Detection[], points: Detection[][], kind: LinkGroup["kind"]) => {
    const members = [...switches, ...points.flat()];
    const far = switches.some((s) => points.flat().some((l) => dist(s, l) > 70 || l.roomId !== s.roomId));
    const shaky = far || hash01(`${members[0]!.id}`) < 0.15;
    const level = minLevel([...members.map((m) => m.level), ...(shaky ? (["yellow"] as DbLevel[]) : [])]);
    const id = `g_${groups.length + 1}`;
    groups.push({
      id,
      switchIds: switches.map((x) => x.id),
      pointIds: points.map((_, i) => `${id}_p${i + 1}`),
      luminaireIds: points.flat().map((l) => l.id),
      points: points.map((pt, i) => ({ id: `${id}_p${i + 1}`, luminaireIds: pt.map((l) => l.id) })),
      kind,
      confidence: shaky ? 0.68 : 0.92,
      level,
      reasons: shaky ? [SWITCH_LINK] : [],
    });
  };

  const twoWay = new Set(live.filter((d) => d.class === "switch_2way"));
  const singles: Detection[] = [];
  for (const a of [...twoWay]) {
    if (!twoWay.has(a)) continue;
    twoWay.delete(a);
    const b = near(a, twoWay, 140)[0];
    if (!b) {
      singles.push(a);
      continue;
    }
    twoWay.delete(b);
    const pt = take(a, 1);
    if (pt.length) push([a, b], [pt], pt[0]!.lifecycle === "existing" ? "add_to_existing" : "two_way");
  }
  singles.push(...live.filter((d) => d.class === "switch_single" || d.class === "switch_fan"));
  singles.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  for (const sw of singles) {
    const r = hash01(sw.id);
    const pts = take(sw, r < 0.6 ? 1 : r < 0.85 ? 2 : 3);
    if (pts.length) push([sw], pts.map((p) => [p]), pts.length === 1 ? "single" : "shared");
  }
  const byId = new Map(live.map((d) => [d.id, d]));
  for (const l of [...free]) {
    const best = groups
      .flatMap((g) => (g.points ?? []).map((p) => ({ g, p, d: dist(l, byId.get(p.luminaireIds[0]!)!) })))
      .sort((a, b) => a.d - b.d)[0];
    if (best && best.d <= 60) {
      best.p.luminaireIds.push(l.id);
      best.g.luminaireIds.push(l.id);
    } else push([], [[l]], "sensor");
  }
  return { schema: "kamutan.links/1", groups };
}

const compositeCode = (g: LinkGroup): { code: string; rule: string } | null => {
  if (g.kind === "sensor") return { code: COMPOSITE_CODES.sensor, rule: "r_comp_sensor" };
  if (g.kind === "add_to_existing") return { code: COMPOSITE_CODES.add_to_existing, rule: "r_comp_two_way" };
  if (g.kind === "two_way") return { code: COMPOSITE_CODES.two_way, rule: "r_comp_two_way" };
  const pts = g.pointIds.length;
  if (pts <= 1) return { code: COMPOSITE_CODES.single1, rule: "r_comp_single" };
  if (pts === 2) return { code: COMPOSITE_CODES.shared2, rule: "r_comp_shared2" };
  return { code: COMPOSITE_CODES.shared3, rule: "r_comp_shared3" };
};

interface Acc {
  code: string;
  ruleId: string;
  qty: number;
  byFloor: Record<string, number>;
  levels: DbLevel[];
  reasons: Set<string>;
  evidence: BoqEvidenceItem[];
  versions: Map<string, string>;
}

export function computeBoq(sheets: readonly EngineSheet[], library: readonly LibraryItem[], computedAt: string): EngineResult {
  const lib = new Map(library.filter((i) => i.active).map((i) => [i.code, i]));
  const acc = new Map<string, Acc>();
  const links = new Map<string, LinksArtifact>();
  const add = (code: string, ruleId: string, row: SheetRow, floor: string, qty: number, dets: Detection[], reasons: string[], linkGroupId: string | null) => {
    const a: Acc = acc.get(code) ?? { code, ruleId, qty: 0, byFloor: {}, levels: [], reasons: new Set(), evidence: [], versions: new Map() };
    a.qty += qty;
    a.byFloor[floor] = (a.byFloor[floor] ?? 0) + qty;
    for (const d of dets) {
      a.levels.push(d.level);
      d.reasons.forEach((r) => a.reasons.add(r));
      a.evidence.push({ sheetId: row.sheet.id, versionId: row.version?.id ?? "v1", detectionId: d.id, linkGroupId, floor });
    }
    reasons.forEach((r) => a.reasons.add(r));
    a.versions.set(row.sheet.id, row.version?.id ?? "v1");
    acc.set(code, a);
  };

  // Authority: one sheet per (discipline, floor) — single-floor sheets first; a multi-floor sheet only fills the gaps.
  const covered = new Set<string>();
  const ordered = [...sheets]
    .filter((s) => s.row.sheet.discipline === "electrical" || s.row.sheet.discipline === "lighting")
    .sort((a, b) => (a.row.sheet.floors?.length ?? 9) - (b.row.sheet.floors?.length ?? 9) || a.row.sheet.id.localeCompare(b.row.sheet.id));
  for (const s of ordered) {
    const disc = s.row.sheet.discipline!;
    const sheetFloors = s.row.sheet.floors ?? [];
    const confirmed = Boolean(s.row.sheet.confirmed);
    const floorOf = (d: Detection) => d.floor ?? (sheetFloors.length === 1 ? sheetFloors[0]! : "unknown");
    const mine = new Set<string>();
    const dets = s.detections.filter((d) => {
      if (d.class === "unknown" || d.lifecycle === "demolish") return false;
      const key = `${disc}/${floorOf(d)}`;
      if (covered.has(key) && !mine.has(key)) return false;
      mine.add(key);
      return true;
    });
    mine.forEach((k) => covered.add(k));
    // Floors confirmed on the sheet screen are authoritative (no "קומה לא ודאית").
    const floorReasons = (d: Detection) => (floorOf(d) === "unknown" && !confirmed ? [UNSURE_FLOOR] : []);

    if (disc === "electrical") {
      for (const d of dets) {
        const code = CLASS_TO_CODE[d.class];
        if (!code) continue;
        const merged = code === "4.05" && d.class !== "data_point" ? [DEFAULT_RULE] : [];
        add(code, `r_class_${d.class}`, s.row, floorOf(d), 1, [d], [...floorReasons(d), ...merged], null);
      }
    } else {
      const graph = s.links ?? synthesizeLinks(dets);
      links.set(s.row.sheet.id, graph);
      const byId = new Map(dets.map((d) => [d.id, d]));
      for (const g of graph.groups) {
        const cc = compositeCode(g);
        const members = [...g.switchIds, ...g.luminaireIds].map((id) => byId.get(id)).filter((d): d is Detection => Boolean(d));
        if (!cc || !members.length) continue;
        const floor = floorOf(members[0]!);
        add(cc.code, cc.rule, s.row, floor, 1, members, [...g.reasons, ...floorReasons(members[0]!)], g.id);
        const a = acc.get(cc.code)!;
        a.levels.push(g.level);
      }
      // Lighting install line: luminaire positions, excluding fans and client-supplied / existing.
      for (const d of dets)
        if (LUMINAIRES.has(d.class) && d.supply !== "client" && d.supply !== "existing" && d.lifecycle !== "existing")
          add("9.01", "r_install_count", s.row, floorOf(d), 1, [d], floorReasons(d), null);
    }
  }

  const lines: BoqLine[] = [];
  const evidence: Record<string, BoqEvidenceItem[]> = {};
  for (const a of acc.values()) {
    const item = lib.get(a.code);
    const id = `bl_${a.code.replace(/[^0-9A-Za-z]/g, "_")}`;
    lines.push({
      id,
      chapter: item?.chapter ?? a.code.split(".")[0]!.padStart(2, "0"),
      chapterTitle: item?.chapterTitle ?? null,
      code: a.code,
      description: item?.description ?? a.code,
      qty: a.qty,
      qtyOverride: null,
      unit: item?.unit ?? "יחידה",
      level: minLevel(a.levels),
      reasons: [...a.reasons].slice(0, 6),
      evidenceRef: `boq/evidence.json.gz#${id}`,
      status: "draft",
      note: null,
      byFloor: a.byFloor,
      evidenceCount: a.evidence.length,
      ruleId: a.ruleId,
      sourceVersions: [...a.versions].map(([sheetId, versionId]) => ({ sheetId, versionId })),
      computedAt,
    });
    evidence[id] = a.evidence;
  }
  return { lines, evidence, links };
}
