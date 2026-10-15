import type { BoqLine, Correction, Detection, Room } from "@/api/types";
import { MIN_CLUSTER, buildReviewQueue, estimateMinutes, estimateSeconds, unionBBox } from "./queueModel";

const det = (
  id: string,
  cls: string,
  level: Detection["level"],
  score: number,
  reason = "התאמה חלקית לסמל",
  extra: Partial<Detection> = {},
): Detection => ({
  id,
  class: cls,
  legendEntryId: null,
  centerMm: { x: 10, y: 10 },
  bboxMm: { x: 8, y: 8, w: 4, h: 4 },
  angleDeg: 0,
  score,
  level,
  reasons: [reason],
  roomId: null,
  floor: "ground",
  lifecycle: "new",
  supply: null,
  annotations: [],
  clusterId: null,
  ...extra,
});
const room = (id: string, name: string | null, level: Room["level"] = "yellow"): Room => ({
  id,
  name,
  nameConfidence: 0.8,
  floor: "ground",
  polygonMm: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ],
  areaM2: 5,
  perimeterM: 9,
  confidence: 0.7,
  level,
  reasons: [],
});
const line = (id: string, code: string, level: BoqLine["level"], extra: Partial<BoqLine> = {}): BoqLine => ({
  id,
  chapter: code.split(".")[0]!.padStart(2, "0"),
  code,
  description: code,
  qty: 1,
  unit: "יחידה",
  level,
  status: "draft",
  byFloor: {},
  evidenceCount: 0,
  ruleId: null,
  sourceVersions: [{ sheetId: "s1", versionId: "v1" }],
  computedAt: null,
  ...extra,
});

describe("review queue model", () => {
  it(`groups ≥ ${MIN_CLUSTER} similar items (sheet + class + level + first reason) into one cluster card, lowest score first`, () => {
    const dets = [
      det("d_1", "socket_double", "yellow", 0.7),
      det("d_2", "socket_double", "yellow", 0.6),
      det("d_3", "socket_double", "yellow", 0.65),
      det("d_4", "socket_double", "red", 0.3),
      det("d_5", "socket_single", "yellow", 0.62, "סמל לא במקרא"),
      det("d_6", "socket_single", "green", 0.95),
      det("d_7", "socket_single", "yellow", 0.5, "x", { manual: "accepted" }),
      det("d_8", "socket_single", "yellow", 0.5, "x", { rejected: true }),
    ];
    const q = buildReviewQueue({
      sheets: [{ sheetId: "s1", versionId: "v1", detections: dets, unknownClusters: [], linkGroups: [], rooms: [] }],
      lines: [],
      roomSettings: new Map(),
      unmatched: [],
    });
    const cluster = q.find((i) => i.kind === "cluster")!;
    expect(cluster.detectionIds).toEqual(["d_2", "d_3", "d_1"]);
    expect(cluster.members!.map((m) => m.score)).toEqual([0.6, 0.65, 0.7]);
    expect(q.filter((i) => i.kind === "detection").map((i) => i.detectionIds![0])).toEqual(["d_4", "d_5"]);
    // human-verified / rejected / green items are not in the queue
    expect(q.flatMap((i) => i.detectionIds ?? [])).not.toContain("d_6");
    expect(q.flatMap((i) => i.detectionIds ?? [])).not.toContain("d_7");
    expect(q.flatMap((i) => i.detectionIds ?? [])).not.toContain("d_8");
    // risk = impact × (1 − score) × level weight, highest first: the red single beats a yellow single
    const risks = q.map((i) => i.risk);
    expect(risks).toEqual([...risks].sort((a, b) => b - a));
    expect(q.find((i) => i.id === "det:s1:d_4")!.risk).toBeCloseTo(1 * 0.7 * 3);
  });

  it("unknown clusters, link groups, rooms (unnamed / not closed / wet without settings), unmatched corrections, lines without items", () => {
    const unknown = [
      det("d_u1", "unknown", "red", 0.2, "סמל לא במקרא", { clusterId: "u_1" }),
      det("d_u2", "unknown", "red", 0.2, "סמל לא במקרא", { clusterId: "u_1" }),
    ];
    const sw = det("d_s", "switch_single", "green", 0.9);
    const lum = det("d_l", "luminaire_ceiling", "green", 0.9);
    const unmatched = { id: "corr_1", kind: "reject", sheetId: "s1", versionId: "v0", anchorMm: { x: 1, y: 1 } } as unknown as Correction;
    const q = buildReviewQueue({
      sheets: [
        {
          sheetId: "s1",
          versionId: "v1",
          detections: [...unknown, sw, lum],
          unknownClusters: [{ id: "u_1", signature: "sig", count: 2, exemplarBboxMm: { x: 0, y: 0, w: 1, h: 1 }, thumb: null }],
          linkGroups: [
            { id: "lk_1", switchIds: ["d_s"], pointIds: ["p"], luminaireIds: ["d_l"], kind: "single", confidence: 0.6, level: "yellow", reasons: [] },
          ],
          rooms: [room("r_1", "מקלחת"), room("r_2", null), room("r_3", "סלון", "green"), room("r_4", "סלון", "red")],
        },
      ],
      lines: [
        line("l1", "3.08", "yellow"),
        line("l2", "4.01", "yellow", { evidenceCount: 3 }),
        line("l3", "5.01", "yellow", { breakdown: [{ label: "x", qty: 1 }] }),
      ],
      roomSettings: new Map(),
      unmatched: [unmatched],
    });
    const kinds = (k: string) => q.filter((i) => i.kind === k);
    expect(kinds("unknown_cluster")).toHaveLength(1);
    expect(kinds("unknown_cluster")[0]!.level).toBe("unknown");
    expect(kinds("link_group")[0]!.linkGroupId).toBe("lk_1");
    expect(kinds("room").map((i) => [i.roomId, i.reasons])).toEqual(
      expect.arrayContaining([
        ["r_1", ["הגדרות חיפוי חסרות"]],
        ["r_2", ["חדר ללא שם"]],
        ["r_4", ["חדר לא סגור"]],
      ]),
    );
    expect(kinds("room").some((i) => i.roomId === "r_3")).toBe(false);
    expect(kinds("unmatched_correction")[0]).toMatchObject({ correctionId: "corr_1", reasons: ["תיקון לא הותאם"], level: "red" });
    // only the template suggestion has no item to look at (4.01 has items; 5.01 is reviewed through its rooms)
    expect(kinds("line").map((i) => i.itemCode)).toEqual(["3.08"]);
  });

  it("time estimate: ≈3 s per item, ≈5 s per cluster card (spec budget: 100 items < 5 min)", () => {
    expect(estimateSeconds([{ kind: "detection" }, { kind: "cluster" }])).toBe(8);
    expect(estimateMinutes(Array.from({ length: 100 }, () => ({ kind: "detection" as const })))).toBe(5);
    expect(estimateMinutes([])).toBe(0);
    expect(
      unionBBox(
        [
          { x: 0, y: 0, w: 1, h: 1 },
          { x: 5, y: 5, w: 1, h: 1 },
        ],
        1,
      ),
    ).toEqual({ x: -1, y: -1, w: 8, h: 8 });
  });
});
