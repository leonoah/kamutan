import { axe, expect, expectNoHorizontalScroll, expectRtl, login, shot, test, waitForWorkspace } from "./support";

/**
 * E2E-09 — share with an external viewer (UI side; the API 403/410 contract is the API/Sec tester's).
 * Share dialog: create a 7-day link, URL shown once, per-sheet title-block masking warnings, list, revoke.
 * External viewer /s/:token (mock demo links): read-only, no edit controls, watermark, expired / revoked / not-found.
 */
test.describe("E2E-09 share", () => {
  test("share dialog: 7-day link, URL once + copy, title-block warnings per sheet, list, revoke with confirm", async ({ page, context }, info) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await login(page, "/projects/p-noah/review?mockBoq=built");
    await waitForWorkspace(page);
    await page.getByRole("button", { name: "שתף" }).click();
    const dlg = page.getByRole("dialog", { name: "שיתוף לצפייה בלבד" });
    await expect(dlg).toBeVisible();
    // defaults: 14 days, hide title block ON, PDF OFF
    await expect(dlg.getByLabel("תוקף בימים")).toHaveValue("14");
    await expect(dlg.getByRole("checkbox", { name: /הסתר את טבלת הכותרת/ })).toBeChecked();
    await expect(dlg.getByRole("checkbox", { name: "אפשר להוריד PDF מסומן" })).not.toBeChecked();
    await shot(page, info, "e2e09-01-share-dialog");
    await axe(page, info, "share-dialog", '[role="dialog"]');

    // label required
    await dlg.getByRole("button", { name: "צור קישור" }).click();
    await expect(dlg.getByText("חובה לתת שם לקישור.")).toBeVisible();
    await dlg.getByLabel("שם הקישור").fill("קבלן חשמל — הצעת מחיר (E2E)");
    await dlg.getByLabel(/נמען/).fill("contractor@example.com");
    await dlg.getByRole("button", { name: "7", exact: true }).click();
    await expect(dlg.getByLabel("תוקף בימים")).toHaveValue("7");
    await expect(dlg.getByText(/בתוקף עד \d{2}\.\d{2}\.\d{4}/).first()).toBeVisible();
    await dlg.getByRole("button", { name: "צור קישור" }).click();

    // created: URL once (LTR, read-only), copy, warning that it is shown once
    const created = dlg.locator("[data-share-created]");
    await expect(created).toBeVisible();
    await expect(created).toContainText("זו הפעם היחידה שהקישור מוצג");
    const url = created.getByLabel("קישור הצפייה");
    await expect(url).toHaveAttribute("readonly", "");
    await expect(url).toHaveAttribute("dir", "ltr");
    const href = await url.inputValue();
    expect(href).toMatch(/\/s\/[A-Za-z0-9_-]{40,}$/); // ≥ 256-bit base64url token
    await created.getByRole("button", { name: "העתק קישור" }).click();
    await expect(page.getByText(/הקישור הועתק/).first()).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(href);

    // per-sheet title-block masking: warnings (role=alert) for sheets without a detectable title block + sheet states
    await expect(dlg.locator("[data-share-warning]").first()).toBeVisible();
    await expect(dlg.getByText("טבלת הכותרת מוסתרת").first()).toBeVisible();
    await expect(dlg.getByText("לא נכלל: לא זוהתה טבלת כותרת").first()).toBeVisible();
    await shot(page, info, "e2e09-02-created");

    // list → the new link is active; revoke through the AlertDialog
    const item = dlg.getByRole("listitem").filter({ hasText: "קבלן חשמל — הצעת מחיר (E2E)" });
    await expect(item).toContainText("פעיל");
    await expect(item).toContainText("contractor@example.com");
    await item.getByRole("button", { name: /בטל את הקישור/ }).click();
    const confirm = page.getByRole("alertdialog", { name: "לבטל את הקישור?" });
    await expect(confirm).toBeVisible();
    await shot(page, info, "e2e09-03-revoke-confirm");
    await confirm.getByRole("button", { name: "בטל קישור" }).click();
    await expect(item).toContainText("בוטל");
  });

  test("opt-in: include sheets without a title block → red 'נכלל בלי הסתרה' + warning", async ({ page }, info) => {
    await login(page, "/projects/p-noah/review?mockBoq=built");
    await waitForWorkspace(page);
    await page.getByRole("button", { name: "שתף" }).click();
    const dlg = page.getByRole("dialog", { name: "שיתוף לצפייה בלבד" });
    await dlg.getByLabel("שם הקישור").fill("פיקוח (E2E)");
    const optIn = dlg.getByRole("checkbox", { name: "כלול גם גיליונות שלא זוהתה בהם טבלת כותרת" });
    await expect(optIn).not.toBeChecked();
    await optIn.check();
    await dlg.getByRole("button", { name: "צור קישור" }).click();
    await expect(dlg.getByText("נכלל בלי הסתרת טבלת הכותרת").first()).toBeVisible();
    await expect(dlg.locator("[data-share-warning]").first()).toBeVisible();
    await shot(page, info, "e2e09-04-unmasked-opt-in");
  });

  test("external viewer: read-only BOQ + drawing, no edit controls, watermark, row → drawing @ipad", async ({ page }, info) => {
    await page.goto("/s/demo-noah");
    await expectRtl(page);
    const viewer = page.locator("[data-share-viewer]");
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    await expect(viewer.locator("[data-read-only]")).toContainText("לקריאה בלבד");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
    const boq = viewer.locator("[data-share-boq]");
    await expect(boq.locator("tr[data-line]").first()).toBeVisible({ timeout: 60_000 });
    await expect(viewer.getByRole("application")).toBeVisible();
    await expect(viewer.locator("[data-watermark]")).toHaveCount(1);
    expect(await viewer.locator("[data-watermark]").getAttribute("data-watermark")).toBeTruthy();

    // no edit affordances anywhere
    for (const name of [/^אשר/, /^דחה/, /שייך/, "ייצוא", "שתף", "בנו מחדש", /עריכת כמות/, /היסטוריה/]) {
      await expect(page.getByRole("button", { name })).toHaveCount(0);
    }
    await expect(page.getByRole("toolbar")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "תור בדיקה" })).toHaveCount(0);
    // no scores / reasons in the public BOQ
    await expect(boq).not.toContainText(/ביטחון \d\.\d|כיול שמרני/);

    // row → drawing: select a line with evidence
    const firstRow = boq.locator("tr[data-line]").first();
    await firstRow.click();
    await expect(firstRow).toHaveClass(/outline-primary/);
    await shot(page, info, "e2e09-05-viewer");
    await axe(page, info, "share-viewer");
  });

  test("external viewer: expired / revoked / unknown token screens @ipad", async ({ page, allowConsole }, info) => {
    allowConsole(/status of 4(04|10)|Failed to load resource/);
    for (const [token, title] of [
      ["demo-expired", "הקישור פג תוקף"],
      ["demo-revoked", "הקישור בוטל"],
      ["no-such-token-e2e", "הקישור לא נמצא"],
    ] as const) {
      await page.goto(`/s/${token}`);
      await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("[data-share-viewer]")).toHaveCount(0);
      await expect(page.locator("[data-share-boq]")).toHaveCount(0);
      await shot(page, info, `e2e09-06-${token}`);
      await axe(page, info, `share-${token}`);
    }
  });

  test("external viewer on a phone (390) @mobile-only @mobile", async ({ page }, info) => {
    await page.goto("/s/demo-noah");
    await expect(page.locator("[data-share-viewer]")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-share-boq] tr[data-line]").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-read-only]")).toBeInViewport();
    await expectNoHorizontalScroll(page);
    await shot(page, info, "m-03-share-viewer", { fullPage: true });
    await axe(page, info, "m-share-viewer");
    await page.goto("/s/demo-revoked");
    await expect(page.getByRole("heading", { name: "הקישור בוטל" })).toBeVisible();
    await shot(page, info, "m-04-share-revoked");
  });

  // A-UI-10: at 390 px the viewer header squeezes the title to "ס…" and wraps the label / version / expiry one word per
  // line (SharedViewerPage.tsx header row: title block + "לקריאה בלבד" + "הורד PDF מסומן" in one non-wrapping flex row).
  test.fixme("A-UI-10 mobile 390: the share viewer title is readable (not truncated to one letter) @mobile-only @mobile", async ({ page }) => {
    await page.goto("/s/demo-noah");
    const h1 = page.locator("[data-share-viewer] h1");
    await expect(h1).toBeVisible({ timeout: 60_000 });
    expect(await h1.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  });
});
