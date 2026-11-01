import type { Page } from "@playwright/test";
import { axe, expect, login, shot, test } from "./support";

/** Synthetic, customer-free PDF bytes (valid magic number; the mock never parses the body). */
const pdf = (name: string, kb = 40) => ({
  name,
  mimeType: "application/pdf",
  buffer: Buffer.concat([Buffer.from("%PDF-1.7\n% kamutan e2e fixture\n"), Buffer.alloc(kb * 1024, 0x20), Buffer.from("\n%%EOF\n")]),
});

const fileInput = (page: Page) => page.getByTestId("file-input");

test.describe("Upload dialog", () => {
  test("hub → 'העלאת שרטוטים' dialog: client-side rejection, upload → processing; network failure → retry re-uploads", async ({ page }, info) => {
    await login(page, "/projects/p-noah");
    await page.getByRole("button", { name: "העלאת שרטוטים" }).click();
    const dlg = page.getByRole("dialog", { name: "העלאת שרטוטים" });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId("dropzone")).toContainText("גררו לכאן את קובצי השרטוטים");
    await shot(page, info, "up-01-dialog");
    await axe(page, info, "upload-dialog", '[role="dialog"]');

    // client-side check: a .txt with a PDF name is rejected with the Hebrew mismatch message, no upload starts
    await fileInput(page).setInputFiles([{ name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("hello world, not a pdf") }]);
    await expect(dlg.getByText(/תוכן הקובץ .*fake\.pdf.* לא תואם לסיומת שלו\./)).toBeVisible();

    // one good file + one that fails on the network at 50% (mock affordance: name contains "fail")
    await fileInput(page).setInputFiles([pdf("E2E-קומת קרקע חשמל.pdf"), pdf("E2E-network-fail.pdf")]);
    const list = dlg.getByRole("list", { name: "קבצים בהעלאה" });
    const good = list.getByRole("listitem").filter({ hasText: "E2E-קומת קרקע חשמל.pdf" });
    const bad = list.getByRole("listitem").filter({ hasText: "E2E-network-fail.pdf" });
    await expect(good).toContainText("הועלה", { timeout: 30_000 });
    await expect(bad).toContainText("ההעלאה נכשלה. בדקו את החיבור ונסו שוב.");
    await expect(bad).toContainText("נכשל");
    await shot(page, info, "up-02-failed-file");

    // re-upload: "נסו שוב" gets a fresh slot and restarts the transfer
    await bad.getByRole("button", { name: "נסו שוב" }).click();
    await expect(bad.getByRole("progressbar")).toBeVisible();
    await expect(bad).toContainText(/מעלה|מתכונן/);
    await expect(bad).toContainText("ההעלאה נכשלה", { timeout: 30_000 }); // same simulated file fails again — UI stays usable
    await expect(dlg.getByText(/\d+ מתוך \d+ הועלו/)).toBeVisible();

    // the good one started an ingest job (toast) and the hub shows it in "העלאות ועיבוד"
    await expect(page.getByText(/הועלה\. העיבוד התחיל\./).first()).toBeVisible();
    await dlg.getByRole("button", { name: "סגירה" }).or(dlg.getByRole("button", { name: "סגור" })).first().click(); // (Escape first dismisses the open toast — Radix layer order)
    await expect(dlg).toBeHidden();
    await shot(page, info, "up-03-hub-processing");
  });

  test("E2E-14 UI: a set of 15 files with one damaged — 14 process, the damaged one is marked 'נכשל' with a reason; project not stuck", async ({ page }, info) => {
    test.setTimeout(150_000);
    await login(page, "/projects/p-levi");
    // empty project: upload is the primary action, inline (no dialog)
    await expect(page.getByRole("heading", { name: "העלו את סט השרטוטים" })).toBeVisible();
    const files = Array.from({ length: 14 }, (_, i) => pdf(`levi-sheet-${String(i + 1).padStart(2, "0")}.pdf`, 8));
    files.splice(7, 0, pdf("levi-sheet-damaged-encrypted.pdf", 8)); // mock affordance: "encrypted" fails at ingest
    await fileInput(page).setInputFiles(files);
    await expect(page.getByText("15 מתוך 15 הועלו")).toBeVisible({ timeout: 60_000 });

    // the damaged set fails with a Hebrew reason; the others go on
    const reason = page.getByText("הקובץ מוגן בסיסמה. שמרו אותו בלי הצפנה והעלו שוב.").first();
    await expect(reason).toBeVisible({ timeout: 60_000 });
    // project not stuck: the other sets' sheets reach the gallery and wait for confirmation; the damaged one is "נכשל"
    await expect(page.getByRole("link", { name: "לאישור הגיליון" }).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/^\d+ גיליונות מחכים לאישור$/)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/^נכשל$/).first()).toBeVisible();
    await expect(page.getByText(/בעיבוד/)).toHaveCount(0, { timeout: 90_000 });
    await shot(page, info, "e2e14-01-set-with-failure", { fullPage: true });
  });

  // A-UI-05 (fixed): a failed set had a reason but no "העלה מחדש" action anywhere. Now the failed job row offers it; the
  // picked file is uploaded as the replacement of the failed set (`replacesSheetSetId`), which then leaves the list.
  test("A-UI-05 E2E-14 UI: the failed file offers 'העלה מחדש', and the fixed file replaces the failed set", async ({ page }, info) => {
    await login(page, "/projects/p-levi");
    await fileInput(page).setInputFiles([pdf("one-encrypted.pdf", 8)]);
    await expect(page.getByText("הקובץ מוגן בסיסמה").first()).toBeVisible({ timeout: 60_000 });
    const again = page.getByRole("button", { name: /^העלה מחדש/ });
    await expect(again).toBeVisible();
    await expect(again).toHaveAccessibleName("העלה מחדש את one-encrypted.pdf");
    await shot(page, info, "e2e14-02-reupload-offered");
    await axe(page, info, "reupload");
    await page.getByTestId("reupload-input").setInputFiles([pdf("one-fixed.pdf", 8)]);
    // the replacement uploads with a "גרסה מתוקנת"/"מחליף את" badge, processes, and the failure is gone
    await expect(page.locator("[data-set-status=superseded]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByText("הקובץ מוגן בסיסמה")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByRole("button", { name: /^העלה מחדש/ })).toHaveCount(0);
    await expect(page.getByText(/מחליף את one-encrypted\.pdf/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "לאישור הגיליון" }).first()).toBeVisible({ timeout: 90_000 });
    await shot(page, info, "e2e14-03-reuploaded", { fullPage: true });
  });

  test("revised upload: 'מחליף את סט X' replaces an existing set; its sheets are superseded", async ({ page }, info) => {
    test.setTimeout(150_000);
    await login(page, "/projects/p-noah");
    await expect(page.locator("[data-sheet]").first()).toBeVisible();
    const before = await page.locator("[data-sheet]").count();
    await page.getByRole("button", { name: "העלאת שרטוטים" }).click();
    const dlg = page.getByRole("dialog", { name: "העלאת שרטוטים" });
    const pick = dlg.getByLabel("מה הקבצים האלה?");
    await expect(pick).toHaveValue(""); // default: a new set
    const option = pick.locator("option").nth(1);
    const label = (await option.textContent())!;
    const oldName = label.replace(/^מחליף את סט /, "");
    const oldId = (await option.getAttribute("value"))!;
    await pick.selectOption(oldId);
    await expect(dlg.getByText(/הגיליונות שלו יוחלפו בגיליונות החדשים/)).toBeVisible();
    await shot(page, info, "up-04-replace-picker");
    await axe(page, info, "upload-replace-dialog", '[role="dialog"]');
    await fileInput(page).setInputFiles([pdf("noah-revision-B.pdf", 8)]);
    const row = dlg.getByRole("listitem").filter({ hasText: "noah-revision-B.pdf" });
    await expect(row).toContainText(`מחליף את ${oldName}`);
    await expect(row).toContainText("הועלה", { timeout: 30_000 });
    await expect(pick).toHaveValue(""); // back to "new set" for the next file
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    // the old set is "הוחלף בגרסה חדשה", the new one says what it replaces; the old sheet left the gallery
    await expect(page.locator("[data-set-status=superseded]")).toHaveCount(1, { timeout: 60_000 });
    await expect(page.locator("[data-set-status=superseded]")).toContainText("הוחלף בגרסה חדשה");
    await expect(page.locator("[data-replaces]").filter({ hasText: `מחליף את ${oldName}` })).toHaveCount(1);
    await expect(page.locator(`[data-sheet^="${oldId}-"]`)).toHaveCount(0);
    await expect.poll(() => page.locator("[data-sheet]").count(), { timeout: 60_000 }).toBe(before - 1 + 2);
    await shot(page, info, "up-05-replaced", { fullPage: true });
  });

  // A-UI-23 (fixed): with a toast open, the first Escape only dismissed the toast (Radix layer order).
  test("A-UI-23: one Escape closes the upload dialog even while a toast is open", async ({ page }) => {
    await login(page, "/projects/p-noah");
    await page.getByRole("button", { name: "העלאת שרטוטים" }).click();
    const dlg = page.getByRole("dialog", { name: "העלאת שרטוטים" });
    await fileInput(page).setInputFiles([pdf("E2E-esc.pdf")]);
    await expect(page.getByText(/הועלה\. העיבוד התחיל\./).first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
  });
});
