import { expect, login, shot, test, waitForWorkspace } from "./support";
import { activeId, queue } from "./review.helpers";

/**
 * E2E-03 — learn from a correction: reclassify one item, "מצא דומים" finds the similar symbols across the project,
 * the similarity slider changes the candidate set, and "החל על N" applies them in one batch.
 * (Cross-project recall "in a new project of the same org" needs the real worker + library: NOT testable in the mock UI —
 * "זכור לארגון" is UI-only per apps/web/NOTES.md.)
 */
test("E2E-03: reclassify one item → find similar → slider → batch apply", async ({ page }, info) => {
  await login(page, "/projects/p-noah/review?sheet=noah-eb8be8a3-p0&mockBoq=built");
  await waitForWorkspace(page);
  // activate the first single-item card of this sheet
  const det = queue(page).locator('[data-queue-item^="det:"] article').first();
  await det.getByRole("button").first().click();
  await expect.poll(async () => (await activeId(page))?.startsWith("det:")).toBe(true);

  await page.keyboard.press("KeyE");
  const picker = page.getByRole("dialog", { name: "שייך לסוג אחר" });
  await expect(picker).toBeVisible();
  await picker.getByRole("combobox", { name: "חיפוש סוג" }).fill("שקע כח");
  await page.keyboard.press("Enter");
  await expect(page.getByText("פריט אחד שויך ל'שקע כח'.").first()).toBeVisible();

  const offer = page.getByText("רוצה שאחפש סמלים דומים בכל הפרויקט?");
  await expect(offer).toBeVisible();
  await shot(page, info, "e2e03-01-offer");
  await page.getByRole("button", { name: /מצא דומים/ }).click();

  const panel = page.getByRole("region", { name: "למד מהתיקון · שקע כח" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/^נמצאו \d+ דומים ב-\d+ גיליונות$/)).toBeVisible({ timeout: 30_000 });
  const counts = panel.getByTestId("learn-counts");
  const above = async () => Number((await counts.textContent())!.match(/^(\d+) מעל הסף/)![1]);
  const before = await above();
  await panel.getByRole("slider").fill("0.4");
  await expect.poll(above).toBeGreaterThan(before);
  await shot(page, info, "e2e03-02-learn-panel");

  // exclude one crop by hand, then apply
  await panel.getByRole("button", { name: /הוצא \/ החזר$/ }).first().click();
  await expect(counts).toContainText("1 הוצאו ידנית");
  const apply = panel.getByRole("button", { name: /^החל על \d+$/ });
  const n = Number((await apply.textContent())!.match(/\d+/)![0]);
  expect(n).toBeGreaterThan(0);
  await apply.click();
  await expect(page.getByText(`${n} פריטים תוקנו בלמידה ל'שקע כח'.`).first()).toBeVisible();
  await expect(panel).toBeHidden();
  await shot(page, info, "e2e03-03-applied");
});
