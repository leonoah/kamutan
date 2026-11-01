import type { Page } from "@playwright/test";
import { expect, login, shot, test, waitForWorkspace, needsNoah } from "./support";
import { activeCard, activeId, drawingPixels, queue, remainingCount } from "./review.helpers";

const IMPACT_RANK: Record<string, number> = { גבוהה: 3, בינונית: 2, נמוכה: 1 };

async function impacts(page: Page) {
  const texts = await queue(page).locator("[data-queue-item] article").allInnerTexts();
  return texts.map((t) => IMPACT_RANK[t.match(/השפעה: (\S+)/)?.[1] ?? ""] ?? 0);
}

/** Wait until the active queue item changed from `prev`. */
async function nextActive(page: Page, prev: string | null) {
  await expect.poll(() => activeId(page), { timeout: 10_000 }).not.toBe(prev);
  return activeId(page);
}

/**
 * E2E-06 — the review queue is ordered by risk (impact × uncertainty); keyboard J/K/A/R/E/N works; each item is
 * focused on the drawing automatically. Runs on desktop and on the iPad viewport (view + approve).
 */
test.describe("E2E-06 review queue", () => {
  test.beforeEach(() => needsNoah());
  test("risk order, J/K/N navigation, A accept, R reject, E reclassify picker, auto-focus on the drawing @ipad", async ({ page }, info) => {
    await login(page, "/projects/p-noah/sheets/noah-eb8be8a3-p0");
    await waitForWorkspace(page);
    await expect(queue(page)).toBeVisible();
    await shot(page, info, "e2e06-01-queue");

    // risk order: the impact bucket never goes up along the list
    const ranks = await impacts(page);
    expect(ranks.length).toBeGreaterThan(3);
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]!, `impact order at ${i}: ${ranks.join(",")}`).toBeLessThanOrEqual(ranks[i - 1]!);
    // the entry item is the highest-risk item of the opened sheet
    const first = await activeId(page);
    const ids = await queue(page).locator("[data-queue-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-queue-item")!));
    expect(first).toBe(ids.find((id) => id.includes("noah-eb8be8a3-p0")));

    // J → next item, and the drawing moves to it (auto-focus)
    const px0 = await drawingPixels(page);
    await page.keyboard.press("KeyJ");
    const second = await nextActive(page, first);
    await expect.poll(async () => (await drawingPixels(page)).equals(px0), { timeout: 10_000, message: "drawing re-focused on the item" }).toBe(false);
    // K → back
    await page.keyboard.press("KeyK");
    await expect.poll(() => activeId(page)).toBe(first);
    // N → next as well (same as J)
    await page.keyboard.press("KeyN");
    await expect.poll(() => activeId(page)).toBe(second);
    await page.keyboard.press("KeyK");
    await expect.poll(() => activeId(page)).toBe(first);

    // A accepts the active item/cluster: it leaves the queue, the next one becomes active, remaining goes down
    const n0 = await remainingCount(page);
    await page.keyboard.press("KeyA");
    const afterA = await nextActive(page, first);
    await expect(queue(page).locator(`[data-queue-item="${first}"]`)).toHaveCount(0);
    await expect.poll(() => remainingCount(page)).toBeLessThan(n0);
    await expect(page.getByText(/אושר|אושרו/).first()).toBeVisible();
    await shot(page, info, "e2e06-02-after-accept");

    // R rejects the active item
    const n1 = await remainingCount(page);
    await page.keyboard.press("KeyR");
    await nextActive(page, afterA);
    await expect(queue(page).locator(`[data-queue-item="${afterA}"]`)).toHaveCount(0);
    await expect.poll(() => remainingCount(page)).toBeLessThan(n1);

    // E opens the class picker (desktop: keyboard). Esc closes it without a change.
    if (info.project.name === "desktop") {
      await page.keyboard.press("KeyE");
      const picker = page.getByRole("dialog", { name: /שייך|לאיזה סוג|סוג/ }).first();
      await expect(picker).toBeVisible();
      await shot(page, info, "e2e06-03-picker");
      await page.keyboard.press("Escape");
      await expect(picker).toBeHidden();
    }

    // "?" shortcut map lists the keys
    await page.keyboard.press("Shift+Slash");
    const help = page.getByRole("dialog", { name: "קיצורי מקלדת" });
    await expect(help).toBeVisible();
    await expect(help).toContainText("אשר פריט / אשכול");
    await page.keyboard.press("Escape");
  });

  // A-UI-09 (fixed): the sheet-locked analysis (IA level 3) listed project-wide line cards that are not on the sheet
  // (e.g. "שורה 3.15 · משאבה לניקוז מי גשם" on the electrical sheet). 09_ia_redesign: the queue is filtered to the sheet.
  test("A-UI-09 sheet analysis: every queue item belongs to the locked sheet", async ({ page }) => {
    await login(page, "/projects/p-noah/sheets/noah-eb8be8a3-p0");
    await waitForWorkspace(page);
    const ids = await queue(page).locator("[data-queue-item]").evaluateAll((els) => els.map((e) => e.getAttribute("data-queue-item")!));
    expect(ids.filter((id) => !id.includes("noah-eb8be8a3-p0"))).toEqual([]);
  });

  test("touch / pointer approve on the active card (iPad: view + approve) @ipad", async ({ page }, info) => {
    await login(page, "/projects/p-noah/sheets/noah-eb8be8a3-p0");
    await waitForWorkspace(page);
    const first = await activeId(page);
    const n0 = await remainingCount(page);
    const card = activeCard(page);
    await card.getByRole("button", { name: /^A?\s*אשר/ }).first().click();
    await nextActive(page, first);
    await expect.poll(() => remainingCount(page)).toBeLessThan(n0);
    await shot(page, info, "e2e06-04-pointer-approve");
  });
});
