import { axe, expect, expectNoHorizontalScroll, login, shot, test, waitForWorkspace, needsNoah } from "./support";
import { canvas, openReview, qtyButton, row } from "./review.helpers";

/**
 * Stage 10 fix round — new flows (web side, mock mode; shapes mirrored until packages/contracts publishes them):
 * members screen (A-API-01), MFA / re-authentication on admin settings, templates and rules (A-API-02), the
 * empty / default library notice (A-LIVE-01), and approved lines that dropped to "נבדק" because their quantity changed.
 */
test.describe("Stage 10: members + re-authentication", () => {
  test("members: invite link (once, copy), change a role, remove behind a confirmation; audited", async ({ page, context }, info) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await login(page, "/settings/members");
    await expect(page.getByRole("heading", { name: "הגדרות ארגון", level: 1 })).toBeVisible();
    const table = page.getByRole("table", { name: "חברי הצוות" });
    await expect(table.locator("[data-member]")).toHaveCount(5);
    await expect(table.locator("[data-member-status=pending]")).toContainText("הוזמן, טרם הצטרף");
    await expect(table).toContainText("(את/ה)");
    await shot(page, info, "s10-members-01");
    await axe(page, info, "members");

    await page.getByLabel("אימייל").fill("kablan@example.com");
    await page.getByLabel("תפקיד", { exact: true }).selectOption({ label: "בודק" });
    await expect(page.getByText(/^בודק: בודק ומאשר שורות/)).toBeVisible();
    await page.getByRole("button", { name: "צור קישור הזמנה" }).click();
    const created = page.locator("[data-invite-created]");
    await expect(created).toContainText("kablan@example.com");
    const url = created.getByLabel("קישור ההזמנה");
    await expect(url).toHaveAttribute("readonly", "");
    await expect(url).toHaveAttribute("dir", "ltr");
    await expect(url).toHaveValue(/\/invite\/[\w:-]+$/);
    await created.getByRole("button", { name: "העתק קישור" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await url.inputValue());
    await expect(table.locator("[data-member]")).toHaveCount(6);
    await shot(page, info, "s10-members-02-invited");

    await page.getByLabel("התפקיד של יוסי מזרחי").selectOption({ label: "עורך" });
    await expect(page.getByText("התפקיד של יוסי מזרחי שונה לעורך.").first()).toBeVisible();
    await page.getByRole("button", { name: "הסר את לאה לוי" }).click();
    const confirm = page.getByRole("alertdialog", { name: "להסיר את חבר הצוות?" });
    await expect(confirm).toContainText("לאה לוי יאבד מיד את הגישה");
    await shot(page, info, "s10-members-03-remove");
    await confirm.getByRole("button", { name: "הסר", exact: true }).click();
    await expect(table).not.toContainText("לאה לוי");

    // audited (in-app navigation keeps the mock state)
    await page.getByRole("link", { name: "יומן פעולות" }).click();
    const log = page.getByRole("table").first();
    await expect(log.getByRole("row").filter({ hasText: "חברי צוות" }).first()).toBeVisible();
  });

  test("an old sign-in: changing org settings asks to re-authenticate first, then saves", async ({ page }, info) => {
    await login(page, "/settings?mockAuthAge=3600");
    await page.getByRole("switch", { name: "שימוש במודל שפה חיצוני (LLM)" }).click();
    await page.getByRole("button", { name: "שמור שינויים" }).click();
    const box = page.locator("[data-reauth]");
    await expect(box).toContainText("נדרשת כניסה מחדש");
    await expect(box).toContainText("שינוי הגדרות ארגון, תבניות, כללים וחברי צוות");
    await shot(page, info, "s10-reauth-settings");
    await axe(page, info, "settings-reauth");
    await box.getByLabel("סיסמה").fill("acceptance-1234");
    await box.getByRole("button", { name: "אמת" }).click();
    await expect(page.getByText("ההגדרות נשמרו ונרשמו ביומן.").first()).toBeVisible();
    await expect(box).toHaveCount(0);
  });

  test("an old sign-in: toggling a rule and inviting a member ask to re-authenticate", async ({ page }) => {
    await login(page, "/library?tab=rules&mockAuthAge=3600");
    await page.getByRole("switch").first().click();
    await expect(page.locator("[data-reauth]")).toBeVisible();
    await page.locator("[data-reauth]").getByRole("button", { name: "ביטול" }).click();
    await expect(page.locator("[data-reauth]")).toHaveCount(0);
    await page.getByRole("link", { name: "הגדרות" }).click();
    await page.getByRole("link", { name: "חברי צוות" }).click();
    await page.getByLabel("אימייל").fill("late@example.com");
    await page.getByRole("button", { name: "צור קישור הזמנה" }).click();
    await expect(page.locator("[data-reauth]")).toBeVisible();
    await page.locator("[data-reauth]").getByLabel("סיסמה").fill("acceptance-1234");
    await page.locator("[data-reauth]").getByRole("button", { name: "אמת" }).click();
    await expect(page.locator("[data-invite-created]")).toContainText("late@example.com");
  });

  test("members screen on a phone (390): no horizontal page scroll @mobile-only @mobile", async ({ page }, info) => {
    await login(page, "/settings/members");
    await expect(page.getByRole("table", { name: "חברי הצוות" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, "m-07-members", { fullPage: true });
  });

  test("invitation link landing: explains and sends to sign in", async ({ page }, info) => {
    await page.goto("/invite/0123456789abcdef");
    await expect(page.getByRole("heading", { name: "הוזמנתם להצטרף לצוות", level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "כניסה" })).toHaveAttribute("href", "/login");
    await axe(page, info, "invite");
  });
});

test.describe("Stage 10: item library state (A-LIVE-01)", () => {
  test("no library: the hub and the BOQ panel say so, with a link that opens the import", async ({ page }, info) => {
    await login(page, "/projects/p-noah?mockLibrary=none&mockBoq=built");
    const hubNote = page.locator("[data-library-notice=none]");
    await expect(hubNote).toContainText("לארגון אין עדיין ספריית סעיפים.");
    await shot(page, info, "s10-library-none-hub");
    await page.getByRole("link", { name: "לסביבת הבדיקה" }).click();
    await waitForWorkspace(page);
    const panelNote = page.locator("#boq-panel [data-library-notice=none]");
    await expect(panelNote).toBeVisible();
    await shot(page, info, "s10-library-none-panel");
    await axe(page, info, "library-none-panel");
    await panelNote.getByRole("link", { name: "ייבוא כתב כמויות קודם" }).click();
    await expect(page.getByRole("dialog", { name: "ייבוא כתב כמויות קודם" })).toBeVisible();
  });

  test("default library: the notice names the shipped chapters; library items say 'ברירת מחדל'", async ({ page }, info) => {
    await login(page, "/projects/p-noah?mockLibrary=default");
    await expect(page.locator("[data-library-notice=default]")).toContainText("כתב הכמויות נבנה מספריית ברירת המחדל.");
    await shot(page, info, "s10-library-default-hub");
    await page.getByRole("link", { name: "ספרייה" }).click();
    await expect(page.getByRole("table").first()).toContainText("ברירת מחדל");
  });

  test("imported library: no notice", async ({ page }) => {
    await login(page, "/projects/p-noah");
    await expect(page.getByRole("heading", { name: "כתב כמויות" })).toBeVisible();
    await expect(page.locator("[data-library-notice]")).toHaveCount(0);
  });
});

test.describe("Stage 10: approved line whose quantity changed", () => {
  test("approve 4.01, add a missed socket on the drawing → 'נבדק' with 'הכמות השתנתה מאז האישור (X → Y)'; filter", async ({ page }, info) => {
    needsNoah();
    await openReview(page, "sheet=noah-eb8be8a3-p0");
    const r = row(page, "4.01");
    const status = r.getByText(/^(טיוטה|נבדק|אושר)$/);
    await r.scrollIntoViewIfNeeded();
    await r.getByText("שקע כפול").first().click();
    await page.keyboard.press("KeyA");
    await expect(status).toHaveText("נבדק");
    await page.keyboard.press("KeyA");
    await expect(status).toHaveText("אושר");
    const before = Number((await qtyButton(page, "4.01").innerText()).match(/\d+/)![0]);

    // + tool → "שקע כפול" → click the drawing (the worker rebuild / mock re-derive moves 4.01 by one)
    await page.keyboard.press("Shift+Equal");
    const picker = page.getByRole("dialog", { name: "איזה פריט להוסיף?" });
    await picker.getByRole("combobox").fill("שקע כפול");
    await page.keyboard.press("Enter");
    await expect(picker).toBeHidden();
    const box = (await canvas(page).boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.3);
    await expect(qtyButton(page, "4.01")).toHaveText(new RegExp(`^\\s*${before + 1}\\b`));
    await expect(status).toHaveText("נבדק", { timeout: 10_000 });
    const chip = r.locator("[data-reason=QTY_CHANGED_SINCE_APPROVAL]");
    await expect(chip).toContainText("הכמות השתנתה מאז האישור");
    await expect(chip.locator("bdi[dir=ltr]")).toHaveText(`(${before} → ${before + 1})`);
    await shot(page, info, "s10-qty-changed-01");

    // the status filter has "הכמות השתנתה מאז האישור (1)" and shows only that line
    await page.keyboard.press("Escape");
    const filter = page.getByLabel(/^סטטוס/);
    await filter.selectOption({ label: "הכמות השתנתה מאז האישור (1)" });
    await expect(page.locator("tr[data-code]")).toHaveCount(1);
    await expect(page.locator("tr[data-code]")).toHaveAttribute("data-code", "4.01");
    await shot(page, info, "s10-qty-changed-02-filter");
    await axe(page, info, "qty-changed-filter", "#boq-panel");
  });
});
