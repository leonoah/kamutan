/**
 * Stage 10 UI acceptance suite (Playwright) — runs the web app in MOCK mode.
 *
 *   pnpm --filter @kamutan/web test:e2e                 # build a mock bundle + vite preview, run all projects
 *   E2E_BASE_URL=http://localhost:5173 pnpm … test:e2e  # reuse a running server (dev or preview), no build
 *
 * Data: `vite preview` serves /dev-artifacts from KAMUTAN_DEV_ARTIFACTS (default /home/claude/kamutan-data/artifacts),
 * so locally the mock runs on the REAL Noah worker artifacts. When that directory is absent (CI) the mock falls back to
 * its deterministic synthetic fixture; the specs are written to pass on both.
 *
 * Output (screenshots, traces, reports) can contain customer drawings, so it goes OUTSIDE git:
 * E2E_OUT (default /home/claude/kamutan-data/acceptance/ui when it exists, else node_modules/.cache/kamutan-e2e/out).
 *
 * Browser: the preinstalled Chromium 1194 (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers) — never `playwright install`.
 * @playwright/test is pinned to 1.56.1, the release that ships Chromium 1194.
 */
import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/opt/pw-browsers";

const DATA_ROOT = "/home/claude/kamutan-data/acceptance/ui";
export const OUT = process.env.E2E_OUT ?? (existsSync(DATA_ROOT) ? DATA_ROOT : resolve(HERE, "node_modules/.cache/kamutan-e2e/out"));
process.env.E2E_OUT = OUT;

// Data mode: "noah" when the real worker artifacts are mounted (dev-index.json), else "fixture" (CI without customer
// data). Specs that assert on the Noah set skip themselves in fixture mode (support.ts → needsNoah()).
const ARTIFACTS = process.env.KAMUTAN_DEV_ARTIFACTS ?? "/home/claude/kamutan-data/artifacts";
process.env.E2E_DATA ??= existsSync(`${ARTIFACTS}/dev-index.json`) ? "noah" : "fixture";

const PORT = Number(process.env.E2E_PORT ?? 4317);
const external = process.env.E2E_BASE_URL;
const baseURL = external ?? `http://localhost:${PORT}`;
const DIST = "node_modules/.cache/kamutan-e2e/dist";

const launchOptions = {
  // Software WebGL for deck.gl (no GPU on CI / sandbox); explicit flag avoids Chromium's deprecation fallback.
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/, // not *.spec.ts: vitest would pick those up
  outputDir: `${OUT}/test-results`,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 2,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: `${OUT}/report`, open: "never" }],
    ["json", { outputFile: `${OUT}/results.json` }],
  ],
  use: {
    baseURL,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    launchOptions,
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, launchOptions },
      grepInvert: /@(ipad|mobile)-only/,
    },
    {
      // iPad Safari is "view and approve only" (07_test_plan: E2E-06, E2E-09). Chromium with the iPad viewport + touch.
      name: "ipad",
      use: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, hasTouch: true, isMobile: false, launchOptions },
      grep: /@ipad/,
    },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, launchOptions },
      grep: /@mobile/,
    },
  ],
  webServer: external
    ? undefined
    : {
        // Production bundle in mock mode (fast, like the speed protocol) + vite preview (also serves /dev-artifacts).
        command: `vite build --outDir ${DIST} --emptyOutDir --logLevel warn && vite preview --outDir ${DIST} --port ${PORT} --strictPort`,
        url: `${baseURL}/login`,
        env: { VITE_USE_MOCKS: "true" },
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
