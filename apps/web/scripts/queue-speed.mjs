#!/usr/bin/env node
/**
 * Queue-speed protocol (Sprint 4, docs/agents/SPRINT4_BRIEF.md: "100 queue items in < 5 minutes").
 *
 * Drives N review-queue actions BY KEYBOARD (A accept · R reject · N next · P previous) in mock mode and measures
 * the UI latency of each action: keydown → the next painted frame after React committed the new queue state
 * (recorded in-page by ReviewPage into `window.__kamutanQueue.latencies`, mock/dev builds only). Target: median
 * < 100 ms per action, so the human budget (≈3 s per item, ≈5 s per cluster card) — not the UI — bounds the speed.
 *
 * Usage:
 *   node apps/web/scripts/queue-speed.mjs [--url http://localhost:5173] [--start] [--actions 100]
 *        [--sheet noah-c054fd3a-p0] [--chromium /path/to/chrome] [--json out.json] [--headed]
 *   --start      start `vite` (VITE_USE_MOCKS=true) on a free port for the run and stop it afterwards
 *   --prod       with --start: measure a PRODUCTION build in mock mode (`vite build` to a temp dir + `vite preview`)
 *                instead of the dev server (React development build is several times slower)
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright  when playwright is not resolvable from here
 * Exit code 1 when the median UI latency is ≥ the target (--target-ms, default 100).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);
const ACTIONS = Number(opt("actions", "100"));
const TARGET_MS = Number(opt("target-ms", "100"));
const SHEET = opt("sheet", "noah-c054fd3a-p0");
const CHROMIUM = opt("chromium", process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome");
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright", "playwright-core"].filter(Boolean);
  const req = createRequire(import.meta.url);
  for (const c of candidates) {
    try {
      return await import(c.startsWith("/") ? c + "/index.mjs" : c).catch(() => req(c));
    } catch {
      /* next */
    }
  }
  throw new Error("playwright not found — set PLAYWRIGHT_MODULE=/path/to/node_modules/playwright");
}

const freePort = () =>
  new Promise((res) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });

