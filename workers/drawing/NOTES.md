# workers/drawing — NOTES (Sprint 1, ingest agent)

Python 3.12+ package `kamutan_drawing` (uv). Cloud Run worker (ADR 0008): Pub/Sub push → `POST /pubsub/ingest`
→ `service.pipeline.process_sheet_version(job, blobs, docs)`. Sprint 1 goal: *upload a set → split into sheets →
classify discipline/floor → scale → tiled viewer*. Shared interfaces: `docs/agents/SPRINT1_BRIEF.md` (authoritative).
The Sprint-0 layout (`derived/{versionId}/…`, PNG tiles, `ports.py`) is gone.

## Flow

```
Pub/Sub push ─► app.py ─► pipeline.process_sheet_version            (orchestrator: identity, no parsing)
                 │          1 jobs/{jobId} must exist, orgId/projectId must match (else invalid_payload, nothing written)
                 │            succeeded + same sha256/versionId → redelivery: re-assert ready, return
                 │          2 download upload (≤100 MB) · sha256 · magic bytes vs fileKind (formats.detect_kind)
                 │          3 sandbox "probe" → pages (DWG → dwg2dxf → DXF, or unsupported_kind)
                 │          4 create sheets/{setId}-p{i} + versions/{versionId} (queued) for every page
                 │          5 per page: sandbox "page" → upload tiles/thumbnail/primitives/text → version + sheet docs
                 └─ 204 / 200 rejected(code) / 500 retry
```

* **Job contract**: `service/contracts.py` = `IngestSheetVersionJob` **schemaVersion 3** (initial: `sheetId=pageIndex=null`,
  all pages; reprocess: one page into an API-created version whose copied `regions` are kept). `storagePath` must equal
  `orgs/{orgId}/projects/{projectId}/uploads/{sheetSetId}/source.{fileKind}`. A test diffs the model against
  `packages/contracts/json-schema/IngestSheetVersionJob.json` and validates written docs against `SheetVersion.json`,
  `Sheet.json`, `Job.json` (jsonschema).
* **Storage** (`pipeline/artifacts.py`, per version `orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/`):
  `tiles/{z}/{x}_{y}.webp`, `thumbnail.webp` (longest side 512), `primitives.msgpack.gz` (`kamutan.primitives/1`, schema
  in the module docstring), `text.json.gz` (`kamutan.text/1`: lines `{text, bboxMm, angle, confidence, heightMm}`).
  Per-org glyph dictionary: `orgs/{o}/glyph-dictionary/v1.json.gz` (optimistic-concurrency merge, idempotent per
  contribution). Content-Type webp/gzip, `Cache-Control: private, max-age=31536000, immutable`.
* **Tiles** (`render/tiles.py`): WebP q80, 256 px, `levels_for` = contracts `levelsFor`; max level at `dpi` (default 300,
  `KAMUTAN_TILE_DPI`); level z = ceil(full / 2^(levels-1-z)); edge tiles cropped. Every level is rendered directly from
  the source in bands of whole tile rows (≤ 24 MP per render call) — an A0 page is never one bitmap.
  Version doc `artifacts.tiles = {prefix: ".../tiles/", format, tileSize, dpi(int), levels, widthPx, heightPx}`.
  Rasters: max level = native resolution, dpi from pHYs/JFIF (rounded to int) else 300 + reason.
* **Firestore**: version `{status queued→processing→ready|failed, progress {stage ingest|render|ocr|classify|scale|done,
  pct}, error {code,message}|null, page {widthMm,heightMm,rotation}, artifacts, regions, stats {paths,segments,textLines,
  glyphs}, workerVersion, jobId, versionNo, createdAt, updatedAt}` + worker bookkeeping `sourceSha256`.
  Sheet `{sheetSetId, pageIndex, title, discipline, floors, scaleDenominator, classification, confirmed, currentVersionId,
  updatedAt}` — confirmed sheets keep the user's discipline/floors/scale (only `classification` is refreshed).
  Job `{status queued→running→succeeded|failed, progress {stage,pct}, attempts, error}` + bookkeeping `result {sha256,
  versionId, pages, failedPages, workerVersion}`. Sheet set: `status splitting→ready|failed`, `pageCount`.
  Progress writes are throttled (stage change or ≥10 % or 2 s). The API/web mappers tolerate the two extra fields.
