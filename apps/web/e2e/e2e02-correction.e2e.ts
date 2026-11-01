import { expect, shot, test, needsNoah } from "./support";
import { canvas, openReview, qtyButton, qtyOf, row } from "./review.helpers";

/**
 * E2E-02 — correction on the drawing reaches the BOQ: a missed symbol is added on the drawing as "שקע כפול",
 * line 4.01 goes up by one within 1 s, the item reads "אושר ידנית", and the change is in the line history (audit).
 */
test.beforeEach(() => needsNoah());

/** Add tool → "שקע כפול" → click the drawing; returns 4.01 before, the click point, and click → cell update in ms. */
async function addSocket(page: import("@playwright/test").Page) {
  await openReview(page);
  await expect(row(page, "4.01")).toBeVisible();
  const before = await qtyOf(page, "4.01");

  // + tool → class picker "איזה פריט להוסיף?" → שקע כפול
  await page.keyboard.press("Shift+Equal");
  const picker = page.getByRole("dialog", { name: "איזה פריט להוסיף?" });
  await expect(picker).toBeVisible();
  await picker.getByRole("combobox").fill("שקע כפול");
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(page.getByRole("button", { name: /הוספה בלחיצה: שקע כפול/ })).toBeVisible();

  const box = (await canvas(page).boundingBox())!;
  const at = { x: box.x + box.width * 0.55, y: box.y + box.height * 0.25 };
  // In-page timing (click → the 4.01 cell shows the new number), independent of Playwright's polling interval.
  await page.evaluate((code) => {
    const w = window as unknown as { __e2e02?: { t0: number; t1: number | null } };
    const cell = () => document.querySelector(`tr[data-code="${code}"]`);
    // The quantity button's text (visible qty + hidden "— קבלה לשורה X").
    const first = () => Array.from(cell()?.querySelectorAll("button") ?? []).find((b) => b.textContent?.includes("קבלה לשורה"))?.textContent ?? "";
    const initial = first();
    w.__e2e02 = { t0: 0, t1: null };
    document.addEventListener("pointerdown", () => (w.__e2e02!.t0 = performance.now()), { capture: true, once: true });
    const mo = new MutationObserver(() => {
      if (w.__e2e02!.t0 && w.__e2e02!.t1 === null && first() !== initial) {
        w.__e2e02!.t1 = performance.now();
        mo.disconnect();
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label"] });
  }, "4.01");
  await page.mouse.click(at.x, at.y);
  await expect(qtyButton(page, "4.01")).toHaveText(new RegExp(`^\\s*${before + 1}\\b`), { timeout: 5_000 });
  const ms = await page.evaluate(() => {
    const m = (window as unknown as { __e2e02: { t0: number; t1: number | null } }).__e2e02;
    return m.t1 === null ? Infinity : Math.round(m.t1 - m.t0);
  });
  return { before, at, ms };
}

test("E2E-02: add a missed symbol on the drawing → 4.01 +1 within 1 s, item 'אושר ידנית', history entry", async ({ page }, info) => {
  const { at, ms } = await addSocket(page);
  info.annotations.push({ type: "E2E-02 table update", description: `${ms} ms (click → cell text, in page; target ≤ 1000 ms)` });
  expect(ms, "4.01 updated within 3 s").toBeLessThan(3_000); // ≤ 1 s: the A-UI-07 test below
  await shot(page, info, "e2e02-01-after-add");

  // the item: select tool, click it → details "אושר ידנית" + reason "נוסף ידנית"
  await page.keyboard.press("KeyV");
  await page.mouse.click(at.x, at.y);
  const details = page.getByRole("dialog").filter({ hasText: "שקע כפול" }).last();
  await expect(details).toContainText("אושר ידנית");
  await expect(details).toContainText("נוסף ידנית");
  await shot(page, info, "e2e02-02-item-details");
  await page.keyboard.press("Escape");

  // audit trail: the line history shows the drawing correction
  await row(page, "4.01").hover();
  await row(page, "4.01").getByRole("button", { name: "היסטוריית השינויים של 4.01" }).click();
  const hist = page.getByRole("dialog", { name: /היסטוריית שינויים/ });
  await expect(hist).toBeVisible();
  await shot(page, info, "e2e02-03-history");
  await page.keyboard.press("Escape");

  // org audit log (admin): the correction is recorded — reached in-app so the in-memory mock keeps its state
  await page.getByRole("navigation", { name: "מיקום" }).getByRole("link", { name: "כמותן" }).click();
  await page.getByRole("link", { name: "הגדרות" }).click();
  await page.getByRole("link", { name: "יומן פעולות" }).click();
  const log = page.getByRole("table").first();
  await expect(log).toBeVisible();
  await expect(log.getByRole("row").filter({ hasText: "תיקונים" }).first()).toBeVisible();
  await shot(page, info, "e2e02-04-audit");
});

// A-UI-07 (fixed): click → 4.01 cell update was 1124–1269 ms in a production mock build (07_test_plan: ≤ 1 s synced,
// < 300 ms local) because the BOQ line waited for the server round trip + re-derive. The line now moves optimistically.
test("A-UI-07 E2E-02: the BOQ line reflects a drawing correction within 1 s", async ({ page }, info) => {
  const { ms } = await addSocket(page);
  info.annotations.push({ type: "A-UI-07 click → 4.01", description: `${ms} ms` });
  expect(ms, "4.01 updated within 1 s").toBeLessThan(1_000);
});

// A-UI-08 (mock side fixed by Web; the real API's line-history builder is the API agent's, see apps/api/NOTES.md): the
// history of 4.01 after a manual add listed only "חישוב מהשרטוטים". A-UI-12: "who" is the signed-in user.
test("A-UI-08 / A-UI-12 E2E-02: the line history lists the drawing correction (who, when, kind)", async ({ page }, info) => {
  await addSocket(page);
  await row(page, "4.01").hover();
  await row(page, "4.01").getByRole("button", { name: "היסטוריית השינויים של 4.01" }).click();
  const hist = page.getByRole("dialog", { name: /היסטוריית שינויים/ });
  const entry = hist.getByRole("listitem").filter({ hasText: "תיקון על השרטוט" }).first();
  await expect(entry).toBeVisible();
  await expect(entry).toContainText(/הוספ/);
  await expect(entry).toContainText("qa.reviewer@example.com");
  await expect(entry).toContainText(/\d{2}\.\d{2}\.\d{4}/);
  await expect(hist).not.toContainText("דנה כהן");
  await shot(page, info, "e2e02-05-history-correction");
});
