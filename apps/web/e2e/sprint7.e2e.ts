import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { OUT, axe, expect, expectNoHorizontalScroll, expectRtl, login, shot, test } from "./support";
import { ELEC, openReview, row } from "./review.helpers";

/**
 * Sprint 7 — owner requests: the BOQ preview ("exactly as the Excel") with print, and renaming a line ("✎ ידני",
 * restore, also in the library). Plus upload hardening: storage quota on the hub + 413 message, infected files.
 * Runs in BOTH data modes (Noah artifacts or the synthetic fixture): only codes both sets carry (4.01, 4.02) are used.
 */
const BUILT = "mockBoq=built";
const doc = (page: Page) => page.locator("[data-boq-document]");
const docTable = (page: Page) => page.locator("[data-boq-table]");
const docRow = (page: Page, code: string) => docTable(page).locator(`tr[data-code="${code}"]`).first();
const toast = (page: Page, text: string | RegExp) => page.locator("li[data-toast-tone]").filter({ hasText: text });

async function openPreview(page: Page, query = "") {
  await login(page, `/projects/p-noah/boq/preview?${BUILT}${query}`);
  await expect(page.getByRole("heading", { level: 1, name: "תצוגה מקדימה של כתב הכמויות" })).toBeVisible();
  await expect(page.locator("[data-boq-document] [data-code]:visible").first()).toBeVisible({ timeout: 60_000 });
}

