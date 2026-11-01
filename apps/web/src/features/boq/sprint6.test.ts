import type { BoqEvidenceItem, BoqLine, Detection, Room, SheetRow } from "@/api/types";
import { normalizeLineDto } from "@/api/http";
import { applySprint6, finalizeSprint6, S6_ITEMS, s6LineId } from "@/api/mockSprint6";
import { libraryItems } from "@/test/fixtures/boq";
import { bulkPlan, filterLines, forwardOrReason, rangeIds, roleCanReach, skipCounts, undoGroups } from "./model";
import { applyQuickMeasure, coverageOf, evidenceShapeFeatures, lineNeedsInput, originOf, quickActionOf, shapeBoxesOn } from "./sprint6";
import { EMPTY_FILTERS } from "@/features/understanding/model";

const line = (p: Partial<BoqLine> = {}): BoqLine => ({
  id: p.id ?? `l_${p.code ?? "4.01"}`,
  chapter: "04",
  code: "4.01",
  description: "x",
  qty: 3,
  unit: "יחידה",
  level: "green",
  status: "draft",
  byFloor: {},
  evidenceCount: 3,
  ruleId: "r_class",
  sourceVersions: [],
  computedAt: null,
  ...p,
});

describe("Sprint 6 model: origin, needs input, quick action, coverage", () => {
  it("origin: the server's, else inferred (manual rule, room-derived, detected)", () => {
    expect(originOf(line({ origin: "text" }))).toBe("text");
    expect(originOf(line({ ruleId: "r_manual" }))).toBe("manual");
    expect(originOf(line({ breakdown: [{ label: "חדר", qty: 2, roomId: "r1" }] }))).toBe("geometry");
    expect(originOf(line())).toBe("detected");
  });

  it("a suggested line needs input until a quantity is entered; an override answers it", () => {
    const s = line({ origin: "suggested", needsInput: true, qty: 0, unit: 'מ"ר' });
    expect(lineNeedsInput(s)).toBe(true);
    expect(lineNeedsInput({ ...s, qtyOverride: 4 })).toBe(false);
    expect(lineNeedsInput(line())).toBe(false);
  });

  it("quick action: the server's, else from the unit (m² / m' / קומפלט / units); none for computed lines", () => {
    expect(quickActionOf(line({ needsInput: true, qty: 0, unit: 'מ"ר', quickAction: { kind: "measure_area", sheetId: "s1" } }))).toEqual({ kind: "measure_area", sheetId: "s1" });
    expect(quickActionOf(line({ needsInput: true, qty: 0, unit: 'מ"א' }))?.kind).toBe("measure_length");
    expect(quickActionOf(line({ needsInput: true, qty: 1, unit: "קומפלט" }))?.kind).toBe("confirm");
    expect(quickActionOf(line({ needsInput: true, qty: 0, unit: "יחידה" }))?.kind).toBe("count");
    expect(quickActionOf(line())).toBeNull();
  });

  it("coverage: 'x מתוך y חושבו מהשרטוט · z להשלמה' counts drawing origins, not suggested / manual", () => {
    const c = coverageOf([
      line({ origin: "detected" }),
      line({ origin: "text" }),
      line({ origin: "geometry" }),
      line({ origin: "suggested", needsInput: true, qty: 0 }),
      line({ origin: "manual", ruleId: "r_manual" }),
    ]);
    expect(c).toEqual({ total: 5, computed: 3, needsInput: 1 });
  });

  it("filter 'להשלמה ידנית' keeps only waiting lines", () => {
    const ls = [line({ id: "a" }), line({ id: "b", needsInput: true, qty: 0 }), line({ id: "c", needsInput: true, qty: 0, qtyOverride: 2 })];
    expect(filterLines(ls, EMPTY_FILTERS, "needsInput").map((l) => l.id)).toEqual(["b"]);
  });

  it("the HTTP adapter maps `qty: null` to 0 + needsInput", () => {
    const l = normalizeLineDto({ ...line(), qty: null } as unknown as BoqLine);
    expect(l.qty).toBe(0);
    expect(l.needsInput).toBe(true);
    expect(normalizeLineDto(line()).needsInput).toBeUndefined();
  });

  it("optimistic quick measure: a waiting line takes the measure (replaces the estimate), confirm sets it", () => {
    const s = line({ origin: "suggested", needsInput: true, qty: 0, unit: 'מ"ר' });
    const m = applyQuickMeasure(s, "measure_area", 4.236, "מדידת שטח ידנית", "s1");
    expect(m).toMatchObject({ qty: 4.24, needsInput: false, origin: "manual" });
    expect(m.breakdown?.at(-1)).toMatchObject({ manual: true, qty: 4.24, sheetId: "s1" });
    const c = applyQuickMeasure(line({ needsInput: true, qty: 1, unit: "קומפלט", origin: "suggested" }), "confirm", 2, "אושר ידנית", null);
    expect(c.qty).toBe(2);
    // a computed line adds the manual part
    expect(applyQuickMeasure(line({ qty: 3 }), "count", 2, "ספירה ידנית", "s1").qty).toBe(5);
  });
});

