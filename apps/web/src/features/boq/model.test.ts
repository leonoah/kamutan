import type { BoqLine, LinkGroup } from "@/api/types";
import { EMPTY_FILTERS } from "@/features/understanding/model";
import { computeBoq, synthesizeLinks } from "@/api/mockBoqEngine";
import { normalizeLine } from "@/api/mockBoq";
import { ELECTRICAL_SPEC, LIGHTING_SPEC, makeUnderstandingFixture } from "@/test/fixtures/understanding";
import { libraryItems } from "@/test/fixtures/boq";
import {
  allowedTransitions,
  arcPath,
  compareCodes,
  convexHull,
  detectionsByLine,
  evidenceBySheet,
  filterLines,
  groupNo,
  groupsOf,
  isCompositeLine,
  floorsOf,
  forwardStatus,
  groupByChapter,
  lineDomain,
  linesByDetection,
  linkGroupFeatures,
  nextNeedingReview,
  receiptOf,
  sortFloors,
} from "./model";

const line = (over: Partial<BoqLine>): BoqLine => ({
  id: "l",
  chapter: "04",
  code: "4.01",
  description: "שקע כפול",
  qty: 14,
  qtyOverride: null,
  unit: "יחידה",
  level: "green",
  reasons: [],
  status: "draft",
  byFloor: { ground: 14 },
  evidenceCount: 14,
  ruleId: "r_class_socket_double",
  sourceVersions: [{ sheetId: "s1", versionId: "v1" }],
  computedAt: null,
  ...over,
});

