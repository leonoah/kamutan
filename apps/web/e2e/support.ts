import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");
export const OUT = process.env.E2E_OUT ?? "node_modules/.cache/kamutan-e2e/out";

/** Console noise that is not an app error (software WebGL on CI / sandbox). */
const CONSOLE_ALLOW = [/GL Driver Message/i, /GroupMarkerNotSet/i, /software WebGL/i, /WebGL.*(stall|performance)/i];

type Fixtures = {
  /** Console errors + uncaught exceptions collected during the test; asserted empty after the test. */
  consoleErrors: string[];
  /** Extra allow-list for one test (e.g. an intentional 404 the UI handles). */
  allowConsole: (re: RegExp) => void;
};

export const test = base.extend<Fixtures>({
  consoleErrors: [
    async ({ page }, use, info) => {
      const errors: string[] = [];
      const allow: RegExp[] = [...CONSOLE_ALLOW];
      (page as Page & { __allow?: RegExp[] }).__allow = allow;
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const text = m.text();
        const url = m.location()?.url ?? "";
        // /dev-artifacts is the local data mount of the mock (absent on CI → 404s are expected, not app errors)
        if (/Failed to load resource/.test(text) && url.includes("/dev-artifacts/")) return;
        if (!allow.some((re) => re.test(text))) errors.push(`console.error: ${text}${url ? ` (${url})` : ""}`);
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      await use(errors);
      if (errors.length) {
        await info.attach("console-errors", { body: errors.join("\n"), contentType: "text/plain" });
      }
      expect(errors, "no console errors / uncaught exceptions").toEqual([]);
    },
    { auto: true },
  ],
  allowConsole: async ({ page }, use) => {
    await use((re) => (page as Page & { __allow?: RegExp[] }).__allow?.push(re));
  },
});
export { expect };

/** Mock sign-in: any valid email + a password of ≥ 10 chars (apps/web/NOTES.md). Session lives in sessionStorage. */
export async function login(page: Page, then = "/projects") {
  await page.goto("/login");
  await page.getByLabel("אימייל").fill("qa.reviewer@example.com");
  await page.getByLabel("סיסמה", { exact: true }).fill("acceptance-1234");
  await page.getByRole("button", { name: "כניסה", exact: true }).click();
  await page.waitForURL(/\/projects$/);
  if (then !== "/projects") await page.goto(then);
}

/** Save a screenshot under E2E_OUT/screens/<project>/<name>.png (outside git: may contain drawings). */
export async function shot(page: Page, info: TestInfo, name: string, opts: { fullPage?: boolean; locator?: Locator } = {}) {
  const file = join(OUT, "screens", info.project.name, `${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined); // drawing tiles
  if (opts.locator) await opts.locator.screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: opts.fullPage ?? false });
  return file;
}

/**
 * Known accessibility defects (defects.md). They are reported as test annotations instead of failing every flow; the
 * strict versions live in a11y.e2e.ts as test.fixme with the defect id. A NEW serious/critical violation still fails.
 */
export const KNOWN_A11Y: { rule: string; defect: string }[] = [
  { rule: "label-content-name-mismatch", defect: "A-UI-03" },
  { rule: "color-contrast", defect: "A-UI-04" },
];

type AxeViolation = { id: string; impact: string | null; help: string; nodes: { target: string[]; failureSummary?: string }[] };

/**
 * axe-core (WCAG 2.1 A/AA) on the page or a region. Fails on serious/critical; saves the full result as JSON.
 * Returns all violations so a caller can inspect minor/moderate ones.
 */
export async function axe(page: Page, info: TestInfo, name: string, include?: string, strict = false) {
  const loaded = await page.evaluate(() => Boolean((window as unknown as { axe?: unknown }).axe));
  if (!loaded) await page.addScriptTag({ path: AXE_PATH });
  const violations = (await page.evaluate(async (sel) => {
    const a = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: unknown[] }> } }).axe;
    const ctx = sel ? { include: [sel] } : document;
    const r = await a.run(ctx, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] }, resultTypes: ["violations"] });
    return r.violations;
  }, include ?? null)) as AxeViolation[];
  const file = join(OUT, "axe", info.project.name, `${name}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(violations, null, 2));
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const known = (v: AxeViolation) => KNOWN_A11Y.find((k) => k.rule === v.id);
  for (const v of serious.filter(known)) {
    info.annotations.push({ type: `axe known ${known(v)!.defect}`, description: `${name}: ${v.id} → ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}` });
  }
  const bad = strict ? serious : serious.filter((v) => !known(v));
  const summary = bad.map((v) => `${v.impact} ${v.id}: ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
  expect.soft(summary, `axe serious/critical on ${name}`).toEqual([]);
  return violations;
}

/** Hebrew / RTL basics on any app screen. */
export async function expectRtl(page: Page) {
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
}

/** No horizontal page scroll (mobile / tablet layouts). */
export async function expectNoHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, `page scrollWidth ${sw} > viewport ${cw}`).toBeLessThanOrEqual(cw + 1);
}

/** Review workspace ready: the drawing canvas is mounted and the queue has an active item. */
export async function waitForWorkspace(page: Page) {
  await expect(page.getByRole("application").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("[data-queue-item] article[data-active]").first()).toBeVisible({ timeout: 60_000 });
}

export const NOAH = "p-noah";

/** True when the mock runs on the real Noah worker artifacts (see playwright.config.ts → E2E_DATA). */
export const NOAH_DATA = process.env.E2E_DATA === "noah";
/** Skip a spec that asserts on the Noah set (15 sheets, Worker-BOQ lines like 4.01) when only the fixture is available. */
export const needsNoah = () => test.skip(!NOAH_DATA, "needs the Noah dev artifacts (KAMUTAN_DEV_ARTIFACTS/dev-index.json)");
