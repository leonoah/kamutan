/// <reference types="vitest" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { devArtifacts } from "./build/devArtifacts";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  // Public Firebase web config lives in .env.firebase (committed by the orchestrator).
  // Precedence: real env vars > .env.local / .env.[mode] > .env.firebase.
  const firebaseEnv = loadEnv("firebase", root, "VITE_FIREBASE_");
  const modeEnv = loadEnv(mode, root, "VITE_");
  const define: Record<string, string> = {};
  if (mode !== "test") {
    for (const [k, v] of Object.entries(firebaseEnv)) {
      if (!(k in modeEnv) && process.env[k] === undefined) define[`import.meta.env.${k}`] = JSON.stringify(v);
    }
  }
  const apiTarget = modeEnv.VITE_API_URL || "http://localhost:3000";

  return {
    // devArtifacts(): dev-server only (apply: "serve") — never part of the production bundle.
    plugins: [react(), devArtifacts()],
    define,
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      port: 5173,
      // Same-origin API in dev, like the Firebase Hosting rewrite /api/** → function `api` in prod.
      proxy: { "/api": { target: apiTarget, changeOrigin: true } },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
      rollupOptions: {
        output: {
          // Vite 8 (Rolldown) takes a function only; same three vendor chunks as before.
          manualChunks(id: string) {
            const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(id);
            if (!m) return undefined;
            const pkg = m[1]!;
            if (pkg === "react" || pkg === "react-dom" || pkg === "react-router-dom" || pkg === "react-router" || pkg === "scheduler") return "react";
            // Sprint 8: only App + Auth are eager ("firebase"); Firestore / Storage / Analytics (+ their deps) are
            // dynamic imports (lib/firebase.ts, api/lazyBackend.ts) and keep their own chunks.
            if (["@firebase/firestore", "@firebase/webchannel-wrapper", "re2js", "@firebase/storage", "@firebase/analytics", "@firebase/installations"].includes(pkg)) return undefined;
            if (pkg === "firebase") return /\/(firestore|storage|analytics|installations)\//.test(id) ? undefined : "firebase";
            if (pkg.startsWith("@firebase/")) return "firebase";
            if (["@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-toast", "@radix-ui/react-progress"].includes(pkg)) return "radix";
            return undefined;
          },
        },
      },
    },
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      css: false,
      env: { VITE_USE_MOCKS: "true" },
    },
  };
});
