#!/usr/bin/env node
// CSP / security-header verification for the built web app (SEC-40).
//
// Serves a Vite build over HTTPS with the *exact* `hosting.headers` + rewrites from firebase.json
// (same matching rules as Firebase Hosting / superstatic: glob `source` or RE2 `regex` on the request
// path; later matches win on duplicate keys), drives Chromium through the main routes and fails when
// the browser reports an enforced CSP violation. Report-Only violations are listed (they belong to the
// stricter candidate policy) but do not fail the run unless --strict-report-only is given.
//
// External hosts are never contacted: requests that pass CSP but leave localhost are aborted by the
// test (CSP is evaluated before the request reaches the network layer, so violations still fire).
//
// Usage:
//   node infra/scripts/csp-verify.mjs --dist apps/web/dist [--mock] [--firebase-json firebase.json]
//        [--report out.json] [--strict-report-only] [--share-token <t>]
// Needs `playwright` (or `playwright-core`) resolvable (NODE_PATH works) and Chromium
// (PLAYWRIGHT_BROWSERS_PATH, e.g. /opt/pw-browsers, or `npx playwright install chromium`).
// `openssl` is used to mint a throwaway self-signed certificate (HTTPS keeps
// upgrade-insecure-requests and HSTS semantics realistic).

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, def = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const dist = path.resolve(opt("dist", "apps/web/dist"));
const firebaseJson = path.resolve(opt("firebase-json", "firebase.json"));
const mock = flag("mock");
const strictRO = flag("strict-report-only");
const reportPath = opt("report");
const shareToken = opt("share-token", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error(`no index.html in ${dist} — build the web app first`);
  process.exit(2);
}
const hosting = JSON.parse(fs.readFileSync(firebaseJson, "utf8")).hosting;

// ---------------------------------------------------------------- Firebase Hosting header semantics
function globToRegExp(glob) {
  if (/[?[\]{}()!@+]/.test(glob)) throw new Error(`unsupported glob in harness: ${glob}`);
  let g = glob.startsWith("/") || glob.startsWith("**") ? glob : `/${glob}`;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.^$|\\/-]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const headerRules = (hosting.headers ?? []).map((h) => ({
  test: h.regex ? new RegExp(h.regex, "u") : globToRegExp(h.source ?? h.glob),
  headers: h.headers,
  label: h.regex ? `regex:${h.regex.slice(0, 24)}…` : h.source,
}));
// Mock builds serve worker artifacts as `data:` URLs that are read with fetch() (apps/web/src/api/mock*.ts).
// Production reads signed Storage URLs instead, so `data:` is added to connect-src for --mock runs ONLY.
const mockConnectData = (v) => v.replace(/(^|;\s*)connect-src ([^;]*)/, (_m, p, list) => `${p}connect-src ${list} data:`);
function headersFor(pathname) {
  const out = {};
  for (const r of headerRules) if (r.test.test(pathname)) for (const h of r.headers) out[h.key.toLowerCase()] = h.value;
  if (mock)
    for (const k of ["content-security-policy", "content-security-policy-report-only"])
      if (out[k]) out[k] = mockConnectData(out[k]);
  return out;
}
const rewrites = (hosting.rewrites ?? []).map((r) => ({ test: globToRegExp(r.source), r }));

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".png": "image/png",
  ".map": "application/json",
};

// ---------------------------------------------------------------- HTTPS server
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csp-verify-"));
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
  "-keyout", path.join(tmp, "k.pem"), "-out", path.join(tmp, "c.pem"),
], { stdio: "ignore" });

// hosting.ignore: files that are never uploaded (e.g. "**/*.map") must not be served either.
const ignored = (hosting.ignore ?? []).flatMap((g) => {
  try {
    return [globToRegExp(g)];
  } catch {
    return [];
  }
});

