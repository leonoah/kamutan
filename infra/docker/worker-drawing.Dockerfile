# syntax=docker/dockerfile:1.7
# Kamutan drawing worker (Python 3.12 + Tesseract heb/eng).
# Build context: repository root.   docker build -f infra/docker/worker-drawing.Dockerfile -t kamutan/worker-drawing .
#
# Security (SEC-17, SEC-46):
# - non-root (uid 10001), no build tools or uv in the runtime image, read-only-rootfs friendly
#   (all scratch goes to $TMPDIR which is mounted as tmpfs/volume at runtime);
# - NO network is needed by the parsing subprocesses at runtime: everything (Python deps,
#   Tesseract traineddata) is baked in at build time. Only the orchestrator talks to Redis/Postgres;
#   parsers run as `unshare -n` / nsjail children (Sprint 1, SEC-17);
# - no secrets in layers; runtime config via env (KAMUTAN_WORKER_DB_URL = dedicated limited role, ADR-0003).
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
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project
COPY workers/drawing/ ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

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
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata
WORKDIR /work
USER 10001:10001
# Fail the build early if heb/eng traineddata are missing.
RUN tesseract --list-langs 2>&1 | grep -qx heb && tesseract --list-langs 2>&1 | grep -qx eng \
 && python -c "import kamutan_drawing, pypdfium2"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Entry module is owned by the worker team; pool selected via KAMUTAN_WORKER_POOL=cpu-heavy|cpu-light.
CMD ["python", "-m", "kamutan_drawing"]
