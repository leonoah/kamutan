import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** WCAG 2.1 contrast checks on the design tokens themselves (jsdom can't run axe color-contrast). */
const css = readFileSync(resolve(__dirname, "tokens.css"), "utf8");

function block(selector: RegExp): Record<string, [number, number, number]> {
  const m = css.match(selector);
  if (!m) throw new Error(`block not found: ${selector}`);
  const out: Record<string, [number, number, number]> = {};
  for (const [, name, r, g, b] of m[1]!.matchAll(/--([\w-]+):\s*(\d+)\s+(\d+)\s+(\d+);/g)) {
    out[name!] = [Number(r), Number(g), Number(b)];
  }
  return out;
}

const lum = ([r, g, b]: [number, number, number]) => {
  const c = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: [number, number, number], b: [number, number, number]) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const light = block(/^:root \{([\s\S]*?)\n\}/m);
const dark = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);

describe.each([
  ["light", light],
  ["dark", dark],
])("%s tokens", (_name, t) => {
  it("text tokens reach 4.5:1 on background and surface", () => {
    for (const fg of ["foreground", "muted-foreground"]) {
      for (const bg of ["background", "surface", "surface-sunken"]) {
        expect(ratio(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(ratio(t["primary-foreground"]!, t.primary!)).toBeGreaterThanOrEqual(4.5);
  });

  it("confidence / state colors reach 3:1 as graphics on surface (WCAG 1.4.11)", () => {
    for (const c of ["conf-high", "conf-mid", "conf-low", "conf-unknown", "manual", "state-demolish", "destructive"]) {
      expect(ratio(t[c]!, t.surface!), c).toBeGreaterThanOrEqual(3);
    }
  });

  it("colors used as small text (primary links, destructive errors) reach 4.5:1", () => {
    for (const c of ["primary", "destructive", "conf-high"]) {
      expect(ratio(t[c]!, t.surface!), c).toBeGreaterThanOrEqual(4.5);
    }
  });
});

it("dark tokens are duplicated identically for prefers-color-scheme and [data-theme=dark]", () => {
  const media = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  expect(media).toEqual(dark);
});
