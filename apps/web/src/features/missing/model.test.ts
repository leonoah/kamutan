import type { MissingItem } from "@/api/types";
import { canLearnAfterMark, canMarkItem, filterCounter, groupMissingByChapter } from "./model";

const item = (code: string, chapter: string, over: Partial<MissingItem> = {}): MissingItem => ({
  id: `ex_${code}`,
  code,
  chapter,
  chapterTitle: `פרק ${chapter}`,
  description: `סעיף ${code}`,
  unit: "יחידה",
  origin: "no_line",
  lineId: null,
  itemId: `it_${code}`,
  state: "open",
  markKind: "count",
  classes: [],
  exclusion: null,
  ...over,
});

describe("missing items model", () => {
  it("groups by chapter in the server's order (chapter order, then code)", () => {
    const g = groupMissingByChapter([item("1.01", "01"), item("1.05", "01"), item("4.02", "04"), item("4.10", "04"), item("9.01", "09")]);
    expect(g.map((x) => [x.chapter, x.items.map((i) => i.code)])).toEqual([
      ["01", ["1.01", "1.05"]],
      ["04", ["4.02", "4.10"]],
      ["09", ["9.01"]],
    ]);
    expect(g[1]!.title).toBe("פרק 04");
  });

  it("is deterministic and keeps an empty list empty", () => {
    const xs = [item("4.02", "04"), item("1.01", "01")];
    expect(groupMissingByChapter(xs)).toEqual(groupMissingByChapter([...xs]));
    expect(groupMissingByChapter([])).toEqual([]);
  });

  it("the counter follows the filter (הכל / בפרויקט / לא רלוונטי)", () => {
    const counts = { all: 7, inProject: 5, notRelevant: 2 };
    expect(filterCounter("all", counts)).toBe(7);
    expect(filterCounter("in_project", counts)).toBe(5);
    expect(filterCounter("not_relevant", counts)).toBe(2);
  });

  it("'סמן בשרטוט' needs an open item with a count / measure tool; lump sums and excluded items have none", () => {
    expect(canMarkItem(item("4.01", "04"))).toBe(true);
    expect(canMarkItem(item("4.01", "04", { markKind: "measure_area" }))).toBe(true);
    expect(canMarkItem(item("1.01", "01", { markKind: null }))).toBe(false);
    expect(canMarkItem(item("4.01", "04", { state: "not_relevant" }))).toBe(false);
  });

  it("'למד' is offered only after a count of a symbol-based item", () => {
    expect(canLearnAfterMark({ markKind: "count", classes: ["socket"] })).toBe(true);
    expect(canLearnAfterMark({ markKind: "count", classes: [] })).toBe(false);
    expect(canLearnAfterMark({ markKind: "measure_area", classes: ["socket"] })).toBe(false);
    expect(canLearnAfterMark({ markKind: null, classes: ["socket"] })).toBe(false);
  });
});
