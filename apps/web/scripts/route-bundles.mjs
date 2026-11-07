#!/usr/bin/env node
/**
 * Sprint 8 — JS loaded per route (code-splitting report).
 *
 *   node scripts/route-bundles.mjs [distDir] [port]
 *
 * Serves a MOCK-mode production build (`VITE_USE_MOCKS=true vite build --outDir <distDir>`) with `vite preview`, signs in
 * through the mock login and opens each route in a fresh page. Every JS response (same origin, /assets/) is recorded:
 * raw bytes and gzip bytes (zlib level 9, like the Vite report). Prints a Markdown table and whether the deck.gl
 * drawing chunk (`DrawingViewer-*.js`) or the review workspace (`ReviewPage-*.js`) was requested.
 * Browser: the preinstalled Chromium (PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers).
 */
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= "/opt/pw-browsers";
const { chromium } = await import("@playwright/test");

const dist = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 4399);
const base = `http://localhost:${port}`;

const ROUTES = [
  ["landing", "/", null],
  ["login", "/login", null],
  ["projects", "/projects", "auth"],
  ["hub", "/projects/p-noah?mockBoq=built", "auth"],
  ["library", "/library", "auth"],
  ["compare", "/projects/p-noah/boq/compare?mockBoq=built", "auth"],
  ["preview", "/projects/p-noah/boq/preview?mockBoq=built", "auth"],
  ["review", "/projects/p-noah/review?mockBoq=built", "auth"],
];

// vite directly (not through npx: killing npx would leave the preview server running on the port)
const server = spawn(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "preview", "--outDir", dist, "--port", String(port), "--strictPort"], { stdio: "ignore" });
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/login`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const rows = [];
  for (const [name, path, auth] of ROUTES) {
    const ctx = await browser.newContext({ locale: "he-IL" });
    const page = await ctx.newPage();
    if (auth) {
      await page.goto(`${base}/login`);
      await page.getByLabel("אימייל").fill("bundle@example.com");
      await page.getByLabel("סיסמה", { exact: true }).fill("bundle-1234567");
      await page.getByRole("button", { name: "כניסה", exact: true }).click();
      await page.waitForURL(/\/projects$/);
    }
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    const seen = new Map();
    page.on("response", async (r) => {
      const u = new URL(r.url());
      if (u.origin !== base || !u.pathname.startsWith("/assets/") || !u.pathname.endsWith(".js")) return;
      try {
        const body = await r.body();
        seen.set(u.pathname.slice(8), { raw: body.length, gz: gzipSync(body, { level: 9 }).length });
      } catch {
        /* navigation raced the body */
      }
    });
    // A full navigation counts everything the route needs from a cold start (the shell included).
    await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
    await sleep(1500);
    const files = [...seen.entries()];
    const sum = (k) => files.reduce((s, [, v]) => s + v[k], 0);
    rows.push({
      name,
      path,
      n: files.length,
      raw: sum("raw"),
      gz: sum("gz"),
      deck: files.some(([f]) => /^DrawingViewer-/.test(f)),
      review: files.some(([f]) => /^ReviewPage-/.test(f)),
      firebase: files.some(([f]) => /^firebase-/.test(f)),
      biggest: files.sort((a, b) => b[1].raw - a[1].raw).slice(0, 3).map(([f, v]) => `${f.replace(/-[\w-]{8}\.js$/, "")} ${(v.raw / 1024).toFixed(0)}`),
    });
    await ctx.close();
  }
  await browser.close();
  const kb = (b) => (b / 1024).toFixed(1);
  console.log("| route | JS files | raw kB | gzip kB | deck.gl chunk | review chunk | firebase | biggest (kB raw) |");
  console.log("| --- | ---: | ---: | ---: | --- | --- | --- | --- |");
  for (const r of rows) {
    console.log(`| ${r.name} \`${r.path.split("?")[0]}\` | ${r.n} | ${kb(r.raw)} | ${kb(r.gz)} | ${r.deck ? "yes" : "no"} | ${r.review ? "yes" : "no"} | ${r.firebase ? "yes" : "no"} | ${r.biggest.join(", ")} |`);
  }
} finally {
  server.kill();
}
