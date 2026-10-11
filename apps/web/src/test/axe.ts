import { configureAxe } from "vitest-axe";

/**
 * jsdom has no layout/canvas, so axe's color-contrast rule cannot run here.
 * Contrast is enforced instead by src/styles/tokens.test.ts (WCAG ratios computed from the tokens)
 * and by axe-core in Playwright against real rendering (07_test_plan §נגישות).
 */
export const axe = configureAxe({
  rules: { "color-contrast": { enabled: false } },
});
