import type { Page } from "@playwright/test";
import { axe, expect, expectNoHorizontalScroll, expectRtl, login, shot, test } from "./support";
import { ELEC, canvas, openReview, row } from "./review.helpers";

/**
 * Sprint 6 — every line of the client's BOQ is present: computed (symbols / text / geometry) or suggested
 * "להשלמה ידנית" with a one-click measure / count / confirm. Plus the owner's feedback: bulk approve, no toast per
 * status change, "already approved". Runs in BOTH data modes (Noah artifacts or the synthetic fixture): the mock's
 * Sprint-6 layer anchors its lines on the electrical sheet of either set.
 */
const BUILT = `sheet=${ELEC}&mockBoq=built`;
const visibleToasts = (page: Page) => page.locator("li[data-toast-tone]");

test.describe("Sprint 6: suggested lines and quick actions", () => {
  test("suggested lines: 'להשלמה ידנית', unit, reason, quick action; origin badges; coverage per chapter; filter", async ({ page }, info) => {
    await openReview(page, BUILT);
    const r = row(page, "7.01");
    await expect(r).toHaveAttribute("data-needs-input", "true");
    await expect(r.getByText("להשלמה ידנית")).toBeVisible();
    await expect(r.locator("[data-origin]").first()).toHaveText(/מוצע/);
    await expect(r.getByText("חסרה כמות")).toBeVisible();
    await expect(r.getByRole("button", { name: "מדידת שטח לסעיף 7.01" })).toBeVisible();
    // Noah mode: Worker-BOQ's own lines win (4.18 may be "סמלים"); every origin is still represented
    await expect(page.locator('tr[data-origin="text"]').first().locator("[data-origin]").first()).toHaveText(/כיתוב/);
    await expect(page.locator('tr[data-origin="geometry"]').first().locator("[data-origin]").first()).toHaveText(/מדידה/);
    await expect(page.locator('tr[data-origin="detected"]').first().locator("[data-origin]").first()).toHaveText(/סמלים/);
    await expect(page.locator("[data-coverage]").first()).toHaveText(/\d+ מתוך \d+ סעיפים חושבו מהשרטוט/);
    await r.scrollIntoViewIfNeeded();
    await shot(page, info, "s6-01-suggested-lines");
    // origin tooltip on hover
    await r.locator("[data-origin]").first().hover();
    await expect(page.getByRole("tooltip").filter({ hasText: "סעיף מוצע" })).toBeVisible();
    await shot(page, info, "s6-02-origin-tooltip");
    // filter
    const chip = page.locator("[data-filter-needs-input]");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    const codes = await page.locator("tr[data-line]").evaluateAll((rs) => rs.map((x) => x.hasAttribute("data-needs-input")));
    expect(codes.length).toBeGreaterThan(5);
    expect(codes.every(Boolean)).toBe(true);
    await shot(page, info, "s6-03-filter-needs-input");
    await axe(page, info, "s6-review-needs-input");
  });

  test("measure quick action: the area tool opens bound to 7.01; the polygon saves and the line completes at once", async ({ page }, info) => {
    await openReview(page, BUILT);
    await row(page, "7.01").getByRole("button", { name: "מדידת שטח לסעיף 7.01" }).click();
    const banner = page.locator("[data-quick-banner]");
    await expect(banner).toContainText("מדידת שטח לסעיף");
    await expect(banner).toContainText("7.01");
    await shot(page, info, "s6-04-quick-measure-armed");
    const b = (await canvas(page).boundingBox())!;
    for (const [fx, fy] of [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]] as const) await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
    await page.keyboard.press("Enter");
    const r = row(page, "7.01");
    await expect(r).not.toHaveAttribute("data-needs-input", "true", { timeout: 2_000 });
    await expect(visibleToasts(page).filter({ hasText: /נשמרה כמות [\d.]+ מ"ר לסעיף 7\.01\./ })).toHaveCount(1);
    await expect(r).toHaveAttribute("data-origin", "manual");
    await expect(banner).toHaveCount(0);
    await shot(page, info, "s6-05-quick-measure-saved");
  });

  test("confirm quick action: dialog prefilled with the estimate → the line leaves 'להשלמה ידנית'", async ({ page }, info) => {
    await openReview(page, BUILT);
    await row(page, "8.03").getByRole("button", { name: "אישור כמות לסעיף 8.03" }).click();
    const dlg = page.getByRole("dialog", { name: /אישור כמות/ });
    await expect(dlg.getByLabel("כמות (קומפלט)")).toHaveValue("1");
    await shot(page, info, "s6-06-confirm-dialog");
    await axe(page, info, "s6-confirm-dialog");
    await dlg.getByRole("button", { name: "אשר כמות" }).click();
    await expect(row(page, "8.03")).not.toHaveAttribute("data-needs-input", "true");
  });

  test("text / stair evidence highlighted on the drawing (row → drawing)", async ({ page }, info) => {
    await openReview(page, BUILT);
    const before = await canvas(page).screenshot();
    const text = page.locator('tr[data-origin="text"]').first();
    const code = (await text.getAttribute("data-code"))!;
    await text.getByRole("button", { name: /^בחר שורה/ }).click();
    await expect(page.locator("footer").getByText(code, { exact: true })).toBeVisible();
    await page.waitForTimeout(1200); // zoom animation
    expect(Buffer.compare(before, await canvas(page).screenshot())).not.toBe(0);
    await shot(page, info, "s6-07-text-evidence");
    await row(page, "5.04").getByRole("button", { name: /^בחר שורה 5\.04/ }).click();
    await page.waitForTimeout(1200);
    await shot(page, info, "s6-08-stair-evidence");
    await row(page, "7.06").getByRole("button", { name: /^בחר שורה 7\.06/ }).click();
    await page.waitForTimeout(1200);
    await shot(page, info, "s6-09-geometry-evidence");
  });

  test("hub card: 'להשלמה ידנית' chip, coverage, filter; the quick action opens the review with the tool bound", async ({ page }, info) => {
    await login(page, "/projects/p-noah?mockBoq=built");
    const card = page.locator("section[aria-labelledby=hub-boq-title]");
    const r = card.locator('tr[data-code="7.01"]');
    await expect(r.getByText("להשלמה ידנית")).toBeVisible({ timeout: 60_000 });
    await expect(card.locator("[data-coverage]").first()).toHaveText(/מתוך \d+ סעיפים חושבו מהשרטוט/);
    await r.scrollIntoViewIfNeeded();
    await shot(page, info, "s6-10-hub-card");
    await card.locator("[data-filter-needs-input]").click();
    await expect(card.locator("tr[data-code]:not([data-needs-input])")).toHaveCount(0);
    await axe(page, info, "s6-hub-needs-input");
    await r.getByRole("link", { name: "מדידת שטח לסעיף 7.01" }).click();
    await expect(page.getByRole("application").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-quick-banner]")).toContainText("7.01", { timeout: 30_000 });
    await expect(page).not.toHaveURL(/quick=1/);
  });

  test("hub card on a phone (390): suggested lines readable, no horizontal scroll @mobile-only @mobile", async ({ page }, info) => {
    await login(page, "/projects/p-noah?mockBoq=built");
    const r = page.locator('section[aria-labelledby=hub-boq-title] tr[data-code="7.01"]');
    await expect(r.getByText("להשלמה ידנית")).toBeVisible({ timeout: 60_000 });
    await r.scrollIntoViewIfNeeded();
    await expectRtl(page);
    await expectNoHorizontalScroll(page);
    await shot(page, info, "s6-11-hub-mobile");
  });
});

test.describe("Owner feedback: bulk approve, toast flood, 'already approved'", () => {
  test("A over several lines: no toast per change (live region instead), ≤ 3 toasts; A on an approved line says so", async ({ page }, info) => {
    await openReview(page, BUILT);
    const r = row(page, "4.01");
    await r.getByRole("button", { name: /^בחר שורה 4\.01/ }).click();
    await page.keyboard.press("KeyA");
    await expect(r.locator("[data-status]")).toHaveAttribute("data-status", "reviewed");
    await page.keyboard.press("KeyA");
    await expect(r.locator("[data-status]")).toHaveAttribute("data-status", "approved");
    await expect(page.getByTestId("live-msg")).toHaveText("השורה 4.01 סומנה 'אושר'.");
    await expect(visibleToasts(page).filter({ hasText: /סומנה '/ })).toHaveCount(0);
    for (let i = 0; i < 5; i++) await page.keyboard.press("KeyA");
    await expect(visibleToasts(page).filter({ hasText: "השורה 4.01 כבר מאושרת." })).toHaveCount(1);
    await expect(visibleToasts(page).filter({ hasText: "אין לך הרשאה" })).toHaveCount(0);
    expect(await visibleToasts(page).count()).toBeLessThanOrEqual(3);
    await shot(page, info, "s6-12-already-approved");
  });

  test("bulk: checkbox, shift range, chapter, 'אשר (N)' → confirm with the count → ONE summary toast → undo", async ({ page }, info) => {
    await openReview(page, BUILT);
    await row(page, "4.00").getByRole("checkbox").click();
    await row(page, "4.05").getByRole("checkbox").click({ modifiers: ["Shift"] });
    const checked = await page.locator("tr[data-checked]").evaluateAll((rs) => rs.map((x) => x.getAttribute("data-code")));
    expect(checked.length).toBeGreaterThanOrEqual(5);
    const bar = page.getByRole("region", { name: "פעולות על השורות שנבחרו" });
    await expect(bar).toBeVisible();
    await shot(page, info, "s6-13-bulk-bar");
    await axe(page, info, "s6-bulk-bar");
    // Shift+A = approve the selection
    await page.keyboard.press("Shift+KeyA");
    const dlg = page.getByRole("dialog", { name: /^לאשר/ });
    await expect(dlg).toBeVisible();
    await shot(page, info, "s6-14-bulk-confirm");
    await axe(page, info, "s6-bulk-confirm");
    await dlg.getByRole("button", { name: /^אשר \d+$/ }).click();
    await expect(visibleToasts(page).filter({ hasText: /^(אושרו \d+ שורות|אושרה שורה אחת)/ })).toHaveCount(1);
    expect(await visibleToasts(page).count()).toBe(1);
    await shot(page, info, "s6-15-bulk-summary");
    const approved = await page.locator('tr[data-line]:has([data-status="approved"])').count();
    expect(approved).toBeGreaterThan(0);
    await visibleToasts(page).getByRole("button", { name: "בטל" }).click();
    await expect(visibleToasts(page).filter({ hasText: /^השינוי בוטל/ })).toHaveCount(1);
    await expect(page.locator('tr[data-line]:has([data-status="approved"])')).toHaveCount(0);
  });

  test("bulk: red lines left out by default; 'כולל N שורות אדומות' warns and the dialog counts them", async ({ page }, info) => {
    await openReview(page, BUILT);
    await page.getByRole("checkbox", { name: /^בחר הכל/ }).click();
    const bar = page.getByRole("region", { name: "פעולות על השורות שנבחרו" });
    const red = bar.getByLabel(/^כולל .*אדומ/);
    await expect(red).not.toBeChecked();
    await red.check();
    await expect(bar.getByRole("note")).toContainText("שורות אדומות לא נבדקו");
    await bar.getByRole("button", { name: /^אשר \(\d+\)/ }).click();
    const dlg = page.getByRole("dialog", { name: /^לאשר/ });
    await expect(dlg.getByRole("alert")).toContainText(/אדומ/);
    await expect(dlg).toContainText(/לא ישתנו: .*להשלמה ידנית/);
    await shot(page, info, "s6-16-bulk-red-optin");
    await dlg.getByRole("button", { name: "ביטול" }).click();
  });
});
