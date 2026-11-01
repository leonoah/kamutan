import type { BBoxMm, BoqEvidenceItem, BoqLine, BoqLineOrigin, BoqQuickActionKind, DbLevel, LibraryItem, PointMm } from "./types";
import type { S4Sheet } from "./mockSprint4Engine";

/**
 * MOCK stand-in for Sprint 6 Worker-Text / Worker-Geometry / Worker-BOQ (SPRINT6_BRIEF): every line of the client's
 * BOQ is present. Lines the drawings carry are produced from `text` evidence (notes, callouts, legend rows) or
 * `geometry` / `stair` evidence; the rest are *suggested* ("להשלמה ידנית") with a quick action. Runs in both data modes
 * (the Noah worker artifacts or the synthetic fixture): the evidence is anchored on the electrical sheet's own
 * detections and rooms, so it lands on the drawing. Codes the base already has are never touched.
 *
 * The real lines arrive with `origin` / `needsInput` / `quickAction` from Worker-BOQ; this only fills the gap until then.
 */

interface S6Item {
  code: string;
  origin: Extract<BoqLineOrigin, "text" | "geometry" | "suggested">;
  /** text: matched string (the evidence label) */
  text?: string;
  /** text: how many matches (qty) */
  count?: number;
  /** geometry: which shape */
  shape?: "partition" | "valance" | "stair";
  /** suggested */
  quick?: BoqQuickActionKind;
  /** suggested: estimator (null → "להשלמה ידנית" with no quantity) */
  estimate?: number | null;
  reason?: string;
}

/** Generic, as the default library: no client wording. */
export const S6_ITEMS: S6Item[] = [
  { code: "4.17", origin: "text", text: "הזנה לתנור + מפסק", count: 3 },
  { code: "4.18", origin: "text", text: "נק' אינטרקום", count: 1 },
  { code: "4.23", origin: "text", text: "דוד + טיימר", count: 1 },
  { code: "4.24", origin: "text", text: "לוח 14 מודול + מונה משני", count: 1 },
  { code: "4.25", origin: "text", text: "לוח תקשורת", count: 1 },
  { code: "9.03", origin: "text", text: "צינור אוורור 4 אינץ'", count: 1 },
  { code: "5.04", origin: "geometry", shape: "stair" },
  { code: "7.05", origin: "geometry", shape: "valance" },
  { code: "7.06", origin: "geometry", shape: "partition" },
  { code: "2.01", origin: "suggested", quick: "measure_area", estimate: null, reason: "בגיליון הבנייה מסומנת חצר אנגלית חדשה. מדדו את קירות התמך." },
  { code: "2.02", origin: "suggested", quick: "confirm", estimate: 1, reason: "יש קומת מרתף בפרויקט. אשרו את רצפת המרתף והמדרגות." },
  { code: "2.03", origin: "suggested", quick: "measure_area", estimate: null, reason: "בתכנית ההריסה מסומן פתח לסגירה בבלוקים." },
  { code: "5.06", origin: "suggested", quick: "measure_area", estimate: null, reason: "במטבח לא שורטט חיפוי. מדדו את שטח החיפוי." },
  { code: "5.07", origin: "suggested", quick: "measure_area", estimate: null, reason: "חיפוי חלקי בשירותי האורחים אינו משורטט." },
  { code: "5.08", origin: "suggested", quick: "confirm", estimate: 1, reason: "בגיליון הבנייה יש קירות חצר. אשרו איטום קומפלט." },
  { code: "7.01", origin: "suggested", quick: "measure_area", estimate: null, reason: "אין תכנית תקרה בסט. מדדו את שטח תקרת הגבס." },
  { code: "7.02", origin: "suggested", quick: "measure_length", estimate: null, reason: "סמל ונטה בתכנית החשמל. מדדו את סינר הגבס." },
  { code: "7.03", origin: "suggested", quick: "measure_area", estimate: null, reason: "חלון קיים לסגירה מבפנים. מדדו את השטח." },
  { code: "7.04", origin: "suggested", quick: "count", estimate: null, reason: "פתחי שירות בגבס אינם משורטטים. ספרו אותם." },
  { code: "7.07", origin: "suggested", quick: "measure_area", estimate: null, reason: "קיר כפול בין היחידה לחדר המדרגות. מדדו את השטח." },
  { code: "8.01", origin: "suggested", quick: "confirm", estimate: 1, reason: "יש עבודות הריסה בפרויקט. תיקונים אחריהן נמדדים כקומפלט." },
  { code: "8.02", origin: "suggested", quick: "measure_area", estimate: null, reason: "קירות חצר וקיר בלוקים חדש. מדדו את שטח הטיח." },
  { code: "8.03", origin: "suggested", quick: "confirm", estimate: 1, reason: "צביעת פנים כללית. אשרו קומפלט." },
  { code: "8.04", origin: "suggested", quick: "confirm", estimate: 1, reason: "שפכטל אמריקאי בקומת הקרקע. אשרו קומפלט." },
];

