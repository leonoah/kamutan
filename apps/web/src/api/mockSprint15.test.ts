import {
  BoqExclusionSchema,
  MissingItemsViewSchema,
  SetBoqExclusionResponseSchema,
  computeMissingItems,
  type MissingLibraryItem,
} from "@kamutan/contracts";
import { createMockBackend } from "./mock";
import { ApiError } from "./types";

const PID = "p-noah";
const ORG = "org-demo";

async function built(opts: Parameters<typeof createMockBackend>[0] = {}) {
  const b = createMockBackend({ latencyMs: 0, jobTickMs: 1, boqTickMs: 1, uploadTickMs: 5, devIndex: false, boqPrebuilt: true, ...opts });
  for (let i = 0; i < 400 && (await b.api.listBoqLines(PID)).items.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  return b;
}
const until = async <T,>(fn: () => Promise<T>, ok: (v: T) => boolean) => {
  for (let i = 0; i < 400; i++) {
    const v = await fn();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
};
const parse = <T,>(s: { safeParse(v: unknown): { success: boolean; data?: T; error?: unknown } }, v: unknown) => {
  const r = s.safeParse(v);
  if (!r.success) throw new Error(JSON.stringify(r.error));
  return r.data as T;
};

describe("Sprint 15 mock: סעיפים שלא זוהו", () => {
  it("lists library lines with no line or qty 0, grouped by chapter in chapter-then-code order, answers parse with the contracts", async () => {
    const b = await built();
    const v = parse(MissingItemsViewSchema, await b.api.getMissingItems(PID));
    expect(v.built).toBe(true);
    expect(v.counts.all).toBe(v.items.length);
    expect(v.counts.inProject).toBe(v.items.length);
    expect(v.counts.notRelevant).toBe(0);
    const chapters = v.items.map((i) => i.chapter);
    expect(chapters).toEqual([...chapters].sort());
    // a line with a quantity never shows up
    const lines = (await b.api.listBoqLines(PID)).items;
    for (const i of v.items) expect(lines.find((l) => l.code === i.code && l.qty > 0)).toBeUndefined();
    expect(v.items.some((i) => i.origin === "no_line")).toBe(true);
    expect(v.items.some((i) => i.origin === "zero_line")).toBe(true);
  });

  it("the three filters split the list, and the counts cover all of them", async () => {
    const b = await built();
    const first = (await b.api.getMissingItems(PID)).items[0]!;
    await b.api.setBoqExclusion(PID, { code: first.code, excluded: true });
    const all = await b.api.getMissingItems(PID, "all");
    const open = await b.api.getMissingItems(PID, "in_project");
    const hidden = await b.api.getMissingItems(PID, "not_relevant");
    expect(hidden.items.map((i) => i.code)).toEqual([first.code]);
    expect(open.items).toHaveLength(all.items.length - 1);
    expect(all.counts).toEqual({ all: all.items.length, inProject: all.items.length - 1, notRelevant: 1 });
    expect(open.counts).toEqual(all.counts);
  });

  it("'לא רלוונטי' hides a zero line from the BOQ lines, totals and the document, and a restore brings it back", async () => {
    const b = await built();
    const zero = (await b.api.getMissingItems(PID)).items.find((i) => i.origin === "zero_line")!;
    const before = await b.api.listBoqLines(PID);
    expect(before.items.some((l) => l.code === zero.code)).toBe(true);

    const res = parse(SetBoqExclusionResponseSchema, await b.api.setBoqExclusion(PID, { code: zero.code, excluded: true, reason: "אין חצר אנגלית בבית הזה" }));
    expect(res.changed).toBe(true);
    parse(BoqExclusionSchema, res.exclusion);
    expect(res.exclusion).toMatchObject({ code: zero.code, active: true, excludedBy: expect.any(String) });

    const after = await b.api.listBoqLines(PID);
    expect(after.items.some((l) => l.code === zero.code)).toBe(false);
    expect(after.items).toHaveLength(before.items.length - 1);
    const doc = await b.api.getBoqDocument(PID, { split: "none", confidence: false, chapters: null });
    expect(JSON.stringify(doc)).not.toContain(`"${zero.code}"`);

    const hidden = (await b.api.getMissingItems(PID, "not_relevant")).items[0]!;
    expect(hidden).toMatchObject({ code: zero.code, state: "not_relevant" });
    expect(hidden.exclusion?.reason).toBe("אין חצר אנגלית בבית הזה");

    // undo = restore
    const back = await b.api.setBoqExclusion(PID, { code: zero.code, excluded: false });
    expect(back).toMatchObject({ changed: true, exclusion: { active: false, restoredBy: expect.any(String) } });
    expect((await b.api.listBoqLines(PID)).items.some((l) => l.code === zero.code)).toBe(true);
    expect((await b.api.getMissingItems(PID, "not_relevant")).items).toHaveLength(0);
  });

  it("is idempotent (a second identical request changes nothing) and the history records who / when", async () => {
    const b = await built();
    const code = (await b.api.getMissingItems(PID)).items[0]!.code;
    expect((await b.api.setBoqExclusion(PID, { code, excluded: true })).changed).toBe(true);
    expect((await b.api.setBoqExclusion(PID, { code, excluded: true })).changed).toBe(false);
    await b.api.setBoqExclusion(PID, { code, excluded: false });
    const audit = (await b.api.listAudit(ORG, { entity: "boqExclusions" } as never)).items;
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(["exclude", "restore"]));
    for (const e of audit) {
      expect(e.actor).toBeTruthy();
      expect(e.at).toBeTruthy();
      expect(e.summary).toContain(code);
    }
  });

  it("the exclusion survives a BOQ rebuild", async () => {
    const b = await built();
    const zero = (await b.api.getMissingItems(PID)).items.find((i) => i.origin === "zero_line")!;
    await b.api.setBoqExclusion(PID, { code: zero.code, excluded: true });
    const prev = (await b.api.listBoqLines(PID)).boq?.latestBuildId;
    await b.api.buildBoq(PID);
    await until(() => b.api.listBoqLines(PID), (r) => r.boq?.latestBuildId !== prev);
    expect((await b.api.listBoqLines(PID)).items.some((l) => l.code === zero.code)).toBe(false);
    expect((await b.api.getMissingItems(PID, "not_relevant")).items.map((i) => i.code)).toContain(zero.code);
  });

  it("an exclusion never hides a quantity: a line with qty > 0 is shown again once it has one", () => {
    const lib: MissingLibraryItem[] = [{ id: "i1", code: "4.01", chapter: "04", description: "שקע", unit: "יחידה", active: true }];
    const ex = [{ id: "ex_4-01_x", code: "4.01", description: "שקע", unit: "יחידה", chapter: "04", active: true, excludedBy: "u", excludedAt: "2026-11-01T00:00:00.000Z" }];
    const zero = computeMissingItems({ library: lib, lines: [], exclusions: ex });
    expect(zero.map((i) => i.state)).toEqual(["not_relevant"]);
    const withQty = computeMissingItems({ library: lib, lines: [{ id: "l1", code: "4.01", chapter: "04", description: "שקע", unit: "יחידה", qty: 3, qtyOverride: null }] as never, exclusions: ex });
    expect(withQty).toEqual([]);
  });

  it("viewers and reviewers cannot exclude (403); an unknown code is a 404; the list is readable by a viewer", async () => {
    for (const role of ["viewer", "reviewer"] as const) {
      const b = await built({ orgs: [{ id: ORG, name: "x", role }] });
      await expect(b.api.setBoqExclusion(PID, { code: "2.01", excluded: true })).rejects.toMatchObject({ status: 403 });
      expect((await b.api.getMissingItems(PID)).built).toBe(true);
    }
    const b = await built();
    await expect(b.api.setBoqExclusion(PID, { code: "no-such", excluded: true })).rejects.toBeInstanceOf(ApiError);
  });
});
