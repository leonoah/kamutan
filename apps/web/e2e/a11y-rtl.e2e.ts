import { axe, expect, expectRtl, login, shot, test, waitForWorkspace, NOAH_DATA } from "./support";

/**
 * Cross-cutting: axe-core WCAG 2.1 AA on every main screen (0 serious/critical, except the known defects that are
 * annotated — see KNOWN_A11Y), Hebrew/RTL, LTR islands for codes/numbers and the drawing.
 */
const MEMBER_SCREENS: { name: string; path: string; ready: (p: import("@playwright/test").Page) => Promise<void> }[] = [
  { name: "projects", path: "/projects", ready: async (p) => void (await expect(p.getByText("בית משפחת נח")).toBeVisible()) },
  { name: "hub", path: "/projects/p-noah", ready: async (p) => void (await expect(p.getByRole("link", { name: "לניתוח" }).first()).toBeVisible()) },
  { name: "hub-empty", path: "/projects/p-levi", ready: async (p) => void (await expect(p.getByTestId("dropzone")).toBeVisible()) },
  { name: "sheets", path: "/projects/p-noah/sheets", ready: async (p) => void (await expect(p.getByText(/מתוך 15 אושרו/)).toBeVisible()) },
  { name: "legend", path: "/projects/p-noah/legend", ready: async (p) => void (await expect(p.getByRole("button", { name: /^אשר את "/ }).first()).toBeVisible()) },
  { name: "sheet-analysis", path: "/projects/p-noah/sheets/noah-eb8be8a3-p0", ready: waitForWorkspace },
  { name: "project-boq", path: "/projects/p-noah/review?mockBoq=built", ready: async (p) => { await waitForWorkspace(p); await expect(p.locator("tr[data-code]").first()).toBeVisible({ timeout: 60_000 }); } },
  { name: "library", path: "/library", ready: async (p) => void (await expect(p.getByRole("heading", { level: 1 })).toBeVisible()) },
  { name: "settings", path: "/settings", ready: async (p) => void (await expect(p.getByRole("heading", { name: "הגדרות ארגון" })).toBeVisible()) },
  { name: "audit", path: "/settings/audit", ready: async (p) => void (await expect(p.getByText(/שרשרת היומן תקינה/)).toBeVisible()) },
  { name: "offboarding", path: "/settings/offboarding", ready: async (p) => void (await expect(p.getByText("1. הורדת ייצוא מלא")).toBeVisible()) },
];

test.describe("a11y + RTL on every main screen", () => {
  for (const s of MEMBER_SCREENS) {
    test(`axe: ${s.name}`, async ({ page }, info) => {
      test.skip(!NOAH_DATA && s.name === "sheets", "the 15-sheet count is Noah data");
      await login(page, s.path);
      await s.ready(page);
      await expectRtl(page);
      await page.waitForTimeout(500);
      await axe(page, info, s.name);
    });
  }

  for (const [name, path] of [["landing", "/"], ["login", "/login"], ["share-viewer", "/s/demo-noah"], ["share-expired", "/s/demo-expired"]] as const) {
    test(`axe: ${name} (public)`, async ({ page, allowConsole }, info) => {
      allowConsole(/status of 410|Failed to load resource/);
      await page.goto(path);
      await expectRtl(page);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
      if (name === "share-viewer") await expect(page.locator("[data-share-boq] tr[data-line]").first()).toBeVisible({ timeout: 60_000 });
      await axe(page, info, name);
    });
  }

  test("RTL: item codes and quantities are LTR islands; the drawing is the only LTR region; no mirrored units", async ({ page }, info) => {
    await login(page, "/projects/p-noah/review?mockBoq=built");
    await waitForWorkspace(page);
    const row = page.locator('tr[data-code="4.01"]');
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row.locator('bdi[dir="ltr"]').filter({ hasText: "4.01" })).toHaveCount(1);
    // the drawing subtree is LTR, the page around it RTL
    await expect(page.getByRole("application").first()).toHaveAttribute("dir", "ltr");
    await expect(page.locator("main, body").first()).not.toHaveAttribute("dir", "ltr");
    // TEXT-sorted codes inside a chapter (3.01 < 3.02 < … < 3.10)
    const codes = await page.locator("tr[data-code]").evaluateAll((r) => r.map((e) => e.getAttribute("data-code")!));
    const ch3 = codes.filter((c) => c.startsWith("3."));
    expect(ch3).toEqual([...ch3].sort());
    // scale "1:50" is rendered left-to-right (not "50:1")
    await expect(page.getByTestId("viewer-scale")).toHaveText(/^1:\d+$/);
    const scaleDir = await page.getByTestId("viewer-scale").evaluate((e) => getComputedStyle(e).direction);
    expect(scaleDir === "ltr" || (await page.getByTestId("viewer-scale").evaluate((e) => !!e.closest('[dir="ltr"]')))).toBe(true);
    await shot(page, info, "rtl-01-boq");
  });

  // ---- strict versions of the former a11y defects (KNOWN_A11Y is empty now; these pin the screens named in defects.md) ----
  test("A-UI-03 strict: no label-content-name-mismatch (hub sheet cards, sheets, sheet analysis queue, share list revoke, share viewer rows)", async ({ page }, info) => {
    await login(page, "/projects/p-noah");
    await expect(page.getByRole("link", { name: "לניתוח" }).first()).toBeVisible();
    const only = (v: { id: string }[]) => v.filter((x) => x.id === "label-content-name-mismatch");
    expect(only(await axe(page, info, "hub-strict", undefined, true))).toEqual([]);
    if (NOAH_DATA) {
      await page.goto("/projects/p-noah/sheets");
      await expect(page.getByText(/מתוך 15 אושרו/)).toBeVisible();
      expect(only(await axe(page, info, "sheets-strict", undefined, true))).toEqual([]);
    }
    await page.goto("/projects/p-noah/sheets/noah-eb8be8a3-p0");
    await waitForWorkspace(page);
    expect(only(await axe(page, info, "sheet-analysis-strict", undefined, true))).toEqual([]);
    await page.goto("/s/demo-noah");
    await expect(page.locator("[data-share-boq] tr[data-line]").first()).toBeVisible({ timeout: 60_000 });
    expect(only(await axe(page, info, "share-viewer-strict", undefined, true))).toEqual([]);
  });
  test("A-UI-04 strict: no color-contrast failures (hub 'ממתין לאישור' chip and others listed in defects.md)", async ({ page }, info) => {
    await login(page, "/projects/p-noah");
    await expect(page.getByRole("link", { name: "לניתוח" }).first()).toBeVisible();
    const v = await axe(page, info, "hub-contrast-strict", undefined, true);
    expect(v.filter((x) => x.id === "color-contrast")).toEqual([]);
  });
  // A-UI-16: the review workspace (sheet analysis + project BOQ) and the share viewer have one <main> and one <h1>.
  for (const [name, path] of [["sheet-analysis", "/projects/p-noah/sheets/noah-eb8be8a3-p0"], ["project-boq", "/projects/p-noah/review?mockBoq=built"]] as const) {
    test(`A-UI-16 ${name}: <main> + one <h1>, no landmark/heading/region findings`, async ({ page }, info) => {
      await login(page, path);
      await waitForWorkspace(page);
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.locator("h1")).toHaveCount(1);
      const v = await axe(page, info, `${name}-landmarks`, undefined, true);
      expect(v.filter((x) => ["landmark-one-main", "page-has-heading-one", "region"].includes(x.id)).map((x) => x.id)).toEqual([]);
    });
  }
  test("A-UI-16 share viewer: <main> + one <h1>, no landmark/region findings", async ({ page }, info) => {
    await page.goto("/s/demo-noah");
    await expect(page.locator("[data-share-boq] tr[data-line]").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("main")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveCount(1);
    const v = await axe(page, info, "share-viewer-landmarks", undefined, true);
    expect(v.filter((x) => ["landmark-one-main", "page-has-heading-one", "region"].includes(x.id)).map((x) => x.id)).toEqual([]);
  });
});