* **Errors** (`errors.py`): stable codes; non-retryable → job/version `failed` and HTTP 200 (acked); retryable
  (`internal`, `storage_unavailable`) → job back to `queued`, HTTP 500 (Pub/Sub redelivers) until `attempts` reaches 5
  (= DLQ max deliveries), then final `failed`. One bad page of a multi-page set fails only that version; the job is
  `failed` with "k of n pages failed", the set is `ready` if any page is. Messages are short English (+Hebrew for DWG),
  never drawing content or stack traces.
* **Classification** (`classify/sheet.py`, title block via `titleblock/classify.py`): `{discipline, floors, sheetTitle,
  scaleText, confidence, level, reasons}` only — client/project name and address stay in the sandbox (never written).
  green ≥ 0.85 with no warning, red < 0.5 or no discipline; rasters capped at yellow (`רסטר`); a non-green level always
  carries a reason (`ביטחון סיווג נמוך` when only the score is low). Scale: title block, cross-checked against dimension
  strings. **Regions** (`classify/regions.py`): drawing viewports from geometry; floors from the title order, or from
  floor labels next to each drawing when there are several drawings and the labels agree with the title;
  `polygonMm` = `[{x,y}]` (contracts `PointMm`), regions without a scale are not written (reason added).

## Formats
| kind | path | notes |
| --- | --- | --- |
| PDF | `parse/pdf.py` (pypdfium2, forms never initialised) | multi-page split (≤ 100 pages, ≤ 5000 mm); SHX text via glyph dictionary (`ocr/reader.py`, `ocr/shapes.py`) + real text layer when present |
| DXF | `parse/dxf.py` (ezdxf drawing frontend → captured polylines; `parse/vectors.py` paints tiles) | real TEXT/MTEXT/ATTRIB (no OCR), layers, INSERTs with attributes in primitives; paper layouts = pages, else model space at the `1:N` found in text / smallest fitting scale; IMAGE/OLE/proxy/XREF ignored; block graph is counted statically before exploding (cycles / fan-out > 2 M → `too_complex`) |
| DWG | `parse/dwg.py` | LibreDWG `dwg2dxf` (`$KAMUTAN_DWG2DXF` or PATH) inside the sandbox, then DXF. **Not installed here or in the image yet** → `unsupported_kind`, message in Hebrew + English ("export to DXF or PDF") |
| PNG/JPEG | `parse/raster.py` | ≤ 200 MP checked from the header before decode; Tesseract heb+eng on title-block bands; capped at yellow. contracts `FileKind` has no `jpg`: a JPEG arrives as `fileKind=png` and is accepted (one raster family) |

## Sandbox (SEC-17, security gate G1) — `sandbox/`
`runner.run_task(task, args, workdir, limits)` starts `python -I -m kamutan_drawing.sandbox.child` in a fresh temp dir:
own session; allow-listed env (no `GOOGLE_*`/secrets); `RLIMIT_AS/CPU/FSIZE/NPROC/CORE`; `unshare -n` (empty netns) when
available; **as root**: drops to a fresh uid from `UID_POOL` per run (workdir chown-ed; `RLIMIT_NPROC` then holds per
sandbox; on teardown every process of that uid is SIGKILLed — a fork bomb outruns `killpg`); **Landlock** (`landlock.py`,
raw syscalls): read/execute only interpreter/venv/`sys.path`/`/usr`/`/etc`/…, write only the workdir, no TCP
connect/bind (ABI ≥ 4), no signals/abstract sockets outside (ABI ≥ 6). Wall timeout + output cap in the parent; every
outcome is a result or a typed `SandboxError`. Child outputs are validated (`safe_output_path`, artifact names).
Tasks (`tasks.py`): `probe`, `page` (pipeline), `parse_pdf`/`parse_dxf`/`parse_raster` (magic check + probe + one page,
used by the fuzzers), `selftest.*` (escape tests). The pipeline calls parsers **only** via `run_task`.
`Limits(net|landlock|drop_root = "auto"|"require"|"off")`; env `KAMUTAN_SANDBOX_NET/LANDLOCK/DROP_ROOT` in `app_from_env`.
`GET /healthz` reports `{landlockAbi, netns, dropRoot, dwg2dxf}` — check it on the first Cloud Run deploy.

