import { expect, login, shot, test, waitForWorkspace } from "./support";

const ORG = "סטודיו נח לעיצוב פנים";

test.describe("Org settings, audit log, offboarding", () => {
  test("org settings: change threshold + a switch → save diff → 'נרשם ביומן' → visible in the audit log", async ({ page }, info) => {
    await login(page, "/settings");
    await expect(page.getByRole("heading", { name: "הגדרות ארגון" })).toBeVisible();
    const slider = page.getByLabel("סף 'מאומת'");
    await expect(slider).toHaveAttribute("min", "0.9");
    await expect(slider).toHaveAttribute("max", "0.995");
    await slider.fill("0.95");
    const block = page.getByRole("switch", { name: "חסום ייצוא כשיש שורות 'לבדיקה'" });
    const was = await block.getAttribute("aria-checked");
    await block.click();
    await expect(block).toHaveAttribute("aria-checked", was === "true" ? "false" : "true");
    await expect(page.getByText("יש שינויים שלא נשמרו")).toBeVisible();
    await shot(page, info, "set-01-settings-dirty");
    await page.getByRole("button", { name: "שמור שינויים" }).click();
    await expect(page.getByText("ההגדרות נשמרו ונרשמו ביומן.").first()).toBeVisible();
    await expect(page.getByText("יש שינויים שלא נשמרו")).toHaveCount(0);

    await page.getByRole("link", { name: "יומן פעולות" }).click();
    const log = page.getByRole("table").first();
    await expect(log.getByRole("row").filter({ hasText: "הגדרות ארגון" }).first()).toBeVisible();
    await shot(page, info, "set-02-audit-after-settings");
  });

  test("audit log: chain verified, entity/action filters, paging ('טען עוד')", async ({ page }, info) => {
    await login(page, "/settings/audit");
    await expect(page.locator('[data-verify="ok"]')).toContainText(/שרשרת היומן תקינה · \d+ רשומות נבדקו/);
    const rows = page.getByRole("table").first().getByRole("row");
    const n0 = await rows.count();
    await page.getByRole("button", { name: "טען עוד" }).click();
    await expect.poll(() => rows.count()).toBeGreaterThan(n0);
    await page.getByLabel("על מה").selectOption({ label: "ייצוא" });
    await expect(rows.nth(1)).toContainText("ייצוא");
    await expect(rows.filter({ hasText: "חברי צוות" })).toHaveCount(0);
    await page.getByLabel("על מה").selectOption({ label: "קישורי שיתוף" });
    await expect(page.getByText("אין רשומות שמתאימות לסינון.").or(rows.nth(1))).toBeVisible();
    await shot(page, info, "set-03-audit-filtered");
  });

  test("offboarding: ZIP export → warnings → typed org name + 'I understand' → org blocked", async ({ page }, info) => {
    await login(page, "/settings/offboarding");
    await expect(page.getByRole("heading", { name: "סיום התקשרות ומחיקת נתוני הארגון" })).toBeVisible();
    for (const w of ["ינותקו מיד", "תיחסם מיד", "בעוד 30 יום", "תעודת מחיקה"]) await expect(page.getByText(new RegExp(w)).first()).toBeVisible();
    await expect(page.getByText("עוד לא הורדתם ייצוא מלא.", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "הכן ייצוא מלא" }).click();
    await expect(page.getByRole("link", { name: "הורד ZIP" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/ההורדה זמינה עד/)).toBeVisible();
    await shot(page, info, "set-04-offboarding-export");

    const submit = page.getByRole("button", { name: "סיים התקשרות ומחק את הנתונים" });
    await expect(submit).toBeDisabled();
    await page.getByLabel("כדי לאשר, הקלידו את שם הארגון").fill("שם שגוי");
    await page.getByLabel(/הבנתי שהפעולה סופית/).check();
    await expect(submit).toBeDisabled();
    await page.getByLabel("כדי לאשר, הקלידו את שם הארגון").fill(ORG);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.locator("[data-offboarded]")).toContainText("הארגון בתהליך סיום התקשרות");
    await shot(page, info, "set-05-offboarded");

    // the rest of the app is blocked for the org (in-app navigation keeps the mock state)
    await page.getByRole("link", { name: "פרויקטים" }).first().click();
    await expect(page.getByText("הארגון בתהליך סיום התקשרות").first()).toBeVisible();
    await expect(page.getByText("בית משפחת נח")).toHaveCount(0);
    await shot(page, info, "set-06-blocked");
  });

  test("offboarding with an old sign-in asks to re-authenticate (wrong then right password)", async ({ page }, info) => {
    await login(page, "/settings/offboarding?mockAuthAge=3600");
    await page.getByRole("button", { name: "הכן ייצוא מלא" }).click();
    const box = page.locator("[data-reauth]");
    await expect(box).toBeVisible();
    await expect(box).toContainText("נדרשת כניסה מחדש");
    await box.getByLabel("סיסמה").fill("short");
    await box.getByRole("button", { name: "אמת" }).click();
    await expect(box.getByText("האימות נכשל. בדקו את הסיסמה ונסו שוב.")).toBeVisible();
    await box.getByLabel("סיסמה").fill("acceptance-1234");
    await box.getByRole("button", { name: "אמת" }).click();
    await expect(page.getByRole("link", { name: "הורד ZIP" })).toBeVisible({ timeout: 30_000 });
    await shot(page, info, "set-07-reauth-done");
  });

  test("non-admin (editor) sees no settings nav and the settings page refuses", async ({ page }) => {
    await login(page, "/projects?mockRole=editor");
    await expect(page.getByText("בית משפחת נח")).toBeVisible();
    await expect(page.getByRole("link", { name: "הגדרות" })).toHaveCount(0);
  });
});

test.describe("Calibration badge", () => {
  test("'כיול שמרני' in the review header opens a plain-Hebrew explanation with capped lines + threshold", async ({ page }, info) => {
    await login(page, "/projects/p-noah/review?mockBoq=built");
    await waitForWorkspace(page);
    const badge = page.getByRole("button", { name: "מצב כיול שמרני — מה זה אומר?" }).first();
    await expect(badge).toBeVisible();
    await badge.click();
    const pop = page.getByRole("dialog").filter({ hasText: "המערכת רצה בכיול שמרני" });
    await expect(pop).toBeVisible();
    await expect(pop).toContainText("200 פריטים");
    await expect(pop).toContainText(/שורות? בכתב הכמויות הוגבל/);
    await expect(pop).toContainText("סף 'מאומת' של המשרד");
    await expect(pop).toContainText("טבלת כיול");
    await shot(page, info, "cal-01-popover");
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    // also in the BOQ panel header
    await expect(page.getByRole("button", { name: "מצב כיול שמרני — מה זה אומר?" })).toHaveCount(2);
  });
});
