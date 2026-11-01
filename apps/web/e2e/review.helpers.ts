import type { Locator, Page } from "@playwright/test";
import { expect, login, waitForWorkspace } from "./support";

/** Ground-floor electrical sheet of Noah (real artifacts locally; the synthetic fixture sheet on CI). */
export const ELEC = "noah-eb8be8a3-p0";

/** Project BOQ workspace on one sheet, BOQ tab. */
export async function openReview(page: Page, query = `sheet=${ELEC}`) {
  await login(page, `/projects/p-noah/review?${query}`);
  await waitForWorkspace(page);
  await expect(page.locator("tr[data-code]").first()).toBeVisible({ timeout: 60_000 });
}

export const row = (page: Page, code: string) => page.locator(`tr[data-code="${code}"]`);
export const qtyButton = (page: Page, code: string) => row(page, code).getByRole("button", { name: new RegExp(`קבלה לשורה ${code.replace(".", "\\.")}`) });
export async function qtyOf(page: Page, code: string): Promise<number> {
  const t = (await qtyButton(page, code).innerText()).trim();
  return Number(t.match(/[\d.]+/)![0]);
}

export const queue = (page: Page) => page.getByRole("region", { name: "תור בדיקה" });
export const activeCard = (page: Page) => page.locator("[data-queue-item] article[data-active]");
export async function activeId(page: Page) {
  return activeCard(page).locator("xpath=..").getAttribute("data-queue-item");
}
export const canvas = (page: Page): Locator => page.getByRole("application").first();
export const remainingCount = async (page: Page) => {
  const label = (await queue(page).getByText(/^נותרו \d+/).first().textContent()) ?? "";
  return Number(label.match(/נותרו (\d+)/)![1]);
};

/** Pixels of the drawing (to detect that the viewer moved / zoomed). */
export const drawingPixels = (page: Page) => canvas(page).screenshot();