const server = https.createServer(
  { key: fs.readFileSync(path.join(tmp, "k.pem")), cert: fs.readFileSync(path.join(tmp, "c.pem")) },
  (req, res) => {
    const url = new URL(req.url, "https://localhost");
    const pathname = decodeURIComponent(url.pathname);
    for (const [k, v] of Object.entries(headersFor(pathname))) res.setHeader(k, v);
    let file = path.join(dist, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
    const isIgnored = ignored.some((re) => re.test(pathname));
    if (!isIgnored && fs.existsSync(file) && fs.statSync(file).isFile()) return send(res, file);
    for (const { test, r } of rewrites) {
      if (!test.test(pathname)) continue;
      if (r.function) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        return res.end('{"error":{"code":"not_found","message":"api not served by csp-verify"}}');
      }
      if (r.destination) return send(res, path.join(dist, r.destination));
    }
    res.statusCode = 404;
    res.end("not found");
  },
);
function send(res, file) {
  res.setHeader("content-type", mime[path.extname(file)] ?? "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `https://localhost:${server.address().port}`;

// ---------------------------------------------------------------- Browser
const require = createRequire(import.meta.url);
let pw;
for (const name of ["playwright", "playwright-core"]) {
  try {
    pw = require(require.resolve(name, { paths: [process.cwd(), ...(process.env.NODE_PATH ?? "").split(":")] }));
    break;
  } catch {
    /* try next */
  }
}
if (!pw) {
  console.error("playwright not found (set NODE_PATH to a node_modules containing playwright)");
  process.exit(2);
}
const browser = await pw.chromium.launch({ args: ["--no-proxy-server"] });
const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "he-IL" });
await context.addInitScript(() => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__csp.push({
      disposition: e.disposition,
      directive: e.effectiveDirective,
      blocked: e.blockedURI,
      source: e.sourceFile ? `${e.sourceFile}:${e.lineNumber}` : null,
      sample: e.sample || null,
    });
  });
});
const external = new Set();
await context.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (u.hostname === "localhost" || u.protocol === "data:" || u.protocol === "blob:") return route.continue();
  external.add(`${u.protocol}//${u.host}`);
  return route.abort("blockedbyclient");
});

const page = await context.newPage();
const consoleCsp = [];
const pageErrors = [];
page.on("console", (m) => {
  const t = m.text();
  if (/Content Security Policy|Trusted Type/i.test(t)) consoleCsp.push(t.slice(0, 400));
});
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

const results = [];
const shotDir = opt("screenshots");
async function shot(name) {
  if (!shotDir) return;
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, `${mock ? "mock" : "real"}-${name}.png`) }).catch(() => {});
}
async function visit(name, url, action) {
  const resp = await page.goto(origin + url, { waitUntil: "load" });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  if (action) await action();
  await page.waitForTimeout(1200);
  const v = await page.evaluate(() => window.__csp.splice(0));
  const h = resp ? resp.headers() : {};
  results.push({
    step: name,
    url,
    finalPath: new URL(page.url()).pathname,
    status: resp?.status() ?? null,
    headers: {
      csp: h["content-security-policy"] ?? null,
      cspReportOnly: h["content-security-policy-report-only"] ?? null,
      hsts: h["strict-transport-security"] ?? null,
      referrerPolicy: h["referrer-policy"] ?? null,
      xRobotsTag: h["x-robots-tag"] ?? null,
      permissionsPolicy: h["permissions-policy"] ?? null,
      nosniff: h["x-content-type-options"] ?? null,
      cacheControl: h["cache-control"] ?? null,
    },
    violations: v,
    heading: await page.locator("h1, h2").first().textContent({ timeout: 2000 }).catch(() => null),
  });
}