describe("BOQ model", () => {
  it("compares item codes as TEXT segments (4.9 < 4.10, 4.1 ≠ 4.10)", () => {
    expect(["4.10", "4.9", "4.1", "9.01", "4.02"].sort(compareCodes)).toEqual(["4.1", "4.02", "4.9", "4.10", "9.01"]);
    expect(compareCodes("4.1", "4.10")).toBeLessThan(0);
    expect(compareCodes("04", "08")).toBeLessThan(0);
  });

  it("receipt: '16 = 14 שזוהו + 2 ידני', per floor, sheets", () => {
    const r = receiptOf(line({ qtyOverride: 16, note: "לפי הלקוח", byFloor: { ground: 9, basement: 5 }, sourceVersions: [{ sheetId: "a", versionId: "v" }, { sheetId: "b", versionId: "v" }] }));
    expect(r).toMatchObject({ total: 16, detected: 14, manual: 2, overridden: true, sheets: 2, note: "לפי הלקוח" });
    expect(r.byFloor).toEqual([["basement", 5], ["ground", 9]]);
    expect(receiptOf(line({})).manual).toBe(0);
  });

  it("floors sort in building order", () => {
    expect(sortFloors(["first", "ground", "x", "basement"])).toEqual(["basement", "ground", "first", "x"]);
    expect(floorsOf([line({ byFloor: { first: 1 } }), line({ byFloor: { ground: 2 } })])).toEqual(["ground", "first"]);
  });

  it("groups lines by chapter with template titles/notes and % מאומת by lines", () => {
    const g = groupByChapter(
      [line({ id: "a", code: "4.10", level: "yellow" }), line({ id: "b", code: "4.9" }), line({ id: "c", chapter: "08", code: "9.01" })],
      [{ code: "04", title: "פרק 04 – עבודות חשמל", notes: ["1. הערה"] }],
    );
    expect(g.map((x) => x.code)).toEqual(["04", "08"]);
    expect(g[0]!.title).toBe("פרק 04 – עבודות חשמל");
    expect(g[0]!.lines.map((l) => l.code)).toEqual(["4.9", "4.10"]);
    expect(g[0]!.stats).toEqual({ green: 1, yellow: 1, red: 0, pct: 50 });
    expect(g[1]!.title).toBe("פרק 08");
  });

  it("status transitions per role: editors review, reviewers/admins approve, viewers nothing", () => {
    expect(allowedTransitions("viewer", "draft")).toEqual([]);
    expect(allowedTransitions("editor", "draft")).toEqual(["reviewed"]);
    expect(allowedTransitions("editor", "reviewed")).toEqual(["draft"]);
    expect(allowedTransitions("reviewer", "reviewed")).toEqual(["approved", "draft"]);
    expect(forwardStatus("editor", "reviewed")).toBeNull();
    expect(forwardStatus("reviewer", "reviewed")).toBe("approved");
    expect(forwardStatus("admin", "approved")).toBeNull();
  });

  it("N: next line needing review (draft non-green first, wraps)", () => {
    const ls = [line({ id: "a" }), line({ id: "b", level: "red" }), line({ id: "c" }), line({ id: "d", level: "yellow" })];
    expect(nextNeedingReview(ls, null)!.id).toBe("b");
    expect(nextNeedingReview(ls, "b")!.id).toBe("d");
    expect(nextNeedingReview(ls, "d")!.id).toBe("b");
    expect(nextNeedingReview([line({ id: "x", status: "approved" })], null)).toBeNull();
    expect(nextNeedingReview([line({ id: "x" }), line({ id: "y", status: "reviewed" })], null)!.id).toBe("x");
  });

  it("shared filters apply to lines (domain, floor, level) + status", () => {
    const ls = [
      line({ id: "a" }),
      line({ id: "b", code: "4.09", ruleId: "r_comp_single", level: "yellow", byFloor: { first: 3 } }),
      line({ id: "c", status: "approved" }),
    ];
    expect(lineDomain(ls[1]!)).toBe("lighting");
    expect(filterLines(ls, { ...EMPTY_FILTERS, domains: ["lighting"] }).map((l) => l.id)).toEqual(["b"]);
    expect(filterLines(ls, { ...EMPTY_FILTERS, floor: "first" }).map((l) => l.id)).toEqual(["b"]);
    expect(filterLines(ls, { ...EMPTY_FILTERS, levels: ["green"] }).map((l) => l.id)).toEqual(["a", "c"]);
    expect(filterLines(ls, EMPTY_FILTERS, "approved").map((l) => l.id)).toEqual(["c"]);
  });

  it("evidence indexes: per sheet, and detection → lines", () => {
    const ev = new Map([
      ["l1", [{ sheetId: "s1", versionId: "v", detectionId: "d1", linkGroupId: null, floor: "ground" }]],
      ["l2", [{ sheetId: "s1", versionId: "v", detectionId: "d1", linkGroupId: "g1", floor: "ground" }, { sheetId: "s2", versionId: "v", detectionId: "d9", linkGroupId: null, floor: null }]],
    ]);
    expect(linesByDetection(ev).get("s1/d1")).toEqual(["l1", "l2"]);
    expect([...evidenceBySheet(ev.get("l2")!)]).toEqual([["s1", 1], ["s2", 1]]);
    expect([...detectionsByLine({ d1: ["l1", "l2"], d2: ["l2"] })]).toEqual([["l1", ["d1"]], ["l2", ["d1", "d2"]]]);
  });

  it("composite lines count distinct groups per sheet (qty = groups) and list them as ק-n", () => {
    const it = (sheetId: string, detectionId: string, linkGroupId: string | null) => ({ sheetId, versionId: "v1", detectionId, linkGroupId, floor: "ground" });
    const items = [it("a", "d1", "lk_3"), it("a", "d2", "lk_3"), it("a", "d3", "lk_7"), it("b", "d1", "lk_3"), it("b", "d9", null)];
    expect([...evidenceBySheet(items)]).toEqual([["a", 2], ["b", 2]]);
    expect(groupsOf(items).map((g) => `${g.sheetId}:${groupNo(g.linkGroupId)}`)).toEqual(["a:3", "a:7", "b:3"]);
    expect(isCompositeLine({ code: "4.11", ruleId: null })).toBe(true);
    expect(isCompositeLine({ code: "4.01", ruleId: "r_class_socket_double" })).toBe(false);
  });

  it("draws Worker-A's traced arcs (dotted when inferred / ambiguous) instead of schematic ones", () => {
    const dets = new Map([["s1", { centerMm: { x: 0, y: 0 } }], ["l1", { centerMm: { x: 40, y: 0 } }]]);
    const g: LinkGroup = { id: "lk_1", switchIds: ["s1"], pointIds: ["pt_1"], luminaireIds: ["l1"], kind: "single", confidence: 0.9, level: "green", reasons: [], arcIds: ["a_1", "a_2"] };
    const arcs = new Map([
      ["a_1", { id: "a_1", polylineMm: [{ x: 0, y: 0 }, { x: 20, y: 5 }, { x: 40, y: 0 }] }],
      ["a_2", { id: "a_2", polylineMm: [{ x: 0, y: 0 }, { x: 40, y: 0 }], inferredSwitch: true }],
    ]);
    const f = linkGroupFeatures([g], dets, () => ({ short: "ק-1", code: "4.09", detail: "" }), arcs).filter((x) => x.kind === "path");
    expect(f.map((p) => p.kind === "path" && [p.path.length, p.dash])).toEqual([[3, "dashed"], [2, "dotted"]]);
  });

  it("link groups → dashed/dotted arcs in the level colour + an 8% hull with a 'ק-n · code' chip", () => {
    const dets = new Map([
      ["s1", { centerMm: { x: 0, y: 0 } }],
      ["s2", { centerMm: { x: 0, y: 10 } }],
      ["l1", { centerMm: { x: 40, y: 0 } }],
    ]);
    const g: LinkGroup = { id: "g1", switchIds: ["s1", "s2"], pointIds: ["p1"], luminaireIds: ["l1"], kind: "two_way", confidence: 0.7, level: "yellow", reasons: [] };
    const f = linkGroupFeatures([g, { ...g, id: "g2", switchIds: ["nope"], luminaireIds: [] }], dets, () => ({ short: "ק-1", code: "4.10", detail: "· 1 גופים" }));
    const arcs = f.filter((x) => x.kind === "path");
    expect(arcs).toHaveLength(2);
    expect(arcs.every((a) => a.kind === "path" && a.dash === "dashed" && a.widthPx === 2 && a.color![0] === 178)).toBe(true);
    const hull = f.find((x) => x.kind === "polygon")!;
    expect(hull).toMatchObject({ label: "ק-1", labelLtr: "4.10", passive: true });
    expect(hull.kind === "polygon" && hull.fillColor![3]).toBe(20);
    const traced = linkGroupFeatures([{ ...g, arcs: [{ pathMm: [{ x: 0, y: 0 }, { x: 40, y: 0 }], completed: true }] }], dets, () => ({ short: "", code: "", detail: "" }));
    expect(traced.find((x) => x.kind === "path")).toMatchObject({ dash: "dotted" });
  });

  it("geometry helpers", () => {
    expect(convexHull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2]])).toHaveLength(4);
    const a = arcPath([0, 0], [10, 0]);
    expect(a[0]).toEqual([0, 0]);
    expect(a.at(-1)).toEqual([10, 0]);
    expect(Math.abs(a[8]![1])).toBeGreaterThan(0.5);
  });
});

