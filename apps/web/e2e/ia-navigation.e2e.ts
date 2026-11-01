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

  // A-UI-01: the hero's decorative gradient blob (LandingPage.tsx, `end-[-10%] w-[520px]`) overflows → 15 px horizontal scroll.
  test.fixme("A-UI-01 mobile 390: landing has no horizontal scroll @mobile-only @mobile", async ({ page }) => {
    await page.goto("/");
    await expectNoHorizontalScroll(page);
  });

  // A-UI-02: the AppShell header (nav + demo badge + avatar menu) does not fit 390 px → 15 px horizontal scroll, the
  // user-menu chevron is cut off at the left edge (components/AppShell.tsx header row).
  test.fixme("A-UI-02 mobile 390: projects (app shell) has no horizontal scroll @mobile-only @mobile", async ({ page }) => {
    await login(page);
    await expectNoHorizontalScroll(page);
  });

  // A-UI-11: the hub header says "87% מאומת" (static project.stats, also on the projects card) while the hub's own BOQ card
  // says "14% מאומת" for the same project at the same moment (ProjectPage.tsx header vs ProjectBoqSummary.tsx).
  test.fixme("A-UI-11 hub: '% מאומת' in the header equals the project BOQ's '% מאומת'", async ({ page }) => {
    await login(page, "/projects/p-noah");
    const header = (await page.getByText(/^\d+% מאומת$/).first().textContent())!;
    await expect(page.getByText(/\d+ שורות · \d+% מאומת/)).toContainText(header);
  });
});