const run = (cmd, argv, env) =>
  new Promise((res, rej) => {
    const c = spawn(cmd, argv, { cwd: webDir, env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
    c.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} ${argv.join(" ")} exited ${code}`))));
  });

async function startVite(prod) {
  const port = await freePort();
  let argv = ["vite", "--port", String(port), "--strictPort"];
  if (prod) {
    const out = mkdtempSync(join(tmpdir(), "kamutan-speed-"));
    await run("npx", ["vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "warn"], { VITE_USE_MOCKS: "true" });
    argv = ["vite", "preview", "--outDir", out, "--port", String(port), "--strictPort"];
  }
  const child = spawn("npx", argv, {
    cwd: webDir,
    env: { ...process.env, VITE_USE_MOCKS: "true" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group → npx AND vite stop together
  });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("vite did not start in 60 s")), 60_000);
    child.stdout.on("data", (b) => {
      // eslint-disable-next-line no-control-regex
      if (/ready in|Local:|localhost:\d+/.test(String(b).replace(/\x1b\[[0-9;]*m/g, ""))) {
        clearTimeout(t);
        res();
      }
    });
    child.on("exit", (c) => rej(new Error(`vite exited (${c})`)));
  });
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  return { url: `http://localhost:${port}`, stop };
}

const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const r1 = (n) => Math.round(n * 10) / 10;

const main = async () => {
  const server = flag("start") ? await startVite(flag("prod")) : null;
  const base = server?.url ?? opt("url", "http://localhost:5173");
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: !flag("headed"),
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "he-IL" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    // Mock sign-in (any email + a ≥ 10-char password), then the review workspace with a built BOQ.
    await page.goto(`${base}/login`);
    await page.fill("input[type=email]", "speed@example.com");
    await page.locator("input[type=password]").first().fill("speed-test-123");
    await page.locator("form button[type=submit]").first().click();
    await page.waitForURL("**/projects", { timeout: 30_000 });
    await page.goto(`${base}/projects/p-noah/review?mockBoq=built&sheet=${SHEET}`);
    await page.waitForSelector("[data-queue-item] article[data-active]", { timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.__kamutanQueue), null, { timeout: 10_000 });
    await page.waitForTimeout(3000); // tiles + overlay settle (first paint is not part of the protocol)
    await page.evaluate(() => {
      window.__kamutanQueue.latencies = [];
      window.__kamutanQueue.actions = 0;
    });
    const remaining0 = await page.evaluate(() => window.__kamutanQueue.remaining());
    const state = () =>
      page.evaluate(() => ({
        active: document.querySelector("[data-queue-item] article[data-active]")?.parentElement?.getAttribute("data-queue-item") ?? null,
        n: window.__kamutanQueue.remaining(),
      }));

    // A realistic mix: mostly accept, some reject, some navigation (keys by physical code → layout-independent).
    const PATTERN = ["KeyA", "KeyA", "KeyN", "KeyR", "KeyA", "KeyP", "KeyA", "KeyA", "KeyR", "KeyN"];
    const perAction = [];
    const t0 = Date.now();
    let done = 0;
    for (let i = 0; i < ACTIONS; i++) {
      const before = await state();
      if (!before.active || before.n === 0) break;
      const key = PATTERN[i % PATTERN.length];
      const ts = Date.now();
      await page.keyboard.press(key);
      // Script-side: until the active item / remaining count changed in the DOM.
      await page
        .waitForFunction(
          (b) => {
            const a = document.querySelector("[data-queue-item] article[data-active]")?.parentElement?.getAttribute("data-queue-item") ?? null;
            return a !== b.active || window.__kamutanQueue.remaining() !== b.n;
          },
          before,
          { timeout: 5000, polling: "raf" },
        )
        .catch(() => null);
      perAction.push({ key, ms: Date.now() - ts });
      done++;
    }
    const totalMs = Date.now() - t0;
    await page.waitForTimeout(300);
    const ui = await page.evaluate(() => window.__kamutanQueue.latencies.slice());
    const remaining1 = await page.evaluate(() => window.__kamutanQueue.remaining());
    // Undo the last 3 steps (Z) — correctness check of the history, not timed.
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("KeyZ");
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1200);
    const afterUndo = await page.evaluate(() => window.__kamutanQueue.remaining());

    const report = {
      url: base,
      build: flag("prod") ? "production (mock mode)" : "as served",
      sheet: SHEET,
      actions: done,
      queueBefore: remaining0,
      queueAfter: remaining1,
      queueAfterUndo3: afterUndo,
      uiLatencyMs: { samples: ui.length, median: r1(pct(ui, 50)), p95: r1(pct(ui, 95)), max: r1(Math.max(...ui)) },
      scriptRoundTripMs: {
        median: r1(
          pct(
            perAction.map((a) => a.ms),
            50,
          ),
        ),
        p95: r1(
          pct(
            perAction.map((a) => a.ms),
            95,
          ),
        ),
      },
      totalMs,
      perActionAvgMs: r1(totalMs / Math.max(1, done)),
      humanBudget: { secondsPerItem: 3, secondsPerCluster: 5, target: "100 items < 300 s" },
      targetMs: TARGET_MS,
      pass: pct(ui, 50) < TARGET_MS,
      pageErrors: errors.slice(0, 5),
    };
    const out = opt("json", null);
    if (out) writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    console.log(
      `\n${done} keyboard actions in ${(totalMs / 1000).toFixed(1)} s (script incl. automation overhead) · UI latency median ${report.uiLatencyMs.median} ms, p95 ${report.uiLatencyMs.p95} ms, max ${report.uiLatencyMs.max} ms → ${report.pass ? "PASS" : "FAIL"} (target < ${TARGET_MS} ms)`,
    );
    process.exitCode = report.pass ? 0 : 1;
  } finally {
    server?.stop();
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]);
  }
};

// Exit explicitly: the browser / preview server must not keep the event loop alive.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
