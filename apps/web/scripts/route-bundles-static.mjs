#!/usr/bin/env node
/**
 * Sprint 8 — JS a route needs on a cold load, from a build's manifest (`vite build --manifest`), any mode:
 * entry chunk + its static imports, plus the route module's chunk + its static imports (lazy `import()`s that only
 * run later — e.g. the drawing viewer inside the review page — are NOT counted, they load when used).
 *
 *   node scripts/route-bundles-static.mjs <distDir> [label]
 */
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const dist = process.argv[2];
const label = process.argv[3] ?? dist;
const man = JSON.parse(readFileSync(join(dist, ".vite/manifest.json"), "utf8"));
const size = new Map();
const bytes = (file) => {
  if (!size.has(file)) {
    const b = readFileSync(join(dist, file));
    size.set(file, { raw: b.length, gz: gzipSync(b, { level: 9 }).length });
  }
  return size.get(file);
};
function closure(key, seen = new Set()) {
  const c = man[key];
  if (!c || seen.has(c.file)) return seen;
  seen.add(c.file);
  for (const i of c.imports ?? []) closure(i, seen);
  return seen;
}
const ROUTES = [
  ["landing", "src/features/landing/LandingPage.tsx"],
  ["projects", "src/features/projects/ProjectsPage.tsx"],
  ["hub", "src/features/projects/ProjectPage.tsx"],
  ["library", "src/features/library/LibraryPage.tsx"],
  ["compare", "src/features/compare/ComparePage.tsx"],
  ["preview", "src/features/boq/BoqPreviewPage.tsx"],
  ["review", "src/features/review/ReviewPage.tsx"],
];
const entry = closure("index.html");
const kb = (n) => (n / 1024).toFixed(1);
console.log(`### ${label}`);
console.log("| route | JS files | raw kB | gzip kB | deck.gl (DrawingViewer) | review workspace |");
console.log("| --- | ---: | ---: | ---: | --- | --- |");
for (const [name, src] of ROUTES) {
  const files = new Set(entry);
  if (man[src]) closure(src, files);
  const list = [...files].filter((f) => f.endsWith(".js"));
  const raw = list.reduce((s, f) => s + bytes(f).raw, 0);
  const gz = list.reduce((s, f) => s + bytes(f).gz, 0);
  const has = (re) => (list.some((f) => re.test(f)) ? "yes" : "no");
  console.log(`| ${name} | ${list.length} | ${kb(raw)} | ${kb(gz)} | ${has(/DrawingViewer-/)} | ${has(/ReviewPage-/)} |`);
}
