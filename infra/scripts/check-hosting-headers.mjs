#!/usr/bin/env node
// Static regression check for firebase.json `hosting.headers` (SEC-40, SEC-29, SEC-21).
// Resolves the headers Firebase Hosting would send for representative paths (glob `source` or RE2
// `regex`, matched against the request path) and asserts the security invariants:
//   * no header key is set by two matching blocks (Hosting's precedence for duplicates is undocumented);
//   * enforced CSP on every app path (incl. /assets/** — an unknown asset URL falls back to index.html),
//     with frame-ancestors 'none', object-src 'none', no 'unsafe-eval', no inline script;
//   * /s/** (share viewer): strict CSP (connect-src 'self' only), Referrer-Policy no-referrer,
//     X-Robots-Tag noindex, Cache-Control no-store;
//   * HSTS >= 1 year with includeSubDomains, nosniff and Permissions-Policy everywhere;
//   * Firebase reserved paths /__/** get no CSP / X-Frame-Options (the auth iframe must stay frameable);
//   * source maps are not deployed.
// Usage: node infra/scripts/check-hosting-headers.mjs [firebase.json]
import fs from "node:fs";

const file = process.argv[2] ?? "firebase.json";
const hosting = JSON.parse(fs.readFileSync(file, "utf8")).hosting;
const blocks = hosting.headers ?? [];

const globRe = (g) =>
  new RegExp(
    "^" +
      g
        .replace(/[.+^$|\\()[\]{}]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, ".*") +
      "$",
  );

const errors = [];
function resolve(path) {
  const out = {};
  for (const b of blocks) {
    const hit = b.regex ? new RegExp(b.regex, "u").test(path) : globRe(b.source ?? b.glob).test(path);
    if (!hit) continue;
    for (const { key, value } of b.headers) {
      const k = key.toLowerCase();
      if (k in out) errors.push(`${path}: header ${key} set by more than one block`);
      out[k] = value;
    }
  }
  return out;
}
const directives = (csp) =>
  Object.fromEntries(
    (csp ?? "")
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...v] = d.split(/\s+/);
        return [name, v];
      }),
  );
const expect = (cond, msg) => cond || errors.push(msg);

const appPaths = ["/", "/login", "/projects", "/projects/p1/review", "/index.html", "/favicon.svg", "/assets/index-abc.js", "/assets/missing.js", "/s", "/apix", "/library"];
const sharePaths = ["/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "/s/x/y"];
const allPaths = [...appPaths, ...sharePaths, "/api/v1/health", "/__/auth/handler"];

for (const p of allPaths) {
  const h = resolve(p);
  const hsts = h["strict-transport-security"] ?? "";
  const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
  expect(maxAge >= 31536000 && /includeSubDomains/i.test(hsts), `${p}: HSTS must be >= 1 year with includeSubDomains (got "${hsts}")`);
  expect(h["x-content-type-options"] === "nosniff", `${p}: X-Content-Type-Options nosniff missing`);
  const pp = h["permissions-policy"] ?? "";
  for (const f of ["camera", "microphone", "geolocation", "payment", "usb"])
    expect(new RegExp(`(^|,\\s*)${f}=\\(\\)`).test(pp), `${p}: Permissions-Policy must disable ${f}`);
}

for (const p of [...appPaths, ...sharePaths]) {
  const h = resolve(p);
  const csp = directives(h["content-security-policy"]);
  expect(h["content-security-policy"], `${p}: enforced Content-Security-Policy missing`);
  expect(csp["frame-ancestors"]?.join(" ") === "'none'", `${p}: frame-ancestors must be 'none'`);
  expect(csp["object-src"]?.join(" ") === "'none'", `${p}: object-src must be 'none'`);
  expect(csp["base-uri"] && !csp["base-uri"].includes("*"), `${p}: base-uri must be restricted`);
  const script = csp["script-src"] ?? csp["default-src"] ?? [];
  expect(!script.some((s) => ["'unsafe-inline'", "'unsafe-eval'", "*", "https:", "http:", "data:"].includes(s)), `${p}: script-src too broad (${script.join(" ")})`);
  expect(!Object.values(csp).flat().includes("'unsafe-eval'"), `${p}: 'unsafe-eval' is not allowed anywhere`);
  expect(h["x-frame-options"] === "DENY", `${p}: X-Frame-Options DENY missing`);
}
for (const p of appPaths) expect(resolve(p)["referrer-policy"] === "strict-origin-when-cross-origin", `${p}: Referrer-Policy must be strict-origin-when-cross-origin`);

for (const p of sharePaths) {
  const h = resolve(p);
  const csp = directives(h["content-security-policy"]);
  expect(h["referrer-policy"] === "no-referrer", `${p}: Referrer-Policy must be no-referrer`);
  expect(/noindex/.test(h["x-robots-tag"] ?? "") && /nofollow/.test(h["x-robots-tag"] ?? ""), `${p}: X-Robots-Tag noindex, nofollow missing`);
  expect(/no-store/.test(h["cache-control"] ?? ""), `${p}: Cache-Control no-store missing`);
  expect(csp["connect-src"]?.join(" ") === "'self'", `${p}: share viewer connect-src must be 'self' only`);
  expect(csp["frame-src"]?.join(" ") === "'none'", `${p}: share viewer frame-src must be 'none'`);
}

const reserved = resolve("/__/auth/handler");
expect(!reserved["content-security-policy"] && !reserved["x-frame-options"], "/__/**: must not get the app CSP / X-Frame-Options (Firebase auth iframe)");
const api = resolve("/api/v1/health");
expect(/no-store/.test(api["cache-control"] ?? ""), "/api/**: Cache-Control no-store missing");
expect((hosting.ignore ?? []).includes("**/*.map"), "hosting.ignore must contain **/*.map (no public source maps)");

const unique = [...new Set(errors)];
if (unique.length) {
  console.error(`hosting headers: ${unique.length} problem(s)`);
  for (const e of unique) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`hosting headers OK (${allPaths.length} paths, ${blocks.length} header blocks)`);
