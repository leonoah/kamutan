# syntax=docker/dockerfile:1.7
# Kamutan drawing worker — Cloud Run service `kamutan-worker` (europe-west1), ADR-0008.
# Python 3.12 + Tesseract heb/eng. Receives Pub/Sub push (topic `ingest`) on POST /pubsub/ingest.
# Build context: repository root.
#   docker build -f infra/docker/worker-drawing.Dockerfile -t kamutan/worker .
#
# Security (SEC-17, SEC-46):
# - non-root (uid 10001), no build tools or uv in the runtime image, read-only-rootfs friendly
#   (scratch goes to $TMPDIR=/work; on Cloud Run that is the in-memory filesystem);
# - parsing needs NO network: Python deps and Tesseract traineddata are baked in at build time.
#   Only the HTTP handler talks to Firestore/Storage, via ADC as the dedicated runtime service
#   account `kamutan-worker@` (ADR-0003 as amended by ADR-0008) — no key files, no secrets in env;
# - Cloud Run IAM (`--no-allow-unauthenticated`, run.invoker only for the Pub/Sub push SA)
#   authenticates every request.
# TODO(SEC-46): pin base images by digest.
# TODO(sprint-1, ADR-0002): add LibreDWG CLI (dwg2dxf) built from source in a separate stage,
#   invoked only as an isolated subprocess — never linked.

# ---------- build ----------
FROM ghcr.io/astral-sh/uv:0.13 AS uv
FROM python:3.12-slim AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=/usr/local/bin/python3.12 \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /src/workers/drawing
# Dependencies first (cache), then the project itself.
COPY workers/drawing/pyproject.toml workers/drawing/uv.lock ./
# --all-extras: includes `serve` (uvicorn) and any GCP client extra the worker declares.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --all-extras --no-install-project
COPY workers/drawing/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --all-extras --no-editable

# ---------- runtime ----------
FROM python:3.12-slim AS runtime
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# Debian packages track the base image security updates; reproducibility comes from the
# base-image digest pin (TODO above), not from per-package versions.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-heb tesseract-ocr-eng \
      util-linux \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 kamutan \
 && useradd --system --uid 10001 --gid kamutan --home-dir /nonexistent --shell /usr/sbin/nologin kamutan \
 && mkdir -p /work && chown kamutan:kamutan /work
COPY --from=build /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TMPDIR=/work \
    OMP_THREAD_LIMIT=1 \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
    PORT=8080
WORKDIR /work
USER 10001:10001
# Fail the build early if heb/eng traineddata are missing.
RUN tesseract --list-langs 2>&1 | grep -qx heb && tesseract --list-langs 2>&1 | grep -qx eng \
 && python -c "import kamutan_drawing, pypdfium2, uvicorn"
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
# Cloud Run injects $PORT (default 8080). Single process; concurrency is set on the service (1 for cpu-heavy).
CMD ["sh", "-c", "exec uvicorn --factory kamutan_drawing.service.app:app_from_env --host 0.0.0.0 --port ${PORT:-8080} --no-access-log"]
