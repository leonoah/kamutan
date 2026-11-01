import { axe, expect, login, shot, test, waitForWorkspace, needsNoah } from "./support";

async function openExport(page: import("@playwright/test").Page, query = "mockBoq=built") {
  await login(page, `/projects/p-noah/review?${query}`);
  await waitForWorkspace(page);
  await expect(page.locator("tr[data-code]").first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "ייצוא", exact: true }).click();
  const dlg = page.getByRole("dialog").filter({ hasText: /ייצוא/ }).first();
  await expect(dlg).toBeVisible();
  return dlg;
}

/**
 * E2E-13 — export dialogs: Excel (summed / split by floor, warning copy with live counts, draft note) and marked PDF
 * (options, sheet subset validation, job progress → "הורד PDF" with a real PDF blob, omitted sheets warning).
 * The Excel FILE content (per-floor columns summing to the qty) is produced by the API/worker; in mock mode the UI
 * only toasts — that part is NOT testable here (Pipeline / API testers).
 */
test.describe("E2E-13 export", () => {
  test("Excel: template, split by floor, unverified-lines warning with counts, export anyway (mock toast)", async ({ page }, info) => {
    const dlg = await openExport(page);
    await expect(dlg.getByRole("heading", { name: "ייצוא כתב כמויות לאקסל" }).or(dlg.getByText("ייצוא כתב כמויות לאקסל")).first()).toBeVisible();
    await expect(dlg.getByText("אקסל", { exact: true }).first()).toBeVisible();
    await dlg.getByText("מפורק לפי קומה").click();
    await expect(dlg.getByText("יש פריטים שלא נבדקו")).toBeVisible();
    await expect(dlg).toContainText(/בכתב הכמויות יש .*"לבדיקה".* ו-.*"סביר"/);
    await expect(dlg).toContainText('בקובץ תופיע עמודת "סטטוס ביטחון"');
    await expect(dlg.getByRole("button", { name: "חזרה לבדיקה (מומלץ)" })).toBeVisible();
    await shot(page, info, "e2e13-01-excel-dialog");
    await axe(page, info, "export-excel-dialog", '[role="dialog"]');
    await dlg.getByRole("checkbox", { name: /טיוטה – כולל פריטים שלא אומתו/ }).check();
    await dlg.getByRole("button", { name: "ייצא בכל זאת" }).click();
    await expect(page.getByText(/מצב הדגמה: הקובץ לא נוצר|מוכן להורדה/).first()).toBeVisible();
  });

  test("Excel blocked by org policy while red lines remain → 'עבור לפריטים' filters ◆", async ({ page }, info) => {
    const dlg = await openExport(page, "mockBoq=built&mockBlockExport=1");
    await expect(dlg.getByText("לא ניתן לייצא עדיין.")).toBeVisible();
    await expect(dlg).toContainText(/נותרו \d+/);
    await shot(page, info, "e2e13-02-blocked");
    await dlg.getByRole("button", { name: "עבור לפריטים" }).click();
    await expect(dlg).toBeHidden();
    await expect(page).toHaveURL(/lvl=/);
  });

  test("marked PDF: options, subset validation, progress → 'הורד PDF' (valid PDF), omitted-sheets warning", async ({ page }, info) => {
    needsNoah();
    const dlg = await openExport(page);
    await dlg.getByText("PDF מסומן", { exact: true }).first().click();
    await expect(dlg.getByText("עמוד נפרד לכל קומה")).toBeVisible();
    await expect(dlg.getByText("הסתר את טבלת הכותרת")).toBeVisible();
    // A-UI-20 (b): hiding the title block defaults ON, like the share dialog
    await expect(dlg.getByRole("checkbox", { name: "הסתר את טבלת הכותרת" })).toBeChecked();
    const all = dlg.getByRole("checkbox", { name: /^כל הגיליונות \(\d+\)$/ });
    await expect(all).toBeChecked();
    // A-UI-20 (a): unchecking "all" reveals the per-sheet list with nothing ticked; tick two → "2 מתוך 15"
    await all.uncheck();
    const sheetBoxes = dlg.locator("[data-marked-pdf] fieldset ul input[type=checkbox]");
    await expect(sheetBoxes).toHaveCount(15);
    for (let i = 0; i < 15; i++) await expect(sheetBoxes.nth(i)).not.toBeChecked();
    await expect(dlg.getByText("בחרו לפחות גיליון אחד.")).toBeVisible();
    await expect(dlg.getByRole("button", { name: "צור PDF" })).toBeDisabled();
    await sheetBoxes.nth(0).check();
    await sheetBoxes.nth(1).check();
    await expect(dlg.getByText(/2 מתוך 15 גיליונות/).first()).toBeVisible();
    await all.check();
    await shot(page, info, "e2e13-03-pdf-options");
    await axe(page, info, "export-pdf-dialog", '[role="dialog"]');
    await dlg.getByRole("checkbox", { name: "עמוד נפרד לכל קומה" }).check();
    await dlg.getByRole("checkbox", { name: "הסתר את טבלת הכותרת" }).check();
    await dlg.getByRole("button", { name: "צור PDF" }).click();
    const link = dlg.getByRole("link", { name: "הורד PDF" });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(dlg).toContainText(/ה-PDF מוכן \(/);
    await expect(dlg).toContainText("קישור ההורדה בתוקף 15 דקות.");
    await expect(link).toHaveAttribute("rel", /noreferrer/);
    // default mock: two sheets have no detectable title block → listed as omitted
    await expect(dlg).toContainText(/הושמטו|לא נמצאה טבלת כותרת/);
    const href = (await link.getAttribute("href"))!;
    const head = await page.evaluate(async (u) => {
      const b = new Uint8Array(await (await fetch(u)).arrayBuffer());
      return String.fromCharCode(...b.slice(0, 5));
    }, href);
    expect(head).toBe("%PDF-");
    await shot(page, info, "e2e13-04-pdf-ready");
  });
});
