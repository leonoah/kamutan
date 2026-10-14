import type { BoqBreakdownRow, BoqEvidenceItem, BoqLine, Correction, DbLevel, Detection, LibraryItem, Room, RoomSettings, SheetRow } from "./types";
import { CLASS_TO_CODE, PLUMBING_CLASS_TO_CODE, PLUMBING_ONE_OFFS } from "@/test/fixtures/boq";
import { isActive, manualItems } from "@/features/corrections/model";
import { defaultSettings, needsTilingSettings, roomTypeOf, settingsDocId, tilingContributions } from "@/features/tiling/model";
import { isCompositeLine } from "@/features/boq/model";

/**
 * MOCK ONLY — Sprint-4 stand-in for Worker-BOQ: plumbing points (chapter 03), tiling (chapter 05) from rooms +
 * room settings, and human corrections applied on top of the automatic lines (manual adds / rejects / reclassifies,
 * manual counts and measures) with `manualCount` for the receipt "16 = 14 שזוהו + 2 ידני".
 */

const LEVEL_RANK: Record<DbLevel, number> = { green: 2, yellow: 1, red: 0 };
const minLevel = (ls: Iterable<DbLevel>): DbLevel => {
  let out: DbLevel = "green";
  for (const l of ls) if (LEVEL_RANK[l] < LEVEL_RANK[out]) out = l;
  return out;
};
const dist = (a: Detection, b: Detection) => Math.hypot(a.centerMm.x - b.centerMm.x, a.centerMm.y - b.centerMm.y);
const r2 = (n: number) => Math.round(n * 100) / 100;
export const lineIdOf = (code: string) => `bl_${code.replace(/[^0-9A-Za-z]/g, "_")}`;

export interface S4Sheet {
  row: SheetRow;
  detections: Detection[];
  rooms: Room[];
}

function lineFrom(lib: Map<string, LibraryItem>, code: string, computedAt: string, patch: Partial<BoqLine>): BoqLine {
  const item = lib.get(code);
  const id = lineIdOf(code);
  return {
    id,
    chapter: item?.chapter ?? code.split(".")[0]!.padStart(2, "0"),
    chapterTitle: item?.chapterTitle ?? null,
    code,
    description: item?.description ?? code,
    qty: 0,
    qtyOverride: null,
    unit: item?.unit ?? "יחידה",
    level: "yellow",
    reasons: [],
    evidenceRef: `boq/evidence.json.gz#${id}`,
    status: "draft",
    note: null,
    byFloor: {},
    evidenceCount: 0,
    ruleId: null,
    sourceVersions: [],
    computedAt,
    ...patch,
  };
}

/** Basin → 3.02 when a wall faucet is drawn next to it (≤ 30 mm paper ≈ 1.5 m at 1:50), else 3.03 (flower faucet). */
export function plumbingCodeOf(d: Detection, sameSheet: readonly Detection[]): string | null {
  if (d.class === "fixture_basin") return sameSheet.some((f) => f.class === "faucet_wall" && dist(f, d) <= 30) ? "3.02" : "3.03";
  return PLUMBING_CLASS_TO_CODE[d.class] || null;
}

/**
 * Plumbing: fixtures from plumbing sheets (one sheet per floor), AC positions (ac_unit) from electrical sheets;
 * showers / baths count once per room; one-off feeds and pumps are suggested from the template (yellow).
 */
