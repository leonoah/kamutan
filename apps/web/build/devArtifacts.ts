import { createReadStream, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Plugin } from "vite";

const TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".json": "application/json",
};

/**
 * DEV ONLY: serves locally rendered sheet artifacts (tiles, thumbnails) at `/dev-artifacts/` so the
 * mock backend can show real drawings. `apply: "serve"` → never part of `vite build`; the directory is
 * outside the repo (default /home/claude/kamutan-data/artifacts, override with KAMUTAN_DEV_ARTIFACTS),
 * so nothing is bundled or committed. Only image/json (and gzip-JSON) files under the root are served (no traversal).
 */
export function devArtifacts(root = process.env.KAMUTAN_DEV_ARTIFACTS ?? "/home/claude/kamutan-data/artifacts"): Plugin {
  const base = resolve(root);
  return {
    name: "kamutan-dev-artifacts",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/dev-artifacts", (req, res, next) => {
        try {
          const url = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
          const file = resolve(base, `.${url}`);
          // Sprint 2 artifacts are gzip JSON (legend/detections/rooms.json.gz): served as JSON with
          // Content-Encoding: gzip so the browser inflates them (like GCS objects with contentEncoding metadata).
          const gz = file.endsWith(".json.gz");
          const ext = gz ? ".json" : file.slice(file.lastIndexOf("."));
          if (!file.startsWith(base + sep) || !TYPES[ext]) {
            res.statusCode = 404;
            return res.end();
          }
          const st = statSync(file, { throwIfNoEntry: false });
          if (!st?.isFile()) {
            res.statusCode = 404;
            return res.end();
          }
          res.setHeader("Content-Type", TYPES[ext]!);
          if (gz) res.setHeader("Content-Encoding", "gzip");
          res.setHeader("Content-Length", String(st.size));
          res.setHeader("Cache-Control", "private, max-age=600");
          createReadStream(file).pipe(res);
        } catch (e) {
          next(e);
        }
      });
    },
  };
}
