import type { Detection, DetectionsArtifact, LegendArtifact, LegendArtifactEntry, Room, RoomsArtifact, UnknownCluster } from "@/api/types";

/**
 * Small, deterministic synthetic Sprint-2 artifacts (kamutan.legend/1, detections/1, rooms/1) for tests and for
 * the mock backend until the worker's real artifacts exist in /home/claude/kamutan-data/artifacts.
 * Positions are synthetic (they do not sit on the real symbols of the drawing).
 */

export interface FixtureSpec {
  sheetId: string;
  /** Legend rows: [class | null, label, classConfidence, labelConfidence]. */
  legendRows: [string | null, string, number, number][];
  legendBox: { x: number; y: number; w: number; h: number };
  /** Rooms: [name | null, x, y, w, h, level] (paper mm). */
  rooms: [string | null, number, number, number, number, "green" | "yellow" | "red"][];
  floor: string;
  detections: number;
  unknownClusters: number[];
  scaleDenominator?: number;
  seed?: number;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REASONS_YELLOW = ["התאמה חלקית לסמל", "קיים/חדש לא ודאי", "דומה לסמל אחר"];
const REASONS_RED = ["סמלים חופפים", "התאמה חלקית לסמל", "OCR נמוך"];
const ANNOTATIONS = ["2X", "H=30", "H=110", "IP44", "3X"];

/** Little line-drawing of a symbol as an SVG data URL (stand-in for the worker's webp crops). */
export function symbolThumb(kind: number, unknown = false): string {
  const shapes = [
    '<circle cx="32" cy="32" r="14"/><path d="M18 32h-10M46 32h10"/>',
    '<circle cx="32" cy="32" r="14"/><path d="M32 18v-10"/>',
    '<path d="M18 46h28M32 46v-26M22 30h20"/><circle cx="32" cy="20" r="4"/>',
    '<rect x="16" y="20" width="32" height="24"/><path d="M16 20l32 24"/>',
    '<path d="M14 40a18 18 0 0 1 36 0z"/><path d="M32 22v-10"/>',
    '<circle cx="32" cy="32" r="12"/><path d="M23 23l18 18M41 23l-18 18"/>',
    '<path d="M20 44l12-24 12 24z"/><path d="M32 44v8"/>',
    '<rect x="20" y="20" width="24" height="24"/><circle cx="32" cy="32" r="6"/>',
  ];
  const body = unknown
    ? '<path d="M16 46l16-28 16 28z"/><circle cx="32" cy="38" r="5"/><path d="M12 22h10M42 22h10"/>'
    : shapes[kind % shapes.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" fill="white"/><g fill="none" stroke="black" stroke-width="2">${body}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export interface UnderstandingFixture {
  legend: LegendArtifact;
  detections: DetectionsArtifact;
  rooms: RoomsArtifact;
  /** Crop URLs keyed by entry / cluster id (like OverlayManifest.thumbs). */
  thumbs: Record<string, string>;
}

export function makeUnderstandingFixture(spec: FixtureSpec): UnderstandingFixture {
  const rand = rng(spec.seed ?? 7);
  const scale = spec.scaleDenominator ?? 50;
  const thumbs: Record<string, string> = {};

  // Legend
  const rowH = Math.min(6.5, (spec.legendBox.h - 8) / Math.max(1, spec.legendRows.length));
  const entries: LegendArtifactEntry[] = spec.legendRows.map(([cls, label, cc, lc], i) => {
    const id = `le_${spec.sheetId}_${i + 1}`;
    const y = spec.legendBox.y + 7 + i * rowH;
    thumbs[id] = symbolThumb(i);
    return {
      id,
      legendId: "lg0",
      symbolBboxMm: { x: spec.legendBox.x + spec.legendBox.w - 9, y, w: 6, h: rowH - 1 },
      labelBboxMm: { x: spec.legendBox.x + 2, y, w: spec.legendBox.w - 13, h: rowH - 1 },
      label,
      labelConfidence: lc,
      suggestedClass: cls,
      classConfidence: cc,
      signature: `sig${spec.sheetId.replace(/[^A-Za-z0-9]/g, "")}${i + 1}`.slice(0, 60),
      thumb: `legend/${id}.webp`,
    };
  });
  const legend: LegendArtifact = {
    schema: "kamutan.legend/1",
    legends: [{ id: "lg0", bboxMm: spec.legendBox, title: "מקרא", confidence: 0.92 }],
    entries,
  };

  // Rooms
  const m = (mm: number) => (mm * scale) / 1000;
  const rooms: Room[] = spec.rooms.map(([name, x, y, w, h, level], i) => ({
    id: `r_${i + 1}`,
    name,
    nameConfidence: name ? 0.9 : 0,
    floor: spec.floor,
    polygonMm: [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ],
    areaM2: Math.round(m(w) * m(h) * 10) / 10,
    perimeterM: Math.round(2 * (m(w) + m(h)) * 100) / 100,
    confidence: level === "green" ? 0.9 : level === "yellow" ? 0.7 : 0.4,
    level,
    reasons: level === "green" ? [] : level === "yellow" ? ["OCR נמוך"] : ["חדר לא סגור"],
  }));

  // Detections: along the room walls (inside), classes from the legend rows with a class.
  const known = entries.filter((e) => e.suggestedClass && e.suggestedClass !== "unknown");
  const detections: Detection[] = [];
  const place = (): { x: number; y: number; room: Room } => {
    const room = rooms[Math.floor(rand() * rooms.length)]!;
    const [a, , c] = room.polygonMm as [{ x: number; y: number }, unknown, { x: number; y: number }];
    const inset = 3.5;
    const side = Math.floor(rand() * 4);
    const t = 0.1 + rand() * 0.8;
    const x = side === 0 || side === 2 ? a.x + t * (c.x - a.x) : side === 1 ? c.x - inset : a.x + inset;
    const y = side === 1 || side === 3 ? a.y + t * (c.y - a.y) : side === 0 ? a.y + inset : c.y - inset;
    return { x, y, room };
  };
  for (let i = 0; i < spec.detections; i++) {
    const e = known[Math.floor(Math.pow(rand(), 1.6) * known.length)]!;
    const { x, y, room } = place();
    const r = rand();
    const score = r < 0.62 ? 0.86 + rand() * 0.13 : r < 0.88 ? 0.55 + rand() * 0.29 : 0.25 + rand() * 0.24;
    const level = score >= 0.85 ? "green" : score >= 0.5 ? "yellow" : "red";
    const lr = rand();
    detections.push({
      id: `d_${i + 1}`,
      class: e.suggestedClass!,
      legendEntryId: e.id,
      centerMm: { x, y },
      bboxMm: { x: x - 2.5, y: y - 2.5, w: 5, h: 5 },
      angleDeg: 0,
      score: Math.round(score * 100) / 100,
      level,
      reasons: level === "green" ? [] : [(level === "yellow" ? REASONS_YELLOW : REASONS_RED)[Math.floor(rand() * 3)]!],
      roomId: room.id,
      floor: spec.floor,
      lifecycle: lr < 0.08 ? "existing" : lr < 0.12 ? "demolish" : "new",
      supply: null,
      annotations: rand() < 0.25 ? [ANNOTATIONS[Math.floor(rand() * ANNOTATIONS.length)]!] : [],
      clusterId: null,
    });
  }
  const unknownClusters: UnknownCluster[] = spec.unknownClusters.map((count, ci) => {
    const id = `u_${ci + 1}`;
    thumbs[id] = symbolThumb(ci, true);
    let first: Detection | null = null;
    for (let j = 0; j < count; j++) {
      const { x, y, room } = place();
      const d: Detection = {
        id: `d_${detections.length + 1}`,
        class: "unknown",
        legendEntryId: null,
        centerMm: { x, y },
        bboxMm: { x: x - 3, y: y - 3, w: 6, h: 6 },
        angleDeg: 0,
        score: 0.3,
        level: "red",
        reasons: ["סמל לא במקרא"],
        roomId: room.id,
        floor: spec.floor,
        lifecycle: "new",
        supply: null,
        annotations: [],
        clusterId: id,
      };
      first ??= d;
      detections.push(d);
    }
    return { id, signature: `unk${ci + 1}${spec.sheetId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 60), count, exemplarBboxMm: first!.bboxMm, thumb: `unknown/${id}.webp` };
  });

  return {
    legend,
    detections: { schema: "kamutan.detections/1", detections, unknownClusters },
    rooms: { schema: "kamutan.rooms/1", rooms },
    thumbs,
  };
}

/** Electrical ground floor (noah-eb8be8a3-p0, A3 landscape 420 × 297 mm). */
export const ELECTRICAL_SPEC: FixtureSpec = {
  sheetId: "noah-eb8be8a3-p0",
  floor: "ground",
  legendBox: { x: 12, y: 197, w: 91, h: 53 },
  legendRows: [
    ["socket_double", "שקע כפול", 0.93, 0.95],
    ["socket_single", "שקע בודד", 0.91, 0.94],
    ["socket_power", "שקע כח 16A", 0.88, 0.9],
    ["data_point", "נק' רשת", 0.9, 0.88],
    ["tv_point", "נק' TV", 0.86, 0.92],
    ["socket_triple", "שלישיית שקעים בהרכבה 3X", 0.62, 0.81],
    ["heater_feed", "הזנה לדוד חשמל", 0.71, 0.66],
    [null, "אביזר מוגן מים IP44", 0.3, 0.58],
  ],
  rooms: [
    ["סלון", 112, 30, 118, 88, "green"],
    ["מטבח", 230, 30, 72, 60, "green"],
    ["חדר שינה", 302, 30, 100, 88, "green"],
    ["שירותים", 230, 90, 36, 28, "yellow"],
    ["מקלחת", 266, 90, 36, 28, "green"],
    ["מסדרון", 112, 118, 290, 22, "yellow"],
    ["חדר עבודה", 112, 140, 98, 82, "green"],
    ["ממ״ד", 210, 140, 88, 82, "green"],
    [null, 298, 140, 104, 82, "red"],
  ],
  detections: 140,
  unknownClusters: [7, 3],
  seed: 11,
};

/** Lighting ground floor (noah-b2046277-p0). */
export const LIGHTING_SPEC: FixtureSpec = {
  sheetId: "noah-b2046277-p0",
  floor: "ground",
  legendBox: { x: 14, y: 30, w: 80, h: 46 },
  legendRows: [
    ["luminaire_ceiling", "גוף תאורה תקרתי", 0.92, 0.93],
    ["luminaire_wall", "גוף תאורה קיר", 0.89, 0.9],
    ["switch_single", "מפסק", 0.9, 0.95],
    ["switch_2way", "מחליף", 0.8, 0.91],
    ["luminaire_strip", "פס לד", 0.55, 0.62],
  ],
  rooms: [
    ["סלון", 112, 30, 118, 88, "green"],
    ["מטבח", 230, 30, 72, 60, "green"],
    ["חדר שינה", 302, 30, 100, 88, "green"],
    ["מסדרון", 112, 118, 290, 22, "yellow"],
  ],
  detections: 60,
  unknownClusters: [4],
  seed: 5,
};
