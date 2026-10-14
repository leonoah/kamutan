import type { BoqLine, Correction, Detection, Room, SheetRow } from "./types";
import {
  applyCorrectionDeltas,
  applyRoomSettingsDeltas,
  authoritativeRooms,
  computePlumbing,
  computeTiling,
  plumbingCodeOf,
} from "./mockSprint4Engine";
import { applyCorrections, baseCorrection, materialize } from "@/features/corrections/model";
import { defaultSettings, settingsDocId } from "@/features/tiling/model";
import { libraryItems } from "@/test/fixtures/boq";

const row = (id: string, discipline: string, floors = ["ground"]): SheetRow => ({
  sheet: { id, sheetSetId: id, currentVersionId: "v1", discipline, floors },
  version: { id: "v1", sheetId: id, status: "ready", createdAt: "2026-10-14T10:00:00.000Z" },
});
const det = (id: string, cls: string, x: number, y = 10, extra: Partial<Detection> = {}): Detection => ({
  id,
  class: cls,
  legendEntryId: null,
  centerMm: { x, y },
  bboxMm: { x: x - 2, y: y - 2, w: 4, h: 4 },
  angleDeg: 0,
  score: 0.7,
  level: "yellow",
  reasons: [],
  roomId: null,
  floor: "ground",
  lifecycle: "new",
  supply: null,
  annotations: [],
  clusterId: null,
  ...extra,
});
const room = (id: string, name: string, area = 5, perimeter = 9, floor = "ground"): Room => ({
  id,
  name,
  nameConfidence: 0.9,
  floor,
  polygonMm: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ],
  areaM2: area,
  perimeterM: perimeter,
  confidence: 0.9,
  level: "yellow",
  reasons: [],
});
const LIB = libraryItems();
const AT = "2026-10-14T10:00:00.000Z";
let n = 0;
const corr = (kind: Correction["kind"], extra: Partial<Correction>, sheetId = "pl") =>
  materialize(
    baseCorrection(kind, { sheetId, versionId: "v1", anchorMm: { x: 1, y: 1 } }, extra),
    "u",
    `2026-10-14T10:00:${String(++n).padStart(2, "0")}.000Z`,
  );

