import type { PointMm, Room, RoomOpening, RoomSettings, RoomType, RoomWall } from "@/api/types";

/**
 * Pure tiling model (brief §Room settings + spec "חיפוי": היקף × גובה פחות פתחים): room type / wet guesses for
 * artifacts that predate Worker-B's Sprint-4 fields, default settings by type, walls derived from the polygon,
 * and the quantities a room contributes to chapter 05 (floor m², cladding m², corner trim m', waterproofing).
 */

export const WET_TYPES: readonly RoomType[] = ["bathroom", "wc"];

const NAME_RULES: [RegExp, RoomType][] = [
  [/רחצה|מקלחת|אמבט/, "bathroom"],
  [/שירותים|שרותים|ש\.?\s?אורחים|WC/i, "wc"],
  [/מטבח/, "kitchen"],
  [/חצר אנגלית|חצר/, "courtyard"],
  [/מרפסת/, "balcony"],
  [/חדר שינה|שינה|הורים|ילדים|עבודה/, "bedroom"],
  [/סלון|פינת אוכל|משפחה|משחקים/, "living"],
  [/מסדרון|פרוזדור|כניסה|מבואה/, "corridor"],
  [/מחסן|ארונות|כביסה|ממ"ד|ממד/, "storage"],
  [/מדרגות/, "stairs"],
];

/** Room type: the worker's when present, else guessed from the (first) name in the label ("חדר רחצה" → bathroom). */
export function roomTypeOf(room: Pick<Room, "name" | "type">, override?: RoomType | null): RoomType {
  if (override) return override;
  if (room.type) return room.type;
  const name = (room.name ?? "").split("/")[0] ?? "";
  return NAME_RULES.find(([re]) => re.test(name))?.[1] ?? "other";
}
/** contracts WET_ROOM_TYPES: bathroom / wc (kitchens get a backsplash only where the user marks it). */
export const isWetType = (t: RoomType) => t === "bathroom" || t === "wc";
/** Rooms whose tiling inputs a reviewer must confirm (wet rooms + courtyards: floor tiling). */
export const needsTilingSettings = (room: Pick<Room, "name" | "type" | "wet">) => isWet(room) || roomTypeOf(room) === "courtyard";
export function isWet(room: Pick<Room, "name" | "type" | "wet">, s?: Pick<RoomSettings, "type"> | null): boolean {
  if (s?.type) return isWetType(s.type);
  if (room.wet !== undefined) return room.wet;
  return isWetType(roomTypeOf(room));
}

/**
 * Defaults by room type (brief + contracts defaultRoomSettings): bathroom / wc (or an untyped wet room) → cladding
 * 2.6 m, floor tiled, waterproofed; courtyard → floor only; kitchen → nothing until the user marks counter walls.
 */
export function defaultSettings(room: Pick<Room, "name" | "type" | "wet">, type?: RoomType | null): RoomSettings {
  const t = roomTypeOf(room, type);
  const bath = t === "bathroom" || t === "wc" || ((t === "other" || !t) && room.wet === true);
  return {
    claddingHeightM: bath ? 2.6 : 0,
    floorTiled: bath || t === "courtyard",
    floorMaterialItemCode: bath || t === "courtyard" ? "5.02" : null,
    wallMaterialItemCode: bath ? "5.01" : null,
    partialCladding: [],
    wasteFactor: 0.07,
    includeInWaterproofing: bath,
  };
}

const lenMm = (a: PointMm, b: PointMm) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Walls: the worker's (`room.walls`) or the polygon edges, with nearly collinear edges merged and stubs under
 * 0.25 m dropped. `scale` = sheet 1:n (paper mm → real m: mm × n / 1000).
 */
export function wallsOf(room: Pick<Room, "id" | "polygonMm" | "walls">, scale: number | null | undefined): RoomWall[] {
  if (room.walls?.length) return room.walls;
  const n = scale ?? 50;
  const pts = room.polygonMm;
  if (pts.length < 3) return [];
  // merge collinear runs
  const merged: PointMm[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = merged[merged.length - 1] ?? pts[pts.length - 1]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % pts.length]!;
    const ax = cur.x - prev.x;
    const ay = cur.y - prev.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const cross = Math.abs(ax * by - ay * bx) / ((Math.hypot(ax, ay) || 1) * (Math.hypot(bx, by) || 1));
    if (merged.length && cross < 0.05) continue; // cur is (almost) on the line prev→next
    merged.push(cur);
  }
  const walls: RoomWall[] = [];
  for (let i = 0; i < merged.length; i++) {
    const a = merged[i]!;
    const b = merged[(i + 1) % merged.length]!;
    const lengthM = (lenMm(a, b) * n) / 1000;
    if (lengthM < 0.25) continue;
    walls.push({ id: `w_${room.id}_${walls.length + 1}`, aMm: a, bMm: b, lengthM: Math.round(lengthM * 100) / 100, exterior: false });
  }
  return walls;
}

export const openingsOf = (room: Pick<Room, "openings">): RoomOpening[] => room.openings ?? [];

