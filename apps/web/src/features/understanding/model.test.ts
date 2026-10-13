import type { Detection } from "@/api/types";
import { ELECTRICAL_SPEC, makeUnderstandingFixture } from "@/test/fixtures/understanding";
import {
  EMPTY_FILTERS,
  applyClusterResolution,
  applyFilters,
  boundsOf,
  countsByClass,
  detectionMarkers,
  filtersFromParams,
  filtersToParams,
  legendBoxes,
  roomPolygons,
  verifiedPct,
} from "./model";
import { fetchArtifact } from "./artifacts";
import { CLASS_INFO, className, isSymbolClass } from "./taxonomy";

const fx = makeUnderstandingFixture(ELECTRICAL_SPEC);
const dets = fx.detections.detections;

const det = (over: Partial<Detection>): Detection => ({
  id: "d_1",
  class: "socket_double",
  legendEntryId: null,
  centerMm: { x: 10, y: 20 },
  bboxMm: { x: 8, y: 18, w: 4, h: 4 },
  angleDeg: 0,
  score: 0.9,
  level: "green",
  reasons: [],
  roomId: null,
  floor: "ground",
  lifecycle: "new",
  supply: null,
  annotations: [],
  clusterId: null,
  ...over,
});

describe("understanding model", () => {
  it("fixture follows the brief's shapes and invariants", () => {
    expect(fx.legend.schema).toBe("kamutan.legend/1");
    expect(fx.detections.schema).toBe("kamutan.detections/1");
    expect(fx.rooms.schema).toBe("kamutan.rooms/1");
    for (const d of dets) {
      if (d.level !== "green") expect(d.reasons.length).toBeGreaterThan(0);
      if (d.class === "unknown") expect(d.clusterId).toMatch(/^u_/);
    }
    for (const e of fx.legend.entries) expect(e.thumb).toBe(`legend/${e.id}.webp`);
  });

  it("markers: level → colour + shape (● ▲ ◆ ◇), size from the bbox in paper mm", () => {
    const m = detectionMarkers([
      det({ id: "a", level: "green" }),
      det({ id: "b", level: "yellow", reasons: ["x"] }),
      det({ id: "c", level: "red", reasons: ["x"], bboxMm: { x: 0, y: 0, w: 7, h: 3 } }),
      det({ id: "d", class: "unknown", level: "red", reasons: ["x"], clusterId: "u_1" }),
    ]);
    expect(m.map((f) => f.shape)).toEqual(["circle", "triangle", "diamond", "diamond-open"]);
    expect(m.map((f) => f.color!.slice(0, 3))).toEqual([[27, 127, 90], [178, 107, 0], [194, 65, 12], [109, 40, 217]]);
    expect(m[2]!.sizeMm).toBe(7);
    expect(m[0]!.position).toEqual([10, 20]);
  });

  it("lifecycle: existing = dashed grey, demolish = dashed red + strike; off layers are dimmed", () => {
    const [n, e, x] = detectionMarkers(
      [det({ id: "n" }), det({ id: "e", lifecycle: "existing" }), det({ id: "x", lifecycle: "demolish" })],
      { new: true, existing: false, demolish: true },
    );
    expect(n).toMatchObject({ dashed: false, strike: false, dimmed: false });
    expect(e).toMatchObject({ dashed: true, strike: false, dimmed: true, color: [120, 113, 108, 255] });
    expect(x).toMatchObject({ dashed: true, strike: true, dimmed: false, color: [159, 18, 57, 255] });
  });

  it("rooms → passive polygons with name + LTR area; legend → dashed boxes", () => {
    const rooms = roomPolygons(fx.rooms.rooms, { unnamed: "חדר ללא שם", areaUnit: "מ״ר" });
    expect(rooms[0]).toMatchObject({ label: "סלון", labelLtr: "26.0", labelSuffix: "מ״ר", passive: true });
    expect(rooms.at(-1)).toMatchObject({ label: "חדר ללא שם", dashed: true });
    expect(legendBoxes(fx.legend)[0]).toMatchObject({ id: "lg0", dashed: true, passive: true });
  });

  it("filters: levels / domain / floor / room, and URL round-trip", () => {
    const f = { ...EMPTY_FILTERS, levels: ["red" as const], domains: ["electrical"] };
    const out = applyFilters(dets, f);
    expect(out.every((d) => d.level === "red" && d.class !== "unknown")).toBe(true);
    const p = filtersToParams({ ...f, room: "r_1", floor: "ground" }, new URLSearchParams("sheet=x"));
    expect(p.get("sheet")).toBe("x");
    expect(filtersFromParams(p)).toEqual({ ...f, room: "r_1", floor: "ground" });
    expect(filtersFromParams(new URLSearchParams())).toEqual(EMPTY_FILTERS);
    expect(applyFilters(dets, { ...EMPTY_FILTERS, room: "r_1" }).every((d) => d.roomId === "r_1")).toBe(true);
  });

  it("counts by class: per-level counts, worst level, domain order", () => {
    const c = countsByClass(dets);
    expect(c.reduce((a, r) => a + r.total, 0)).toBe(dets.length);
    for (const r of c) expect(r.green + r.yellow + r.red + r.unknown).toBe(r.total);
    expect(c.at(-1)!.cls).toBe("unknown");
    expect(c.at(-1)!.worst).toBe("unknown");
    expect(c[0]!.legendEntryId).toMatch(/^le_/);
  });

  it("cluster resolution re-labels (yellow at best) or drops the instances, and removes the cluster", () => {
    const r = applyClusterResolution(fx.detections, "u_1", "socket_power");
    expect(r.unknownClusters.map((u) => u.id)).toEqual(["u_2"]);
    const moved = r.detections.filter((d) => d.class === "socket_power" && d.legendEntryId === null);
    expect(moved).toHaveLength(7);
    expect(moved.every((d) => d.level === "yellow" && d.clusterId === null)).toBe(true);
    expect(applyClusterResolution(fx.detections, "u_2", null).detections).toHaveLength(dets.length - 3);
  });

  it("verified share, bounds", () => {
    expect(verifiedPct([det({}), det({ level: "red", reasons: ["x"] })])).toBe(50);
    expect(boundsOf([det({})], 1)).toEqual([7, 17, 13, 23]);
    expect(boundsOf([])).toBeNull();
  });

  it("taxonomy: Hebrew names, symbol classes only for the pickers", () => {
    expect(className("socket_double")).toBe("שקע כפול");
    expect(className("unknown")).toBe("סמל לא מוכר");
    expect(className("weird_new")).toBe("weird_new");
    expect(isSymbolClass("room")).toBe(false);
    expect(isSymbolClass("switch_2way")).toBe(true);
    expect(Object.keys(CLASS_INFO)).toHaveLength(35);
  });
});

describe("fetchArtifact", () => {
  afterEach(() => vi.unstubAllGlobals());
  const doc = { schema: "kamutan.rooms/1", rooms: [] };

  it("gunzips raw .json.gz bodies (no Content-Encoding)", async () => {
    const gz = await new Response(new Response(JSON.stringify(doc)).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    expect(new Uint8Array(gz)[0]).toBe(0x1f);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(gz)));
    await expect(fetchArtifact("https://signed/rooms.json.gz", "kamutan.rooms/1")).resolves.toEqual(doc);
  });

  it("accepts already-inflated JSON and rejects a wrong schema / HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(doc))));
    await expect(fetchArtifact("u", "kamutan.rooms/1")).resolves.toEqual(doc);
    await expect(fetchArtifact("u", "kamutan.legend/1")).rejects.toThrow(/schema/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await expect(fetchArtifact("u", "kamutan.rooms/1")).rejects.toThrow(/403/);
  });
});