export function computePlumbing(sheets: readonly S4Sheet[], library: readonly LibraryItem[], computedAt: string) {
  const lib = new Map(library.filter((i) => i.active).map((i) => [i.code, i]));
  type PAcc = {
    qty: number;
    byFloor: Record<string, number>;
    levels: DbLevel[];
    reasons: Set<string>;
    ev: BoqEvidenceItem[];
    versions: Map<string, string>;
  };
  const acc = new Map<string, PAcc>();
  const add = (code: string, row: SheetRow, d: Detection, floor: string) => {
    const a: PAcc = acc.get(code) ?? { qty: 0, byFloor: {}, levels: [], reasons: new Set<string>(), ev: [], versions: new Map() };
    a.qty += 1;
    a.byFloor[floor] = (a.byFloor[floor] ?? 0) + 1;
    a.levels.push(d.level);
    d.reasons.forEach((r) => a.reasons.add(r));
    a.ev.push({ sheetId: row.sheet.id, versionId: row.version?.id ?? "v1", detectionId: d.id, linkGroupId: null, floor });
    a.versions.set(row.sheet.id, row.version?.id ?? "v1");
    acc.set(code, a);
  };
  const covered = new Set<string>();
  const ordered = [...sheets].sort(
    (a, b) => (a.row.sheet.floors?.length ?? 9) - (b.row.sheet.floors?.length ?? 9) || a.row.sheet.id.localeCompare(b.row.sheet.id),
  );
  for (const s of ordered) {
    const disc = s.row.sheet.discipline;
    if (disc !== "plumbing" && disc !== "electrical") continue;
    const floors = s.row.sheet.floors ?? [];
    const floorOf = (d: Detection) => d.floor ?? (floors.length === 1 ? floors[0]! : "unknown");
    const mine = new Set<string>();
    const showerRooms = new Set<string>();
    for (const d of s.detections) {
      if (d.lifecycle === "demolish" || d.class === "unknown") continue;
      if (disc === "electrical" && d.class !== "ac_unit") continue;
      if (disc === "plumbing" && d.class === "ac_unit") continue;
      const code = plumbingCodeOf(d, s.detections);
      if (!code) continue;
      const key = `${disc}/${floorOf(d)}`;
      if (covered.has(key) && !mine.has(key)) continue;
      mine.add(key);
      if ((code === "3.11" || code === "3.12") && d.roomId) {
        const k = `${code}/${d.roomId}`;
        if (showerRooms.has(k)) continue;
        showerRooms.add(k);
      }
      add(code, s.row, d, floorOf(d));
    }
    mine.forEach((k) => covered.add(k));
  }
  const lines: BoqLine[] = [];
  const evidence: Record<string, BoqEvidenceItem[]> = {};
  for (const [code, a] of acc) {
    const l = lineFrom(lib, code, computedAt, {
      qty: a.qty,
      level: minLevel(a.levels),
      reasons: [...a.reasons].slice(0, 6),
      byFloor: a.byFloor,
      evidenceCount: a.ev.length,
      ruleId: `r_plumb_${code.replace(".", "_")}`,
      sourceVersions: [...a.versions].map(([sheetId, versionId]) => ({ sheetId, versionId })),
    });
    lines.push(l);
    evidence[l.id] = a.ev;
  }
  if (acc.size)
    for (const code of PLUMBING_ONE_OFFS)
      if (lib.has(code))
        lines.push(lineFrom(lib, code, computedAt, { qty: 1, level: "yellow", reasons: ["הוצע מתבנית — לאשר"], ruleId: "r_plumb_template" }));
  return { lines, evidence };
}

/** Tiling authority: per floor, the rooms of the best discipline (architecture master > construction > plumbing > any). */
const ROOM_AUTHORITY = ["architecture_master", "construction", "plumbing", "electrical", "lighting"];
export function authoritativeRooms(sheets: readonly S4Sheet[]): { row: SheetRow; room: Room }[] {
  const byFloor = new Map<string, { rank: number; items: { row: SheetRow; room: Room }[] }>();
  for (const s of sheets) {
    const rank = ROOM_AUTHORITY.indexOf(s.row.sheet.discipline ?? "");
    if (rank < 0) continue;
    for (const room of s.rooms) {
      const f = room.floor ?? "unknown";
      const cur = byFloor.get(f);
      if (!cur || rank < cur.rank) byFloor.set(f, { rank, items: [{ row: s.row, room }] });
      else if (rank === cur.rank) {
        const dup = cur.items.some((x) => x.room.name === room.name && Math.abs(x.room.areaM2 - room.areaM2) <= 0.05 * Math.max(1, room.areaM2));
        if (!dup) cur.items.push({ row: s.row, room });
      }
    }
  }
  return [...byFloor.values()].flatMap((v) => v.items);
}

