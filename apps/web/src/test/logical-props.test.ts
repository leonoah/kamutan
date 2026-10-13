import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Spec 05_ux §כללי RTL: only logical Tailwind utilities (ms/me/ps/pe/start/end/text-start).
 * Physical ml-/mr-/pl-/pr-/left-/right-/text-left/text-right are allowed only inside the canvas (LTR).
 * Stand-in for the lint rule until an ESLint config lands.
 */
const SRC = resolve(__dirname, "..");
const ALLOWED = new Set(["features/viewer/SheetViewer.tsx"]);
const PHYSICAL =
  /(?<![\w-])-?(ml|mr|pl|pr|left|right|rounded-l|rounded-r|border-l|border-r|text-left|text-right)-[\w[\]./]+/g;
const PHYSICAL_BARE = /(?<![\w-])(text-left|text-right)(?![\w-])/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".tsx") && !p.endsWith(".test.tsx") ? [p] : [];
  });
}

it("uses only logical (RTL-safe) spacing/position utilities outside the drawing canvas", () => {
  const offenders: string[] = [];
  const files = walk(SRC);
  expect(files.length).toBeGreaterThan(10);
  for (const file of files) {
    const rel = relative(SRC, file).replaceAll("\\", "/");
    if (ALLOWED.has(rel)) continue;
    // Scan string literals (className values, cva/cn arguments).
    for (const lit of readFileSync(file, "utf8").matchAll(/"([^"\n]*)"/g)) {
      const text = lit[1] ?? "";
      for (const hit of text.matchAll(PHYSICAL)) offenders.push(`${rel}: ${hit[0]}`);
      for (const hit of text.matchAll(PHYSICAL_BARE)) offenders.push(`${rel}: ${hit[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});
