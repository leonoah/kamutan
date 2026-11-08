import type { Page } from "@playwright/test";
import { axe, expect, expectNoHorizontalScroll, expectRtl, login, shot, test } from "./support";

/**
 * Sprint 9 — input-quality gate (contracts `SheetVersion.quality`). Mock project "p-web" (drawings collected from the
 * web): "web-shot-p0" = warn (CAD-viewer screenshot, ~96 dpi) → counted, every item capped + the quality reason;
 * "web-crop-p0" = reject (~30 dpi, mirrored, cropped) → no counts, the drawing still shows. Runs in BOTH data modes (the
 * p-web data is synthetic; with the Noah artifacts its tiles reuse two Noah renders, without them the tiles 404 quietly).
 */
const WARN = "web-shot-p0";
const REJECT = "web-crop-p0";
const tile = (page: Page, id: string) => page.locator(`article[data-sheet="${id}"]`);

test.describe("Sprint 9: input quality", () => {
  test("hub: warn / reject tiles, no counts on the rejected one, quality list with what to do; axe", async ({ page }, info) => {
    await login(page, "/projects/p-web");
    await expectRtl(page);
    await expect(page.getByRole("heading", { level: 1, name: /דירת כהן/ })).toBeVisible();
    const warn = tile(page, WARN);
    const reject = tile(page, REJECT);
    await expect(warn).toHaveAttribute("data-quality", "warn");
    await expect(reject).toHaveAttribute("data-quality", "reject");
    await expect(warn.locator('[data-quality-badge="warn"]')).toContainText("איכות ירודה");
    await expect(reject.locator('[data-quality-badge="reject"]')).toContainText("לא נספר");
    await expect(warn.getByText(/^\d+ פריטים$/)).toBeVisible();
    await expect(warn.getByText("צילום מסך ולא קובץ שרטוט")).toBeVisible();
    await expect(reject.getByText("לא נספרו פריטים")).toBeVisible();
    await expect(reject.getByText(/^\d+ פריטים$/)).toHaveCount(0);
    await expect(reject.getByText("רזולוציה נמוכה מדי (כ-30 dpi)")).toBeVisible();
    await expect(reject.getByText("הקובץ הפוך (מראה)")).toBeVisible();

    const section = page.locator("[data-quality-section]");
    await expect(section).toBeVisible();
    await expect(section).toContainText("2 גיליונות עם בעיית איכות");
    const rejRow = section.locator(`[data-quality-row="${REJECT}"]`);
    await expect(rejRow).toContainText("העלה את קובץ ה-PDF המקורי מתוכנת השרטוט");
    await expect(rejRow).toContainText("העלה את הגיליון המלא, כולל המסגרת וטבלת הכותרת.");
    await expect(rejRow.getByRole("button", { name: /העלה קובץ מקורי במקום/ })).toBeVisible();
    await shot(page, info, "s9-01-hub-quality", { fullPage: true });
    await axe(page, info, "s9-hub-quality");

    // the processing list opens the sheet analysis
    await rejRow.getByRole("link", { name: "הריסה — חיתוך הפוך" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/p-web/sheets/${REJECT}$`));
    await expect(page.locator('[data-quality-banner="reject"]')).toBeVisible({ timeout: 30_000 });
  });

  test("rejected sheet: banner says what to do, the drawing is shown, counts are not; axe", async ({ page }, info) => {
    await login(page, `/projects/p-web/sheets/${REJECT}`);
    const banner = page.locator('[data-quality-banner="reject"]');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("איכות הקובץ נמוכה מדי לספירה.");
    await expect(banner).toContainText("השרטוט מוצג לעיון בלבד");
    await expect(banner.locator('[data-quality-issue="low_resolution"]')).toContainText("רזולוציה נמוכה מדי (כ-30 dpi)");
    await expect(banner.locator('[data-quality-issue="mirrored"]')).toContainText("הקובץ הפוך (מראה)");
    await expect(banner.locator('[data-quality-issue="partial_crop"]')).toBeVisible();
    await expect(banner.getByRole("button", { name: /העלה קובץ מקורי במקום/ })).toBeVisible();
    await expect(page.getByRole("application").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-counts-rejected]")).toContainText("לא נספרו פריטים");
    await shot(page, info, "s9-02-sheet-rejected");
    await axe(page, info, "s9-sheet-rejected");
  });

  test("warn sheet: banner, items are counted and carry the quality reason; axe", async ({ page }, info) => {
    await login(page, `/projects/p-web/sheets/${WARN}`);
    const banner = page.locator('[data-quality-banner="warn"]');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('כולם מסומנים לבדיקה ולא יסומנו "מאומת"');
    await expect(banner.locator('[data-quality-issue="screenshot"]')).toContainText("העלה את קובץ ה-PDF המקורי מתוכנת השרטוט במקום צילום מסך.");
    await expect(banner.locator('[data-quality-issue="low_resolution"]')).toContainText("רזולוציה נמוכה מדי (כ-96 dpi)");
    await expect(page.getByRole("application").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-counts-rejected]")).toHaveCount(0);
    const chip = page.locator('[data-queue-item] [data-reason="INPUT_QUALITY"]').first();
    await expect(chip).toBeVisible({ timeout: 60_000 });
    await expect(chip).toContainText("איכות קובץ ירודה");
    await expect(chip).toHaveAttribute("title", /צילום מסך ולא קובץ שרטוט/);
    await shot(page, info, "s9-03-sheet-warn");
    await axe(page, info, "s9-sheet-warn");
  });

  test("upload the original for a rejected sheet: the replacement set takes its place", async ({ page }) => {
    await login(page, "/projects/p-web");
    const rejRow = page.locator(`[data-quality-row="${REJECT}"]`);
    await expect(rejRow).toBeVisible();
    await rejRow.getByTestId("reupload-input").setInputFiles({
      name: "הריסה-מקורי.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.concat([Buffer.from("%PDF-1.7\n%e2e\n"), Buffer.alloc(4096, 0x20), Buffer.from("\n%%EOF\n")]),
    });
    // the replaced set goes away once the new one is in; its quality notice with it
    await expect(page.locator(`[data-quality-row="${REJECT}"]`)).toHaveCount(0, { timeout: 60_000 });
    await expect(tile(page, REJECT)).toHaveCount(0);
    await expect(page.locator("[data-quality-section]")).toContainText("גיליון אחד עם בעיית איכות");
  });

  test("phone: hub quality notices fit without horizontal scroll @mobile-only", async ({ page }, info) => {
    await login(page, "/projects/p-web");
    await expect(tile(page, REJECT)).toBeVisible();
    await expect(page.locator("[data-quality-section]")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, "s9-04-hub-quality-phone", { fullPage: true });
  });
});