describe("Sprint 6 evidence on the drawing: text bbox, geometry polygon / polyline, stair treads", () => {
  const items: BoqEvidenceItem[] = [
    { kind: "text", sheetId: "s1", versionId: "v1", detectionId: "t1", linkGroupId: null, floor: null, text: "לוח תקשורת", bboxMm: { x: 10, y: 10, w: 20, h: 4 } },
    { kind: "geometry", sheetId: "s1", versionId: "v1", detectionId: "g1", linkGroupId: null, floor: null, quantity: 12, geometry: { type: "polygon", mm: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] } },
    { kind: "geometry", sheetId: "s1", versionId: "v1", detectionId: "g2", linkGroupId: null, floor: null, geometry: { type: "polyline", mm: [{ x: 0, y: 0 }, { x: 30, y: 0 }] } },
    { kind: "stair", sheetId: "s1", versionId: "v1", detectionId: "st", linkGroupId: null, floor: null, treads: [0, 1, 2].map((i) => [{ x: i * 3, y: 0 }, { x: i * 3 + 3, y: 0 }, { x: i * 3 + 3, y: 9 }, { x: i * 3, y: 9 }]) },
    { kind: "text", sheetId: "other", versionId: "v1", detectionId: "t2", linkGroupId: null, floor: null, bboxMm: { x: 0, y: 0, w: 1, h: 1 } },
    { sheetId: "s1", versionId: "v1", detectionId: "d1", linkGroupId: null, floor: null },
  ];
  it("draws each kind on its sheet only, never pickable; detections are left to the markers", () => {
    const f = evidenceShapeFeatures(items, "s1", "yellow", { label: "7.01", unit: 'מ"ר', tread: "מדרגה" });
    expect(f.every((x) => x.passive)).toBe(true);
    const text = f.find((x) => x.id.includes("t1"));
    expect(text).toMatchObject({ kind: "polygon", label: "לוח תקשורת" });
    expect(f.find((x) => x.id.includes("g1"))).toMatchObject({ kind: "polygon", label: "7.01", labelLtr: "12" });
    expect(f.find((x) => x.id.includes("g2"))).toMatchObject({ kind: "path" });
    expect(f.filter((x) => x.id.startsWith("ev-3-st-t"))).toHaveLength(3);
    expect(f.some((x) => x.id === "ev-4-t2" || x.id === "ev-5-d1")).toBe(false);
    expect(f).toHaveLength(6);
  });
  it("zoom boxes cover the shapes of the current sheet", () => {
    const boxes = shapeBoxesOn(items, "s1");
    expect(boxes).toHaveLength(4);
    expect(boxes[3]!.bboxMm).toEqual({ x: 0, y: 0, w: 9, h: 9 });
  });
});