export const s6LineId = (code: string) => `bl_s6_${code.replace(/[^0-9A-Za-z]/g, "_")}`;
const r1 = (n: number) => Math.round(n * 10) / 10;
const CHAPTER: Record<string, string> = { "2": "02", "4": "04", "5": "05", "7": "06", "8": "07", "9": "08" };

function bboxOf(pts: readonly PointMm[]): BBoxMm {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
const perimeterMm = (poly: readonly PointMm[]) => poly.reduce((s, p, i) => s + Math.hypot(poly[(i + 1) % poly.length]!.x - p.x, poly[(i + 1) % poly.length]!.y - p.y), 0);

/** Eleven treads across the longer side of a (stair) room's bbox. */
function treadsIn(b: BBoxMm, n: number): PointMm[][] {
  const along = b.w >= b.h;
  const step = (along ? b.w : b.h) / n;
  return Array.from({ length: n }, (_, i) =>
    along
      ? [
          { x: b.x + i * step, y: b.y },
          { x: b.x + (i + 1) * step, y: b.y },
          { x: b.x + (i + 1) * step, y: b.y + b.h },
          { x: b.x + i * step, y: b.y + b.h },
        ]
      : [
          { x: b.x, y: b.y + i * step },
          { x: b.x + b.w, y: b.y + i * step },
          { x: b.x + b.w, y: b.y + (i + 1) * step },
          { x: b.x, y: b.y + (i + 1) * step },
        ],
  );
}

export interface S6Context {
  sheets: readonly S4Sheet[];
  library: readonly LibraryItem[];
  at: string;
}

/** Adds the Sprint 6 lines (text / geometry / suggested) the base does not have, with their evidence. */
export function applySprint6(
  base: { lines: BoqLine[]; evidence: Record<string, BoqEvidenceItem[]> },
  ctx: S6Context,
): { lines: BoqLine[]; evidence: Record<string, BoqEvidenceItem[]> } {
  const have = new Set(base.lines.map((l) => l.code));
  const lib = new Map(ctx.library.map((i) => [i.code, i]));
  const target =
    ctx.sheets.find((s) => s.row.sheet.discipline === "electrical" && s.rooms.length && s.detections.length) ??
    ctx.sheets.find((s) => s.rooms.length) ??
    ctx.sheets[0];
  if (!target) return base;
  const sheetId = target.row.sheet.id;
  const versionId = target.row.version?.id ?? "v1";
  const floor = target.row.sheet.floors?.length === 1 ? target.row.sheet.floors[0]! : (target.row.sheet.floors?.[0] ?? "ground");
  const rooms = [...target.rooms].filter((r) => r.polygonMm.length >= 3).sort((a, b) => b.areaM2 - a.areaM2);
  const dets = target.detections;
  const lines = [...base.lines];
  const evidence = { ...base.evidence };

  const make = (it: S6Item, qty: number, level: DbLevel, extra: Partial<BoqLine>): BoqLine => {
    const item = lib.get(it.code);
    const id = s6LineId(it.code);
    return {
      id,
      chapter: item?.chapter ?? CHAPTER[it.code.split(".")[0]!] ?? "08",
      chapterTitle: item?.chapterTitle ?? null,
      code: it.code,
      description: item?.description ?? it.code,
      qty,
      qtyOverride: null,
      unit: item?.unit ?? "יחידה",
      level,
      reasons: [],
      evidenceRef: `boq/evidence.json.gz#${id}`,
      status: "draft",
      note: null,
      byFloor: qty ? { [floor]: qty } : {},
      evidenceCount: 0,
      ruleId: `r_s6_${it.origin}`,
      sourceVersions: [],
      computedAt: ctx.at,
      ...extra,
    };
  };

  S6_ITEMS.forEach((it, idx) => {
    if (have.has(it.code) || !lib.has(it.code)) return;
    if (it.origin === "text") {
      const n = it.count ?? 1;
      const items: BoqEvidenceItem[] = Array.from({ length: n }, (_, k) => {
        const d = dets.length ? dets[(idx * 7 + k * 13) % dets.length]! : null;
        const r = rooms[(idx + k) % Math.max(1, rooms.length)];
        const anchor = d ? { x: d.bboxMm.x + d.bboxMm.w + 1.5, y: d.bboxMm.y } : r ? bboxOf(r.polygonMm) : { x: 20, y: 20 };
        const text = it.text ?? it.code;
        return {
          kind: "text",
          sheetId,
          versionId,
          detectionId: `tx_${it.code.replace(".", "_")}_${k}`,
          linkGroupId: null,
          floor,
          quantity: 1,
          text,
          bboxMm: { x: anchor.x, y: anchor.y, w: Math.max(8, text.length * 1.4), h: 3.2 },
        };
      });
      evidence[s6LineId(it.code)] = items;
      lines.push(make(it, n, "yellow", { origin: "text", needsInput: false, quickAction: null, reasons: ["זוהה מכיתוב בשרטוט"], evidenceCount: n, sourceVersions: [{ sheetId, versionId }] }));
      return;
    }
    if (it.origin === "geometry") {
      const room = it.shape === "stair" ? (rooms.find((r) => r.type === "stairs") ?? rooms[rooms.length - 1]) : rooms[it.shape === "valance" ? 1 % rooms.length : 0];
      if (!room) return;
      const scale = room.perimeterM > 0 ? room.perimeterM / Math.max(1e-6, perimeterMm(room.polygonMm)) : 0.05; // m per paper mm
      let item: BoqEvidenceItem;
      let qty: number;
      if (it.shape === "stair") {
        const treads = treadsIn(bboxOf(room.polygonMm), 11);
        qty = treads.length;
        item = { kind: "stair", sheetId, versionId, detectionId: `st_${room.id}`, roomId: null, linkGroupId: null, floor, quantity: qty, treads };
      } else {
        // a wall run: the first three edges of the room (partition: × 2.6 m height → m²; valance: m')
        const run = [...room.polygonMm.slice(0, 4)];
        const lenM = r1(perimeterMm([...run, run[0]!]) * scale - Math.hypot(run[run.length - 1]!.x - run[0]!.x, run[run.length - 1]!.y - run[0]!.y) * scale);
        qty = it.shape === "partition" ? r1(lenM * 2.6) : lenM;
        item = { kind: "geometry", sheetId, versionId, detectionId: `gm_${it.code.replace(".", "_")}_${room.id}`, roomId: null, linkGroupId: null, floor, quantity: qty, geometry: { type: "polyline", mm: run } };
      }
      evidence[s6LineId(it.code)] = [item];
      lines.push(
        make(it, qty, "yellow", {
          origin: "geometry",
          needsInput: false,
          quickAction: null,
          reasons: [it.shape === "stair" ? "נספרו מדרגות מהשרטוט" : "נמדד מקווי קיר בשרטוט"],
          evidenceCount: 1,
          sourceVersions: [{ sheetId, versionId }],
          breakdown: [{ label: room.name ?? "חדר ללא שם", qty, sheetId, roomId: room.id }],
        }),
      );
      return;
    }
    const qty = it.estimate ?? 0;
    evidence[s6LineId(it.code)] = [];
    lines.push(
      make(it, qty, it.estimate == null ? "red" : "yellow", {
        origin: "suggested",
        needsInput: true,
        quickAction: { kind: it.quick ?? "count", sheetId: it.quick === "confirm" ? null : sheetId },
        reasons: it.reason ? [it.reason] : [],
      }),
    );
  });
  return { lines, evidence };
}

/**
 * After the corrections layer: a suggested line that received a manual measure / count (its quick action) or a
 * confirmation is complete — no longer "להשלמה ידנית", origin `manual`, yellow ("הושלם ידנית").
 */
export function finalizeSprint6(lines: BoqLine[], confirmed: ReadonlyMap<string, number>): BoqLine[] {
  return lines.map((l) => {
    if (!l.needsInput) return l;
    const conf = confirmed.get(l.id);
    const manualRows = (l.breakdown ?? []).filter((b) => b.manual);
    if (conf === undefined && !manualRows.length) return l;
    const qty = conf ?? Math.round(manualRows.reduce((s, b) => s + b.qty, 0) * 100) / 100;
    const floor = Object.keys(l.byFloor)[0] ?? "ground";
    return {
      ...l,
      qty,
      byFloor: conf !== undefined ? { [floor]: qty } : l.byFloor,
      needsInput: false,
      origin: "manual",
      level: "yellow",
      reasons: ["הושלם ידנית", ...(l.reasons ?? [])],
      ...(conf !== undefined ? { manualCount: 1, breakdown: [{ label: "אושר ידנית", qty, sheetId: null, manual: true }] } : {}),
    };
  });
}