describe("mock BOQ engine (stand-in for Worker-BOQ)", () => {
  const elec = makeUnderstandingFixture(ELECTRICAL_SPEC);
  const light = makeUnderstandingFixture(LIGHTING_SPEC);
  const row = (id: string, discipline: string) => ({
    sheet: { id, sheetSetId: id, currentVersionId: "v1", discipline, floors: ["ground"] },
    version: { id: "v1", sheetId: id, status: "ready" as const, createdAt: "" },
  });

  it("synthesizes switch groups per room; every luminaire belongs to at most one group", () => {
    const links = synthesizeLinks(light.detections.detections);
    expect(links.groups.length).toBeGreaterThan(3);
    const all = links.groups.flatMap((g) => g.luminaireIds);
    expect(new Set(all).size).toBe(all.length);
    expect(links.groups.every((g) => g.pointIds.length >= 1)).toBe(true);
  });

  it("aggregates socket lines from the electrical sheet and composite + install lines from the lighting sheet", () => {
    const res = computeBoq(
      [
        { row: row("e", "electrical"), detections: elec.detections.detections, links: null },
        { row: row("l", "lighting"), detections: light.detections.detections, links: null },
        // a second electrical sheet of the same floor is NOT counted again (authority / de-dup)
        { row: { ...row("e2", "electrical"), sheet: { ...row("e2", "electrical").sheet, floors: ["basement", "ground"] } }, detections: elec.detections.detections, links: null },
      ],
      libraryItems(),
      "2026-10-14T00:00:00.000Z",
    );
    const by = new Map(res.lines.map((l) => [l.code, l]));
    const doubles = elec.detections.detections.filter((d) => d.class === "socket_double" && d.lifecycle !== "demolish").length;
    expect(by.get("4.01")!.qty).toBe(doubles);
    expect(by.get("4.01")!.description).toBe("שקע כפול");
    expect(by.get("4.01")!.byFloor).toEqual({ ground: doubles });
    expect(res.evidence[by.get("4.01")!.id]!.every((e) => e.sheetId === "e")).toBe(true);
    // composite lighting lines = one unit per group; evidence carries the group id
    const comp = res.lines.filter((l) => ["4.09", "4.10", "4.11", "4.16", "4.15", "4.12"].includes(l.code));
    expect(comp.reduce((s, l) => s + l.qty, 0)).toBe(res.links.get("l")!.groups.length);
    expect(res.evidence[comp[0]!.id]!.every((e) => e.linkGroupId !== null)).toBe(true);
    // line level = lowest evidence level
    const det = (sheet: string, id: string) => (sheet === "l" ? light : elec).detections.detections.find((d) => d.id === id)!;
    for (const l of res.lines) {
      const lv = new Set(res.evidence[l.id]!.map((e) => det(e.sheetId, e.detectionId).level));
      if (lv.has("red")) expect(l.level).toBe("red");
    }
    expect(by.get("9.01")!.qty).toBeGreaterThan(0);
    expect(by.has("4.17")).toBe(true); // heater_feed → 4.17
  });

  it("normalizes Worker-BOQ local lines tolerantly", () => {
    const l = normalizeLine({ code: 4.1, description: "x", qty: 2, floor: "ground", level: "red" }, 0)!;
    expect(l).toMatchObject({ code: "4.1", chapter: "04", byFloor: { ground: 2 }, level: "red", status: "draft" });
    expect(normalizeLine({ description: "no code" }, 1)).toBeNull();
  });
});