/** Defaults when an opening has no height: doors 2.1 m; windows 1.2 m high from a 1.0 m sill. */
export function openingAreaWithin(o: RoomOpening, claddingHeightM: number): number {
  if (claddingHeightM <= 0) return 0;
  if (o.kind === "window") {
    const sill = 1.0;
    const h = Math.max(0, Math.min(o.heightM ?? 1.2, claddingHeightM - sill));
    return o.widthM * h;
  }
  return o.widthM * Math.min(o.heightM ?? 2.1, claddingHeightM);
}

export interface TilingQuantities {
  type: RoomType;
  wet: boolean;
  areaM2: number;
  perimeterM: number;
  /** Floor tiling (m²). */
  floorM2: number;
  /** Full-height cladding: perimeter × height (gross), openings deducted, net. */
  claddingGrossM2: number;
  openingsM2: number;
  claddingNetM2: number;
  /** Partial cladding Σ (to − from) × height. */
  partialM2: number;
  /** External corners × cladding height (m'). */
  cornersM: number;
  waterproofing: number;
  waste: number;
  /** Order quantity of all m² items (× (1 + waste)). */
  orderM2: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function tilingQuantities(room: Room, s: RoomSettings): TilingQuantities {
  const type = roomTypeOf(room, s.type);
  const wet = isWet(room, s);
  const h = Math.max(0, s.claddingHeightM);
  const excluded = new Set(s.keepOpenings ?? []);
  const openingsM2 =
    h > 0
      ? openingsOf(room)
          .filter((o) => !excluded.has(o.id))
          .reduce((sum, o) => sum + openingAreaWithin(o, h), 0)
      : 0;
  const claddingGrossM2 = room.perimeterM * h;
  const claddingNetM2 = Math.max(0, claddingGrossM2 - openingsM2);
  const partialM2 = s.partialCladding.reduce((sum, p) => sum + Math.max(0, p.toM - p.fromM) * Math.max(0, p.heightM), 0);
  const floorM2 = s.floorTiled ? room.areaM2 : 0;
  const cornersM = (room.externalCorners ?? 0) * h;
  const m2 = floorM2 + claddingNetM2 + partialM2;
  return {
    type,
    wet,
    areaM2: room.areaM2,
    perimeterM: room.perimeterM,
    floorM2: r2(floorM2),
    claddingGrossM2: r2(claddingGrossM2),
    openingsM2: r2(openingsM2),
    claddingNetM2: r2(claddingNetM2),
    partialM2: r2(partialM2),
    cornersM: r2(cornersM),
    waterproofing: s.includeInWaterproofing ? 1 : 0,
    waste: s.wasteFactor,
    orderM2: r2(m2 * (1 + s.wasteFactor)),
  };
}

/** Line codes of the tiling chapter (client sample BOQ 5.xx). */
export const TILING_CODES = {
  cladding: "5.01",
  floor: "5.02",
  corners: "5.03",
  waterproofing: "5.05",
  kitchenPartial: "5.06",
  otherPartial: "5.07",
} as const;

/** Where a room's quantities go: [code, qty, unit, formula]. */
export function tilingContributions(
  room: Room,
  s: RoomSettings,
  fmt: (n: number) => string = (n) => String(r2(n)),
): {
  code: string;
  qty: number;
  unit: string;
  formula: string;
  waste: number | null;
}[] {
  const q = tilingQuantities(room, s);
  const out: { code: string; qty: number; unit: string; formula: string; waste: number | null }[] = [];
  if (q.floorM2 > 0) out.push({ code: TILING_CODES.floor, qty: q.floorM2, unit: 'מ"ר', formula: `${fmt(q.floorM2)} מ"ר רצפה`, waste: s.wasteFactor });
  if (q.claddingNetM2 > 0) {
    const f = `${fmt(q.perimeterM)} מ"א × ${fmt(s.claddingHeightM)} מ'${q.openingsM2 > 0 ? ` − ${fmt(q.openingsM2)} מ"ר פתחים` : ""}`;
    out.push({ code: TILING_CODES.cladding, qty: q.claddingNetM2, unit: 'מ"ר', formula: f, waste: s.wasteFactor });
  }
  if (q.partialM2 > 0) {
    const code = q.type === "kitchen" ? TILING_CODES.kitchenPartial : q.claddingNetM2 > 0 ? TILING_CODES.cladding : TILING_CODES.otherPartial;
    out.push({ code, qty: q.partialM2, unit: 'מ"ר', formula: `חיפוי חלקי ${fmt(q.partialM2)} מ"ר`, waste: s.wasteFactor });
  }
  if (q.cornersM > 0)
    out.push({
      code: TILING_CODES.corners,
      qty: q.cornersM,
      unit: 'מ"א',
      formula: `${room.externalCorners} פינות × ${fmt(s.claddingHeightM)} מ'`,
      waste: null,
    });
  if (q.waterproofing) out.push({ code: TILING_CODES.waterproofing, qty: 1, unit: "קומפלט", formula: "איטום רצפה", waste: null });
  return out;
}

export const settingsDocId = (sheetId: string, roomId: string) => `${sheetId}__${roomId}`;
