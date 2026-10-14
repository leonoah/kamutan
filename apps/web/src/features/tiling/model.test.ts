import type { Room, RoomSettings } from "@/api/types";
import { defaultSettings, isWet, needsTilingSettings, openingAreaWithin, roomTypeOf, tilingContributions, tilingQuantities, wallsOf } from "./model";

const room = (name: string | null, extra: Partial<Room> = {}): Room => ({
  id: "r_1",
  name,
  nameConfidence: 0.9,
  floor: "ground",
  // 50 × 40 mm at 1:50 → 2.5 × 2.0 m
  polygonMm: [
    { x: 0, y: 0 },
    { x: 25, y: 0 },
    { x: 50, y: 0 },
    { x: 50, y: 40 },
    { x: 0, y: 40 },
  ],
  areaM2: 5,
  perimeterM: 9,
  confidence: 0.9,
  level: "green",
  reasons: [],
  ...extra,
});

describe("tiling model", () => {
  it("room type from the worker or the (first) name; wet = bathroom / wc (contracts WET_ROOM_TYPES)", () => {
    expect(roomTypeOf(room("חדר רחצה"))).toBe("bathroom");
    expect(roomTypeOf(room("שירותים"))).toBe("wc");
    expect(roomTypeOf(room("מטבח"))).toBe("kitchen");
    expect(roomTypeOf(room("סלון / פינת אוכל"))).toBe("living");
    expect(roomTypeOf(room("חדר שינה / חדר כביסה"))).toBe("bedroom");
    expect(roomTypeOf(room(null))).toBe("other");
    expect(roomTypeOf(room("סלון", { type: "courtyard" }))).toBe("courtyard");
    expect(isWet(room("מקלחת"))).toBe(true);
    expect(isWet(room("מטבח"))).toBe(false);
    expect(isWet(room("חדר"), { type: "wc" })).toBe(true);
    expect(needsTilingSettings(room("חצר אנגלית"))).toBe(true);
  });

  it("defaults by type: bathroom 2.6 m + floor + waterproofing, courtyard floor only, others nothing", () => {
    expect(defaultSettings(room("חדר רחצה"))).toMatchObject({
      claddingHeightM: 2.6,
      floorTiled: true,
      includeInWaterproofing: true,
      wasteFactor: 0.07,
    });
    expect(defaultSettings(room("חצר אנגלית"))).toMatchObject({ claddingHeightM: 0, floorTiled: true, includeInWaterproofing: false });
    expect(defaultSettings(room("מטבח"))).toMatchObject({ claddingHeightM: 0, floorTiled: false, partialCladding: [] });
  });

  it("walls from the polygon: collinear edges merged, lengths at the sheet scale, contract ids (w_…)", () => {
    const walls = wallsOf(room("x"), 50);
    expect(walls.map((w) => w.lengthM)).toEqual([2.5, 2, 2.5, 2]);
    expect(walls.every((w) => /^w_[A-Za-z0-9_-]+$/.test(w.id))).toBe(true);
  });

  it("cladding = perimeter × height − openings (doors up to 2.1 m, windows above a 1.0 m sill); kept openings are not subtracted", () => {
    const r = room("חדר רחצה", {
      externalCorners: 2,
      openings: [
        { id: "o_1", kind: "door", wallId: "w_1", widthM: 0.8, heightM: null, centerMm: null },
        { id: "o_2", kind: "window", wallId: "w_2", widthM: 0.6, heightM: 0.8, centerMm: null },
      ],
    });
    expect(openingAreaWithin(r.openings![0]!, 2.6)).toBeCloseTo(1.68);
    expect(openingAreaWithin(r.openings![1]!, 2.6)).toBeCloseTo(0.48);
    const s: RoomSettings = { ...defaultSettings(r), claddingHeightM: 2.6 };
    const q = tilingQuantities(r, s);
    expect(q.claddingGrossM2).toBeCloseTo(23.4);
    expect(q.openingsM2).toBeCloseTo(2.16);
    expect(q.claddingNetM2).toBeCloseTo(21.24);
    expect(q.floorM2).toBe(5);
    expect(q.cornersM).toBeCloseTo(5.2);
    expect(q.waterproofing).toBe(1);
    expect(q.orderM2).toBeCloseTo((21.24 + 5) * 1.07, 1);
    expect(tilingQuantities(r, { ...s, keepOpenings: ["o_1"] }).openingsM2).toBeCloseTo(0.48);
  });

  it("contributions go to the sample BOQ codes; kitchen partial cladding → 5.06, guest WC strip → 5.07", () => {
    const bath = tilingContributions(room("חדר רחצה", { externalCorners: 1 }), defaultSettings(room("חדר רחצה")));
    expect(bath.map((c) => c.code)).toEqual(["5.02", "5.01", "5.03", "5.05"]);
    expect(bath.find((c) => c.code === "5.01")!.formula).toBe("9 מ\"א × 2.6 מ'");
    const kitchen = tilingContributions(room("מטבח"), {
      ...defaultSettings(room("מטבח")),
      partialCladding: [{ wallId: "w_r_1_1", fromM: 0, toM: 2.5, heightM: 0.6 }],
    });
    expect(kitchen).toEqual([expect.objectContaining({ code: "5.06", qty: 1.5, unit: 'מ"ר' })]);
    const wc = tilingContributions(room("שירותים"), {
      ...defaultSettings(room("שירותים")),
      claddingHeightM: 0,
      floorTiled: false,
      includeInWaterproofing: false,
      partialCladding: [{ wallId: "w", fromM: 0, toM: 1, heightM: 1.2 }],
    });
    expect(wc.map((c) => [c.code, c.qty])).toEqual([["5.07", 1.2]]);
  });
});