test.describe("Sprint 7: BOQ preview", () => {
  test("from the hub card: title rows, columns, chapters + notes, subtotals, totals, warning; axe; options", async ({ page }, info) => {
    await login(page, `/projects/p-noah?${BUILT}`);
    await page.getByRole("link", { name: "תצוגה מקדימה של כתב הכמויות" }).click();
    await expect(page).toHaveURL(/\/projects\/p-noah\/boq\/preview$/);
    await expectRtl(page);
    const t = docTable(page);
    await expect(t).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-title-rows]")).toContainText("כתב כמויות");
    await expect(page.locator("[data-title-rows]")).toContainText("בית משפחת נח");
    await expect(page.locator("[data-title-rows]")).toContainText(/תאריך: \d\d\.\d\d\.\d{4}/);
    const heads = await t.locator("thead th").allInnerTexts();
    expect(heads.map((h) => h.trim())).toEqual(["סעיף", "תאור העבודה", "יחידה", 'כמות סה"כ', "מחיר יח'", 'סה"כ ₪', "רמת ביטחון", "סטטוס"]);
    await expect(t.locator('tbody[data-chapter="04"] th[scope="colgroup"]')).toContainText("פרק 04");
    await expect(t.locator('tbody[data-chapter="04"]')).toContainText("הערות:");
    expect(await t.locator('tbody[data-chapter="04"] tr[data-note-row]').count()).toBeGreaterThan(1);
    await expect(page.locator('[data-title-rows] [data-title-kind="warning"]')).toContainText("יש פריטים שלא נבדקו");
    expect(await t.locator("tr[data-subtotal]").count()).toBe(await t.locator("tbody[data-chapter]").count());
    await expect(t.locator("[data-grand-totals]")).toContainText('סה"כ כללי לא כולל מע"מ');
    await expect(t.locator("[data-grand-totals]")).toContainText('סה"כ כללי כולל מע"מ');
    await expect(t.locator("tr[data-needs-input]").first()).toContainText("להשלמה ידנית");
    await expect(page.locator("[data-preview-warning]")).toContainText("יש שורות שעדיין לא מוכנות");
    await shot(page, info, "s7-01-preview");
    await shot(page, info, "s7-01-preview-full", { fullPage: true });
    await axe(page, info, "s7-preview");

    // options (URL-backed)
    const before = await t.locator("tr[data-row-line]").count();
    await page.getByRole("radio", { name: "מפורק לפי קומה" }).click();
    await expect(page).toHaveURL(/split=floor/);
    await expect.poll(() => t.locator("tr[data-row-line]").count()).toBeGreaterThanOrEqual(before);
    await page.getByRole("checkbox", { name: 'הצג עמודות "רמת ביטחון" ו"סטטוס"' }).uncheck();
    await expect(t.locator("thead th")).toHaveCount(6);
    await page.locator("[data-chapter-picker] summary").click();
    await page.getByRole("checkbox", { name: "כל הפרקים" }).uncheck();
    await expect(page.getByText("בחרו לפחות פרק אחד.")).toBeVisible();
    await page.getByRole("checkbox", { name: /פרק 04/ }).check();
    await expect(t.locator("tbody[data-chapter]")).toHaveCount(1);
    await expect(page).toHaveURL(/chapters=04/);
    await shot(page, info, "s7-02-preview-options");
    await axe(page, info, "s7-preview-options");
  });

  test("print: A4 portrait CSS, no app chrome, header row repeats; print-media screenshot + axe", async ({ page }, info) => {
    await openPreview(page);
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("[data-app-chrome]")).toBeHidden();
    await expect(page.locator("[data-preview-toolbar]")).toBeHidden();
    await expect(page.locator("[data-boq-list]")).toBeHidden();
    await expect(docTable(page)).toBeVisible();
    expect(await docTable(page).locator("thead").evaluate((el) => getComputedStyle(el).display)).toBe("table-header-group");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(255, 255, 255)");
    await page.setViewportSize({ width: 794, height: 1123 });
    await shot(page, info, "s7-03-print", { fullPage: true });
    await axe(page, info, "s7-print");
    // the real print path: Chromium's PDF (A4) — several pages, the header row on each page
    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    const file = join(OUT, "screens", info.project.name, "s7-03-print.pdf");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, pdf);
    const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
    if (existsSync("/usr/bin/pdftotext")) {
      const text = execFileSync("/usr/bin/pdftotext", ["-layout", file, "-"]).toString("utf8").split("\f").filter((p) => p.trim());
      // every page carries the column header ("סעיף" / "יחידה"; pdftotext may reverse RTL words, so both spellings)
      // (a last page holding only the "הופק …" footer has no table)
      for (const p of text.filter((x) => !/^\s*\S*\s*הופק/.test(x.trim()) || x.trim().split("\n").length > 3)) expect(/סעיף|ףיעס/.test(p) && /יחידה|הדיחי/.test(p), "header row on every page").toBe(true);
    }
    await page.emulateMedia({ media: "screen" });
  });

  test("a row opens the line in the review workspace; export from the preview keeps the split", async ({ page }, info) => {
    await openPreview(page, "&split=floor");
    await page.getByRole("button", { name: "ייצוא לאקסל" }).click();
    const dlg = page.getByRole("dialog");
    await expect(dlg.getByRole("radio", { name: "מפורק לפי קומה" })).toBeChecked();
    await shot(page, info, "s7-04-preview-export");
    await page.keyboard.press("Escape");
    const r = docRow(page, "4.01");
    const lineId = await r.getAttribute("data-row-line");
    await r.locator("td").first().click();
    await expect(page).toHaveURL(new RegExp(`/projects/p-noah/review\\?line=${encodeURIComponent(lineId!)}`));
    await expect(page.getByRole("application").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(`tr[data-line="${lineId}"]`)).toHaveAttribute("data-selected", "true", { timeout: 30_000 });
  });

  test("linked from the BOQ panel and the export dialog", async ({ page }) => {
    await openReview(page, `sheet=${ELEC}&${BUILT}`);
    await expect(page.locator("#boq-panel [data-preview-link]")).toHaveAttribute("href", "/projects/p-noah/boq/preview");
    await page.getByRole("button", { name: "ייצוא", exact: true }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByText("מפורק לפי קומה").click();
    await dlg.getByRole("link", { name: "תצוגה מקדימה" }).click();
    await expect(page).toHaveURL(/\/boq\/preview\?split=floor$/);
    await expect(docTable(page)).toBeVisible({ timeout: 60_000 });
  });

  test("tablet: the grid fits, no sideways page scroll @ipad-only", async ({ page }, info) => {
    await openPreview(page);
    await expect(docTable(page)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, "s7-05-preview-ipad");
    await axe(page, info, "s7-preview-ipad");
  });

  test("phone: a readable stacked list, no sideways scroll @mobile-only", async ({ page }, info) => {
    await openPreview(page);
    await expect(page.locator("[data-boq-list]")).toBeVisible();
    await expect(docTable(page)).toBeHidden();
    await expect(page.locator('[data-boq-list] li[data-code="4.01"]').first()).toBeVisible();
    await expect(page.locator("[data-boq-list] [data-grand-totals]")).toContainText('סה"כ כללי כולל מע"מ');
    await expectNoHorizontalScroll(page);
    await shot(page, info, "s7-06-preview-mobile");
    await axe(page, info, "s7-preview-mobile");
  });
});