describe("mock Worker-BOQ (Sprint 4)", () => {
  it("plumbing: basin + wall faucet → 3.02, basin alone → 3.03; WCs, AC drains from electrical; one-offs suggested (yellow)", () => {
    const pl = row("pl", "plumbing");
    const el = row("el", "electrical");
    const dets = [
      det("d_1", "fixture_basin", 10),
      det("d_2", "faucet_wall", 20),
      det("d_3", "fixture_basin", 200),
      det("d_4", "fixture_wc_concealed", 300),
      det("d_5", "fixture_wc_monoblock", 400),
    ];
    expect(plumbingCodeOf(dets[0]!, dets)).toBe("3.02");
    expect(plumbingCodeOf(dets[2]!, dets)).toBe("3.03");
    const { lines, evidence } = computePlumbing(
      [
        { row: pl, detections: dets, rooms: [] },
        { row: el, detections: [det("d_a", "ac_unit", 5), det("d_b", "ac_unit", 50), det("d_c", "socket_double", 9)], rooms: [] },
      ],
      LIB,
      AT,
    );
    const q = Object.fromEntries(lines.map((l) => [l.code, l.qty]));
    expect(q).toMatchObject({ "3.01": 2, "3.02": 1, "3.03": 1, "3.04": 1, "3.07": 1, "3.08": 1, "3.15": 1 });
    expect(lines.find((l) => l.code === "3.08")).toMatchObject({ level: "yellow", reasons: ["הוצע מתבנית — לאשר"], evidenceCount: 0 });
    expect(evidence[lines.find((l) => l.code === "3.01")!.id]!.map((e) => e.sheetId)).toEqual(["el", "el"]);
  });

  it("tiling: authoritative rooms per floor, defaults for wet rooms, saved settings win (verified)", () => {
    const arch = row("ar", "architecture_master");
    const elec = row("el", "electrical");
    const sheets = [
      { row: arch, detections: [], rooms: [room("r_1", "חדר רחצה", 5, 9), room("r_2", "סלון", 30, 22)] },
      { row: elec, detections: [], rooms: [room("r_9", "חדר רחצה", 5.1, 9.1)] }, // same floor, lower authority → ignored
    ];
    expect(authoritativeRooms(sheets).map((x) => x.room.id)).toEqual(["r_1", "r_2"]);
    const lines = computeTiling(sheets, new Map(), LIB, AT);
    const by = Object.fromEntries(lines.map((l) => [l.code, l]));
    expect(by["5.01"]!.qty).toBeCloseTo(9 * 2.6);
    expect(by["5.01"]!.orderQty).toBeCloseTo(9 * 2.6 * 1.07, 1);
    expect(by["5.01"]!.wasteFactor).toBe(0.07);
    expect(by["5.01"]!.breakdown![0]!.formula).toBe("9 מ\"א × 2.6 מ'");
    expect(by["5.01"]!.level).toBe("yellow");
    expect(by["5.02"]!.qty).toBe(5);
    expect(by["5.05"]!.qty).toBe(1);
    const saved = new Map([[settingsDocId("ar", "r_1"), { ...defaultSettings(room("r_1", "חדר רחצה")), claddingHeightM: 2.0 }]]);
    const after = Object.fromEntries(computeTiling(sheets, saved, LIB, AT).map((l) => [l.code, l]));
    expect(after["5.01"]!.qty).toBeCloseTo(18);
    expect(after["5.01"]!.level).toBe("green");
    // Worker-BOQ's own 05 lines: a saved room is layered on as a delta (+ breakdown row)
    const worker: BoqLine[] = [{ ...by["5.01"]!, qty: 60, orderQty: 64.2 }];
    const layered = applyRoomSettingsDeltas(worker, sheets, saved, LIB, AT);
    expect(layered[0]!.qty).toBeCloseTo(60 - 9 * 0.6);
    expect(layered[0]!.breakdown!.at(-1)!.label).toBe("חדר רחצה (הגדרות חדר)");
  });

  it("corrections on top of the lines: reject −1, add +1 manual, reclassify moves the item, count / measure add manual quantities", () => {
    const pl = row("pl", "plumbing");
    const raw = [det("d_1", "fixture_wc_concealed", 10), det("d_2", "fixture_wc_concealed", 60), det("d_3", "fixture_wc_monoblock", 110)];
    const base = computePlumbing([{ row: pl, detections: raw, rooms: [] }], LIB, AT);
    const corrections = [
      corr("reject", { detectionId: "d_1" }),
      corr("add", { class: "fixture_wc_concealed", geometry: { type: "point", mm: [{ x: 300, y: 10 }] } }),
      corr("reclassify", { detectionId: "d_3", class: "fixture_wc_concealed" }),
      corr("count", {
        itemCode: "3.06",
        quantity: 2,
        unit: "unit",
        geometry: {
          type: "point",
          mm: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
        },
      }),
      corr("measure", {
        itemCode: "5.02",
        quantity: 4.5,
        unit: "m2",
        geometry: {
          type: "polygon",
          mm: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      }),
    ];
    const corrected = applyCorrections(raw, corrections, "pl").detections;
    const out = applyCorrectionDeltas(base, new Map([["pl", { row: pl, raw, corrected }]]), corrections, LIB, AT);
    const by = Object.fromEntries(out.lines.map((l) => [l.code, l]));
    // 3.04: 2 detected − 1 rejected + 1 added + 1 reclassified = 3, one of them manual
    expect(by["3.04"]!.qty).toBe(3);
    expect(by["3.04"]!.manualCount).toBe(1);
    expect(by["3.07"]!.qty).toBe(0);
    expect(by["3.06"]).toMatchObject({ qty: 2, manualCount: 2 });
    expect(by["3.06"]!.breakdown).toEqual([expect.objectContaining({ label: "ספירה ידנית", qty: 2, manual: true })]);
    expect(by["5.02"]).toMatchObject({ qty: 4.5, manualCount: 1 });
    expect(out.evidence[by["3.04"]!.id]!.map((e) => e.detectionId).sort()).toEqual(["d_2", "d_3", `m_${corrections[1]!.id}`].sort());
  });
});