describe("Owner feedback: status key and bulk status", () => {
  it("A on an approved line says 'already approved' (also for admins), not a permission error", () => {
    expect(forwardOrReason("admin", line({ status: "approved" }))).toEqual({ blocked: "already_approved" });
    expect(forwardOrReason("admin", line({ status: "reviewed" }))).toEqual({ to: "approved" });
    expect(forwardOrReason("editor", line({ status: "reviewed" }))).toEqual({ to: "approved" });
    expect(forwardOrReason("viewer", line({ status: "reviewed" }))).toEqual({ blocked: "forbidden" });
    expect(forwardOrReason(null, line())).toEqual({ blocked: "no_role" });
    expect(forwardOrReason("admin", line({ needsInput: true, qty: 0 }))).toEqual({ blocked: "needs_input" });
  });

  it("bulk plan: red lines out unless opted in, waiting lines never, the state machine walked per role", () => {
    const ls = [
      line({ id: "g", status: "draft" }),
      line({ id: "r", status: "draft", level: "red" }),
      line({ id: "a", status: "approved" }),
      line({ id: "w", status: "draft", needsInput: true, qty: 0 }),
      line({ id: "v", status: "reviewed", level: "yellow" }),
    ];
    const p = bulkPlan(ls, "approved", "admin", false);
    expect(p.eligible.map((l) => l.id)).toEqual(["g", "v"]);
    expect(skipCounts(p.skipped)).toEqual({ red: 1, already: 1, needs_input: 1 });
    expect(bulkPlan(ls, "approved", "admin", true).eligible.map((l) => l.id)).toEqual(["g", "r", "v"]);
    // editors approve too (SEC-07); viewers reach nothing
    expect(bulkPlan(ls, "reviewed", "editor", false).eligible.map((l) => l.id)).toEqual(["g"]);
    expect(roleCanReach("editor", "approved")).toBe(true);
    expect(roleCanReach("viewer", "approved")).toBe(false);
    expect(roleCanReach("reviewer", "approved")).toBe(true);
    expect(roleCanReach("viewer", "reviewed")).toBe(false);
  });

  it("range selection and undo groups", () => {
    expect(rangeIds(["a", "b", "c", "d"], "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeIds(["a", "b"], null, "b")).toEqual(["b"]);
    const before = new Map([
      ["a", "draft" as const],
      ["b", "reviewed" as const],
      ["c", "draft" as const],
    ]);
    expect(undoGroups(before, ["a", "b", "c"])).toEqual([
      { to: "draft", lineIds: ["a", "c"] },
      { to: "reviewed", lineIds: ["b"] },
    ]);
  });
});

describe("mock Sprint 6 layer (stand-in for the workers)", () => {
  const row = { sheet: { id: "s1", discipline: "electrical", floors: ["ground"] }, version: { id: "v1" } } as unknown as SheetRow;
  const room = (id: string, x: number, area: number, type?: Room["type"]): Room => ({
    id,
    name: id,
    nameConfidence: 1,
    floor: "ground",
    polygonMm: [{ x, y: 0 }, { x: x + 40, y: 0 }, { x: x + 40, y: 20 }, { x, y: 20 }],
    areaM2: area,
    perimeterM: 12,
    confidence: 1,
    level: "green",
    reasons: [],
    ...(type ? { type } : {}),
  });
  const det = (i: number) => ({ id: `d${i}`, class: "socket_double", bboxMm: { x: i * 5, y: 50, w: 3, h: 3 }, centerMm: { x: i * 5 + 1.5, y: 51.5 } }) as Detection;
  const sheets = [{ row, detections: Array.from({ length: 20 }, (_, i) => det(i)), rooms: [room("big", 0, 30), room("mid", 50, 12), room("st", 100, 4, "stairs")] }];

  it("adds text / geometry / suggested lines for the codes the base lacks, with their evidence", () => {
    const base = { lines: [line({ code: "4.17", id: "base_417" })], evidence: {} };
    const out = applySprint6(base, { sheets, library: libraryItems(), at: "t" });
    const byCode = new Map(out.lines.map((l) => [l.code, l]));
    expect(byCode.get("4.17")!.id).toBe("base_417"); // never touched
    const t = byCode.get("4.18")!;
    expect(t).toMatchObject({ origin: "text", needsInput: false, qty: 1 });
    expect(out.evidence[t.id]![0]).toMatchObject({ kind: "text", sheetId: "s1", text: expect.any(String) });
    const stair = byCode.get("5.04")!;
    expect(stair).toMatchObject({ origin: "geometry", qty: 11 });
    expect(out.evidence[stair.id]![0]!.treads).toHaveLength(11);
    const s = byCode.get("7.01")!;
    expect(s).toMatchObject({ origin: "suggested", needsInput: true, qty: 0, level: "red", quickAction: { kind: "measure_area", sheetId: "s1" } });
    expect(s.reasons?.[0]).toMatch(/תקרת הגבס/);
    expect(byCode.get("8.03")).toMatchObject({ needsInput: true, qty: 1, level: "yellow", quickAction: { kind: "confirm", sheetId: null } });
    // every catalogued code with a library item is present
    for (const it of S6_ITEMS) if (libraryItems().some((i) => i.code === it.code)) expect(byCode.has(it.code)).toBe(true);
  });

  it("finalize: a measured / confirmed suggested line is complete (manual, yellow, no longer waiting)", () => {
    const s = line({ id: s6LineId("7.01"), code: "7.01", origin: "suggested", needsInput: true, qty: 4, level: "red", breakdown: [{ label: "מדידת שטח ידנית", qty: 4, manual: true }] });
    const c = line({ id: s6LineId("8.03"), code: "8.03", origin: "suggested", needsInput: true, qty: 1, unit: "קומפלט" });
    const [a, b] = finalizeSprint6([s, c], new Map([[c.id, 2]]));
    expect(a).toMatchObject({ qty: 4, needsInput: false, origin: "manual", level: "yellow" });
    expect(b).toMatchObject({ qty: 2, needsInput: false, origin: "manual" });
  });
});
