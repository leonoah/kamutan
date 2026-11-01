import { expect, login, shot, test, needsNoah } from "./support";

/** Setup strip of the hub: sheet confirmation (S06) and legend confirmation (S07). */
test.describe("Sheet and legend confirmation", () => {
  test("confirm one sheet, then all; the hub's setup strip updates", async ({ page }, info) => {
    needsNoah();
    await login(page, "/projects/p-noah");
    await expect(page.getByText(/\d+ גיליונות מחכים לאישור/)).toBeVisible();
    await page.getByRole("link", { name: "אישור גיליונות" }).click();
    await expect(page).toHaveURL(/\/projects\/p-noah\/sheets$/);
    await expect(page.getByRole("heading", { name: "אישור גיליונות", level: 1 })).toBeVisible();
    const progress = page.getByText(/^\d+ מתוך 15 אושרו$/);
    await expect(progress).toBeVisible();
    const before = Number((await progress.textContent())!.match(/^(\d+)/)![1]);
    await shot(page, info, "sh-01-sheets");

    // uncertain fields are marked (dashed frame + "לא ודאי — כדאי לבדוק")
    await expect(page.getByText("לא ודאי — כדאי לבדוק").first()).toBeVisible();
    // scale input is LTR-safe numeric, discipline is a Hebrew select
    const firstConfirm = page.getByRole("button", { name: /^אשר את / }).first();
    const name = (await firstConfirm.getAttribute("aria-label"))!.replace(/^אשר את /, "");
    await firstConfirm.click();
    await expect(progress).toHaveText(`${before + 1} מתוך 15 אושרו`);

    await page.getByRole("button", { name: "אשר הכל" }).click();
    await expect(page.getByText("15 מתוך 15 אושרו")).toBeVisible();
    await shot(page, info, "sh-02-sheets-all-confirmed");
    expect(name.length).toBeGreaterThan(0);

    // back to the hub (in-app navigation keeps the in-memory mock state): the strip no longer asks to confirm sheets
    await page.getByRole("navigation", { name: "מיקום" }).getByRole("link", { name: "בית משפחת נח" }).click();
    await expect(page).toHaveURL(/\/projects\/p-noah$/);
    await expect(page.getByText(/גיליונות מחכים לאישור/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "לניתוח" }).first()).toBeVisible();
    await shot(page, info, "sh-03-hub-after-confirm");
  });

  test("legend: confirm a row, reassign a class, ignore a row; progress counts them", async ({ page }, info) => {
    await login(page, "/projects/p-noah/legend");
    await expect(page.getByRole("heading", { name: "אישור מקרא", level: 1 })).toBeVisible();
    const progress = page.getByText(/^\d+ מתוך \d+ אושרו$/).first();
    await expect(progress).toBeVisible();
    const [, c0, total] = (await progress.textContent())!.match(/^(\d+) מתוך (\d+)/)!;
    await shot(page, info, "lg-01-legend");

    const confirmBtns = page.getByRole("button", { name: /^אשר את "/ });
    await confirmBtns.nth(1).click();
    await expect(progress).toHaveText(`${Number(c0) + 1} מתוך ${total} אושרו`);

    // reassign: change the class of the next suggested row, then confirm it
    const select = page.getByRole("combobox", { name: /^סוג לשורת המקרא / }).nth(2);
    const options = await select.locator("option").allTextContents();
    const target = options.find((o) => o.trim() === "שקע כפול") ?? options[2]!;
    await select.selectOption({ label: target });
    const rowConfirm = page.getByRole("button", { name: /^אשר את "/ }).nth(1);
    await rowConfirm.click();
    await expect(progress).toHaveText(`${Number(c0) + 2} מתוך ${total} אושרו`);

    await page.getByRole("button", { name: /^התעלם מ-"/ }).first().click();
    await expect(page.getByText("לא פריט").first()).toBeVisible();
    await expect(page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: "לא הצלחנו" })).toHaveCount(0);
    await shot(page, info, "lg-02-legend-decided");
  });
});
