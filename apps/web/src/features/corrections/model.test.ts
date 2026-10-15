import type { Correction, Detection, LinksArtifact } from "@/api/types";
import {
  HISTORY_LIMIT,
  applyCorrections,
  applyLinkCorrections,
  baseCorrection,
  classFamily,
  manualItems,
  materialize,
  popRedo,
  popUndo,
  pushStep,
  reissue,
  type History,
  type HistoryStep,
} from "./model";

const det = (id: string, cls: string, x: number, y: number, extra: Partial<Detection> = {}): Detection => ({
  id,
  class: cls,
  legendEntryId: null,
  centerMm: { x, y },
  bboxMm: { x: x - 2, y: y - 2, w: 4, h: 4 },
  angleDeg: 0,
  score: 0.6,
  level: "yellow",
  reasons: ["התאמה חלקית לסמל"],
  roomId: null,
  floor: "ground",
  lifecycle: "new",
  supply: null,
  annotations: [],
  clusterId: null,
  ...extra,
});
let t = 0;
const corr = (kind: Correction["kind"], extra: Partial<Correction> = {}, sheetId = "s1"): Correction =>
  materialize(
    baseCorrection(kind, { sheetId, versionId: "v1", anchorMm: { x: 10, y: 10 } }, extra),
    "u1",
    `2026-10-14T10:00:${String(++t).padStart(2, "0")}.000Z`,
  );

const DETS = [det("d_1", "socket_double", 10, 10), det("d_2", "socket_single", 50, 50), det("d_3", "switch_single", 90, 90)];

