import { axe, expect, expectNoHorizontalScroll, expectRtl, login, shot, test, waitForWorkspace, needsNoah } from "./support";

/** IA v2 (docs/spec/09_ia_redesign.md): landing → projects → project hub → sheet analysis → project BOQ. */
test.describe("IA v2 navigation", () => {
  test("landing (public) → login → projects → hub → sheet analysis (locked) → project BOQ", async ({ page }, info) => {
    needsNoah();
    await page.goto("/");
    await expectRtl(page);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("כתב כמויות מתוך סט שרטוטים");
    // the three steps + the confidence language
    await expect(page.getByRole("heading", { name: "איך זה עובד" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "שפת הביטחון" })).toBeVisible();
    await shot(page, info, "ia-01-landing");

    await page.getByRole("link", { name: "כניסה למערכת" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await login(page);

    // Level 1 — projects: cards with status, % verified, sheets, next action (always to level 2)
    await expect(page.getByRole("heading", { name: "פרויקטים", level: 1 })).toBeVisible();
    const noahCard = page.locator("li, article").filter({ hasText: "בית משפחת נח" }).first();
    await expect(noahCard).toContainText("% מאומת");
    await expect(noahCard).toContainText("15 גיליונות");
    await shot(page, info, "ia-02-projects");
    const next = noahCard.getByRole("link", { name: /המשך בדיקה/ });
    await expect(next).toHaveAttribute("href", "/projects/p-noah");
    await next.click();

    // Level 2 — project hub: gallery + project BOQ + setup strip; upload is a secondary action
    await expect(page).toHaveURL(/\/projects\/p-noah$/);
    await expect(page.getByRole("heading", { name: "בית משפחת נח", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^שרטוטים/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "כתב כמויות" })).toBeVisible();
    await expect(page.getByRole("list", { name: "הכנה" }).or(page.getByRole("link", { name: "אישור גיליונות" })).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "העלאת שרטוטים" })).toBeVisible();
    await expect(page.getByRole("link", { name: "לסביבת הבדיקה" })).toHaveAttribute("href", "/projects/p-noah/review");
    await page.waitForTimeout(800);
    await shot(page, info, "ia-03-hub");
    await shot(page, info, "ia-03-hub-full", { fullPage: true });

    // Level 3 — sheet analysis: "לניתוח" opens one sheet, locked (no sheet switcher), breadcrumb with the sheet name
    const analyse = page.getByRole("link", { name: "לניתוח" }).first();
    await expect(analyse).toBeVisible();
    await analyse.click();
    await expect(page).toHaveURL(/\/projects\/p-noah\/sheets\/[^/]+$/);
    await waitForWorkspace(page);
    const crumbs = page.getByRole("navigation", { name: "מיקום" });
    await expect(crumbs).toContainText("בית משפחת נח");
    await expect(crumbs).toContainText("ניתוח שרטוט");
    // opens on "ספירה לפי סוג" (component mapping)
    await expect(page.getByRole("tab", { name: "ספירה לפי סוג" })).toHaveAttribute("aria-selected", "true");
    // locked: no sheet picker
    await expect(page.getByRole("combobox", { name: /גיליון/ })).toHaveCount(0);
    await shot(page, info, "ia-04-sheet-analysis");

    // breadcrumb back to the hub, then the project BOQ (all sheets)
    await crumbs.getByRole("link", { name: "בית משפחת נח" }).click();
    await expect(page).toHaveURL(/\/projects\/p-noah$/);
    await page.getByRole("link", { name: "לסביבת הבדיקה" }).click();
    await expect(page).toHaveURL(/\/projects\/p-noah\/review/);
    await waitForWorkspace(page);
    await expect(page.getByRole("tab", { name: "כתב כמויות" })).toBeVisible();
    await shot(page, info, "ia-05-project-boq");
  });

  test("hub: clicking a drawing filters the project BOQ by that sheet", async ({ page }, info) => {
    needsNoah();
    await login(page, "/projects/p-noah");
    const boq = page.locator("section").filter({ has: page.getByRole("heading", { name: "כתב כמויות" }) }).first();
    await expect(boq).toContainText(/\d+ שורות/);
    const before = (await boq.textContent())!.match(/(\d+) שורות/)![1];
    const ready = page.locator("li, article").filter({ has: page.getByRole("link", { name: "לניתוח" }) }).first();
    await ready.getByRole("button").first().click();
    await expect(boq).not.toContainText(`${before} שורות`);
    await shot(page, info, "ia-06-hub-filtered");
  });

  test("hub BOQ card: chapter titles not duplicated, one dash style (A-UI-18); similar lines distinguishable (A-UI-17)", async ({ page }) => {
    needsNoah();
    await login(page, "/projects/p-noah");
    const boq = page.locator("section").filter({ has: page.getByRole("heading", { name: "כתב כמויות" }) }).first();
    await expect(boq).toContainText(/\d+ שורות/);
    const summaries = await boq.locator("summary").allTextContents();
    expect(summaries.length).toBeGreaterThan(0);
    for (const s of summaries) {
      expect(s, "no 'פרק 03 · פרק 03 – …'").not.toMatch(/פרק \S+ · פרק/);
      expect(s, "en dash only").not.toMatch(/\s-\s/);
    }
    // descriptions are clamped to two lines, not cut to one: the full text is in the cell and a title tooltip
    const cell = boq.locator("tbody td[title]").first();
    await expect(cell.locator(".line-clamp-2")).toHaveCount(1);
    const desc = await cell.getAttribute("title");
    await expect(cell).toHaveText(desc!);
  });

  test("sheet analysis: header stats describe the locked sheet (A-UI-14); no Sprint-2 placeholder copy (A-UI-15)", async ({ page }) => {
    needsNoah();
    await login(page, "/projects/p-noah/sheets/noah-b2046277-p0");
    await waitForWorkspace(page);
    const header = page.locator("header").first();
    const toReview = Number((await header.getByRole("button", { name: /^\d+ לבדיקה$/ }).textContent())!.match(/\d+/)![0]);
    // the level chips under the header count the same items (red + unknown)
    const chips = page.getByRole("group", { name: "ביטחון", exact: true });
    const n = async (label: string) => Number(((await chips.getByRole("button", { name: new RegExp(`^${label} \\(\\d+\\)$`) }).textContent()) ?? "").match(/\((\d+)\)/)?.[1] ?? "0");
    expect(toReview).toBe((await n("לבדיקה")) + (await n("לא מוכר")));
    await expect(page.getByText(/יגיע בהמשך/)).toHaveCount(0);
  });

  test("an unauthenticated deep link goes to login; unknown routes show a 404 page", async ({ page }, info) => {
    await page.goto("/projects/p-noah");
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/no-such-page");
    await expect(page.getByText(/לא נמצא/).first()).toBeVisible();
    await shot(page, info, "ia-07-404");
  });

  test("mobile 390: landing and projects render in Hebrew RTL, primary actions reachable @mobile-only @mobile", async ({ page }, info) => {
    await page.goto("/");
    await expectRtl(page);
    await expect(page.getByRole("link", { name: "כניסה למערכת" })).toBeInViewport();
    await shot(page, info, "m-01-landing", { fullPage: true });
    await axe(page, info, "m-landing");
    await login(page);
    await expect(page.getByText("בית משפחת נח")).toBeVisible();
    await expect(page.getByRole("button", { name: "פרויקט חדש" })).toBeVisible();
    await shot(page, info, "m-02-projects", { fullPage: true });
    await axe(page, info, "m-projects");
  });

  // A-UI-01 (fixed): the hero's decorative gradient blob overflowed → 15 px horizontal scroll; the page now clips x.
  test("A-UI-01 mobile 390: landing has no horizontal scroll @mobile-only @mobile", async ({ page }) => {
    await page.goto("/");
    await expectNoHorizontalScroll(page);
  });

  // A-UI-02 (fixed): the AppShell header (nav + demo badge + avatar menu) did not fit 390 px. Now: icon-only logo,
  // tighter gaps; the user menu is fully on screen. Also the hub and the library inside the shell.
  test("A-UI-02 mobile 390: projects (app shell) has no horizontal scroll @mobile-only @mobile", async ({ page }) => {
    await login(page);
    await expect(page.getByText("בית משפחת נח")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expect(page.getByRole("button", { name: "תפריט משתמש" })).toBeInViewport({ ratio: 1 });
    for (const path of ["/projects/p-noah", "/library"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expectNoHorizontalScroll(page);
    }
  });

  // A-UI-11 (fixed): the hub header said "87% מאומת" (static project.stats) while the hub's BOQ card said "14% מאומת".
  // The header now uses the same live lines as the card once a BOQ is built.
  test("A-UI-11 hub: '% מאומת' in the header equals the project BOQ's '% מאומת'", async ({ page }) => {
    await login(page, "/projects/p-noah");
    const header = (await page.getByText(/^\d+% מאומת$/).first().textContent())!;
    await expect(page.getByText(/\d+ שורות · \d+% מאומת/)).toContainText(header);
  });
});
