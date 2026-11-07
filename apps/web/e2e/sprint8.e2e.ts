import type { Page, Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { axe, expect, expectNoHorizontalScroll, expectRtl, login, shot, test } from "./support";
import { ELEC, openReview, row } from "./review.helpers";

/**
 * Sprint 8 — prices & totals, "מה השתנה", deletes + the 100-sheet limit, code-splitting.
 * Runs in BOTH data modes (Noah artifacts or the synthetic fixture): only codes both carry (4.01, 4.02) are named;
 * everything else is read from the screen (counts, totals).
 */
const BUILT = "mockBoq=built";
const toast = (page: Page, text: string | RegExp) => page.locator("li[data-toast-tone]").filter({ hasText: text });
/** "₪ 1,234.50" → 1234.5 */
const money = (s: string) => Number((/₪\s*([\d,]+\.\d\d)/.exec(s)?.[1] ?? "NaN").replace(/,/g, ""));
const pdf = (name: string) => ({ name, mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.7\n%e2e\n"), Buffer.alloc(4096, 0x20), Buffer.from("\n%%EOF\n")]) });

test.describe("Sprint 8: library prices", () => {
  test("inline edit, ללא מחיר filter, bulk edit (set + %); axe", async ({ page }, info) => {
    await login(page, "/library");
    await expectRtl(page);
    const r401 = page.locator('tr[data-item="4.01"]');
    await expect(r401).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("columnheader", { name: "מחיר יח'" })).toBeVisible();
    await expect(r401.locator("[data-item-price]")).toContainText("₪");
    await shot(page, info, "s8-01-library-prices");
    await axe(page, info, "s8-library");

    // inline: click → type → Enter (optimistic) → "✎ ידני"
    await r401.locator("[data-item-price]").click();
    const input = page.getByLabel("מחיר של סעיף 4.01");
    await expect(input).toBeFocused();
    await input.fill("1,234.5");
    await input.press("Enter");
    await expect(r401.locator("[data-item-price]")).toContainText("₪ 1,234.50");
    await expect(r401.locator("[data-item-price]")).toContainText("ידני");
    await expect(toast(page, "המחיר של סעיף 4.01 נשמר")).toBeVisible();
    // invalid input keeps the editor with a hint; Esc cancels
    await r401.locator("[data-item-price]").click();
    await page.getByLabel("מחיר של סעיף 4.01").fill("-3");
    await expect(page.getByText("מחיר לא תקין")).toBeVisible();
    await page.getByLabel("מחיר של סעיף 4.01").press("Escape");
    await expect(r401.locator("[data-item-price]")).toContainText("₪ 1,234.50");

    // "ללא מחיר" count + filter
    const unpriced = page.locator("[data-library-unpriced]");
    await expect(unpriced).toContainText("ללא מחיר");
    await page.getByRole("button", { name: "רק ללא מחיר" }).click();
    await expect(page.locator("tr[data-item]").first()).toBeVisible();
    for (const t of await page.locator("tr[data-item] [data-item-price]").allInnerTexts()) expect(t).not.toContain("₪");
    await page.getByRole("button", { name: "רק ללא מחיר" }).click();

    // bulk: 4.01 + 4.02 → +10%
    await page.getByRole("checkbox", { name: "בחירת סעיף 4.01" }).check();
    await page.getByRole("checkbox", { name: "בחירת סעיף 4.02" }).check();
    const bar = page.locator("[data-library-bulk]");
    await expect(bar).toContainText("2 סעיפים נבחרו");
    const before402 = money(await page.locator('tr[data-item="4.02"] [data-item-price]').innerText());
    await bar.getByRole("button", { name: "עריכת מחירים" }).click();
    const dlg = page.getByRole("dialog", { name: "עריכת מחירים לכמה סעיפים" });
    await dlg.getByRole("radio", { name: "שינוי באחוזים" }).check();
    await dlg.getByLabel("אחוז שינוי (שלילי = הוזלה)").fill("10");
    await expect(dlg.locator("[data-bulk-preview]")).toContainText("ישתנו 2 סעיפים");
    await shot(page, info, "s8-02-library-bulk");
    await axe(page, info, "s8-library-bulk", '[role="dialog"]');
    await dlg.getByRole("button", { name: "החלה" }).click();
    await expect(toast(page, "המחיר עודכן ב-2 סעיפים")).toBeVisible();
    await expect(page.locator('tr[data-item="4.01"] [data-item-price]')).toContainText("₪ 1,357.95");
    expect(money(await page.locator('tr[data-item="4.02"] [data-item-price]').innerText())).toBeCloseTo(Math.round(before402 * 110) / 100, 2);
    await expect(bar).toBeHidden();
  });

  test("price import: matched / conflicts / unmatched review → explicit overwrite → applied; axe", async ({ page }, info) => {
    await login(page, "/library");
    await page.getByRole("button", { name: "ייבוא מחירים" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg).toContainText("ייבוא מחירים מכתב כמויות מתומחר");
    await dlg.locator('input[type="file"]').setInputFiles({ name: "boq-priced-2025.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from("PK\u0003\u0004 e2e") });
    await expect(dlg.getByRole("heading", { name: "בדיקה לפני שמירה" })).toBeVisible({ timeout: 30_000 });
    const summary = dlg.locator("[data-price-review-summary]");
    await expect(summary).toContainText("יקבלו מחיר");
    await expect(summary).toContainText("התנגשות");
    await expect(summary).toContainText("לא נמצאו בספרייה");
    await shot(page, info, "s8-03-price-import-review");
    await axe(page, info, "s8-price-import", '[role="dialog"]');

    // nothing is written yet: the conflicts tab shows the manual 4.01 price, kept by default
    await dlg.getByRole("tab", { name: /התנגשויות/ }).click();
    const conflict = dlg.locator('tr[data-review-row="4.01"]');
    await expect(conflict).toContainText("✎");
    await expect(conflict.getByRole("radio", { name: "השאר את המחיר הידני" })).toBeChecked();
    const fileText = (await conflict.locator("td").nth(3).innerText()).trim();
    await conflict.getByRole("radio", { name: "החלף במחיר מהקובץ" }).check();
    await dlg.getByRole("tab", { name: /לא נמצאו/ }).click();
    await expect(dlg.locator('tr[data-review-row="4.40"]')).toBeVisible();
    await shot(page, info, "s8-04-price-import-unmatched");
    await dlg.locator("[data-apply-prices]").click();
    await expect(dlg.locator("[data-price-import-done]")).toContainText("קיבלו מחיר מהקובץ");
    await expect(dlg.locator("[data-price-import-done]")).toContainText("מחיר ידני אחד הוחלף");
    await dlg.getByRole("button", { name: /סגור|סגירה/ }).last().click();
    // the library shows the file's price for 4.01 (source: imported)
    await expect(page.locator('tr[data-item="4.01"] [data-item-price]')).toContainText(fileText);
    await expect(page.locator('tr[data-item="4.01"] [data-item-price]')).toContainText("מיובא");
  });
});

test.describe("Sprint 8: prices in the BOQ", () => {
  test("BOQ panel: unit price / total columns, chapter subtotals, totals; line price override ✎ ידני → restore → history; ללא מחיר filter", async ({ page }, info) => {
    await openReview(page, `sheet=${ELEC}&${BUILT}`);
    const panel = page.locator("#boq-panel");
    await expect(panel.locator('th[data-col="total"]')).toContainText('סה"כ ₪');
    await expect(panel.locator('[data-chapter-subtotal="04"]')).toContainText("₪");
    const totals = panel.locator("[data-boq-totals]");
    await expect(totals).toContainText('סה"כ לפני מע"מ');
    await expect(totals).toContainText('מע"מ 18%');
    await expect(totals).toContainText('סה"כ כולל מע"מ');
    const before = money(await totals.locator('[data-total="afterVat"]').innerText());
    await shot(page, info, "s8-05-panel-prices");
    await axe(page, info, "s8-panel-prices", "#boq-panel");

    // override the 4.01 unit price
    const r = row(page, "4.01");
    await r.locator("[data-price-cell]").click();
    const dlg = page.getByRole("dialog", { name: /מחיר יחידה לסעיף/ });
    await expect(dlg).toContainText("מחיר במחירון הארגון");
    await dlg.getByLabel("מחיר ליחידה (₪)").fill("abc");
    await dlg.getByRole("button", { name: "שמירת מחיר" }).click();
    await expect(dlg.getByRole("alert")).toContainText("יש להזין מחיר");
    await dlg.getByLabel("מחיר ליחידה (₪)").fill("50");
    await dlg.getByLabel("סיבה (לא חובה)").fill("הצעת הקבלן");
    await expect(dlg.locator("[data-price-preview]")).toContainText("₪ 50.00");
    await shot(page, info, "s8-06-price-dialog");
    await axe(page, info, "s8-price-dialog", '[role="dialog"]');
    await dlg.getByRole("button", { name: "שמירת מחיר" }).click();
    await expect(r.locator("[data-price-cell]")).toContainText("₪ 50.00");
    await expect(r.locator("[data-manual-price]")).toContainText("ידני");
    const qty = Number(((await r.getByRole("button", { name: /קבלה לשורה 4\.01/ }).innerText()).match(/[\d.]+/) ?? ["0"])[0]);
    expect(money(await r.locator("[data-line-total]").innerText())).toBeCloseTo(qty * 50, 2);
    await expect.poll(async () => money(await totals.locator('[data-total="afterVat"]').innerText())).not.toBe(before);

    // restore, then the history has both changes
    await r.locator("[data-price-cell]").click();
    await page.getByRole("dialog").getByRole("button", { name: "חזרה למחיר המחירון" }).click();
    await expect(r.locator("[data-manual-price]")).toHaveCount(0);
    await expect(toast(page, "חזר למחיר המחירון")).toBeVisible();
    await r.hover();
    await r.getByRole("button", { name: "היסטוריית השינויים של 4.01" }).click();
    const hist = page.getByRole("dialog", { name: /היסטוריית שינויים/ });
    await expect(hist.locator('[data-action="price"]')).toHaveCount(2);
    await expect(hist).toContainText("חזרה למחיר המחירון");
    await shot(page, info, "s8-07-price-history");
    await page.keyboard.press("Escape");

    // "ללא מחיר" chip filters the table
    const chip = panel.locator("[data-filter-unpriced]");
    await expect(chip).toContainText("ללא מחיר");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    const shown = panel.locator("tr[data-line]");
    await expect(shown.first()).toBeVisible();
    expect(await shown.count()).toBe(await panel.locator("tr[data-line][data-unpriced]").count());
    await expect(shown.first().locator("[data-unpriced]")).toContainText("ללא מחיר");
    await shot(page, info, "s8-08-panel-unpriced");
    await chip.click();

    // the columns can be hidden (per viewer)
    await panel.getByRole("checkbox", { name: "מחירים" }).uncheck();
    await expect(panel.locator('th[data-col="total"]')).toHaveCount(0);
  });

  test("hub card totals + discount in project settings → hub, preview (+ VAT setting 17%); axe", async ({ page }, info) => {
    await login(page, `/projects/p-noah?${BUILT}`);
    const card = page.locator("section[aria-labelledby='hub-boq-title']");
    await expect(card.locator("tr[data-line]").first()).toBeVisible({ timeout: 60_000 });
    await expect(card.locator('[data-chapter-subtotal="04"]')).toContainText("₪");
    await expect(card.locator('[data-hub-price]').first()).toBeVisible();
    await expect(card.locator("[data-totals]")).toContainText('סה"כ כולל מע"מ');
    await expect(card.locator("[data-filter-unpriced]")).toContainText("ללא מחיר");
    await shot(page, info, "s8-09-hub-prices");
    await axe(page, info, "s8-hub", "section[aria-labelledby='hub-boq-title']");

    // project settings: discount −5% (validation first), then the hub shows the discount row
    await page.getByRole("link", { name: "הגדרות הפרויקט" }).click();
    await expect(page).toHaveURL(/\/projects\/p-noah\/settings$/);
    await expect(page.getByRole("heading", { level: 1, name: "הגדרות הפרויקט" })).toBeVisible();
    const pct = page.getByLabel("אחוז (מספר שלילי = הנחה)");
    await pct.fill("250"); // contracts PRICE_ADJUSTMENT_MAX_PCT = 200
    await expect(page.locator("[data-adjustment-form]").getByRole("alert")).toContainText("יש להזין אחוז");
    await pct.fill("-5");
    await page.locator("[data-adjustment-form]").getByRole("button", { name: "שמירה" }).click();
    await expect(toast(page, "ההנחה / התוספת נשמרה")).toBeVisible();
    await expect(page.locator("[data-adjustment-current]")).toContainText("הנחה 5%");
    await shot(page, info, "s8-10-project-settings");
    await axe(page, info, "s8-project-settings");

    await page.getByRole("link", { name: "בית משפחת נח" }).click();
    const totals = page.locator("section[aria-labelledby='hub-boq-title'] [data-totals]");
    await expect(totals.locator('[data-total="adjustment"]')).toContainText("הנחה 5%");
    const sub = money(await totals.locator('[data-total="subtotal"]').innerText());
    const adj = money((await totals.locator('[data-total="adjustment"]').innerText()).replace("−", ""));
    expect(adj).toBeCloseTo(Math.round(sub * 5) / 100, 2);

    // preview: subtotal → discount → before VAT; prices with 2 decimals
    await page.getByRole("link", { name: "תצוגה מקדימה של כתב הכמויות" }).click();
    const grand = page.locator("[data-boq-table] [data-grand-totals]");
    await expect(grand).toBeVisible({ timeout: 60_000 });
    await expect(grand.locator("[data-adjustment]")).toContainText("הנחה 5%");
    await expect(page.locator("[data-boq-table] tbody[data-chapter] tr[data-row-line]").first()).toContainText(/₪ [\d,]+\.\d\d/);
    await expect(page.locator("[data-preview-unpriced]")).toContainText("ללא מחיר");
    await shot(page, info, "s8-11-preview-discount", { fullPage: true });
    await axe(page, info, "s8-preview");

    // org settings: VAT 17% → the preview's VAT row
    await page.goto(`/settings?${BUILT}`); // a reload starts a fresh mock: build the BOQ again
    const vat = page.getByLabel('שיעור מע"מ (%)');
    await expect(vat).toHaveValue("18");
    await vat.fill("60");
    await expect(page.locator("[data-vat-setting]").getByRole("alert")).toBeVisible();
    await vat.fill("17");
    await page.getByRole("button", { name: "שמור שינויים" }).click();
    await expect(toast(page, "ההגדרות נשמרו")).toBeVisible();
    await shot(page, info, "s8-12-org-vat");
    await axe(page, info, "s8-org-settings");
    // client-side navigation (a reload would start a fresh mock)
    await page.getByRole("link", { name: "פרויקטים" }).click();
    await page.getByRole("link", { name: "בית משפחת נח" }).first().click();
    await page.getByRole("link", { name: "תצוגה מקדימה של כתב הכמויות" }).click();
    await expect(page.locator("[data-boq-table] [data-grand-totals]")).toContainText('מע"מ (17%)', { timeout: 60_000 });
  });

  test("phone: hub card with prices has no horizontal scroll @mobile-only", async ({ page }, info) => {
    await login(page, `/projects/p-noah?${BUILT}`);
    await expect(page.locator("section[aria-labelledby='hub-boq-title'] tr[data-line]").first()).toBeVisible({ timeout: 60_000 });
    await expectNoHorizontalScroll(page);
    await page.locator("section[aria-labelledby='hub-boq-title'] [data-totals]").scrollIntoViewIfNeeded();
    await shot(page, info, "s8-13-hub-mobile");
  });
});

test.describe("Sprint 8: share link prices", () => {
  test("'הצג מחירים' is off by default; a link with it shows prices + totals, one without shows none", async ({ page }, info) => {
    await login(page, `/projects/p-noah/review?sheet=${ELEC}&${BUILT}`);
    await page.getByRole("button", { name: "שתף" }).click();
    const dlg = page.getByRole("dialog", { name: "שיתוף לצפייה בלבד" });
    const opt = dlg.getByRole("checkbox", { name: "הצג מחירים" });
    await expect(opt).not.toBeChecked();
    await dlg.getByLabel("שם הקישור").fill("קבלן — עם מחירים (E2E)");
    await opt.check();
    await shot(page, info, "s8-14-share-prices-option");
    await axe(page, info, "s8-share-dialog", '[role="dialog"]');
    await dlg.getByRole("button", { name: "צור קישור" }).click();
    const url = await dlg.getByLabel("קישור הצפייה").inputValue();
    expect(url).toMatch(/\/s\//);
    await expect(dlg.locator("[data-share-list] li").filter({ hasText: "קבלן — עם מחירים (E2E)" })).toContainText("כולל מחירים");
    // same mock (client-side navigation): the new link's viewer has prices
    await page.keyboard.press("Escape");
    await page.evaluate((u) => {
      history.pushState({}, "", new URL(u).pathname);
      dispatchEvent(new PopStateEvent("popstate"));
    }, url);
    const viewer = page.locator("[data-share-viewer]");
    await expect(viewer.locator("[data-share-boq] tr[data-line]").first()).toBeVisible({ timeout: 60_000 });
    await expect(viewer.getByRole("columnheader", { name: "מחיר יח'" })).toBeVisible();
    await expect(viewer.locator("[data-share-totals]")).toContainText('סה"כ כולל מע"מ');
  });

  test("external viewer: seeded links with / without prices", async ({ page }, info) => {
    await page.goto("/s/demo-noah");
    const viewer = page.locator("[data-share-viewer]");
    await expect(viewer.locator("[data-share-boq] tr[data-line]").first()).toBeVisible({ timeout: 60_000 });
    await expect(viewer.getByRole("columnheader", { name: "מחיר יח'" })).toHaveCount(0);
    await expect(viewer.locator("[data-share-totals]")).toHaveCount(0);
    await expect(viewer).not.toContainText("₪");

    await page.goto("/s/demo-noah-prices");
    await expect(viewer.locator("[data-share-boq] tr[data-line]").first()).toBeVisible({ timeout: 60_000 });
    await expect(viewer.getByRole("columnheader", { name: 'סה"כ ₪' })).toBeVisible();
    await expect(viewer.locator("[data-share-price]").first()).toBeVisible();
    await expect(viewer.locator("[data-share-totals]")).toContainText('מע"מ 18%');
    await shot(page, info, "s8-15-share-viewer-prices");
    await axe(page, info, "s8-share-viewer-prices");
  });
});

test.describe("Sprint 8: מה השתנה", () => {
  test("from the hub: latest vs previous, added / removed / changed with Δ and causing sheets; filter; since last export; export to Excel; axe", async ({ page }, info) => {
    await login(page, `/projects/p-noah?${BUILT}`);
    await page.getByRole("link", { name: "מה השתנה בכתב הכמויות" }).click();
    await expect(page).toHaveURL(/\/boq\/compare$/);
    await expect(page.getByRole("heading", { level: 1, name: "מה השתנה" })).toBeVisible();
    const table = page.locator("[data-compare-table]");
    await expect(table.locator("tr[data-compare-line]").first()).toBeVisible({ timeout: 60_000 });
    const summary = page.locator("[data-compare-summary]");
    await expect(summary.locator('[data-summary="added"]')).toContainText(/נוספו|נוספה/);
    await expect(summary.locator('[data-summary="removed"]')).toContainText(/הוסרה|הוסרו/);
    await expect(summary.locator('[data-summary="changed"]')).toContainText(/השתנו|השתנתה/);
    await expect(page.locator("[data-compare-delta]")).toContainText("₪");
    await expect(table.locator('tr[data-change="added"]').first()).toBeVisible();
    await expect(table.locator('tr[data-compare-line="4.99"]')).toHaveAttribute("data-change", "removed");
    const changed = table.locator('tr[data-change="changed"]').first();
    await expect(changed.locator("[data-delta-total]")).toContainText("₪");
    await expect(table.locator("[data-cause-link]").first()).toBeVisible();
    // contracts: without an explicit "to" the comparison runs against the live BOQ
    await expect(page.locator("[data-compare-live]")).toBeVisible();
    await expect(page.locator("[data-sheet-changes]")).toContainText("גיליונות שהשתנו");
    await shot(page, info, "s8-16-compare");
    await axe(page, info, "s8-compare");

    // filter
    await page.getByRole("radio", { name: /^הוסרו/ }).click();
    await expect(table.locator("tr[data-compare-line]")).toHaveCount(await table.locator('tr[data-change="removed"]').count());
    await page.getByRole("radio", { name: /^הכל/ }).click();

    // since the last export (the mock's previous build was exported) and a pick of two builds
    await page.getByRole("radio", { name: "מאז הייצוא האחרון" }).click();
    await expect(page).toHaveURL(/base=export/);
    await expect(table.locator("tr[data-compare-line]").first()).toBeVisible();
    await page.getByRole("radio", { name: "גרסה מסוימת" }).click();
    await expect(page.locator('[data-build-select="from"]')).toBeVisible();
    await expect(page.locator('[data-build-select="to"]')).toBeVisible();
    await expect(page).toHaveURL(/from=/);
    await expect(table.locator("tr[data-compare-line]").first()).toBeVisible();

    // export "תוספות ושינויים" (a real spreadsheet file in mock mode)
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "ייצוא לאקסל" }).click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(/^boq-changes-.*\.xls$/);
    const body = readFileSync((await file.path())!, "utf8");
    expect(body).toContain("תוספות ושינויים");
    expect(body).toContain("4.99");
    await expect(toast(page, /מוכן להורדה/)).toBeVisible();

    // a cause opens the sheet analysis
    await page.getByRole("radio", { name: "הגרסה הקודמת" }).click();
    const link = table.locator("[data-cause-link]").first();
    const sheetId = await link.getAttribute("data-cause-link");
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/projects/p-noah/sheets/${sheetId}`));
  });

  test("from the BOQ panel; phone layout @mobile", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "phone layout only");
    await login(page, `/projects/p-noah/boq/compare?${BUILT}`);
    await expect(page.locator("[data-compare-list] [data-compare-line]").first()).toBeVisible({ timeout: 60_000 });
    await expectNoHorizontalScroll(page);
    await shot(page, info, "s8-17-compare-mobile", { fullPage: true });
    await axe(page, info, "s8-compare-mobile");
  });

  test("the BOQ panel links to it", async ({ page }) => {
    await openReview(page, `sheet=${ELEC}&${BUILT}`);
    await page.locator("#boq-panel [data-compare-link]").click();
    await expect(page).toHaveURL(/\/projects\/p-noah\/boq\/compare$/);
    await expect(page.getByRole("heading", { level: 1, name: "מה השתנה" })).toBeVisible();
    // the review session may have rebuilt the BOQ (same lines → "previous" can be empty, as the API answers);
    // since the last export (the seeded exported build) always has changes
    await page.getByRole("radio", { name: "מאז הייצוא האחרון" }).click();
    await expect(page.locator("[data-compare-table] tr[data-compare-line]").first()).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("Sprint 8: deletes + the 100-sheet limit", () => {
  test("delete a sheet set from the gallery: confirm dialog → tiles gone, storage meter + toast; from the upload history; axe", async ({ page }, info) => {
    await login(page, "/projects/p-noah");
    const tiles = page.locator("article[data-sheet]");
    await expect(tiles.first()).toBeVisible({ timeout: 30_000 });
    const n0 = await tiles.count();
    const storage0 = await page.locator("[data-storage]").innerText();
    const first = tiles.first();
    await first.locator("[data-tile-menu]").click();
    await page.getByRole("menuitem", { name: /מחיקת סט השרטוטים/ }).click();
    const dlg = page.getByRole("alertdialog");
    await expect(dlg).toContainText("יימחקו לצמיתות");
    await expect(dlg).toContainText("קישורי צפייה");
    await shot(page, info, "s8-18-delete-set");
    await axe(page, info, "s8-delete-set", '[role="alertdialog"]');
    await dlg.getByRole("button", { name: "מחיקה לצמיתות" }).click();
    await expect(toast(page, /נמחק\. פונו/)).toBeVisible();
    await expect(toast(page, /אחסון: .* מתוך/)).toBeVisible();
    await expect.poll(() => tiles.count()).toBeLessThan(n0);
    await expect.poll(() => page.locator("[data-storage]").innerText()).not.toBe(storage0);
    await shot(page, info, "s8-19-after-delete");

    // the upload history offers the same delete
    await page.getByText("העלאות ועיבוד").click();
    const del = page.locator("[data-set-status] [data-delete-set]").first();
    await expect(del).toBeVisible();
    await del.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "ביטול" }).click();
    await expect(page.getByRole("alertdialog")).toBeHidden();
  });

  test("delete a project (admin): danger zone, typed confirmation, back to the list with the freed space", async ({ page }, info) => {
    await login(page, "/projects/p-levi/settings");
    const zone = page.locator("[data-danger-zone]");
    await expect(zone).toContainText("אזור מסוכן");
    await zone.getByRole("button", { name: "מחיקת הפרויקט" }).click();
    const dlg = page.getByRole("alertdialog");
    const confirm = dlg.getByRole("button", { name: "מחיקת הפרויקט לצמיתות" });
    await expect(confirm).toBeDisabled();
    await dlg.getByRole("textbox").fill("דירת לוי");
    await dlg.getByRole("checkbox", { name: "הבנתי שאי אפשר לשחזר את הפרויקט" }).check();
    await expect(confirm).toBeDisabled();
    await shot(page, info, "s8-20-delete-project");
    await axe(page, info, "s8-delete-project", '[role="alertdialog"]');
    await dlg.getByRole("textbox").fill("דירת לוי — שיפוץ מטבח ורחצה");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(toast(page, /הפרויקט .* נמחק\. פונו/)).toBeVisible();
    await expect(page.getByRole("link", { name: "דירת לוי — שיפוץ מטבח ורחצה" })).toHaveCount(0);
  });

  test("non-admins see no delete-project button; viewers no set delete", async ({ page }) => {
    await login(page, "/projects/p-noah/settings?mockRole=editor");
    await expect(page.locator("[data-danger-zone]")).toContainText("רק מנהלי הארגון יכולים למחוק פרויקט.");
    await expect(page.getByRole("button", { name: "מחיקת הפרויקט" })).toHaveCount(0);
    await page.goto("/projects/p-noah?mockRole=viewer");
    await expect(page.locator("article[data-sheet]").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-tile-menu]")).toHaveCount(0);
  });

  test("the 100-sheet limit: hub message and the upload's Hebrew 409", async ({ page }, info) => {
    await login(page, "/projects/p-noah");
    const tiles = page.locator("article[data-sheet]");
    await expect(tiles.first()).toBeVisible({ timeout: 30_000 });
    // fixture or Noah: the limit is set to the current sheet count (stands in for 100)
    await expect.poll(() => tiles.count(), { timeout: 30_000 }).toBeGreaterThan(1);
    const n = await tiles.count();
    await page.goto(`/projects/p-noah?mockSheetLimit=${n}`);
    await expect(page.locator('[data-sheet-limit="reached"]')).toContainText(`הגעתם למגבלה של ${n} גיליונות בפרויקט`, { timeout: 30_000 });
    await page.getByRole("button", { name: "העלאת שרטוטים" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.locator("input[type=file]").setInputFiles([pdf("one-more-sheet.pdf")]);
    const item = dlg.getByRole("list", { name: "קבצים בהעלאה" }).locator("li").filter({ hasText: "one-more-sheet.pdf" });
    // the API's Hebrew 409 sheet_limit message (contracts sheetLimitMessageHe)
    await expect(item).toContainText(`המגבלה היא ${n} גיליונות לפרויקט`, { timeout: 30_000 });
    await shot(page, info, "s8-21-sheet-limit");
    await axe(page, info, "s8-sheet-limit", '[role="dialog"]');
  });
});

test.describe("Sprint 8: code-splitting", () => {
  const heavy = (r: Request) => /\/assets\/(DrawingViewer|ReviewPage)-[\w-]+\.js$/.test(r.url());

  for (const [name, path, ready] of [
    ["landing", "/", "main"],
    ["projects", "/projects", "table, [data-project-row], main h1"],
    ["hub", `/projects/p-noah?${BUILT}`, "article[data-sheet]"],
  ] as const) {
    test(`${name} does not load the drawing viewer (deck.gl) or the review workspace`, async ({ page }) => {
      if (name !== "landing") await login(page);
      const seen: string[] = [];
      page.on("request", (r) => {
        if (heavy(r)) seen.push(r.url());
      });
      await page.goto(path);
      await expect(page.locator(ready).first()).toBeVisible({ timeout: 30_000 });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      expect(seen, `${name} requested ${seen.join(", ")}`).toEqual([]);
    });
  }

  test("the review route does load them; a slow screen chunk shows the loading state", async ({ page }) => {
    await login(page);
    const seen: string[] = [];
    page.on("request", (r) => {
      if (heavy(r)) seen.push(r.url());
    });
    await page.goto(`/projects/p-noah/review?sheet=${ELEC}`);
    await expect(page.getByRole("application").first()).toBeVisible({ timeout: 60_000 });
    expect(seen.some((u) => /DrawingViewer-/.test(u))).toBe(true);
    expect(seen.some((u) => /ReviewPage-/.test(u))).toBe(true);

    // first load of a lazy screen whose chunk is slow → the skeleton (role=status) until it arrives
    await page.route(/\/assets\/LibraryPage-[\w-]+\.js$/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto("/library");
    await expect(page.locator("[data-route-loading]")).toBeVisible();
    await expect(page.locator("[data-route-loading]")).toContainText("טוען את המסך");
    await expect(page.getByRole("heading", { level: 1, name: "ספריית סעיפים" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-route-loading]")).toHaveCount(0);
  });
});