test.describe("Sprint 7: rename a line", () => {
  test("panel: double-click → edit (counter, Esc cancels) → Enter saves with a reason → ✎ ידני, history, preview, restore", async ({ page }, info) => {
    await openReview(page, `sheet=${ELEC}&${BUILT}`);
    const r = row(page, "4.01").first();
    const text = r.locator("[data-description-for] button").first();
    const original = (await text.innerText()).trim();
    await text.dblclick();
    const box = page.getByRole("textbox", { name: "תאור העבודה של סעיף 4.01" });
    await expect(box).toBeFocused();
    await box.press("End");
    await box.pressSequentially(" זמני");
    await box.press("Escape");
    await expect(box).toHaveCount(0);
    await expect(r).toContainText(original);
    await text.focus();
    await page.keyboard.press("Enter");
    await expect(box).toBeFocused();
    await box.fill("שקע כפול לבן מוגן מים");
    await expect(page.locator("[data-rename-counter]")).toContainText("21/500");
    await page.getByLabel("סיבה (לא חובה)").fill("לפי בקשת הלקוח");
    await shot(page, info, "s7-10-rename-editor");
    await axe(page, info, "s7-rename-editor");
    await box.press("Enter");
    await expect(r.locator("[data-description-for]")).toContainText("שקע כפול לבן מוגן מים");
    await expect(r.locator("[data-manual-name]")).toContainText("✎ ידני");
    await expect(toast(page, "השם של סעיף 4.01 עודכן.")).toBeVisible();
    await shot(page, info, "s7-11-renamed");
    // history: before → after + reason
    await r.hover();
    await r.locator("[data-history-for]").click();
    const dlg = page.getByRole("dialog");
    const item = dlg.locator('li[data-action="description"]').first();
    await expect(item).toContainText("שינוי שם השורה");
    await expect(item).toContainText(original);
    await expect(item).toContainText("שקע כפול לבן מוגן מים");
    await expect(item).toContainText("לפי בקשת הלקוח");
    await shot(page, info, "s7-12-history");
    await axe(page, info, "s7-rename-history", '[role="dialog"]');
    await page.keyboard.press("Escape");
    // the preview shows the new wording with the marker (SPA navigation keeps the mock state)
    await page.locator("#boq-panel [data-preview-link]").click();
    await expect(docRow(page, "4.01")).toContainText("שקע כפול לבן מוגן מים", { timeout: 60_000 });
    await expect(docRow(page, "4.01").locator("[data-manual-name]")).toBeVisible();
    await shot(page, info, "s7-13-preview-renamed");
    // back to the workspace, restore
    await docRow(page, "4.01").locator("td").first().click();
    await expect(page.getByRole("application").first()).toBeVisible({ timeout: 60_000 });
    const r2 = row(page, "4.01").first();
    await r2.getByRole("button", { name: "שינוי שם של סעיף 4.01" }).click();
    await expect(page.getByText(`נוסח מקורי: ${original}`)).toBeVisible();
    await page.getByRole("button", { name: "שחזר לנוסח המקורי" }).click();
    await expect(r2.locator("[data-manual-name]")).toHaveCount(0);
    await expect(r2.locator("[data-description-for]")).toContainText(original);
    await expect(toast(page, "סעיף 4.01 חזר לנוסח המקורי.")).toBeVisible();
  });

  test("'עדכן גם בספריית הסעיפים' with an old sign-in → re-authenticate → saved in the library too", async ({ page }, info) => {
    await openReview(page, `sheet=${ELEC}&${BUILT}&mockAuthAge=3600`);
    const r = row(page, "4.02").first();
    await r.hover();
    await r.getByRole("button", { name: "שינוי שם של סעיף 4.02" }).click();
    const box = page.getByRole("textbox", { name: "תאור העבודה של סעיף 4.02" });
    await box.fill("אביזר שלישיית שקעים (ספרייה)");
    await page.getByRole("checkbox", { name: "עדכן גם בספריית הסעיפים" }).check();
    await page.getByRole("button", { name: "שמור" }).click();
    const reauth = page.locator("[data-rename-editor] [data-reauth]");
    await expect(reauth).toBeVisible();
    await shot(page, info, "s7-14-rename-reauth");
    await axe(page, info, "s7-rename-reauth");
    await reauth.getByLabel("סיסמה").fill("acceptance-1234");
    await reauth.getByRole("button", { name: "אמת" }).click();
    await expect(toast(page, "השם של סעיף 4.02 עודכן, גם בספריית הסעיפים.")).toBeVisible();
    await expect(r.locator("[data-manual-name]")).toBeVisible();
    // the org library has the new wording (source → manual)
    await page.evaluate(() => {
      history.pushState({}, "", "/library");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page.getByText("אביזר שלישיית שקעים (ספרייה)").first()).toBeVisible({ timeout: 30_000 });
  });

  test("hub card: editors rename with the pencil; reviewers see no pencil", async ({ page }, info) => {
    await login(page, `/projects/p-noah?${BUILT}&mockRole=editor`);
    const r = page.locator('tr[data-code="4.01"]').first();
    await expect(r).toBeVisible({ timeout: 60_000 });
    await r.hover();
    await r.getByRole("button", { name: "שינוי שם של סעיף 4.01" }).click();
    const box = page.getByRole("textbox", { name: "תאור העבודה של סעיף 4.01" });
    await box.fill("שקע כפול בהזמנה");
    await shot(page, info, "s7-15-hub-rename");
    await axe(page, info, "s7-hub-rename");
    await box.press("Enter");
    await expect(toast(page, "השם של סעיף 4.01 עודכן.").or(page.locator('li[data-toast-tone="error"]')).first()).toBeVisible();
    await expect(toast(page, "השם של סעיף 4.01 עודכן.")).toBeVisible();
    await expect(r.locator("[data-manual-name]")).toBeVisible();
    await expect(r).toContainText("שקע כפול בהזמנה");
    await page.goto(`/projects/p-noah?${BUILT}&mockRole=reviewer`);
    await expect(page.locator('tr[data-code="4.01"]').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: /^שינוי שם של סעיף/ })).toHaveCount(0);
  });
});

