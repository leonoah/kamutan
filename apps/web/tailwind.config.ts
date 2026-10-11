import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/** Colors are stored as space-separated RGB channels in CSS variables (see src/styles/tokens.css)
 *  so Tailwind opacity modifiers work: bg-primary/10, ring-conf-low/40 … */
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.5rem", screens: { "2xl": "1280px" } },
    extend: {
      colors: {
        background: token("background"),
        surface: token("surface"),
        "surface-sunken": token("surface-sunken"),
        canvas: token("canvas-bg"),
        foreground: token("foreground"),
        muted: { DEFAULT: token("muted"), foreground: token("muted-foreground") },
        border: token("border"),
        input: token("border-strong"),
        ring: token("primary"),
        primary: { DEFAULT: token("primary"), foreground: token("primary-foreground") },
        destructive: { DEFAULT: token("destructive"), foreground: token("primary-foreground") },
        highlight: "var(--highlight)",
        conf: {
          high: token("conf-high"),
          mid: token("conf-mid"),
          low: token("conf-low"),
          unknown: token("conf-unknown"),
        },
        manual: token("manual"),
        state: { existing: token("state-existing"), demolish: token("state-demolish") },
      },
      fontFamily: {
        sans: ["Heebo", "Assistant", "Arial Hebrew", "Noto Sans Hebrew", "Segoe UI", "Arial", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        meta: ["12px", { lineHeight: "1.5" }],
        dense: ["13px", { lineHeight: "1.3" }],
        body: ["14px", { lineHeight: "1.5" }],
        panel: ["16px", { lineHeight: "1.4", fontWeight: "500" }],
        screen: ["20px", { lineHeight: "1.3", fontWeight: "700" }],
        hero: ["28px", { lineHeight: "1.2", fontWeight: "700" }],
      },
      borderRadius: { sm: "4px", DEFAULT: "8px", md: "8px", lg: "12px" },
      boxShadow: {
        float: "0 1px 2px rgb(0 0 0 / 0.04), 0 8px 24px -6px rgb(0 0 0 / 0.14)",
      },
      transitionDuration: { DEFAULT: "150ms" },
      transitionTimingFunction: { DEFAULT: "cubic-bezier(0, 0, 0.2, 1)" },
    },
  },
  plugins: [animate],
} satisfies Config;
