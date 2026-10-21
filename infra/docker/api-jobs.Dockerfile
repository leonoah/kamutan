# syntax=docker/dockerfile:1.7
# Kamutan API batch jobs — Cloud Run JOB `kamutan-offboard-purge` (europe-west1), SEC-52 step (3)-(5).
# Runs `node dist/scripts/offboard-purge.js` (apps/api/src/scripts/offboard-purge.ts) once per execution;
# Cloud Scheduler triggers it daily (infra/IAM.md §3b, docs/runbooks/offboarding-purge.md).
# Build context: repository root.
#   docker build -f infra/docker/api-jobs.Dockerfile -t kamutan/api-jobs .
#
# Security (SEC-24, SEC-46, SEC-49):
# - non-root (`node`, uid 1000), production dependencies only, no source / tests / build tools in the runtime image;
# - credentials only through ADC as the dedicated runtime SA `kamutan-purge@` (no key files, no secrets in env —
#   the script supplies a throwaway UPLOAD_TOKEN_SECRET to the config loader itself).
# TODO(SEC-46): pin base images by digest (same as worker-drawing.Dockerfile).

# ---------- build ----------
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /src
# Workspace manifests first (dependency cache), then the sources the API build needs.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @kamutan/api... --filter @kamutan/contracts...
COPY packages/contracts/ packages/contracts/
COPY apps/api/ apps/api/
RUN pnpm --filter @kamutan/contracts build \
 && pnpm --filter @kamutan/api build \
 && pnpm --filter @kamutan/api deploy --prod /out \
 && rm -rf /out/src /out/test /out/scripts \
 && cp -r apps/api/dist /out/dist \
 && test -f /out/dist/scripts/offboard-purge.js

# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /out /app
USER node
# Fail the build early if the bundle cannot load its dependencies.
RUN node -e "require('/app/dist/scripts/offboard-purge.js')"
ENTRYPOINT ["node", "/app/dist/scripts/offboard-purge.js"]
# Default = purge every org past deleteAfter. Override per execution, e.g. `--args=--dry-run`.
CMD []