/** Tiling lines (5.01 cladding, 5.02 floor, 5.03 corners, 5.05 waterproofing, 5.06/5.07 partial). */
export function computeTiling(
  sheets: readonly S4Sheet[],
  settings: ReadonlyMap<string, RoomSettings>,
  library: readonly LibraryItem[],
  computedAt: string,
) {
  const lib = new Map(library.filter((i) => i.active).map((i) => [i.code, i]));
  type TAcc = {
    qty: number;
    order: number;
    waste: number | null;
    byFloor: Record<string, number>;
    rows: BoqBreakdownRow[];
    levels: DbLevel[];
    reasons: Set<string>;
    versions: Map<string, string>;
  };
  const acc = new Map<string, TAcc>();
  for (const { row, room } of authoritativeRooms(sheets)) {
    const saved = settings.get(settingsDocId(row.sheet.id, room.id)) ?? null;
    if (!saved && !needsTilingSettings(room)) continue;
    const s = saved ?? defaultSettings(room);
    const label = `${room.name ?? "חדר ללא שם"}${room.floor ? ` · ${room.floor}` : ""}`;
    for (const c of tilingContributions(room, s)) {
      const a: TAcc = acc.get(c.code) ?? {
        qty: 0,
        order: 0,
        waste: null,
        byFloor: {},
        rows: [],
        levels: [],
        reasons: new Set<string>(),
        versions: new Map(),
      };
      a.qty += c.qty;
      a.order += c.waste !== null ? c.qty * (1 + c.waste) : c.qty;
      if (c.waste !== null) a.waste = c.waste;
      const f = room.floor ?? "unknown";
      a.byFloor[f] = r2((a.byFloor[f] ?? 0) + c.qty);
      a.rows.push({ label, qty: r2(c.qty), formula: c.formula, sheetId: row.sheet.id, roomId: room.id });
      // Human-confirmed settings are verified; defaults stay "סביר" until someone looks at the room.
      a.levels.push(saved ? "green" : room.level === "red" ? "red" : "yellow");
      if (!saved) a.reasons.add(c.code === "5.01" ? "גובה חיפוי ברירת מחדל" : "הגדרות חדר ברירת מחדל");
      if (room.level === "red") a.reasons.add("חדר לא סגור");
      a.versions.set(row.sheet.id, row.version?.id ?? "v1");
      acc.set(c.code, a);
    }
  }
  return [...acc].map(([code, a]) =>
    lineFrom(lib, code, computedAt, {
      qty: r2(a.qty),
      level: minLevel(a.levels),
      reasons: [...a.reasons],
      byFloor: a.byFloor,
      evidenceCount: a.rows.length,
      ruleId: `r_tiling_${code.replace(".", "_")}`,
      sourceVersions: [...a.versions].map(([sheetId, versionId]) => ({ sheetId, versionId })),
      wasteFactor: a.waste,
      orderQty: a.waste !== null ? r2(a.order) : null,
      breakdown: a.rows,
    }),
  );
}

/** Item code of a detection class (electrical / plumbing). */
export const codeOfClass = (cls: string, sameSheet: readonly Detection[] = [], d?: Detection): string | null =>
  CLASS_TO_CODE[cls] ?? (d ? plumbingCodeOf({ ...d, class: cls }, sameSheet) : PLUMBING_CLASS_TO_CODE[cls] || null);

/**
 * Human corrections on top of automatic lines: compares the raw detections with the corrected ones per sheet.
 * Rejected items leave their (non-composite) line; added / reclassified ones join the line of their class (manual);
 * accepted evidence turns a line green when all its items on loaded sheets are verified; manual counts / measures
 * add their quantity to `itemCode`. Composite lighting lines (switch groups) are not re-derived here.
 */