const steps = [];
steps.push(["login page", "/login"]);
if (mock) {
  steps.push([
    "mock sign-in → projects",
    "/login",
    async () => {
      await page.getByLabel("אימייל").fill("dana@studio.co.il");
      await page.getByLabel("סיסמה").fill("correct-horse-battery");
      await page.getByRole("button", { name: "כניסה", exact: true }).click();
      await page.waitForURL("**/projects", { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
    },
  ]);
  steps.push(["project list", "/projects"]);
  steps.push([
    "dialog (Radix portal)",
    "/projects",
    async () => {
      // Radix dialogs inject <style> (react-remove-scroll) only while open: exercise style-src.
      await page.getByRole("button", { name: "פרויקט חדש" }).first().click({ timeout: 5000 });
      await page.waitForTimeout(800);
      await shot("dialog");
      await page.keyboard.press("Escape");
    },
  ]);
  steps.push(["project page", "/projects/p-noah"]);
  steps.push(["sheets", "/projects/p-noah/sheets"]);
  steps.push([
    "review workspace",
    "/projects/p-noah/review",
    async () => {
      await page.waitForTimeout(4000); // viewer tiles, overlays, workers
      await page.mouse.wheel(0, -400).catch(() => {});
      await page.waitForTimeout(1500);
      await shot("review");
    },
  ]);
  steps.push(["library", "/library"]);
  steps.push(["org settings", "/settings"]);
  steps.push(["audit log", "/settings/audit"]);
  steps.push(["offboarding", "/settings/offboarding"]);
  // Mock share links seeded by apps/web/src/api/mockSprint5.ts.
  steps.push(["share viewer (mock link)", "/s/demo-noah", async () => {
    await page.waitForTimeout(3000);
    await shot("share");
  }]);
  steps.push(["share viewer (expired)", "/s/demo-expired"]);
}
steps.push(["share viewer (unknown)", `/s/${shareToken}`]);
steps.push(["not found", "/definitely-not-a-route"]);

for (const [name, url, action] of steps) {
  try {
    await visit(name, url, action);
  } catch (e) {
    results.push({ step: name, url, error: String(e).slice(0, 300), violations: [] });
  }
}
await browser.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });

const enforced = results.flatMap((r) => r.violations.filter((v) => v.disposition === "enforce").map((v) => ({ step: r.step, ...v })));
const reportOnly = results.flatMap((r) => r.violations.filter((v) => v.disposition === "report").map((v) => ({ step: r.step, ...v })));
const summary = {
  mode: mock ? "mock" : "real",
  origin,
  steps: results,
  enforcedViolations: enforced,
  reportOnlyViolations: reportOnly,
  consoleCspMessages: [...new Set(consoleCsp)],
  pageErrors: [...new Set(pageErrors)],
  externalOriginsAttempted: [...external].sort(),
};
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2));

console.log(`CSP verify (${summary.mode}) against ${dist}`);
for (const r of results) {
  const e = r.violations.filter((v) => v.disposition === "enforce").length;
  const ro = r.violations.filter((v) => v.disposition === "report").length;
  console.log(
    `  ${r.error ? "ERR " : e ? "FAIL" : "ok  "} ${r.step.padEnd(24)} ${r.url.padEnd(28)} → ${String(r.finalPath ?? "").padEnd(24)}` +
      ` status=${r.status ?? "-"} enforced=${e} reportOnly=${ro}${r.error ? ` ${r.error}` : ""}`,
  );
}
for (const v of enforced) console.log(`  ENFORCED  [${v.step}] ${v.directive} blocked=${v.blocked} ${v.source ?? ""} ${v.sample ?? ""}`);
for (const v of reportOnly) console.log(`  REPORT-ONLY [${v.step}] ${v.directive} blocked=${v.blocked} ${v.source ?? ""} ${v.sample ?? ""}`);
if (summary.externalOriginsAttempted.length) console.log(`  external origins (allowed by CSP, aborted by harness): ${summary.externalOriginsAttempted.join(" ")}`);
if (summary.pageErrors.length) console.log(`  page errors: ${summary.pageErrors.join(" | ")}`);

const failed = enforced.length > 0 || results.some((r) => r.error) || (strictRO && reportOnly.length > 0);
process.exit(failed ? 1 : 0);