## How to run
```bash
cd workers/drawing
flock /tmp/kamutan-uv.lock uv sync
uv run pytest -q --ignore=tests/fuzz                         # unit + pipeline + sandbox + sample integration
KAMUTAN_DATA_DIR=/home/claude/kamutan-data/sample-noah uv run pytest -q tests/test_integration_sample.py
KAMUTAN_FUZZ=1 KAMUTAN_FUZZ_BUDGET_S=30 KAMUTAN_FUZZ_TARGET=sandbox \
  uv run --frozen --with hypothesis==6.168.5 pytest -m fuzz tests/fuzz -q -s
uv run ruff check . && uv run ruff format --check . && uv run mypy src
uv run python scripts/ingest_local.py [--force] [--only id,id]   # 15 samples → /home/claude/kamutan-data/artifacts
uv run python -m kamutan_drawing.cli ingest FILE... --out DIR     # any file; DIR/{sheetId}/sheet.json+version.json for golden
uv run uvicorn --factory kamutan_drawing.service.app:app_from_env --port 8080   # Cloud Run entry (needs ADC)
```
`scripts/ingest_local.py` writes the production layout under the artifacts root (`orgs/org-demo/projects/p-noah/sheets/
noah-{id}-p0/versions/v1/…`, Firestore docs under `_firestore/`), a `version.json` per version dir and `dev-index.json`
(same keys as `apps/web/scripts/make_dev_tiles.py` wrote — `tiles.prefix` without trailing slash — plus classification,
regions, stats). Never point it at the repo.

## Measured (this box, 2 vCPU, 2026-10-13)
* 15 sample A3 sheets, OCR on, 300 dpi, 379 tiles each: 4–19 s per sheet, 150 s total with a cold org glyph store.
* Synthetic A0 (20k paths): 27 s, 14043×9933 px, 7 levels, 2897 tiles, child peak RSS 341 MB.
* Fuzz (sandbox target, 30 s budget): 47 passed in 88 s.

## Known gaps / TODO
* **DWG**: no `dwg2dxf` in the sandbox or the worker image (Dockerfile TODO, infra owner) → `unsupported_kind`.
* **Cold glyph store**: an org's first sheets are read with fewer OCR votes → lower confidence (sample: 08222cb2 0.62 cold
  vs 0.92 warm) and, rarely, a misread floor (af849ec4 when ingested alone). It improves as the org uploads more sheets;
  a font-derived bootstrap dictionary or the VLM labelling batch (Sprint 2) would fix the cold start.
* **Nightly golden** runs the CLI once per file into separate `--out` roots (cold store per sheet): 14/15 pass. Calling
  `python -m kamutan_drawing.cli ingest "$KAMUTAN_DATA_DIR"/sample-noah/sheet_*.pdf --out "$out"` once (one org) matches
  production; `.github/` is owned by DevOps.
* **Production isolation**: the image runs as uid 10001 → no per-sandbox uid; `RLIMIT_NPROC` applies to the whole
  service uid (512) and Landlock/`unshare -rn` availability on Cloud Run gen2 is unverified (`/healthz`). With
  `landlock=require` the worker fails closed.
* Glyph-store deltas come from the sandbox (untrusted) and are merged into the org store: a hostile file can only
  poison its own org's dictionary (labels), not read or write anything else.
* PDF vector extraction ~13k paths/s (finding F-4): an A0 with > 1.5 M paths hits the 120 s CPU limit (`parse_cpu_limit`).
* Regions are axis-aligned rectangles from geometry clustering; L-shaped or overlapping viewports need the user's edit.
* Per-project 2 GB quota, ClamAV: not in the worker (gate G3/G4, API/infra).
* Latin in tiny fonts, `Ø` and a few symbol clusters are still misread (see `spikes/SHX_SPIKE_REPORT.md`).
* `spikes/ground_truth/shx_gt.json` contains project text (incl. the project name) — keep the repo private.