export function applyCorrectionDeltas(
  base: { lines: BoqLine[]; evidence: Record<string, BoqEvidenceItem[]> },
  perSheet: ReadonlyMap<string, { row: SheetRow; raw: readonly Detection[]; corrected: readonly Detection[] }>,
  corrections: readonly Correction[],
  library: readonly LibraryItem[],
  computedAt: string,
): { lines: BoqLine[]; evidence: Record<string, BoqEvidenceItem[]> } {
  const lib = new Map(library.filter((i) => i.active).map((i) => [i.code, i]));
  const lines = new Map(base.lines.map((l) => [l.id, { ...l, byFloor: { ...l.byFloor }, manualCount: l.manualCount ?? 0 }]));
  const evidence: Record<string, BoqEvidenceItem[]> = Object.fromEntries(
    Object.entries(base.evidence).map(([k, v]) => [k, v.map((e) => ({ ...e }))]),
  );
  const byCode = new Map([...lines.values()].map((l) => [l.code, l]));
  const lineFor = (code: string) => {
    let l = byCode.get(code);
    if (!l) {
      l = { ...lineFrom(lib, code, computedAt, { level: "green", ruleId: "r_manual" }), manualCount: 0 };
      lines.set(l.id, l);
      byCode.set(code, l);
      evidence[l.id] = [];
    }
    return l;
  };
  const bump = (l: BoqLine, floor: string, n: number, manual: boolean) => {
    l.qty = r2(Math.max(0, l.qty + n));
    l.byFloor[floor] = r2(Math.max(0, (l.byFloor[floor] ?? 0) + n));
    if (manual) l.manualCount = r2((l.manualCount ?? 0) + n);
  };
  const evLines = (sheetId: string, detId: string) =>
    Object.entries(evidence)
      .filter(([, items]) => items.some((e) => e.sheetId === sheetId && e.detectionId === detId))
      .map(([id]) => lines.get(id))
      .filter((l): l is BoqLine & { manualCount: number } => Boolean(l));

  for (const [sheetId, s] of perSheet) {
    const raw = new Map(s.raw.map((d) => [d.id, d]));
    const versionId = s.row.version?.id ?? "v1";
    const floorOf = (d: Detection) => d.floor ?? (s.row.sheet.floors?.length === 1 ? s.row.sheet.floors[0]! : "unknown");
    for (const d of s.corrected) {
      const before = raw.get(d.id);
      const drop = (l: BoqLine) => {
        if (isCompositeLine(l)) return;
        bump(l, floorOf(d), -1, false);
        evidence[l.id] = (evidence[l.id] ?? []).filter((e) => !(e.sheetId === sheetId && e.detectionId === d.id));
        l.evidenceCount = evidence[l.id]!.length;
      };
      const join = (cls: string, manual: boolean) => {
        const code = codeOfClass(cls, s.corrected, d);
        if (!code) return;
        const l = lineFor(code);
        bump(l, floorOf(d), 1, manual);
        (evidence[l.id] ??= []).push({ sheetId, versionId, detectionId: d.id, linkGroupId: null, floor: floorOf(d) });
        l.evidenceCount = evidence[l.id]!.length;
        if (!l.sourceVersions.some((v) => v.sheetId === sheetId)) l.sourceVersions = [...l.sourceVersions, { sheetId, versionId }];
      };
      if (!before) {
        if (!d.rejected && d.manual === "added") join(d.class, true);
        continue;
      }
      if (d.rejected) evLines(sheetId, d.id).forEach(drop);
      else if (d.class !== before.class) {
        const old = evLines(sheetId, d.id);
        old.forEach(drop);
        // Only re-home items that counted before (or are plumbing/electrical classes with a line).
        join(d.class, false);
      }
    }
  }
  // A (non-composite) line whose evidence is all human-verified now turns green ("אושר ידנית").
  const levelOf = new Map<string, DbLevel>();
  for (const [sheetId, s] of perSheet) for (const d of s.corrected) levelOf.set(`${sheetId}/${d.id}`, d.level);
  const touched = corrections.some((c) => isActive(c) && (c.kind === "accept" || c.kind === "reclassify" || c.kind === "add"));
  if (touched)
    for (const l of lines.values()) {
      if (isCompositeLine(l)) continue;
      const items = evidence[l.id] ?? [];
      if (items.length && items.every((e) => levelOf.get(`${e.sheetId}/${e.detectionId}`) === "green") && l.level !== "green") {
        l.level = "green";
        l.reasons = ["אושר ידנית"];
      }
    }
  // Manual counts / measures → their line.
  for (const m of manualItems(corrections.filter(isActive))) {
    if (!m.itemCode) continue;
    const l = lineFor(m.itemCode);
    bump(l, m.correction.floor ?? "unknown", m.quantity, false);
    l.manualCount = (l.manualCount ?? 0) + (m.kind === "count" ? m.quantity : 1);
    l.breakdown = [
      ...(l.breakdown ?? []),
      {
        label: m.kind === "count" ? "ספירה ידנית" : m.kind === "area" ? "מדידת שטח ידנית" : "מדידת אורך ידנית",
        qty: r2(m.quantity),
        sheetId: m.sheetId,
        manual: true,
      },
    ];
    if (l.wasteFactor !== undefined && l.wasteFactor !== null) l.orderQty = r2(l.qty * (1 + l.wasteFactor));
  }
  return { lines: [...lines.values()].filter((l) => l.qty > 0 || (l.manualCount ?? 0) > 0 || base.lines.some((b) => b.id === l.id)), evidence };
}

