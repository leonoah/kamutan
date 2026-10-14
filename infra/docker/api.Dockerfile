# syntax=docker/dockerfile:1.7
# Kamutan Core API (NestJS) — also used for the export worker (different start command).
# Build context: repository root.   docker build -f infra/docker/api.Dockerfile -t kamutan/api .
#
# Security (SEC-46): slim base, non-root, prod deps only, no secrets in layers.
# TODO(SEC-46): pin base images by digest (node:22-slim@sha256:...) — Dependabot "docker" updates them.

ARG PNPM_VERSION=9.15.0

# ---------- build ----------
FROM node:26-slim AS build
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    CI=1
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# Fetch deps using only the lockfile for good layer caching.
# (`dist/` is git-ignored, so `pnpm deploy` may skip it — it is copied explicitly below.)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

COPY turbo.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline --filter "@kamutan/api..." \
 && pnpm turbo run build --filter "@kamutan/api..." \
 && pnpm --filter @kamutan/api deploy --prod /out \
 && rm -rf /out/dist && cp -r apps/api/dist /out/dist \
 && rm -rf /out/src /out/test /out/*.md /out/.env*

# ---------- runtime ----------
FROM node:26-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=768"
WORKDIR /app
# The official image ships an unprivileged `node` user (uid 1000).
COPY --from=build --chown=root:root /out/ /app/
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Export worker: override CMD with ["node", "dist/workers/export.js"] (Railway startCommand).
CMD ["node", "dist/main.js"]