test.describe("Sprint 7: upload hardening", () => {
  test("hub storage use; 413 quota message and an infected file in the upload dialog", async ({ page }, info) => {
    await login(page, `/projects/p-noah?mockQuotaMb=50`);
    await expect(page.locator("[data-storage]")).toContainText(/אחסון: .*MB.* מתוך .*50 MB/);
    await expect(page.locator("[data-storage]")).toContainText("כמעט מלא");
    await page.getByRole("button", { name: "העלאת שרטוטים" }).click();
    const dlg = page.getByRole("dialog");
    const pdf = (n: number) => Buffer.concat([Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n"), Buffer.alloc(n, 48)]);
    await dlg.locator("input[type=file]").setInputFiles([
      { name: "big-plan.pdf", mimeType: "application/pdf", buffer: pdf(6 * 1024 * 1024) },
      { name: "eicar-test.pdf", mimeType: "application/pdf", buffer: pdf(64) },
    ]);
    const list = dlg.getByRole("list", { name: "קבצים בהעלאה" });
    const big = list.locator("li").filter({ hasText: "big-plan.pdf" });
    const bad = list.locator("li").filter({ hasText: "eicar-test.pdf" });
    await expect(big.getByRole("alert")).toContainText("אין מספיק מקום בפרויקט");
    await expect(bad.locator("[data-file-infected]")).toContainText("הקובץ נחסם: זוהה תוכן זדוני", { timeout: 30_000 });
    await shot(page, info, "s7-20-upload-quota-infected");
    await axe(page, info, "s7-upload-errors", '[role="dialog"]');
  });
});