export { roomTypeOf };

/**
 * When Worker-BOQ's own tiling lines are the base (dev), a saved room setting is layered on as a delta: what the
 * room adds with the user's settings minus what it added with the type defaults, per line, plus a breakdown row.
 * (The real worker recomputes the chapter from roomSettings; this keeps the mock's numbers anchored to its lines.)
 */
export function applyRoomSettingsDeltas(
  lines: BoqLine[],
  sheets: readonly S4Sheet[],
  settings: ReadonlyMap<string, RoomSettings>,
  library: readonly LibraryItem[],
  computedAt: string,
): BoqLine[] {
  if (!settings.size) return lines;
  const lib = new Map(library.filter((i) => i.active).map((i) => [i.code, i]));
  const out = new Map(lines.map((l) => [l.code, { ...l, byFloor: { ...l.byFloor }, breakdown: [...(l.breakdown ?? [])] }]));
  for (const s of sheets)
    for (const room of s.rooms) {
      const saved = settings.get(settingsDocId(s.row.sheet.id, room.id));
      if (!saved) continue;
      const before = new Map(tilingContributions(room, defaultSettings(room)).map((c) => [c.code, c]));
      const after = new Map(tilingContributions(room, saved).map((c) => [c.code, c]));
      const label = room.name ?? "חדר ללא שם";
      for (const code of new Set([...before.keys(), ...after.keys()])) {
        const d = (after.get(code)?.qty ?? 0) - (before.get(code)?.qty ?? 0);
        let l = out.get(code);
        if (!l) {
          if (d <= 0) continue;
          l = { ...lineFrom(lib, code, computedAt, { ruleId: "r_tiling_settings" }), breakdown: [] };
          out.set(code, l);
        }
        const f = room.floor ?? "unknown";
        l.qty = r2(Math.max(0, l.qty + d));
        l.byFloor[f] = r2(Math.max(0, (l.byFloor[f] ?? 0) + d));
        const a = after.get(code);
        if (a) l.breakdown!.push({ label: `${label} (הגדרות חדר)`, qty: r2(a.qty), formula: a.formula, sheetId: s.row.sheet.id, roomId: room.id });
        if (l.wasteFactor != null || a?.waste != null) {
          l.wasteFactor = l.wasteFactor ?? a?.waste ?? null;
          l.orderQty = l.wasteFactor != null ? r2(l.qty * (1 + l.wasteFactor)) : null;
        }
        l.level = "green";
        l.reasons = (l.reasons ?? []).filter((r) => !/ברירת מחדל/.test(r));
      }
    }
  return [...out.values()];
}