describe("corrections model", () => {
  it("accept → green 'אושר ידנית' (human-verified), reject → kept but flagged (never counted)", () => {
    const { detections } = applyCorrections(DETS, [corr("accept", { detectionId: "d_1" }), corr("reject", { detectionId: "d_2" })], "s1");
    expect(detections.find((d) => d.id === "d_1")).toMatchObject({ level: "green", manual: "accepted", reasons: ["אושר ידנית"] });
    expect(detections.find((d) => d.id === "d_2")).toMatchObject({ rejected: true });
    expect(detections).toHaveLength(3);
  });

  it("reclassify changes the class (learned ones carry ✦ 'תוקן בלמידה'); move shifts the item; add creates a manual ◈", () => {
    const { detections } = applyCorrections(
      DETS,
      [
        corr("reclassify", { detectionId: "d_1", class: "socket_power" }),
        corr("reclassify", { detectionId: "d_2", class: "socket_power", reason: "learned" }),
        corr("move", { detectionId: "d_3", geometry: { type: "point", mm: [{ x: 95, y: 92 }] } }),
        corr("add", { class: "tv_point", anchorMm: { x: 200, y: 100 }, geometry: { type: "point", mm: [{ x: 200, y: 100 }] } }),
      ],
      "s1",
    );
    expect(detections.find((d) => d.id === "d_1")).toMatchObject({ class: "socket_power", manual: "reclassified", level: "green" });
    expect(detections.find((d) => d.id === "d_2")).toMatchObject({ class: "socket_power", manual: "learned", reasons: ["תוקן בלמידה"] });
    expect(detections.find((d) => d.id === "d_3")!.centerMm).toEqual({ x: 95, y: 92 });
    const added = detections.find((d) => d.manual === "added")!;
    expect(added).toMatchObject({ class: "tv_point", level: "green", centerMm: { x: 200, y: 100 } });
    expect(added.id).toMatch(/^m_corr_/);
  });

  it("re-matches by anchorMm within radiusMm + class family on a new version; reports unmatched ones", () => {
    // New version: ids changed, the socket moved 1 mm; the switch is gone.
    const v2 = [det("d_10", "socket_double", 11, 10), det("d_11", "socket_single", 50, 50)];
    const c1 = corr("accept", { detectionId: "d_1", class: "socket_double", anchorMm: { x: 10, y: 10 } });
    const c2 = corr("reject", { detectionId: "d_3", class: "switch_single", anchorMm: { x: 90, y: 90 } });
    const { detections, unmatched } = applyCorrections(v2, [c1, c2], "s1");
    expect(detections.find((d) => d.id === "d_10")!.manual).toBe("accepted");
    expect(unmatched.map((c) => c.id)).toEqual([c2.id]);
    expect(classFamily("socket_power")).toBe(classFamily("socket_double"));
    expect(classFamily("luminaire_wall")).not.toBe(classFamily("socket_double"));
  });

  it("ignores reverted corrections and other sheets", () => {
    const c = { ...corr("reject", { detectionId: "d_1" }), revertedAt: "2026-10-14T11:00:00.000Z" };
    const other = corr("reject", { detectionId: "d_2" }, "s2");
    expect(applyCorrections(DETS, [c, other], "s1").detections.every((d) => !d.rejected)).toBe(true);
  });

  it("links: link attaches a point to a switch (or makes a group), unlink detaches, accept / reject a whole group", () => {
    const links: LinksArtifact = {
      schema: "kamutan.links/1",
      groups: [
        {
          id: "lk_1",
          switchIds: ["d_3"],
          pointIds: ["p1"],
          luminaireIds: ["l_1"],
          kind: "single",
          confidence: 0.6,
          level: "yellow",
          reasons: ["קישור מפסק לא ודאי"],
        },
      ],
    };
    const linked = applyLinkCorrections(links, [corr("link", { switchIds: ["d_3"], pointIds: ["l_2"] })], "s1")!;
    expect(linked.groups[0]).toMatchObject({ luminaireIds: ["l_1", "l_2"], kind: "shared", level: "green" });
    const fresh = applyLinkCorrections(links, [corr("link", { switchIds: ["d_9"], pointIds: ["l_7"] })], "s1")!;
    expect(fresh.groups).toHaveLength(2);
    const unlinked = applyLinkCorrections(links, [corr("unlink", { switchIds: ["d_3"], pointIds: ["l_1"], linkGroupId: "lk_1" })], "s1")!;
    expect(unlinked.groups).toHaveLength(0);
    const accepted = applyLinkCorrections(links, [corr("accept", { linkGroupId: "lk_1" })], "s1")!;
    expect(accepted.groups[0]!.level).toBe("green");
    expect(applyLinkCorrections(links, [corr("reject", { linkGroupId: "lk_1" })], "s1")!.groups).toHaveLength(0);
    expect(links.groups[0]!.luminaireIds).toEqual(["l_1"]); // input untouched
  });

  it("manual counts / measures → items with Hebrew units", () => {
    const items = manualItems([
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
        quantity: 4.2,
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
      corr("measure", {
        itemCode: "5.03",
        quantity: 1.5,
        unit: "m",
        geometry: {
          type: "polyline",
          mm: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
          ],
        },
      }),
    ]);
    expect(items.map((i) => [i.kind, i.itemCode, i.quantity, i.unit])).toEqual([
      ["count", "3.06", 2, "יחידה"],
      ["area", "5.02", 4.2, 'מ"ר'],
      ["length", "5.03", 1.5, 'מ"א'],
    ]);
  });

  it("history: a group action is one step; undo / redo; at most 100 steps per session", () => {
    const step = (n: number): HistoryStep => ({ label: `s${n}`, ids: [`c${n}`], redo: [], batchId: null });
    let h: History = { past: [], future: [] };
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) h = pushStep(h, step(i));
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0]!.label).toBe("s5");
    const u = popUndo(h);
    expect(u.step!.label).toBe(`s${HISTORY_LIMIT + 4}`);
    const r = popRedo(u.next);
    expect(r.step!.label).toBe(u.step!.label);
    expect(r.next.past).toHaveLength(HISTORY_LIMIT);
    expect(pushStep(u.next, step(999)).future).toEqual([]); // a new action clears the redo stack
    const again = reissue([baseCorrection("accept", { sheetId: "s1", versionId: "v1", anchorMm: { x: 1, y: 1 } })], "b2");
    expect(again[0]!.batchId).toBe("b2");
  });
});
