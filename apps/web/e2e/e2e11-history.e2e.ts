import { expect, shot, test, axe, needsNoah } from "./support";
import { openReview, qtyButton, row } from "./review.helpers";

const statusOf = (page: import("@playwright/test").Page, code: string) => row(page, code).getByText(/^(טיוטה|נבדק|אושר)$/);

/**
 * E2E-11 — statuses and history. Line 4.01 is moved טיוטה → נבדק → אושר with A (admin), then its quantity is overridden
 * with a reason. Deviation agreed in Sprint 3/5 (07_test_plan E2E-11 note): the line returns to "נבדק", not "טיוטה".
 * The history shows before/after, who, when and the reason; the org audit log shows the change.
 */
test.beforeEach(() => needsNoah());

test("E2E-11: A/A → 'אושר', override with reason → 'נבדק', history before/after + who/when, org audit", async ({ page }, info) => {
  await openReview(page, "sheet=noah-eb8be8a3-p0&mockBoq=built");
  const r = row(page, "4.01");
  await r.scrollIntoViewIfNeeded();
  await r.getByText("שקע כפול").first().click();
  await expect(statusOf(page, "4.01")).toHaveText("טיוטה");

  await page.keyboard.press("KeyA");
  await expect(statusOf(page, "4.01")).toHaveText("נבדק");
  await expect(page.getByText(/השורה 4\.01 סומנה 'נבדק'/).first()).toBeVisible();
  await page.keyboard.press("KeyA");
  await expect(statusOf(page, "4.01")).toHaveText("אושר");

  // override (E) — reason is mandatory
  const before = Number((await qtyButton(page, "4.01").innerText()).match(/\d+/)![0]);
  await page.keyboard.press("KeyE");
  const dlg = page.getByRole("dialog", { name: "עריכת כמות — 4.01" });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel("כמות חדשה").fill(String(before + 2));
  await dlg.getByRole("button", { name: "שמור כמות" }).click();
  await expect(dlg.getByText("חובה לכתוב סיבה.")).toBeVisible();
  await dlg.getByLabel(/למה משנים את הכמות/).fill("2 שקעים נוספים לפי שיחה עם הלקוח (בדיקת קבלה)");
  await axe(page, info, "override-dialog", '[role="dialog"]');
  await dlg.getByRole("button", { name: "שמור כמות" }).click();
  await expect(dlg).toBeHidden();
  await expect(qtyButton(page, "4.01")).toContainText(String(before + 2));
  await expect(statusOf(page, "4.01")).toHaveText("נבדק"); // deviation: back to "נבדק", re-approval needed
  await expect(r).toContainText("ידני");
  await shot(page, info, "e2e11-01-overridden");

  // history: newest first, before → after, who, when, reason, reopened note
  await r.hover();
  await r.getByRole("button", { name: "היסטוריית השינויים של 4.01" }).click();
  const hist = page.getByRole("dialog", { name: /היסטוריית שינויים/ });
  await expect(hist).toBeVisible();
  await expect(hist).toContainText("שינוי כמות ידני");
  await expect(hist).toContainText("שינוי סטטוס");
  await expect(hist).toContainText(String(before));
  await expect(hist).toContainText(String(before + 2));
  await expect(hist).toContainText("2 שקעים נוספים לפי שיחה עם הלקוח");
  await expect(hist).toContainText("השורה חזרה ל'נבדק' כי הכמות שונתה אחרי אישור.");
  await expect(hist).toContainText(/\d{2}\.\d{2}\.\d{4}/);
  await expect(hist.locator("s, del, .line-through").first()).toBeVisible(); // "before" struck through
  // newest first: the override and the status reopen it caused (same timestamp, order between the two not stable: A-UI-06)
  const top2 = (await hist.getByRole("listitem").allInnerTexts()).slice(0, 2).join(" ");
  expect(top2).toContain("שינוי כמות ידני");
  expect(top2).toContain("השורה חזרה ל'נבדק'");
  await shot(page, info, "e2e11-02-history");
  await axe(page, info, "history-dialog", '[role="dialog"]');
  await page.keyboard.press("Escape");

  // org audit (admin) — reached in-app so the mock keeps its state
  await page.getByRole("navigation", { name: "מיקום" }).getByRole("link", { name: "כמותן" }).click();
  await page.getByRole("link", { name: "הגדרות" }).click();
  await page.getByRole("link", { name: "יומן פעולות" }).click();
  const log = page.getByRole("table").first();
  await expect(log.getByRole("row").filter({ hasText: "שינוי כמות ידני" }).first()).toBeVisible();
  await expect(log.getByRole("row").filter({ hasText: "שינוי סטטוס" }).first()).toBeVisible();
  await shot(page, info, "e2e11-03-audit");
});
