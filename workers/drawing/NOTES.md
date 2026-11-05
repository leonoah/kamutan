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
* Per-project 2 GB quota: API (Sprint 7). ClamAV: in the worker since Sprint 7 (see "Sprint 7 — … ClamAV" below).
* Latin in tiny fonts, `Ø` and a few symbol clusters are still misread (see `spikes/SHX_SPIKE_REPORT.md`).
* `spikes/ground_truth/shx_gt.json` contains project text (incl. the project name) — keep the repo private.

## Sprint 2 — rooms/lifecycle/gateway (Worker-B)

Pure modules called by Worker-A's pipeline (brief signatures). Shared types: `kamutan_drawing/types_sprint2.py`
(`BBox` x/y/w/h + `from_xyxy`/`coerce`, `Region.from_dict` for `classify.regions` dicts, `Room.to_json` =
`kamutan.rooms/1` room, `LifecycleResult`, `level_for` = brief level rule, `TextLine`/`TextSpan` re-exports,
`SimpleText` + `text_items_from_json` for `text.json.gz` lines, `vector_sheet_from_primitives` to rebuild a
`VectorSheet` from `primitives.msgpack.gz` outside the sandbox). New deps: `shapely`, `httpx`, `jsonschema` (runtime),
`types-shapely`, `types-jsonschema` (dev).

### `rooms.segment(prims, text, region_polygons, scale_denominator, *, exclude_paths=None, debug=None) -> list[Room]`
Per region (paper mm; scale = region's `scaleDenominator`, else the argument, else 1:50 + `קנ"מ לא ודאי`):
1. **walls** (`rooms/walls.py`): non-white filled paths; the dominant fill colour (grey 201 on every sample) + other
   colours that are wall-thick and touch it (red/yellow new/demolished walls, black columns) + heavy pen strokes
   (≥ 0.45 mm, the 0.55 mm wall outlines). Fallback on fill-less sheets: pairs of parallel segments of the dominant pen
   6–60 cm apart.
2. **openings**: door swing arcs (beziers merged per path, or circle fit on polylines; r 0.5–1.3 m, sweep 60–120°,
   hinge on a wall) → bridge hinge → closed-leaf end; windows/glazing = solid polylines whose both ends touch walls,
   in near-identical pairs, *and* with wall continuing ≥ 0.3 m beyond both ends along the glazing (rejects wardrobe
   fronts and stair treads); then a mitre closing of 0.45 m (gaps < 0.9 m).
3. **faces** = region box − walls. Faces not touching the region border are closed rooms (0.92). Faces that leak are
   cut by the building envelope (round closing 2.5 m, holes filled): pieces with ≤ 15 % of their perimeter unwalled are
   rooms with `חדר לא סגור` (0.6), the rest is exterior. Dropped: < 1 m², < 0.5 m wide, > 60 % of the region.
4. **names** (`rooms/names.py`): dictionary of ~20 canonical rooms with variants (סלון/חדר מגורים, ח.שינה N, ממ"ד/ממ״ד,
   ש.אורחים→שירותים, ח.רחצה הורים…; `ח.` = חדר; qualifiers כללי/הורים/קיים ignored); a room word inside a long note
   ("פירוק מטבח קיים") scores low. Several label-like names in one face → "A / B" + `כמה שמות בחלל אחד`.
   nameConfidence = match × OCR confidence; < 0.85 → `שם חדר לא ודאי` (yellow); none → `ללא שם` (≤ 0.7).
5. area / perimeter in m² / m with the scale; `polygonMm` simplified 0.15 mm; ids `r_1…` in reading order.
`assign_room(rooms, x, y)` gives the room of a detection centre; `rooms_json(rooms)` the artifact document.
Debug: `uv run python -m kamutan_drawing.rooms.debug [fileId…]` → `/home/claude/kamutan-data/debug/rooms_*.png`.
Runtime 0.1–0.5 s per A3 sheet.

**Sample results** (1:50, local artifacts; areas m²):
| sheet | rooms |
| --- | --- |
| 08222cb2 arch ground | open plan סלון/פינת אוכל(+מטבח, כניסה, מדרגות) 70.2 (not closed: pivot entrance door) · שירותים 2.2 |
| 6fa88f92 arch basement | מטבח 25.4 · חדר שינה 14.9 · חדר רחצה 3.7 |
| 6fa88f92 arch 2nd plan | ח.שינה 8.9 / 10.3 / 15.6 (סוויטת הורים) / 10.4 (ח.שינה 3 + ח.עבודה) · ח.רחצה 5.0 / 4.9 · ח.ארונות 4.8 · חדר טלויזיה+מדרגות 21.3 |
| eb8be8a3 / b2046277 / 8d51ed5a ground | same open plan 70.6–70.9 + שירותים 2.2 |
| c054fd3a / 1bbe4113 | 2nd plan identical to 6fa88f92 (8.9/10.3/15.8/10.4/5.0/5.0/4.8/21.3); basement bedroom+living merged 41.9 (the partition is a thin line on MEP sheets) |
| 2a308827 / 8099ab2c first | same 8 rooms as above |
Sanity: bathrooms 3.7–5.0, WC 2.2, bedrooms 8.9–15.8, open living 70 (living+dining+kitchen+hall). No room GT exists yet
(gt/noah has no rooms file) — Data/QA's evaluation will give numbers.

### `lifecycle.classify(prims, bboxes_mm, legend_hints) -> list[LifecycleResult]`
Evidence: (1) lifecycle words in text near the item — each note votes only for its nearest bbox (≤ 12 mm):
הריסה/פירוק/לביטול → demolish (wins over "קיים" in "פירוק מטבח קיים"), חדש/מתוכנן/מוצע → new, קיים/קיימת → existing;
(2) the item's dominant ink colour via `legend_hints["colors"]` (`{"#ffff14": "demolish"}`), else by sheet kind
(`legend_hints["discipline"]`: demolition → highlighted colour = demolish, construction → new, plain black/grey =
existing); (3) dashed via `legend_hints["dashed"]`; (4) `legend_hints["default"]` (0.5); else `unknown` +
`לא נקבע מצב קיים/חדש/הריסה`. Colour–text conflict → ≤ 0.45 + `סתירה בין צבע לכיתוב`; agreeing text+colour → up to
0.92. **Worker-A must pass the page text as `legend_hints["text"]`** (the brief signature has no text argument) and
`exclude_paths` if symbol strokes are in `textPaths`. **Measured colour semantics on the samples** (text near coloured
paths): ת. הריסה (70a5c3e0/af849ec4/f14c7573) **yellow (255,255,20) = demolish** (47 הריסה/פירוק notes, 0 new);
ת. בניה (1470f005) **red = new** (12 "סגירת/בניית" notes). The brief's "red = demolish" does not hold for this set;
ת. מאסטר mixes both, so no built-in colour map — only the sheet-kind prior. Sanity: coloured items on the 3 demolition
sheets → demolish 95 % / 86 % / 97 % (18/19, 6/7, 31/32); on construction sheets → new 83 % / 86 % / 71 % (20/24, 140/162, 5/7; the rest is unknown or "existing" from nearby "קיים" notes); on lighting b2046277 the 10 fixtures next to the
6 "נק' קיימת" notes → existing, the other 53 → unknown.

### `llm_gateway` — `from_env(org_settings_reader, *, blobs=None, transport=None, env=None, fake=None) -> LlmGateway`
`LlmGateway.call(org_id, purpose, images, prompt_vars, schema, *, region_kind) -> GatewayResult(status, data, cached,
cost_usd, reason, request_id, retryable, provenance="llm")`. **`region_kind` is required** (`legend`, `legend_row`,
`legend_label`, `glyph`, `symbol`, `room_label`, `text_region`); `title_block`/missing/other → `refused`.
Order per call: refusals (purpose, region kind, sandbox, ≤ 8 images, vars ≤ 16 KB) → global switch
(`KAMUTAN_LLM_PROVIDER` default `disabled`; anthropic without `KAMUTAN_LLM_API_KEY`+`KAMUTAN_LLM_MODEL` = disabled) →
org `orgs/{o}.settings.llmEnabled` (default false; read on every call via `docstore_settings_reader(docs)`; read
failure = disabled) → images re-encoded to metadata-free PNG ≤ 1568 px → per-org cache
`orgs/{o}/llm-cache/v1/{sha256(model,purpose,promptVersion,schema,vars,images)}.json.gz` (re-validated on read) →
monthly budget `settings.llmMonthlyBudgetUsd` (default 30; spend in `orgs/{o}/llm-cache/usage/YYYY-MM.json`,
optimistic-concurrency writes; worst case incl. one repair must fit) → provider (no tools, temperature 0, drawing
text only inside `<data>` with `</data>` neutralised) → JSON parse + jsonschema, one repair retry → cache + usage.
One structured log line per call (`logger kamutan.llm_gateway`, `extra={"llm": {...}}`): requestId, org, purpose,
regionKind, provider, model, nImages, imageBytes, sentImageBytes, varsBytes, tokensIn/Out, costUsd, cacheHit,
validation, status, reason, latencyMs — never images, vars or replies. Provider errors are typed
(`provider_timeout`/`provider_http_429` retryable; 4xx not). Prices: `KAMUTAN_LLM_PRICE_IN/OUT_PER_MTOK` (defaults 3/15
USD are placeholders — set the contracted model's). The gateway must be built in the worker parent process; inside the
sandbox child it refuses (and the child env allow-list carries no LLM variables). Callers cap LLM-derived confidence
at yellow (SEC-33).

### Tests / commands
`uv run pytest -q tests/test_rooms.py tests/test_lifecycle.py tests/test_llm_gateway.py` → 77 passed (synthetic
reportlab plans + sample sheets through the local artifacts, skipped without them); full `--ignore=tests/fuzz` suite
206 passed. `ruff check`, `ruff format --check`, `mypy` clean for these files.

### Gaps
* Open-plan spaces are one room (no virtual split between living / dining / kitchen); multi-name chips explain it.
* Non-standard doors (the double pivot entrance of the ground floor) are not bridged → `חדר לא סגור`.
* On MEP sheets thin partitions (basement bedroom/living on c054fd3a) are not walls → rooms merge.
* Stairs are not a room type; stair wells merge into the adjacent hall or are dropped as slivers.
* Region boxes from Sprint 1 can include detail drawings (1470f005 sections) — handled by the 15 % open-perimeter cut,
  but a better region split would help. Floors come from `regions` (e.g. 6fa88f92's second plan is labelled `ground`).
* Lifecycle text votes need symbol bboxes from Worker-A; legend semantics (colour/dashed) must be parsed into
  `legend_hints` — none of the sample legends define colours, so MEP items default to `unknown` unless a note says
  "קיים".
* Budget usage is per worker-visible month in Storage, not a Redis circuit breaker; no global (all-org) cap yet; no
  80 % alert. Anthropic provider is tested only against `httpx.MockTransport` (no key here); the EU/Bedrock routing from
  04_architecture is a configuration of `KAMUTAN_LLM_BASE_URL`/provider, not implemented.

## Sprint 2 — legend, symbols, integration (Worker-A)

Goal: *the legend is recognised and the symbols and rooms are marked on the drawing*. Interfaces:
`docs/agents/SPRINT2_BRIEF.md` (artifacts validated in tests against `packages/contracts/json-schema` —
`LegendArtifact`, `DetectionsArtifact`, `RoomsArtifact`, `LegendEntry`, `SheetVersion`).

### Flow (new sandbox task `understand`, after the `page` task)
```
page (sandbox: tiles, primitives, text, classify, regions)
  └─ understand (sandbox, pipeline/understand.py; reads the page's primitives.msgpack.gz + text.json.gz)
       legend  → legend/parse.py   (every sheet)
       detect  → symbols/detect.py (electrical / lighting / plumbing only; rasters → symbols/raster.py)
       rooms   → rooms.segment (Worker-B) on architecture/master/construction/demolition sheets and any sheet with
                 room names; detections get roomId (rooms.assign_room) + floor (regions); lifecycle.classify(…,
                 {"text": spans, "discipline", "exclude_paths", "default": "new" on MEP sheets})
  └─ orchestrator (service/pipeline.py `_understand`): uploads legend.json.gz / detections.json.gz / rooms.json.gz /
     legend/{entryId}.webp / unknown/{clusterId}.webp (names allow-listed), optional LLM label refinement, writes
     `legendEntries`, version `artifacts.{legend,detections,rooms}` + `stats.{detections,rooms,legendEntries}`.
```
Progress stages `legend` (88) → `detect` (91) → `rooms` (96) → `done`. Best effort: a failing `understand` task leaves
the page `ready` without the three artifacts (logged); storage errors are retried as before. `Options.understand`
(env `KAMUTAN_UNDERSTAND=0` turns it off), `Options.llm` (gateway; default `llm_gateway.from_env`, i.e. disabled).
Idempotent: same input → byte-identical artifacts (tested); re-runs overwrite `suggested` entries only.

### Legend (`legend/`)
* `tables.py` — the legend is found **from geometry**: ≥ 4 horizontal rules (≥ 25 mm) with the same left and right
  edges, gaps ≤ 16 mm, outside the title block. (On the sample set the title "מקרא:" is never read by the SHX reader.)
  Titles above the table are used when readable ("טבלת תאורה" → types table).
* `parse.py` — *symbol legend*: stroke groups (KD-tree connected components) larger than the label text, clustered in
  columns (≥ 2 per column); per content row (band between rules holding Hebrew text) the symbol = groups in the column
  (overshooting rows allowed, text glyphs not touching it dropped), the label = Hebrew spans between the previous
  column and this one (RTL: label left of symbol); a span touching the symbol is the symbol's own text (BEZEK, כ.רשת,
  TV, 2X → `qualifier`) when another label lies further left. *Fixture-types table*: header with "סוג"/"מס'"; number
  column = bare digit spans; rows whose number and description were read as one span ("16 גוף תלוי פעמון מיני") are
  split. Entry ids `le_{sheetId}_{n}`, `signature` = 16 hex of a 6×6 ink-share raster (3 % threshold) + aspect + curve
  share + qualifier; lookups also try 26 *probe* variants (sub-cell shifts / thresholds) because float noise between
  sheets (rotated pages) can flip a cell (multi-probe hashing).
* `classes.py` — ~70 ordered Hebrew keyword rules → class ids (`benchmark/schema/classes.json`); no-class rules for
  markers (ראה הערה, אביזר מוגן מים, צינור/קוברה, ברז לניאגרה); fuzzy (1 edit) only for keywords ≥ 6 letters (one slip
  turns תאורה into תנור). 2X/3X (`multiplicity`, Hebrew א read for X accepted) upgrade socket_single → double/triple,
  socket_power → power_double.

### Symbols (`symbols/`) — vector, legend-conditioned
* `template.py` — template = legend strokes centred on their bbox, resampled every 0.1 mm; anchor = largest arc
  (beziers fitted per chain, `arcs.py`) else the longest straight stroke; identical drawings (symmetric chamfer
  < 2.5 % of size in some orientation) form a *family* (socket/2X socket; BEZEK/TV/TEL brackets).
* `match.py` — poses from scene primitives like the anchor (radius ratio = scale; partial arc / stroke direction =
  rotation; full circles: 8 × 45°; mirror unless the template is symmetric); **forward chamfer** (template → ink,
  KD-tree, capped 0.6 mm, on-ink share) for all poses in batches, **reverse chamfer** (ink inside the posed box →
  template; strokes longer than the symbol ignored) and **solid-fill area** difference for the survivors;
  quality = (0.6·forward + 0.4·reverse) × fill factor; NMS across templates keeps the runner-up for the margin. Scene
  = strokes in a colour of some legend symbol (grey furniture out), minus legend tables (and overshooting symbols) and
  the title block. Legend scale ≠ plan scale: if < 2 strong matches, the arc-radius ratio mode is tried.
* `detect.py` — family member by the *nearest* qualifier text (none found → the plain member + `דומה לסמל אחר`;
  simple drawings (bracket, cross) need their text or a ≥ 0.85 fit); markers annotate the nearest item ("מוגן מים");
  annotations from text (`H=…`, `IP..`, 2X/3X), each token to its nearest detection; a nearby label naming a more
  specific class of the same family refines it (power → 3-phase / power-double / heater feed, ceiling → fan…,
  reason `סוג עודכן לפי כיתוב סמוך`); plumbing sheets (no legend): text-anchored items (מרכז ניאגרה, מונובלוק, ברז קיר,
  נק' מים+ביוב) with `זוהה מכיתוב בלבד`; unknown clusters: repeated (≥ 3) black symbol-like groups (2–8 mm, a curve
  or ≥ 3 directions) not explained by a detection or text, grouped by a rotation-tolerant descriptor → `u_n`, members
  `class: unknown` red `סמל לא במקרא`.
* `marks.py` — 2X/3X re-read **from strokes** (the SHX reader merges them with the socket arc: "א 0%", "2]"): a glyph
  library harvested from the same sheet (confident numeric spans such as dimensions + the legend's own "2X"), words of
  two glyphs in 3 reading directions, each word to its nearest socket.
* `tags.py` — fixture-type tags: digits inside small circles matched against the strokes of the types table's own
  numbers (two passes: bbox-normalised, then circle-normalised with the learned digit/radius ratio, robust to a
  dimension line crossing the tag); a tag sets the type/class of the nearest lighting symbol (`סוג N` annotation,
  `legendEntryId` = the types-table entry) or becomes a detection of its own (`סוג לפי תג בלבד`).
* `raster.py` — PNG/JPEG fallback: rules by morphological opening, legend columns as above, labels by Tesseract `heb`
  on native-resolution crops, NCC (cached scene FFT + integral images) at 4 rotations (+mirror), templates with > 40
  hits dropped; every detection `רסטר`, never green.
* Scoring (`score_detection`, heuristic until Sprint 5 calibration): score = quality × (0.8 + 0.2·margin/0.25) ×
  (0.7 + 0.3·classConf/0.8) × 0.9 if the scale is unknown/estimated × 0.85 outside the regions; green ≥ 0.85 with no
  warning reason, red < 0.5; reasons: `התאמה חלשה לסמל במקרא` (q < 0.72), `דומה לסמל אחר` (margin < 0.12),
  `תווית המקרא לא ודאית`, `קנ"מ לא ודאי`, `מחוץ לאזור השרטוט`, `רסטר`, `ביטחון נמוך` (only the score is low).
* `debug.py` — `uv run python -m kamutan_drawing.symbols.debug SHEET.pdf detections.json.gz [rooms.json.gz] OUT.png`.

### Firestore
`legendEntries/{le_…}`: `suggested` docs (class null, thumbPath = full storage path). Before the sandbox runs, the
orchestrator lists the org's `symbolMappings` and the project's `confirmed`/`ignored` legend entries (new additive
`list_docs(collection)` on the three doc stores) and passes `{signature: {class, itemCode, status, entryId}}`:
mapped entries get `suggestedClass` at 0.95; detections of a confirmed signature use its class and link
`legendEntryId` to the confirmed entry (no new entry is created); ignored signatures produce no detections; an existing
`confirmed`/`ignored` doc is never overwritten. LLM (`legend_label`, region `legend_row`, the entry crop only) is
called for labels with confidence < 0.6 when the gateway is enabled (≤ 12 per sheet); the result is capped at 0.8 and
rewritten into `legend.json.gz` + the entry doc. Works unchanged with the gateway disabled (default).

### Sample results (15 sheets, `scripts/ingest_local.py --force`, 2 vCPU; total 170 s)
| sheet | discipline | legend entries | detections | g/y/r | rooms | s/sheet (understand) |
| --- | --- | --- | --- | --- | --- | --- |
| eb8be8a3 | electrical | 20 | 26 (sockets 17, speaker 2, unknown 7) | 11/8/7 | 2 | 15.8 (5.1) |
| c054fd3a | electrical | 20 | 54 (sockets 37, heater 4, tv 8, switch 5) | 21/33/0 | 10 | 21.4 (7.5) |
| b2046277 | lighting | 20 + 24 types | 41 (luminaires 26, switches 15) | 3/38/0 | 2 | 18.7 (6.0) |
| 1bbe4113 | lighting | 20 + 24 types | 55 (luminaires+fans 24, switches 26, unknown 5) | 6/44/5 | 10 | 21.6 (6.5) |
| 8d51ed5a / 24ab0ea0 / 2a308827 | plumbing | 0 (none drawn) | 3 / 3 / 4 (text anchors) | all yellow | 2/2/8 | 7–10 |
| other 8 sheets | arch/construction/demolition | 0 | — (rooms only) | | 1–11 | 5–15 |
All 20 legend labels on the electrical/lighting sheets are read and classed (4 marker rows → no class); 24/24
fixture types. Impressions vs the *draft* counts (gt/noah/draft_counts.md — not tuned on, not a GT): eb8be8a3
single/double/triple 4/5/1 vs draft 4/5/2, filled sockets (power + 3-phase) 4+3 vs draft 2 + 1 power-double + 3,
speakers 2/3; c054fd3a single/double/triple 19/11/2 vs draft 18/11/3, power 5 (+4 heater feeds); b2046277 26 fixture positions vs 25 tags, 23/25 tag numbers read
(27 and the off-table "100" not); 1bbe4113 fixtures 24 vs 24 (5 ceiling fans = type 17 ✓). Visual checks:
`/home/claude/kamutan-data/debug/overlay_{eb8be8a3,c054fd3a,b2046277,1bbe4113}.png`.

### Known gaps
* **Look-alike families** (BEZEK/TV/TEL/רשת brackets): told apart only by text next to them; on c054fd3a that text is
  vertical and unreadable, so the 8 comms points are all `tv_point` + `דומה לסמל אחר`. A stroke-based qualifier
  reader (like `marks.py`, against the legend's qualifier strokes) would fix it.
* Lighting sheets are mostly **yellow** (legend label confidence ~0.6 from the cold glyph store and tag-only types);
  levels are heuristic until the Sprint-5 calibration. Switch counts look high on 1bbe4113 (26 vs ≈21 draft) —
  the "2-way" vs "single" distinction relies on the drawing (מחלף has an extra stroke) and is not verified.
* Raster fallback is basic: fine on clean renders (synthetic test), low recall on real 300-dpi renders of the samples
  (SHX labels read poorly by Tesseract; simple templates dropped as non-discriminative).
* Text anchors (plumbing) give one item per label ("ברז קיר" serving two faucets counts 1). No leader-line following.
* Detail boxes ("פרט A 1:20") are not excluded from spotting (none of their symbols matched on the samples).
* The LLM refinement updates the legend entry, not the already computed detections (they follow on reprocess after
  the user confirms). No kbench run: the only GT file (`gt/noah/sheets/eb8be8a3.geojson`) is `draft`.
* Integration touched files outside the Worker-A dirs (additive): `sandbox/tasks.py` (task `understand`),
  `stores/{memory,local,gcp}.py` (`list_docs`).

### Sprint 2 accuracy round (Worker-A) — rules added after the Data agent's GT evaluation
General rules only (no per-sheet logic, no GT data in code). Measured with
`uv run kbench eval --truth …/gt/noah --pred-detections …/artifacts` (gt-v0.2.1-draft):
micro-F1 0.751 → **0.818** (glyph 0.803 → 0.869); green 48 @ 81 % (LB95 68 %) → **13 @ 100 % (LB95 77 %)**; review burden
73 % → 92 % (the two-floor sheets are now all yellow, see floors); items correct 40 % → 48 %.
* **Green** = strong fit (q ≥ 0.86) + margin ≥ 0.3 over the runner-up + specific, well-read class (≥ 0.7) + no warning;
  or score ≥ 0.85 without warnings. New warning chips: `שיוך כיתוב לא ודאי` (a 2X/3X word, a type tag or a refining label
  has another symbol ≤ 3 mm farther than the one it was given to), `פריטים חופפים` (two items < 4 mm apart),
  `סוג בטבלה שונה מסמל הגוף` (a type tag names another class than a *specific* glyph; a generic ⊕ point takes the
  table's type), `כיתוב ליד הסמל לא נקרא` (an X-like word next to a socket whose digit was not read),
  `קומה לא ודאית`, `סוג לפי הערה ליד הסימון`.
* **NMS on shared strokes** (`match._nms`): candidates are the same instance when ≥ 50 % of either posed template lies
  on the other; the more specific template (≥ 1.25× the strokes, containing the other) wins unless its fit is > 0.15
  worse. Fixes 2-way switches reported as single + 2-way and keeps switch banks at 2 mm pitch.
* **2X/3X at any angle** (`marks.py`): words are read along their own baseline (45° walls), both directions, best of
  the two; digits 2–4 only.
* **Floors** (`pipeline/understand.py`): when a sheet holds several drawings whose floors come from the title order
  with no agreeing label next to the drawing ("קומה א'", "קומת מרתף"), or a label next to a drawing names another
  floor, the title assignment is kept and its detections and rooms get `קומה לא ודאית` (yellow) — the owner confirms
  the drawing convention (c054fd3a / 1bbe4113: title "מרתף+קרקע", lower plan has the bedrooms).
* **"ראה הערה" crosses** become items only with an exact fit and a classed note ≤ 10 mm away (פעמון → doorbell,
  אינטרקום → intercom), one note per cross, yellow. **Panels**: a rectangle crossed by both diagonals ≤ 20 mm from a
  "לוח חשמל/תקשורת" label (the legend shows the home-run arrow, drawn at another size inside the panel), yellow.
* **Unknown clusters**: groups must be larger than 1.35× the body-text height (rotated SHX glyphs were clustered), and
  lone rings (circles as polylines), circled numbers and groups on the end of a line running away from them (conduit
  ends) are not asked about. 12 red false positives → 0.
* Refinement guard: a hollow socket glyph is never refined into a power / 3-phase socket by a nearby label.
* Stroke-wise reading of comms qualifiers (BEZEK/TV/TEL/רשת, `marks.read_qualifier`) is implemented but **off**
  (`READ_QUALIFIER_STROKES`): it chose the wrong sub-type more often than the plain fallback (tv 1/4 vs 4/8).
Still open: data/phone points (0/6, all predicted tv, yellow), socket_box_6 "פרט A" callouts (text only), speakers
next to text (2/3), luminaire type vs glyph semantics (strip/pendant), burden on two-floor sheets (floor question).

## Sprint 3 — switch ↔ luminaire link graph + floor confirmation (Worker-A)

Brief: `docs/agents/SPRINT3_BRIEF.md`. Package `kamutan_drawing.links` (pure; no I/O except `debug.py`).

### Flow (inside the `understand` sandbox task, after rooms/lifecycle; lighting sheets only)
```
links/arcs.py   extract_chains(vs)        dashed chains: exploded dashes (one tiny path per dash, the AutoCAD PDF export)
                                          chained end-to-end per pen + paths with a real dash array
links/graph.py  build_links(chains, dets) attach ends → split pass-throughs → circuits → points → kind/confidence
links/__init__  link_sheet(...) / link_from_artifacts(...)   (stored-artifact entry: debug, ingest_local fallback)
links/floors.py apply_confirmed_floors(artifacts, sheet_doc, regions=None)   (re-exported by pipeline/understand.py)
links/debug.py  uv run python -m kamutan_drawing.links.debug [fileId…] → /home/claude/kamutan-data/debug/links_*.png
```
* **Chaining**: dash candidates = open stroked paths ≤ 3.2 mm. An end continues into another dash's end when both
  point at each other (≤ 40°) within the pen's own adaptive gap (2.5 × median best gap, 0.8–4 mm); greedy by cost,
  each end once; a runner-up within 0.25 cost = ambiguous join (`קשתות חוצות`). Chains need ≥ 3 dashes, ≥ 3 mm and
  a regular dash length (≥ 70 % within ±35 % of the median — rejects text strokes that line up). SHX "text paths" are
  NOT excluded: the text heuristic flags switch stems and the last dash at a switch.
* **Attachment** (per chain end): *ink* first — the connected symbol-sized strokes (paths ≤ 12 mm) within 1.0 mm of
  the end (arcs end inside the 0.5 mm switch ring / on the luminaire crosshair) form a glyph; the detection box that
  holds ≥ 50 % of it wins (switch banks at 2 mm pitch are separated by glyph, not by detection centre, which is
  ~1 mm off). Two boxes hold it equally → nearer centre if > 0.6 mm clearer, else ambiguous (`קישור מפסק לא ודאי`).
  No ink → distance to box ≤ 0.35·size + 0.8 mm (arcs that stop short). Nothing → dangling (`קשת לא מסתיימת
  בסמל`) unless it lands ≤ 1 mm on another wire (branch). A chain through a luminaire centre (≤ 0.8 mm) is split.
* **Wiring filter**: pens with ≥ 30 % of the both-ends-attached chains (red on Noah); other chains count only when
  attached at both ends and clearly curved (≥ 5 dashes). Half-attached chains need the wiring pen.
* **Inferred switches**: arc ends on one switch box but on glyphs > 1 mm apart = a bank switch the detector missed;
  the far glyph becomes an inferred switch (`inferredSwitches` on the group, `מפסק לא זוהה (לפי קשת)`).
* **Groups** = connected components {detections, arcs}. Points = luminaires joined by an arc and closer than
  `point_merge_m` (0.3 m real at the plan scale; default keeps the 40 cm spots apart = 3 points, matches 4.16).
  Kinds: no switch → `sensor` (fixture type row with גלאי/חיישן in the types table's notes column, or such a note
  next to the luminaire) else not grouped; all points existing ("נק' קיימת" nearest the luminaire, or lifecycle
  existing) or the only switch has a "להוסיף …" note → `add_to_existing`; 1 switch → `single`/`shared`; ≥ 2 →
  `two_way`. `fan` comes from the switch side only (switch_fan, or a "מאוורר" note — two-line notes are merged into
  one block — nearest the switch): "להוסיף מחלף" on a light+fan point is 4.12, "מפסק למאוורר" is 4.14.
  Switches marked "קיים" do not count as added. Unlinked new luminaires → `unlinkedLuminaireIds` (no group).
* **Confidence** 0.92 × 0.65^ambiguous ends × 0.5^dangling ends × 0.8 crossing × 0.75 inferred × rule penalties
  (`מחלף ללא מחלף שני בגיליון` 0.8, `יותר משני מפסקים לנקודה` 0.75, `נקודה קיימת ונקודה חדשה באותו מפסק` 0.7,
  `סוג מפסק לא תואם לקבוצה` 0.85). Level = brief rule; every chip is a warning → **green only when every arc end is
  attached unambiguously** and no rule fired. Member detections' `קומה לא ודאית` is carried to the group.
* Rules are `LinkParams` fields (configurable; the org rule set can feed them later).

### Artifact `links.json.gz` (`kamutan.links/1`) + version doc
`{schema, groups: [{id "lk_<n>", kind, switchIds, pointIds, luminaireIds, confidence, level, reasons, floor, fan,
inferredSwitches, arcIds}], points: [{id "pt_<n>", luminaireIds, centerMm, lifecycle}], arcs: [{id "a_<n>",
polylineMm (Douglas–Peucker 0.1 mm), ends [detId|null ×2], ambiguous, inferredSwitch}], unlinkedLuminaireIds}`.
The contracts' `LinksArtifactSchema` is `.strict()` with the 8 brief fields — the extra fields were requested from
the API agent as optional additions (else they move to a sibling file). The task returns `linksFile:
"links.json.gz"` (deliberately NOT in `files`: the current `service/_understand` raises on unknown names) and
`linkStats {groups, green, yellow, red, byKind, arcs, danglingEnds, inferredSwitches, unlinkedSwitches,
unlinkedLuminaires}`. **Service wiring (Worker-BOQ owns `service/`) is pending**: upload `linksFile` → `artifacts.links`,
`stats.links = linkStats`, pass `floorsConfirmed`. Until then `scripts/ingest_local.py` computes the links from the
stored artifacts (same code) so `dev-index.json` has `links` / `artifacts.links` / `stats.links`.

### Floor confirmation
`understand(..., floors_confirmed=True)` (task arg `floorsConfirmed`) uses the regions' floors and adds no
`קומה לא ודאית`. `apply_confirmed_floors({"detections", "rooms", "links"}, sheet_doc, regions)` (deep copies; no-op
unless `sheet_doc.confirmed`): floor of the confirmed region containing the item (a single confirmed floor covers the
sheet), the chip removed; detections/rooms whose only reason was the chip go back to green (the floor rule only ever
demoted green → yellow and a non-green item always has a reason); groups take their members' majority floor and are
re-levelled from confidence + remaining reasons. For `boq.build` on stored artifacts — no re-parsing.

### Results (Noah, `ingest_local.py --force`, 15/15 succeeded; links stage 1.8–2.5 s/sheet)
| sheet | arcs | groups by kind | levels g/y/r | notes |
| --- | --- | --- | --- | --- |
| b2046277 ground | 19 | single 7, shared 4 (2× 2 pts, 2× 3 pts), two_way 1, sensor 1 | 12/1/0 | yellow = 2-way to the existing "100" point (its "נק' קיימת" note is unread) |
| 1bbe4113 basement+ground | 24 | single 10, shared 3, two_way 1, add_to_existing 4 (1 fan) | 0/16/2 | all carry `קומה לא ודאית` until the floors are confirmed; red = parents' suite (ambiguous stacked switches) and the corridor spot (arc to an undetected switch); 1 inferred switch (bathroom bank) |
Implied composite counts (default mapping) vs `boq_truth.json`: 4.09 17/16, 4.10 2/2, 4.11 5/5, 4.12 3/3, 4.14 1/1,
4.15 1/1, 4.16 2/2 (4.09 +1 = GT-D-006: the GT also implies 17).
`kbench eval-links` (gt-v0.3-draft, frozen; run for numbers only, nothing tuned on it): group exact recall 28/30
(0.93), precision 28/29 (0.97), switch assignment 30/32, luminaire assignment 37/39, kind accuracy 29/30, **green
precision 12/12**. Errors: the parents' suite (disputed GT-D-005 area) and the inferred bank switch (no switch id).
Tests: `tests/test_links.py` (18, synthetic reportlab arcs: exploded + real dashes, irregular strokes, single/shared/
pass-through, two-way + short end, lone 2-way, dangling, ambiguous, crossing, inferred bank switch, existing/fan/sensor
rules, fixture-table sensor, floor chip, `apply_confirmed_floors`, understand integration, bends).

### Gaps
* Unread "נק' קיימת"/"קיים" notes (cold glyph store) leave existing points/switches as new: one 4.12 counted as 4.09
  on b2046277; the suite's existing 2-way switch counts as added (red `יותר משני מפסקים לנקודה`).
* Cross-sheet two-way pairs ("מחלף שני במרתף") are not joined across sheets; a lone 2-way gets `מחלף ללא מחלף שני בגיליון`.
* Inferred switches have no detection id (BOQ evidence points to the arc); dangling ends do not create a switch.
* Electrical sheets are not linked (authority: lighting); DXF dashed lines are handled as chains but untested on real DXF.
* `ruff format .` was run once at the worker root while other agents were editing; it reformatted 2 files (mine
  plus possibly one in `boq/`) — formatting only.

## Sprint 3 — BOQ build + library import (Worker-BOQ)

Goal: *a full electrical + lighting BOQ (chapter 04 + 9.01) traceable to the drawing items*. Interfaces:
`docs/agents/SPRINT3_BRIEF.md` + contracts `boq.ts` / `library.ts` / `jobs.ts` (mirrored in `boq/contracts.py`;
`tests/test_boq_contracts.py` diffs the job models, LinkGroup, the default rules (`json-schema/defaults/boq-defaults.json`)
and validates every written doc / artifact against the generated JSON schemas).

### Job routing (`service/app.py`)
`POST /pubsub/ingest` dispatches on the payload `type`: `boq.build` → `boq.build.run_boq_build`, `library.import` →
`library_import.importer.run_library_import`, anything else → `process_sheet_version` exactly as before (ingest
unchanged). Same response semantics (204 / 200 rejected / 500 retry, 5 attempts).

### `library.import` (`library_import/`)
* `readers.py` (sandbox only): `.xls` via xlrd (`formatting_info` → number format), `.xlsx` via openpyxl
  (`read_only`, `data_only`: cached formula values, never evaluated) → bounded grid (32 sheets × 5000 rows × 40 cols)
  with each numeric cell's displayed decimals. New sandbox task `boq_parse` (`sandbox/tasks.py`, additive): magic
  check, read, parse; any library exception → `file_unreadable`.
* `parse.py`: picks the sheet with a BOQ header (`סעיף | תאור | יחידה | כמות …`, most item rows wins; other sheets —
  cover, contract, change orders, raw CAD counts — listed as ignored); title rows (only "כתב כמויות…" and
  "שם הפרויקט: {projectName}" reach the template — names/addresses are dropped); chapter rows `פרק NN – …`; notes
  ("הערות:" + numbered/plain rows, numbering kept as written); items; per-chapter and grand totals recognised.
  **TEXT codes**: number format first (`0.00` → 4.1 is "4.10"), else the numbering scheme (max decimals in the file)
  + sequence context (4.09, 4.1, 4.11 → "4.10"); flags `trailing_zero_restored`, `ambiguous_code` ("4.00" — could be
  the chapter number; a restoration no neighbour supports), `gap_before:4.13`, `chapter_code_mismatch:8` (9.01 under
  "פרק 08"). Descriptions are normalised exactly like contracts `normalizeDescription`. On the sample: 77/77 lines,
  codes, quantities, units and the `ambiguous_code` flag identical to `gt/noah/boq_truth.json`.
* `importer.py` (orchestrator): job doc ownership, redelivery = no-op (same `importId`), ≤ 20 MB, magic vs
  `sourceKind`; items → `itemLibrary/{itemIdFor(code, description)}` (contracts algorithm, tested against TS
  vectors) → idempotent across files; `manual` items never overwritten; `active`/`tags` only on create;
  `importFlags` (extra field) keeps the parser flags. `boqTemplates/tpl_default` (`source: import`, chapters with the
  header text as `title` + notes + `codePrefixes`, columns, titleRows, `vatRate` 0.18) only when the org has none.
  `libraryImports/{importId}` gets status / stats / error when the API created it.

### Rules (`boq/rules.py`)
Rule docs = contracts `BoqRule`; `DEFAULT_RULES` mirrors `DEFAULT_BOQ_RULES` (diff test). Seeding is
create-if-missing per rule id (new defaults appear, admin edits survive). `Library.resolve(code, description)`: same
code with a similar description (char-trigram Dice ≥ 0.45) → that item; else the most similar description (≥ 0.6)
→ that item + reason `שיוך לפריט לפי כלל ברירת מחדל`; custom rules / user-chosen codes (confirmed legend entry or
symbol mapping `itemCode`) trust the code. No item → line under the pseudo-chapter **"לא משויך"** (code `X-…`), red,
`אין פריט בספרייה` (`אין כלל שיוך לסוג זה` when no rule covers the class). Any rule reason caps the line at yellow.
Worker constants (no field in the strict match schemas): class_to_item counts new work only (lifecycle
`existing`/`demolish` skipped, `stats.excludedByLifecycle`). Markers / page furniture: the default `r_none_*` rules
(class_to_item, `itemCode: null`). **Label rules** (`LABEL_RECLASS`): a `heater_feed` whose nearest Hebrew label
(≤ 10 mm) says "דוד" (not "קיים"/"תנור") is a `water_heater_feed` (→ 4.23), chip `סוג עודכן לפי כיתוב סמוך`; never
applied to a user-confirmed class. **Shared elements** (`SHARED_KINDS`): the same `two_way` group (same switch/point
counts and fixture-type annotations, luminaires outside named rooms or in a stair room) on two lighting sheets of
adjacent floors is counted once (the copy's switches and luminaires are dropped, also from 9.01), chip
`מופיע בשני גיליונות`, yellow.

### Aggregation (`boq/aggregate.py`, pure) and de-dup (`boq/dedup.py`)
1. **prepare**: confirmed legend entry → its class / itemCode; `ignored` entry or `symbolMappings.ignored` → dropped;
   mapping class / itemCode otherwise. **Confirmed sheets**: Worker-A's `links.floors.apply_confirmed_floors` on the
   detections + link groups, with `effective_regions` (a confirmation that changed the floors without new regions
   relabels region floors in drawing order: "מרתף+קרקע" → basement + first) → floor chip removed.
2. **de-dup** per `authority` rule and floor: secondary sheets (other discipline) are aligned onto each
   authoritative sheet by translation voting (2 mm bins; accepted when ≥ 3 and ≥ half the items find a partner),
   else identity when both pages have the same size/rotation; matched items (≤ `radiusMm` real → paper mm via
   scale) are dropped, unmatched kept with `פריט מגיליון משני`; no alignment → kept with `יישור גיליונות נכשל — ייתכן כפל`.
3. **composite lighting**: per `links.json.gz` group (unknown fields ignored): features `groupKind`, points
   (`pointIds`, else luminaires clustered by `pointMergeMm`), switch count/classes (a group controlling only
   ceiling fans and no 2-way switch counts as a fan-switch group); first matching rule → 1 unit; groups entirely
   existing are skipped; no rule → "לא משויך". Group level/reasons join the line. **No links artifact** on a lighting
   sheet → fallback: 1 group per new single switch, 2-way switches paired by proximity, fan switches as
   add_to_existing, every line red `חושב ללא גרף קישורים`.
4. **install count** (9.01) per rule flags; **class → item** for everything else (switch / luminaire / fan classes
   are consumed by 3–4).
5. **lines**: id `ln_{code}` (`ln_x_…` unmatched), qty, `byFloor` (`unknown` + chip when a detection has no floor),
   level = min of evidence (+ caps), reasons = rule reasons then evidence reasons by frequency (≤ 32), evidence
   `{sheetId, versionId, detectionId, linkGroupId|null, floor}`, `sourceVersions`, `ruleId` (`legend_{entryId}` /
   `mapping_{signature}` for user codes). Everything sorted → deterministic (tested).

### `boq.build` (`boq/build.py`)
Job doc + `boqBuilds/{buildId}` must exist (org/project checked); succeeded build = redelivery no-op. Inputs: every
`sheets/*` with discipline electrical/lighting, current version `ready`, `detections.json.gz` (+ `links.json.gz` from
`artifacts.links` or next to it; paths must be under the version prefix). Writes `boq/{buildId}/evidence.json.gz`,
upserts `boqLines` (full-doc replace so `byFloor` never keeps stale floors; `BOQ_LINE_PRESERVED_FIELDS` copied from
the current doc — read-modify-write, a PATCH landing in between can be lost: TODO transaction in the GCP store).
**Approved line whose qty changed** (superseded in Stage 10: it now drops to `reviewed`, see "Stage 10 — fix round"): status kept, chip `הכמות השתנתה מאז האישור`, level red; baseline
`approvedQty`/`approvedQtyAt` (extra fields) = the qty at the first rebuild after that approval; cleared when
`approvedAt` changes (re-approval) or the qty returns. Obsolete worker lines: deleted when draft without
override/note/lock (new `delete` on the three doc stores), else kept at qty 0, red `הסעיף לא נמצא בבנייה האחרונה`.
Lines without `computedAt` (manual) are never touched. Build doc `running → succeeded|failed` + `stats {lines, green,
yellow, red, sheets, evidence, duplicatesRemoved, unmapped, unlinkedSwitches, fallbackSheets, durationMs}` +
`evidenceRef`; project `boq {latestBuildId, builtAt, pendingBuildId: null}` and `stale: false` **only if `boq.staleAt`
did not change during the build** (an API change meanwhile keeps it stale).

### Local run
`uv run python scripts/boq_local.py [--build-id ID] [--json OUT]`: imports `boq_sample.xls` into `org-demo`
(sandboxed), builds over `/home/claude/kamutan-data/artifacts`, writes `orgs/org-demo/projects/p-noah/boq/boq-lines.json`
(+ root `boq-lines.json`, `boqLines`/`boqEvidence` pointers in `dev-index.json` for the web mock) and prints chapter
04 + 9.01 vs `boq_truth.json`. 0.1 s per build. Result (links from Worker-A, contracts default rules), 14/29 exact:
4.01, 4.04, 4.07, **4.09–4.12, 4.14–4.16** (all composite lines), 4.18, 4.21, 4.22, 4.24 exact; 4.00 22/23, 4.02 6/5,
4.03 7/8, 4.05 8/11, 4.17 4/3, 9.01 39/43; not produced: 4.06 (text-only callouts), 4.08, 4.19, 4.20/4.27
(conduits not detected), 4.23, 4.25, 4.26, 4.28 (second panel / text-only items).

### Integration round (Sprint 3)
* Ingest: `_understand` passes `floorsConfirmed` (sheet `confirmed`) and, when the task reports `linksFile`, uploads
  `links.json.gz` (name checked) → `artifacts.links`, `stats.links` = sanitised `linkStats` (`tests/test_service_links.py`).
* Mirrors resynced with the regenerated contracts: 9.01 default `excludeLifecycle [demolish], excludeSupply []`,
  `r_none_*` rules, optional LinkGroup fields `floor/fan/inferredSwitches/arcIds`; import stats + job result carry
  `ambiguousCodes` and `templateName`. Seeding is create-if-missing: an org seeded before a default changed keeps
  the old doc (the API owns updating default rule docs).
* Composite evidence = switches + luminaires of each counted group, each item with its `linkGroupId` (fallback groups
  get synthetic `lk_fb{n}`): **the UI/export must count distinct `linkGroupId`s, not items**, for composite lines.
* kbench `eval-boq` (gt-v0.3-draft), chapter 04 + 9.01: gated exact 11/22 → **12/22**, ΣAE 20 → 19; disputed exact
  3/7 → 4/7, ΣAE 7 → 3. Changes: 4.17 4 → 3 ✓, 4.23 — → 1 ✓, 9.01 39 → 43 ✓, 4.10 2 → 1 (the stair group is no longer
  counted twice; the master existing+new 2-way is read by the link graph as a fan group — the old 2 was two errors
  cancelling).

### Gaps
* Two-floor sheets are still classified basement + ground (truth: basement + first) until the owner confirms them;
  byFloor shows "ground" for first-floor items. The ground-floor switch de-dup of c054fd3a falls back to identity
  (no duplicates found: those are heater/vent switches); the basement alignment is voted from 3 switches.
* Lines are project-wide (`floor: null`) with `byFloor`; no per-room breakdown yet (rooms artifact not used).
* Only electrical / lighting sheets are built (plumbing in a later sprint).

## Sprint 4 — learn from correction, correction re-match, fixtures integration (Worker-A)

Brief: `docs/agents/SPRINT4_BRIEF.md`; contracts `packages/contracts/src/corrections.ts` (`FindSimilarJob`,
`SimilarSearch`, `SimilarCandidate`, `Correction`).

### `symbols.find_similar` job
```
POST /pubsub/ingest {type: "symbols.find_similar"} ─► service/similar.py run_find_similar      (orchestrator)
   jobs/{jobId} + similarSearches/{searchId} (API-created, queued) must exist; succeeded → redelivery no-op
   targets: scope sheet → the exemplar's version; project → + the current ready version of every other sheet
   copies primitives / text / legend / detections (paths must lie under the version prefix) into a workdir
 └─ sandbox task find_similar ─► symbols/similar.py run → find_similar                            (parsing)
   upload crops orgs/{o}/projects/{p}/similar/{searchId}/{c_n}.webp; fill the SimilarSearch contract fields
   (status, candidates [{id c_n, sheetId, versionId, centerMm, bboxMm, score, alreadyDetected, currentClass,
   thumb}], thumbs = number of crops, finishedAt, error); search stats → jobs/{jobId}.result
```
* **Template** = the exemplar's strokes built *exactly* like a legend template (`template.build_template` on a
  synthetic `LegendEntry`): segments with both ends inside the box (+0.25 mm) whose path is symbol-sized, and
  of the connected stroke groups only those with ≥ 60 % of their length inside (a loose box on a switch bank
  does not take the neighbour's lever). Rotations / mirror / anchors / forward+reverse chamfer / fill / NMS =
  `symbols.match` unchanged.
* **Scale**: searched at ratio 1 and, when both sheets have a scale and they differ, at exemplar/target scale.
* **Scene** per target: strokes in an exemplar colour (±90 RGB), minus legend tables (`legend.json.gz`) and the
  title block (`read_title_block` on `text.json.gz`). Candidates with quality ≥ 0.5, the exemplar itself
  dropped, score desc (deterministic ties), ≤ `maxCandidates`.
* **alreadyDetected / currentClass**: detection within 3 mm of the candidate centre — exemplar class family first,
  symbols before derived fixture records (`d_fx_*`, an AC snapped onto its socket), then nearest.
* An empty exemplar box (no strokes) is a succeeded search with 0 candidates (`result.reason = empty_exemplar`).
* **Measured** (Noah, 15 A3 sheets, `scope: project`, exemplar socket_double `d_1` on eb8be8a3): **2.9 s** end to
  end (sandbox start + 15 sheet loads 1.1 s + search 1.4 s + 43 crops); 43 candidates (28 ≥ 0.85, 42 ≥ 0.7): every
  socket glyph on eb8be8a3 + c054fd3a (single/double/triple are one drawing — `currentClass` tells them apart),
  42 already detected, 1 not detected (c054fd3a (93.5, 256.8), score 0.61). Scope `sheet`: 10 candidates in 1.0 s.
  Other exemplars: switch_single 3.5 s (41: 1bbe4113 21, b2046277 12, c054fd3a 7 …), luminaire_ceiling 2.5 s.

### `symbols.rematch` (pure; for Worker-BOQ's `boq.build` and the API queue)
`rematch(corrections, new_detections, *, sheet_id=None, version_id=None, default_radius_mm=3.0) -> [Rematched]`
(input order; `.to_json()` → `{correctionId, status, detectionId, distanceMm}`). Statuses: `matched`,
`unmatched` (→ "תיקון לא הותאם"), `already_detected` (an `add` the detector now finds), `added`, `manual`
(measure/count), `reverted`, `other_sheet`, `other_target` (link/unlink, group/room targets). Rule: anchorMm
within radiusMm of the detection centre + same `class_family` of the reference class (`fromClass` if present,
else `class`; none for reclassify) — signature equality breaks ties; one new detection per edited item
(corrections sharing an old `detectionId` travel together); same version → `detectionId` kept.
`rematch_ids(ids, old_dets, new_dets)` re-maps the switchIds/pointIds of link corrections.

### Fixtures integration (understand)
`fixtures.detect(vs, spans, rooms, discipline, regions=, scale_denominator=, detections=)` (Worker-B, feature-
checked import) runs after rooms on architecture / master / construction / plumbing / electrical (AC) sheets.
Its records become `Detection`s (ids `d_fx_*`), go through the same floor rule (`קומה לא ודאית`) and lifecycle
(plumbing default new) and are written into `detections.json.gz`; the Sprint-2 plumbing text anchors are dropped
where the stage ran. Extended records (source / attachedTo / label / leaderMm) → `fixtures.json.gz`
(`fixturesFile`; the orchestrator uploads it next to `detections.json.gz` — **not** in `SheetVersion.artifacts`,
which is strict: request `artifacts.fixtures` from the API agent). `fixtureStats {total, byClass}` in the task
result. Rooms get `type`/`wet` from `rooms.types.room_type` with the fixtures inside when the Room objects carry
those fields. Detections now also carry `signature` (legend entry / unknown-cluster stroke signature).

### Results (`ingest_local.py --force`, 15/15 succeeded, 295 s total on a shared 2-vCPU box)
| sheet | discipline | detections by class (incl. fixtures) | s/sheet |
| --- | --- | --- | --- |
| 08222cb2 | master | basin 1, kitchen sink 1, wc_concealed 1 | 20.9 |
| 1470f005 | construction | basin 1, kitchen sink 1, wc_concealed 1 | 15.2 |
| 1bbe4113 | lighting | fan 6, ceiling 15, outdoor 1, pendant 1, wall 1, switch_2way 5, switch_single 14 | 32.3 |
| 24ab0ea0 | plumbing | ac 2, basin 2, shower 1, washing machine 1, wc_monoblock 1 | 14.5 |
| 2a308827 | plumbing | ac 5, faucet_wall 3, basin 3, bath 1, shower 1, washing machine 1, wc_concealed 2 | 12.0 |
| 6fa88f92 | master | basin 3, bath 1, kitchen sink 1, wc_concealed 3 | 26.5 |
| 8099ab2c | construction | basin 3, bath 1, wc_concealed 2 | 8.9 |
| 8d51ed5a | plumbing | ac 1, basin 1, kitchen sink 1, wc_concealed 1, garden_tap 2 | 16.2 |
| ad257a1c | construction | kitchen sink 1, wc_concealed 1 | 12.7 |
| b2046277 | lighting | ceiling 9, outdoor 10, pendant 1, strip 3, wall 3, switch_2way 3, switch_single 10 | 30.0 |
| c054fd3a | electrical | ac 6, doorbell 1, heater 4, intercom 1, panel 1, socket double 11 / power 5 / single 17 / triple 4, switch 5, tv 8 | 45.0 |
| eb8be8a3 | electrical | ac 2, socket 3phase 3 / double 4 / power 2 / power_double 1 / single 5 / triple 2, speaker 3 | 27.4 |
| 70a5c3e0 / af849ec4 / f14c7573 | demolition | — | 8–9 |
kbench (same GT files): Sprint-2/3 classes unchanged — semantic micro-F1 on those classes 0.818 (TP 135 / FP 24 /
FN 36) before and after, every per-class row identical; `eval-links` identical (exact R 28/30, P 28/29, green
12/12). New classes (GT added by Data/QA): ac_unit F1 0.82, basin 0.95, wc_concealed 0.92, bath / faucet_wall /
washing machine / garden_tap 1.0, kitchen sink 0.86, wc_monoblock 0.67, shower 0 (Worker-B). Overall semantic
micro-F1 0.823; the glyph-level number drops (0.869 → 0.757) only because fixtures have no legend glyph in the
truth (text-only items are excluded there, the predictions are not) — a kbench reporting artefact.

### Tests / commands
`tests/test_similar.py` (13: orientations, alreadyDetected preference, loose box on a switch bank, empty box,
scale ratio between 1:50 / 1:100 sheets, WebP crops, job sheet/project scope through the real sandbox, errors,
push routing, contracts mirror of FindSimilarJob / SimilarSearch / SimilarCandidate), `tests/test_rematch.py` (9),
`tests/test_understand_fixtures.py` (4). Files touched outside my dirs (additive): `sandbox/tasks.py` (task
`find_similar`), `service/pipeline.py` (upload `fixturesFile`).

### Gaps
* find_similar searches stroke drawings only (no raster sheets); text inside the box is part of the template
  (a box including "2X" finds only "2X" sockets — by design, but undocumented in the UI).
* Single / double / triple sockets are one glyph: candidates of the other members appear with their
  `currentClass`; the web slider + class column must make that visible.
* `fixtures.json.gz` is not referenced from the version doc until the contracts allow `artifacts.fixtures`.
* Room `type`/`wet`/walls/openings come from Worker-B's rooms upgrade (not yet in `rooms.json.gz` at this run).
* mypy: 12 errors remain in Worker-B's `fixtures/` (in progress); none in Worker-A files.

## Sprint 4 — plumbing, tiling, corrections in `boq.build` (Worker-BOQ)

Brief: `docs/agents/SPRINT4_BRIEF.md`. Contracts (API agent): `library.ts` rule kinds `plumbing_point`,
`tiling_floor`, `tiling_cladding`, `tiling_corner`, `waterproofing`, `one_off_suggestion` (+ `wasteFactor`),
`corrections.ts` (`Correction`, `RoomSettings`, `defaultRoomSettings`), `boq.ts` (line `orderQty` / `wasteFactor` /
`manualCount`, evidence `source` / `correctionId` / `quantity` / `roomId` / `verified`, evidence-file
`corrections {applied, unmatched}`, build `debounceUntil` / `afterBuildId`). Mirrors: `boq/rules.py` `DEFAULT_RULES`
(defaults v3, diffed against `boq-defaults.json`), `tiling.default_settings` (= `defaultRoomSettings`);
`tests/test_boq_contracts.py` validates lines / evidence / build / corrections / roomSettings / rooms against the
generated JSON schemas.

### Modules (`boq/`, all pure except `build.py`)
* `spaces.py` — `Room` from `rooms.json.gz` (Sprint-4 fields optional; missing `type` inferred from the name:
  רחצה→bathroom, שירותים/ש.אורחים→wc, מטבח, חצר אנגלית→courtyard, …). **Canonical rooms** per floor = the rooms of
  the best room-source sheet (construction > architecture > architecture_master > plumbing > electrical > lighting;
  demolition never). `roomSettings/{sheetId}__{roomId}` saved on any sheet's copy of a room is mapped onto the
  canonical room (same floor, area ± 15 %, name/type similarity; own doc wins, else latest `at`).
* `plumbing.py` — `plumbing_point`: per fixture the first rule by priority (fixtureClasses, floors, roomTypes /
  roomNamePatterns of its room — no room → passes with `פריט מחוץ לחדר`, faucet within `faucetRadiusMm` real mm on the
  same sheet and not in another room); `perRoom` → one unit per (rule, room). Basin counted by a `withoutFaucet…`
  rule with no faucet nearby → `סוג ברז לפי ברירת מחדל`. A covered class no rule matches → red "לא משויך".
  `one_off_suggestion`: ANY trigger (always / classes / textPatterns in sheet OCR text / roomTypes of canonical
  rooms), all restricted to `floors`; qty = `quantity`, always yellow `הצעה – לאשר ידנית`, evidence = first cue.
* `tiling.py` — per room and measure the first rule whose `roomTypes` include the (settings-overridden) type, else
  the measure's first rule + `שיוך לפריט לפי כלל ברירת מחדל`. Floor area (floorTiled; `wetOnly` = wet room or an
  explicit user doc); full cladding = perimeter × h − doors w × min(h_door ?? 2.1, h) − windows w × max(0, min(h,
  sill + (h_win ?? 1.2)) − sill), sill 1.0 m, `keepOpenings` skipped; no openings in the artifact → one 0.8 m default
  door + `פתחים לא זוהו — הופחתה דלת ברירת מחדל`; partial = Σ (toM − fromM) × heightM; corner trim =
  externalCorners × h (unknown → qty 0 + `פינות חיצוניות לא זוהו`); waterproofing 1 קומפלט per room. Items: the room's
  `floorMaterialItemCode` / `wallMaterialItemCode` override the rule's. `orderQty = qty × (1 + waste)` on rules with
  a `wasteFactor` (the room doc's wins). Level: room not closed / unnamed → yellow; no user-confirmed doc (`by`) →
  `הגדרות חדר לפי ברירת מחדל` (≤ yellow) ⇒ green only when every room is closed, named and confirmed.
* `corrections.py` — `parse_corrections` (skips `revertedAt`, invalid docs; order `at`, id) and
  `apply_corrections(sheets, corrections, old_detections)` applied after floor confirmation, before prepare:
  accept → green `אושר ידנית` (evidence `verified`), reject / remove → dropped (also from link groups), reclassify →
  class / itemCode win over legend entries / mappings / label rules, green `סווג ידנית`; move → new centre + room;
  add → manual detection `m_{corrId}` (`source: manual`, green `נוסף ידנית`); link / unlink → human groups (kind from
  counts, green; unlink with only `linkGroupId` dissolves the group); accept / reject / remove of a `linkGroupId`
  (group green / dissolved) or a `roomId` (room green / excluded from tiling); measure → polygon m² / polyline m'
  (paper mm × sheet scale, or `quantity`), count with `itemCode` → one manual evidence item per click, count with only
  a `class` → one manual detection per click (then the normal rules). **Re-matching** uses Worker-A's
  `symbols.rematch.rematch` / `rematch_ids` (anchor within `radiusMm` paper + class family, the old version's
  detections from `versions/{v}/detections.json.gz` supply the family / id positions); an `add` whose item the detector
  now finds accepts that detection instead (no double count). Not applicable → `unmatched` `{correctionId, sheetId,
  versionId (the build's current version), reason}`: `לא נמצא פריט במיקום התיקון`, `הגיליון לא נכלל בבנייה`,
  `קבוצת הקישור לא נמצאה`, `תיקון חסר נתונים`.
* `dedup.py` — fixtures + AC (`DROP_FAMILIES`, worker constant until contracts carry `unmatchedSecondary`): on a
  floor with an authoritative sheet every secondary copy is dropped (text-anchored fixtures are too few to vote an
  alignment). A floor without an authoritative sheet: the secondary sheet with most items of the family is the
  authority for the others (fixtures on both the construction and the architecture plan count once).
* `build.py` — now loads every ready sheet: electrical / lighting / plumbing (all detections), construction /
  architecture(_master) (fixture classes only + rooms), others (rooms, corrections only); texts when a suggestion
  rule has `textPatterns`; `corrections`, `roomSettings`. Writes evidence `corrections {applied, unmatched}`, build doc
  `unmatchedCorrections` (review queue) and `stats.corrections {total, reverted, invalid, applied, unmatched,
  rematched, manual}`. **Debounce**: before `running`, sleeps until `debounceUntil` (re-reading the build doc,
  capped at `createdAt` + 60 s); an `afterBuildId` not yet terminal is polled ≤ 60 s, then the message is handed
  back (retryable, nothing written).

### Local run (`scripts/boq_local.py`)
Writes `SAMPLE_ROOM_SETTINGS` (user inputs: bathrooms 2.6 m — basement 2.2 m to its ceiling per Data/QA's
`gt/noah/tiling`, guest WC 0.8 × 1.5 m partial wall + not waterproofed, kitchen backsplash 2.5 × 0.8 m) and
`sample_corrections()` (SYNTHETIC: accept a basin, add an AC, count 11 stair treads → 5.04, draw the English
courtyard floor 2.08 m² → 5.02, an accept made on version v0 re-matched onto the shower, a remove that matches
nothing). `--no-corrections`, `--room-settings F`, `--corrections F`, `--chapters 3. 5. 4. 9.01`. 0.12–0.4 s/build.
kbench `eval-boq` (gated lines; artifacts of 14.10 23:36 with Worker-B's fixtures, floors unconfirmed):

| scope | no corrections | with the synthetic corrections |
| --- | --- | --- |
| 03 (11 gated; 3.02/3.03/3.04/3.07 disputed but exact) | EM 10/11, ΣAE 4 (3.01 13 vs 9) | EM 10/11, ΣAE 5 (3.01 14) |
| 05 (8) | EM 3/8 (5.05, 5.06, 5.07), ΣAE 35.6 | EM 5/8 (+5.02 18.10, 5.04 11), ΣAE 22.6 |
| 04 + 9.01 (22) | EM 12/22, ΣAE 19 | same |

Chapter 04 + 9.01: **identical** (qty, level, byFloor, evidenceCount, reasons) to the Sprint-3 code (`git archive
HEAD`) run on the same artifacts. 5.01 62.96 vs 57 (no openings / niches in the rooms artifact → one default door per
bathroom; Data/QA's per-room expectation is 57.63 with the real openings), 5.03 0 (no `externalCorners` yet), 5.08 —
(no default rule in the contracts), 3.01 13: c054fd3a / 1bbe4113 are still "basement + ground" (truth basement +
first) — with the owner's floor confirmation the first-floor plumbing AC copies are de-duplicated against c054fd3a
(→ 2 + 2 + 4 = 8, the 9th AC is not on the electrical sheets).

### Tests
`tests/test_boq_s4.py` (14: room types / canonical rooms, plumbing faucet / room / floor rules, fixture de-dup +
fallback authority, suggestions, tiling formula incl. openings / keepOpenings / partial / corners / waste / confirmed
→ green / settings mapped from another sheet / type fallback, corrections accept / reject / reclassify / move / add /
re-match / unmatched / link / unlink / measure / count / rooms, build job end-to-end incl. evidence + build doc,
debounce + afterBuildId with a fake clock), `tests/test_boq_contracts.py` (+2 schema tests).

### Gaps
* 5.01 / 5.03 need Worker-B's `openings` / `externalCorners` on the construction plans (canonical rooms); laundry
  niches are not separate sub-areas. Kitchen sinks count as 3.03 (contracts default rule includes them).
* Room-specific library lines are mapped by the default rules' `floors` (3.13 basement shower) — no general
  name-similarity assignment (contracts have no `roomKeywords`); `roomNamePatterns` is the configurable path.
* `unmatchedSecondary` is a worker constant (`DROP_FAMILIES`); a lone wall faucet (no basin) is never counted.
* Corrections on sheets not loaded by the build (no current ready version) are unmatched; the old-version detections
  are read from Storage per (sheet, version) once per build.

## Sprint 4 — fixtures/rooms (Worker-B)

Brief: `docs/agents/SPRINT4_BRIEF.md`. Pure modules (no I/O except the `debug.py` tools). New package
`kamutan_drawing.fixtures`; `rooms/` gains tiling geometry, types, wall borrowing and sheet alignment.

### API (exact signatures — Worker-A integrates in `pipeline/understand.py`, Worker-BOQ consumes)
```python
from kamutan_drawing.fixtures import detect, fixtures_json, dedupe_floor, SheetFixtures, anchors_from_rooms
detect(prims: VectorSheet, text: Sequence[TextLike], rooms: Sequence[Room | dict], discipline: str | None, *,
       regions: Sequence[Region | dict] | None = None, scale_denominator: int | None = None,
       detections: Sequence[Detection | dict] | None = None, debug: dict | None = None) -> list[FixtureDetection]
FixtureDetection.to_json(*, extended=False) -> contracts Detection dict (id "d_fx_<n>", lifecycle "unknown")
    extended=True adds source ("shape"|"text"|"shape+text"), attachedTo (faucet → fixture id), label, leaderMm,
    and after dedupe_floor sheetId + duplicates ["sheetId/detId"]
fixtures_json(dets) -> {"schema": "kamutan.fixtures/1", "fixtures": [extended dicts]}
dedupe_floor(sheets: Sequence[SheetFixtures]) -> list[FixtureDetection]          # one floor, project level
SheetFixtures(sheet_id, discipline, floor, fixtures, scale_denominator=50, page_size=(w, h),
              anchors=anchors_from_rooms(rooms_of_that_floor), room_polygons=[r.polygon_mm ...])

from kamutan_drawing.rooms import segment, apply_fixtures, reference_walls, reference_walls_json, reference_walls_from_json
segment(prims, text, region_polygons, scale_denominator, *, exclude_paths=None, debug=None,
        reference_walls: Sequence[ReferenceWalls] | None = None) -> list[Room]     # Sprint-2 signature + 1 kwarg
apply_fixtures(rooms, fixtures) -> None        # type / wet from fixtures inside (FixtureDetection or Detection dicts)
rooms.types.room_type(name, fixture_classes, area_m2) -> (type, wet, notes)   # what apply_fixtures uses
Room.to_json(*, extended=False)   # extended adds type, wet, walls, openings, externalCorners, externalCornersMm,
rooms_json(rooms, *, extended=False)  #   typeSource — keep False until the contracts' Room carries them
reference_walls(prims, regions, scale_denominator, *, sheet_id=None, exclude_paths=None) -> list[ReferenceWalls]
reference_walls_json(refs) -> {"schema": "kamutan.walls/1", drawings: [{floor, scaleDenominator, sheetId,
                               regionId, polygonsMm, closuresMm}]};  reference_walls_from_json(doc) -> refs
rooms.align.align(a, b) / align_polygons(polys_a, polys_b) -> Alignment(dx, dy, iou) | None   # a → b translation
```
Call order on a sheet: `rooms = segment(...)` → `fx = detect(vs, spans, rooms, discipline, regions=…,
scale_denominator=…, detections=symbol_dets)` → `apply_fixtures(rooms, fx)`; append `f.to_json()` to the
detections (drop Worker-A's Sprint-2 plumbing text anchors where `detect` ran — done in understand). Wall borrowing
needs the architecture walls of the same floor: the service would store `reference_walls_json(...)` of each
construction / master version (`walls.json.gz`) and pass `reference_walls_from_json(...)` (construction first) to
the MEP sheets' `segment` — **not wired yet** (service / understand owners).

### Fixtures (`fixtures/`)
* `shapes.py` — the furniture pen (thin solid grey r=g=b 90–235; *text paths are not excluded*: fixture blocks are
  exploded into tiny arc paths that the SHX heuristic flags) → connected components (0.08 mm) with *children*
  (rings inside) → features in metres (oriented box L×W, curved share, hull fill, X diagonals, round child) →
  rules: WC (0.45–0.85 × 0.28–0.52, D/oval bowl; tank box ≥ 0.62 m → monoblock else concealed, always
  `סוג אסלה לפי צורה`), basin (oval 0.28–0.75, hull fill 0.7–0.86, or a 0.3–0.6 m circle), bath (1.35–2.05 ×
  0.5–0.98 box with a rounded tub), shower tray (0.7–1.5 square with an X), washing machine (0.5–0.78 square with
  a drum; also drum circle + square sides when the square is merged into a niche outline), kitchen sink (box
  0.4–1.25 × 0.38–0.66 with a drain ring). No fixture inside another (WC seat ≠ basin).
* `labels.py` — text lines → note blocks (stacked ≤ 0.7 line height and aligned, or pieces of one row) → kind by
  ordered keyword rules (normalised Hebrew, 1 fuzzy pass for long words; whole-token "מ.א"/"מ.כ"); markers veto a
  block ("ברז לניאגרה", "פירוק…", "משאבה", "חדר כביסה", "ומייבש").
* `leaders.py` — dark thin straight strokes (glyph strokes inside ≤ 5 mm text boxes dropped), endpoint graph
  (0.25 mm); seeds = segments ≥ 1.5 mm touching the block (underlines); BFS end-to-end (≤ 24 pieces); terminals =
  free ends ≥ 2 mm outside the block and not on another note. "V" leaders give two terminals.
* `detect.py` — discipline gates (arch/master/construction: shapes + "מסתור ניאגרה"-like notes; plumbing: all;
  electrical: AC only; demolition/lighting: nothing). A label picks the compatible shape its leader ends on
  (box + 0.3 m) or passes over; else the nearest compatible shape in its room ≤ 2.5 m / anywhere ≤ 1.5 m
  (`קו הפניה לא נמצא` / `קו הפניה לא ודאי`); else a text-only item at the leader end (`זוהה מכיתוב בלבד`).
  Faucet notes → one faucet per served basin/sink (`attachedTo`), the note also confirms the basin. Shower notes
  / mixers → one shower per room unless the room has a bath (then annotations on the bath). Shapes in named dry
  rooms (bedroom, living, corridor, storage, stairs, balcony) are dropped unless a label confirms them; kitchen
  sinks only in kitchen/living/unnamed rooms. AC: drain / socket notes are units, "מזגן עילי" joins the nearest
  unit ≤ 1.5 m; electrical AC snaps to the nearest socket detection ≤ 15 mm (`מזגן לפי שקע H=240`).
  Scores: shape+leader 0.9, shape+nearest 0.8, shape only 0.6–0.72 (`זוהה מצורה בלבד`), text only 0.55–0.62.
* `dedupe.py` — authority plumbing > master > construction > electrical; alignment by room outlines (FFT,
  IoU ≥ 0.3) else family votes (+ room-name anchors) else identity on equal pages else `יישור גיליונות נכשל`;
  match radius 0.5 m (AC 1.6 m, tap 1.0 m); a text-only item confirmed by a drawn copy → `shape+text`; for sinks
  the drawing's class (basin / kitchen sink) wins, for WCs the label's type.
* Classes `fixture_shower`, `fixture_bath`, `fixture_kitchen_sink`, `fixture_washing_machine`, `garden_tap`,
  `ac_unit` are **not yet in** `benchmark/schema/classes.json` / contracts `DetectionClass` (Data / API agents);
  `tests/test_fixtures.py` validates against `Detection.json` with them added.

### Rooms (`rooms/`)
* `walls.py` — `WallSet.openings: [Opening(kind door|window, a, b, width_mm, via)]`; door sweeps 60–180°; when the
  arc's closed end is not on a wall (door in a slanted wall, pivot / double door) the opening is closed from the
  hinge to the nearest wall *corner* 0.6–2 radii away within ±60° of an arc end, through free space (fixes the
  ground-floor pivot entrance: open plan 70.2 m² "not closed" → 68.4–68.6 m² closed). `reference=` /
  `reference_closures=`: borrowed walls / door-window closures (`WallSet.borrowed`).
* `geometry.py` — walls (polygon simplified 0.5 mm, collinear < 10° merged, edges < 5 cm folded), `exterior` (space
  0.6/1.0/1.5 m behind the face outside the envelope), openings on the room boundary (≥ 50 % within 0.4 m; door =
  leaf radius or hinge→jamb, window = glazing length, `heightM` null), `perimeterM` = inner face incl. openings,
  **`externalCorners` = reflex vertices of the simplified room polygon (turn ≥ 30°, both edges ≥ 10 cm) — wall
  ends / pillars / shafts protruding into the room and window-recess reveals; corners ≤ 30 cm from a door's
  closing line are excluded (door frames)**, with their points in `externalCornersMm`.
* `types.py` — name → type (merged names: wettest; "סלון" in an open plan → living), fixtures complete it
  (shower/bath → bathroom, WC → wc ≤ 4 m² else bathroom, kitchen sink in an unnamed room → kitchen); `wet` =
  bathroom | wc | laundry room; a named dry room holding a wet fixture stays dry.
* `reference.py` + `align.py` — MEP sheets borrow the architecture walls of the same floor: FFT correlation of wall
  masks (1 px/mm, refined at 4 px/mm), accepted at IoU ≥ 0.45; pieces the sheet lacks (wall-like) and closures it
  could not bridge are added; rooms touching them get `קירות הושלמו מגיליון אדריכלות` (≤ 0.8, yellow).
  c054fd3a basement: bedroom+living 41.9 m² → bedroom 14.9 + living/kitchen 25.5 (same as the master sheet);
  master suite on c054fd3a closed (window closure borrowed).

### Results (Noah, local artifacts; floors of the two-plan sheets set to the owner convention r1 = first)
Fixtures after `dedupe_floor` (`/home/claude/kamutan-data/debug/fixtures_*.png`):
| floor (sheets) | fixtures | per room |
| --- | --- | --- |
| ground (08222cb2, 1470f005, 8d51ed5a, eb8be8a3) | WC concealed 1, basin 1, kitchen sink 1, garden tap 2 (ברז גן + תמי 4), AC 2 | שירותים: WC + basin · living: kitchen sink, garden tap (תמי 4) · outside: garden tap, AC ×2 |
| basement (24ab0ea0, 6fa88f92 r0, ad257a1c, c054fd3a r0) | WC monoblock 1, basin 1, shower 1, kitchen sink 1, washer 1, AC 2 | bathroom: WC-m + basin + shower · living/kitchen: kitchen sink, AC · niche: washer, AC |
| first (2a308827, 6fa88f92 r1, 8099ab2c, c054fd3a r1) | WC concealed 2, basin 3, bath 1, shower 1, faucet_wall 3, washer 1, AC 5 | general bath: WC + 2 basins + 2 wall faucets (one "V" leader) + bath · master bath: WC + basin + wall faucet + shower · bedrooms/TV room/corridor: AC ×5 · niche: washer |
Implied plumbing points vs `boq_truth.json`: 3.04 concealed WC 3/3, 3.07 monoblock 1/1, 3.02 basin + wall faucet
3/3, 3.03 basins/sinks without wall faucet 4/4, 3.05 washers 2/2, 3.06 garden taps 2/2, 3.01 AC 9/9, showers 2
(3.11 master, 3.13 basement) + bath 1 (3.12). Single sheets: 2a308827 16 items, 24ab0ea0 7, 8d51ed5a 6, c054fd3a
6 AC (+1 merged "מזגן עילי"), eb8be8a3 2 AC; master/construction sheets 2–8 shape items (yellow), demolition /
lighting 0.

Wet rooms (`rooms_v4_*.png`, master sheets):
| floor | room | area m² | inner perimeter m | openings | external corners | walls (ext.) |
| --- | --- | --- | --- | --- | --- | --- |
| ground | שירותים (wc) | 2.21 | 6.03 | door 0.67, window 0.58 | 0 | 7 (2) |
| basement | חדר רחצה | 3.72 | 8.49 | door 0.62 | 1 | 7 (1) |
| first | ח.רחצה כללי | 5.04 | 9.64 | door 0.62, windows 1.20 / 1.40 (one is the laundry niche's) | 2 | 8 (1) |
| first | ח.רחצה הורים | 4.86 | 8.97 | door 0.62, window 1.00 | 1 | 8 (4) |
Same rooms on the MEP sheets within ±0.3 m² (master bath 4.7–5.0 depending on the window closure). 5.03 truth
15.6 m' (= 6 corners × 2.6 m if all three bathrooms) vs 4 corners here (2+1+1); not tuned.

### Commands / tests
```bash
uv run python -m kamutan_drawing.fixtures.debug [fileId…]      # fixtures_*.png + per-room table
uv run python -m kamutan_drawing.rooms.debug --v4 [fileId…]    # rooms_v4_*.png (borrowed walls magenta) + wet table
KAMUTAN_DATA_DIR=/home/claude/kamutan-data/sample-noah uv run pytest -q tests/test_fixtures.py tests/test_rooms_v4.py
```
`tests/test_fixtures.py` (39: label kinds/blocks, synthetic reportlab plan with WC/basins/bath/kitchen sink/washer +
leaders incl. a "V", monoblock label, shape-only on arch, shower from mixer, discipline gates, AC snapping / merging,
dry-room filter, text-only at leader end, Detection contract, determinism, dedupe (translation, failure, room
alignment), 4 sample tests), `tests/test_rooms_v4.py` (23: walls/openings/perimeter/exterior, pillar corners,
slanted door → jamb, borrowed partition + JSON round trip + other floor ignored, alignment, room types,
apply_fixtures, 3 sample tests). Full suite `--ignore=tests/fuzz`: 425 passed (290 s). ruff / ruff format / mypy
(CI: `uv sync --locked --all-groups --all-extras`; `uv run --with mypy==2.4.0 mypy src`) clean. Runtime (A3, this box):
rooms incl. geometry 0.2–0.6 s, fixtures 0.2–0.65 s, rooms with a reference sheet 0.15–1.2 s.

### Gaps
* Shapes are tuned on one office's blocks (grey furniture pen, these WC/basin/bath drawings); another office's
  blocks need the rules widened (sizes are in metres, so scale is handled). Showers are mostly text-driven (the
  sample draws no trays); a shower on an architecture sheet without a tray is not found.
* WC type from the shape alone is a guess (the sample's monoblock and concealed blocks are the same drawing) —
  the plumbing note decides; always yellow without it.
* OCR misses some notes (ground "ניקוז למזגן" in the bay: AC 1 instead of 2 on 8d51ed5a — the electrical sheet
  supplies it after dedupe). Some leaders are not followed (labels whose leader starts inside a long merged block
  or crosses other notes) → nearest-in-room fallback (yellow).
* `dedupe_floor` needs correct floors: on the two-plan sheets (6fa88f92 / c054fd3a / 1bbe4113) the second plan is
  classified `ground` until the owner confirms `first` (Sprint-3 floor confirmation).
* Wall borrowing is not wired into the service (reference JSON per version + passing it to MEP sheets). Openings
  borrowed as closures have no kind / width. Master sheets also show demolished walls — use construction sheets as
  the reference when both exist.
* `externalCorners` counts reflex corners only (no window-reveal depth threshold beyond 10 cm edges); a room that
  leaks ("חדר לא סגור") gets corners from the leak. Door/window heights are always null (not in plan).
* New classes + room fields need the contracts (Detection class enum, Room optional fields); until then
  `to_json()` stays on the Sprint-2 schema and the extended data is only in `fixtures.json.gz` / `extended=True`.

## Sprint 4 — integration (Worker INTEGRATOR)

Builds on Worker-A / Worker-B / Worker-BOQ's Sprint-4 work (sections above). Everything below is in
`workers/drawing`; contracts / API asks are listed at the end.

### Rooms artifact + wall borrowing + floor inference
* `rooms.json.gz` now carries the contracts' optional Room fields (`type`, `wet`, `walls`, `openings`,
  `externalCorners`): understand writes `Room.to_json(extended=True)`, which is now *contract-only* (validated against
  `RoomsArtifact.json` in `tests/test_rooms_v4.py`); the debug-only `externalCornersMm` / `typeSource` moved behind
  `extras=True` (`rooms_json(rooms, extras=True)`). Openings without a wall id are dropped; walls ≤ 512, openings ≤ 256.
  Room types / wet come from Worker-B's `apply_fixtures` (also when the fixtures stage did not run).
* **Walls** (`kamutan.walls/1`, Worker-B's `rooms.reference_walls_json`): understand writes `walls.json.gz` on
  construction / architecture / master sheets (`wallsFile` in the task result); the service uploads it under the
  version prefix (found by name — not in `SheetVersion.artifacts`).
* **Borrowing**: before the `understand` task the service copies the `walls.json.gz` of the project's *other current*
  versions into the workdir (`_reference_walls_files`: construction first, then architecture, then master; a master
  sheet borrows from construction / architecture only; construction sheets borrow from nobody; ≤ 8 sheets, ≤ 20 MB
  each) and passes them as `referenceWalls`; `rooms.segment(..., reference_walls=…)` uses the ones of the region's floor.
  `scripts/ingest_local.py` processes construction → architecture → master → the rest so the references exist.
* **Floor inference** (`rooms.reference.infer_region_floors`): a region whose walls align with another floor's
  reference drawing at IoU ≥ 0.45 and ≥ 0.25 better than with its own (title-block) floor takes that floor — the
  stacked two-plan sheets titled "basement + ground" whose second plan is the first floor (c054fd3a / 6fa88f92 /
  1bbe4113: ground-plan IoU 0.17 vs first 0.98). Applied before detect (detections, rooms, fixtures get the floor),
  returned as `regionFloors`; the service writes it into the version's `regions[].floor` and the sheet's `floors`
  (never on `confirmed` sheets; the `קומה לא ודאית` chip stays until the owner confirms).

### Fixtures (error patterns of `gt/noah/eval_sprint4.md`)
* **Showers at the shower zone** (`fixtures.detect._shower_zones`): faces of (thin grey strokes in the room + the room
  outline) sized 0.7–2.0 × 0.6–1.5 m, ≥ 85 % rectangular, touching the room outline, holding no other fixture — the
  one nearest the shower note / mixer (≤ 2.5 m) gives the centre (`מקלחת במרכז תא המקלחת`, `shape+text`); none →
  stays on the note with `תא מקלחת לא זוהה — לפי הכיתוב`. On plans (no notes) a bathroom without bath / shower whose
  corner holds a squarish enclosure gets a shape-only shower (yellow).
* **Text-only items on their note** (`_snap_text_items`): AC drain notes snap to the `+` point mark
  (`shapes.cross_marks`: two dark single-segment strokes 2.5–8 mm crossing at their middles — flagged as SHX text,
  so text paths are included) at the leader end (≤ 6 mm) or, when the leader was confused, the free one nearest the
  note (≤ 12 mm). Sink notes ("נק' מים+ביוב") snap to the nearest sink-sized box outline (`shapes.sink_boxes`) in the
  same room (≤ 1.5 m); class by context: kitchen / living room or a "מטבח" name ≤ 3 m → kitchen sink, bathroom / wc →
  basin.
* **Lifecycle**: fixtures on plans default to `new` (`unknown` / `demolish` → `new`: on renovation plans the old
  fixture drawn in the demolition pen is replaced at the same spot); `existing` is kept.

### BOQ
* **AC authority by floor** (`boq/dedup.py`, `AUTHORITY_ORDER = {"ac": ("plumbing", "electrical")}`,
  `ROOM_FAMILIES = {"ac"}`; overridable per rule with `match.authorityOrder` / `match.matchRooms` /
  `match.roomMatchRadiusMm`): the plumbing sheet's drain marks are the plan of record; electrical AC sockets only fill
  floors without a plumbing sheet. Secondary items are placed by the translation of the two sheets' room outlines
  (`rooms.align.align_polygons`, IoU ≥ 0.4; item votes / identity as fallback) and matched one-to-one — same room of the
  authoritative sheet first (items ≤ 0.8 m outside a room belong to it), else ≤ 1.6 m; unmatched copies are kept
  (`פריט מגיליון משני`, yellow) — e.g. the ground-floor unit whose drain note OCR missed. No placement → all dropped.
  Fixtures keep `DROP_FAMILIES = {"fixtures"}` (plumbing sheet wins, master / construction copies dropped).
* **Tiling defaults** (Data/QA's back-solved conventions; a user's `roomSettings` doc always wins):
  default cladding = min(2.6 m, ceiling) with the ceiling read from a level mark ("-2.55 H=220", one line or stacked)
  inside / ≤ 0.5 m from the room (`spaces.level_marks` / `ceiling_heights`; plan sheets now always load their text);
  windows sill 1.0 m, head capped at 2.1 m (`TilingParams.window_head_m`); doors 2.1 m; corner trim = externalCorners
  × height (Worker-B's corners now in the artifact); waterproofing by default only for rooms with a shower or bath
  (fixtures of any sheet mapped onto the canonical room by `match_room`; a floor without fixture information keeps
  the type default).

### Results (Noah)
`ingest_local.py --force`: 15/15 in 256 s, max 40 s/sheet (c054fd3a) on a 2-vCPU box shared with other agents;
`boq_local.py` 0.2–0.4 s/build. kbench on the same GT (`gt-v0.4.1-draft`):

| metric | before (Sprint-4 dev run) | after |
| --- | --- | --- |
| kbench eval, Sprint-2/3 classes | per-class rows of Worker-A's run | **identical** (every row) |
| semantic micro-F1, all classes | 0.823 | 0.847 |
| eval-links exact R / P / green | 28/30, 28/29, 12/12 | 28/30, 28/29, 12/12 |
| eval-fixtures micro-F1 (3 mm) | 0.840 (P .875 R .808) | **0.941** (P .960 R .923) |
| fixture_shower / kitchen_sink / ac_unit F1 | 0 / 0.857 / 0.824 | 1.0 / 1.0 / 0.882 |
| fixtures items correct before review | 0.491 (floor 10, lifecycle 11) | 0.906 (class 1, unmatched 1) |
| rooms: type acc / wet F1 / openings R | 0 / 0 / 0 (fields missing) | 1.0 / 1.0 / 0.857 |
| eval-boq 03 gated, no corrections | EM 10/11, ΣAE 4 (3.01 13) | **EM 11/11, ΣAE 0** |
| eval-boq 03, demo corrections | EM 10/11, ΣAE 5 (3.01 14) | EM 10/11, ΣAE 1 (3.01 10 = the synthetic "add an AC") |
| eval-boq 05, no corrections | EM 3/8, ΣAE 35.6 (5.03 0) | EM 3/8, ΣAE 22.9 (5.03 12.6) |
| eval-boq 05, demo corrections | EM 5/8, ΣAE 22.6 | EM 5/8, ΣAE 9.8 |
| eval-boq 04 + 9.01 | EM 12/22, ΣAE 19 | EM 12/22, ΣAE 19 |

### Tests
`tests/test_integration_s4.py` (floor inference, `+` marks, AC room-aware authority + electrical-only floor, level
marks, ceiling cap / window head / waterproofing by fixtures, service reference-walls order + `regionFloors`
cleaning); `test_rooms_v4.py` validates the extended rooms document against `RoomsArtifact.json`;
`test_boq_s4.py` updated (a bath holding only a WC is no longer waterproofed by default).

### Gaps
* 5.01 62.8 vs 57 (Data's rule 57.63) / 5.02 16.0 vs 18.1 / 5.03 12.6 vs 15.6–17: geometry, not defaults — the laundry
  niches are cut off the bathroom polygons (basement 3.73 vs 4.64 m², first bath 5.04 vs 5.88) and their mouths are
  counted as clad wall; the master bath is "not closed" (window not found); corners 1/2/2 vs 3/3/1. "Niche walls not
  clad" / "floor incl. niches" need niche sub-areas from Worker-B's rooms.
* Level marks are not OCR'd on this sample (SHX), so the ceiling cap does not fire here (the demo settings set the
  basement bath to 2.2 m).
* Wall borrowing / floor inference read the references available *when a sheet is processed*: a construction plan
  uploaded after the MEP sheets does not update them until they are reprocessed.
* WC type on plans without a note is a shape guess (6fa88f92 basement monoblock read as concealed).

### Final sync (rules v5, artifacts)
* `SheetVersion.artifacts.fixtures` / `.walls` are written (`FIXTURES_IN_ARTIFACTS = True`); all 15 local version docs
  validate against `SheetVersion.json`; `tests/test_integration_s4.py` runs a confirmed construction plan through the
  real pipeline + sandbox and validates the version doc, `WallsArtifact`, `FixturesArtifact`, `RoomsArtifact`.
* Contracts (edited by the integrator, `DEFAULT_BOQ_RULES_VERSION` 5): `AuthorityMatchSchema` + `authorityOrder`,
  `matchRooms`, `roomMatchRadiusMm`; `r_auth_ac` = plumbing first (electrical fills floors without a plumbing sheet),
  room-aware, 1.6 m. Floor tiling stays bathrooms + WCs (+ niches): courtyard OUT by default (GT-D-007).
  `boq/rules.py` mirrors v5 (diff test green). `tiling.py` implements the v4/v5 match fields: `defaultWindowSillM` /
  `defaultWindowHeadM`, `capAtCeiling` (also caps explicit heights, per contracts), `excludeNiches` (niche rooms not
  clad, no corners), `includeNiches` (niche rooms floor-tiled with the bathrooms), `requireFixtureClasses`
  (waterproofing default only with shower / bath; explicit settings win); `default_settings` = contracts
  `defaultRoomSettings(type, wet, {ceilingHeightM, niche, hasShowerOrBath})` (unknown fixtures → bathroom yes, wc no).
  A room of another type reaches a measure's first rule only through an explicit settings doc.
* Rooms emit `ceilingHeightM` from level marks inside them (none OCR'd on Noah); `niche` is read by the BOQ but not
  emitted — niche sub-rooms are not segmented yet (Worker-B gap; 5.01 / 5.02 remain geometry-limited).
* Re-run (ingest 15/15 in 254 s, max 39 s/sheet): every kbench number identical to the table above (03 11/11 exact,
  05 3/8 ΣAE 22.9 / 5/8 ΣAE 9.8 with demo corrections, 04+9.01 12/22).

## Sprint 5 — laundry niches, master-bath window, upload-order dependency (Worker-B)

Brief: `docs/agents/SPRINT5_BRIEF.md` §8. Owned code: `rooms/`, `fixtures/` (unchanged), `lifecycle/`; plus the two
Sprint-5 fields on the shared `types_sprint2.Room` (`niche`, `parent_room_id`). No change in `pipeline/` /
`service/`: understand already writes `Room.to_json(extended=True)` and calls `apply_fixtures`, which carry the niches.

### 1. Laundry niches as sub-rooms (`rooms/niches.py`, `segment._niches`, `geometry.room_geometry`)
* **Root cause of the Sprint-4 gap**: a washing-machine niche's mouth (0.76 / 0.83 m on Noah) is narrower than the
  0.9 m closing gap of `segment._faces`, so the closing filled the whole niche: its floor belonged to no room and its
  mouth was a wall face of the bathroom.
* **Candidates** = free space that only the closing filled (`(region − walls − bridges) ∩ closing`), cleaned by a 5 cm
  opening; niche-shaped when 0.3–2.5 m², ≥ 0.45 m wide, 0.4–1.4 m deep (area / mouth), touching exactly one kept room
  along a 0.5–1.6 m mouth, rest of the outline ≥ 85 % wall, no door / window bridge on it.
* **Evidence**: washing-machine shape inside (`fixtures.shapes.detect_shapes` on the candidate's box), laundry label
  inside ("כביסה", "מ.כ" / 'מ"כ', "מייבש"), or a parent that is wet by its name (bathroom / WC / laundry room).
  A candidate holding another sanitary shape (WC, basin, bath, shower tray, sink) is rejected (WC / shower alcove).
  Machine or label → 0.85–0.9 (green); wet parent only → 0.7 + `גומחה לפי צורה בלבד` (yellow). `apply_fixtures`:
  a washer detected in the niche (plumbing sheets) removes that reason; a WC / basin / bath / shower in it adds
  `כלים סניטריים בגומחה` (yellow, 0.6). Niches keep `type: "niche"`; their `wet` follows the parent.
* **Output** (`rooms.json.gz`, contract fields already added by the API agent in this tree): niche room
  `{id: "<parentId>_n<k>", type: "niche", niche: true, parentRoomId, polygonMm, areaM2, perimeterM, walls,
  openings: [], externalCorners: 0, floor: parent's}`; ids of the other rooms are unchanged (niche ids hang off the
  parent's, so `roomSettings` keys stay valid). The mouth is a wall `open: true` in **both** rooms (only open walls
  carry the key; `exterior` is false on them).
* **Semantics** (for API / BOQ / web): the parent's `areaM2` does **not** include the niche (the niche's floor counts
  through its own row, BOQ `includeNiches`); `perimeterM` of both rooms **excludes** open walls (there is no wall
  face to clad) — consumers must not subtract open walls again; the parent's `externalCorners` are counted on
  parent ∪ niches (the end of a niche side wall at the mouth is an outside corner of the bathroom's tiling).
* Noah: one niche per laundry recess on every plan sheet — basement bath (0.71 m², ad257a1c / 6fa88f92 / c054fd3a /
  24ab0ea0 / 1bbe4113) and first-floor general bath (0.61 m², 8099ab2c / 6fa88f92 (0.5: demolished wall) /
  c054fd3a / 2a308827 / 1bbe4113); green where the plumbing / electrical sheet draws the machine or "כביסה", yellow
  (shape only) on construction / master plans. No other room of the 15 sheets gets a niche (dry-parent recesses
  such as the basement bedroom's triangle are rejected for lack of evidence).

### 2. Master-bath window missed → room not closed (`rooms/walls._add_windows`)
* **Root cause** (Noah construction plan 8099ab2c, also 2a308827 / c054fd3a / 1bbe4113 which borrow it): the window
  in the east wall is a straight glass line jamb-to-jamb (20 mm) plus an outer frame drawn as a **"U" polyline** (1 mm
  out, 22 mm along, 1 mm back). Glazing lines were paired by *path length* (±15 %): 24 vs 20 mm failed, the window had
  a single line, no bridge → the 1.0 m gap leaked and the master bath **and** master bedroom were `חדר לא סגור`. On the
  master sheet the same glass line is drawn twice (two layers), so it paired with itself by accident and "worked".
  The jamb test (`_in_wall_line`) also probed along the U's 1 mm end jog instead of along the window.
* **Fix (general)**: lines are compared by their **chord** when nearly straight (vertices ≤ 15 cm from the chord, path
  ≤ 1.35 × chord; bent bay-window glazing keeps its path length); the jamb probe uses the direction to the first vertex
  ≥ 15 cm from the end (skips jogs); the window width is the **shortest** line of the group (the glass spans the wall
  gap; frames overlap the jambs).
* Effect on all 15 sheets (rooms with reference walls, before → after): master bath + master bedroom closed on
  8099ab2c / 2a308827 / c054fd3a / 1bbe4113 (bath 4.7–4.8 m², window 1.00 m); 6 demolition-plan rooms of af849ec4
  closed; bedroom windows 1.40 → 1.20 m (= the wall gap; the old value was the frame's path); 4 double-detected
  windows merged (08222cb2 ×2, 6fa88f92, b2046277); no room area changed elsewhere, no room got "not closed".
* Regression tests: synthetic room whose window has a jogged outer frame (`tests/test_rooms_s5.py`; fails on the
  Sprint-4 code: no window, room not closed) + the Noah sheet (local artifacts).

### 3. Upload-order dependency (`lifecycle/dependents.py`)
Pure decisions + one service hook; the requests are turned into reprocess jobs by the API (contract request below).
* `borrows_from(dep, src)`: wall-source rank construction 0 < architecture 1 < master 2 < everything else; a sheet
  borrows from strictly better ranks; construction borrows from nobody. Every edge raises the rank → **no loops**
  (a reprocessed MEP sheet is never a source; a reprocessed master sheet only triggers MEP sheets).
* `dependents_to_reprocess(source, sheets)`: ready wall source → the project's other sheets that borrow from it,
  floors overlapping (unknown floors overlap; *unconfirmed* sheets are always included — their region floors are
  inferred from every floor's walls), current version not failed, and not already processed with this source
  version (`referenceSources` on the version doc; unknown → not used).
* `merge_request(existing, dep, source, now)` → `reprocessRequests/{sheetId}` `{sheetId, status: "pending",
  dependentVersionId, sources: ["sheetId/versionId"…], reason: "reference_walls", firstRequestedAt, notBefore,
  updatedAt}` (epoch s). **Idempotent** (same source version again → no write), **debounced** (`notBefore` = now +
  120 s, never later than first + 900 s), a newer version of the same source replaces the older one.
* `due_requests(requests, sheets, now)` → `{sheetId: fire | wait | drop}`: wait while the dependent is queued /
  processing; drop when the sheet is gone or was reprocessed meanwhile with every requested source; else fire.
  `reprocess_reason(req)` → `{kind: "reference_walls", sources, message: "תוכנית קירות של אותה קומה עודכנה — הגיליון
  עובד מחדש"}` for the new version.
* Hook: `schedule_dependents(docs, project_path, sheet_id, *, now) -> [sheetIds written]` (reads `sheets/*` + their
  current versions via `DocStore.list_docs/get`).

#### Service snippet for Worker-Cal (single call site in `service/pipeline.py`; exact text)
1. In `_run`, inside the page loop, right after `outcomes.append(out)`:
```python
        if out.status == "ready":
            _schedule_dependents(job, docs, sid)
```
2. New helper (anywhere in the module, e.g. after `_result`):
```python
def _schedule_dependents(job: IngestSheetVersionJob, docs: DocStore, sid: str) -> None:
    """Sprint 5 (Worker-B, lifecycle.dependents): a construction / architecture / master version became ready →
    debounced, idempotent reprocess requests (``reprocessRequests/{sheetId}``) for the sheets of its floor that were
    processed without it. Best effort: never fails the page."""
    try:
        from ..lifecycle.dependents import schedule_dependents

        written = schedule_dependents(docs, job.project_path, sid, now=time.time())
        if written:
            log.info("job %s: reprocess requested for %d dependent sheet(s)", job.jobId, len(written))
    except Exception:  # noqa: BLE001 - scheduling is advisory; the page is ready either way
        log.warning("job %s: scheduling dependent reprocess failed", job.jobId, exc_info=True)
```
3. (makes `drop` / "already used" exact; needs the SheetVersion contract field below) record the wall sources a
   version used — `_reference_walls_files(..., used: list[str] | None = None)`: after `out.append(rel)` add
   `if used is not None: used.append(f"{osid}/{vid}")`; in `_understand` create `ref_sources: list[str] = []`, pass
   `used=ref_sources` in the `"referenceWalls"` call and return `"referenceSources": ref_sources` in the result dict;
   in `_process_page`, inside `if understanding is not None:` add
   `vfields["referenceSources"] = list(understanding.get("referenceSources") or [])[:16]`.
Without (3) the hook still works (an unknown `referenceSources` counts as "not used": at worst one extra reprocess).

### Contract requests (API agent)
* `RoomsArtifact` — already in this tree (`type: "niche"`, `parentRoomId`, `walls[].open`), thank you. Please make the
  doc comments match the semantics above: `parentRoomId` — "its floor is tiled with the parent's (BOQ
  `includeNiches`); the parent's `areaM2` does NOT include it"; `perimeterM` — "inner face incl. door / window
  openings, excl. `open` walls"; `walls[].open` — "already excluded from `perimeterM`".
* `SheetVersion` (additive, optional): `referenceSources: string[]` (≤ 16, `"{sheetId}/{versionId}"` of the wall sources
  the understanding used) and `reprocessReason: {kind: "reference_walls" | "manual", sources: string[] (≤ 32),
  message: string (≤ 200)} | null`.
* New collection `orgs/{o}/projects/{p}/reprocessRequests/{sheetId}` (shape in §3; written only by the worker's
  service account; firestore rules: no client access). **Consumer** (API, scheduled every minute — the worker has no
  queue publisher): for each pending request apply `due_requests` (mirror the Python, 20 lines): `fire` →
  `repo.createReprocessVersion(org, project, sheetId, 'system:dependents', ingest)` with
  `reprocessReason = reprocess_reason(req)` on the new version, publish the ingest job, then set the request
  `{status: "fired", firedAt, versionId}`; `drop` → `{status: "dropped"}`; `wait` → leave it; a
  `RepoConflictError(in_progress)` = wait. Show `reprocessReason.message` in the sheet's history panel.
* Requests to the BOQ owner (`boq/` is read-only for me): (a) `includeNiches` should count a niche only when its
  parent (`parentRoomId`) passes the rule's `roomTypes` (today any niche is floor-tiled, e.g. a laundry niche of a
  corridor would be); (b) `boq/spaces.ROOM_TYPES` lacks `"niche"` (inferred as `other` — harmless, the `niche` flag
  drives the rules); (c) never subtract `open` walls from `perimeterM` again.
* Data/QA: `eval-tiling-rooms` compares the GT bathroom polygon (which includes the laundry niche) with the parent room
  only — compare GT with parent ∪ its `parentRoomId` children (area, union perimeter) and the niche with
  `sub_polygons_mm.laundry_niche`. GT master-bath window: `0.8 m "east wall frame 328.56-344.57"` is the shutter
  pocket; the opening in the wall (glass line jamb to jamb) is 344.57–364.55 = 1.0 m — please review.

### Results (Noah; `ingest_local.py --force` into a scratch root, 15/15 in 403 s on the shared box; `boq_local.py
--no-corrections` with the built-in demo room settings; kbench `eval-boq` / `eval-tiling-rooms`)
| line / metric | sample BOQ | GT rule | before (Sprint-4 final) | after |
| --- | --- | --- | --- | --- |
| 5.01 wall cladding m² | 57 | 57.63 | 62.79 (PE +10.2 %) | **56.30 (−1.2 %, within tol)** |
| 5.02 floor tiling m² | 18.1 | 18.11 | 16.02 (−11.5 %) | **17.06 (−5.7 %)** — niches 0.71 + 0.61 added |
| 5.03 corner trim m' | 15.6 | 17.0 | 12.60 | 12.20 — corners basement 1→2, first bath 2→3 (GT 3/3), master 2→0 (GT 1, was a leak artefact) |
| chapter 03+05 gated | | | exact 14/19, within tol 14/19, ΣAE 22.87 | exact 14/19, **within tol 15/19, ΣAE 17.14** |
| chapter 03 | | | 15/15 lines = sample | **unchanged** (identical quantities) |
| chapter 04 + 9.01 gated | | | exact 12/22, ΣAE 19.0 | **unchanged** (12/22, ΣAE 19.0) |
| rooms: master bath closed (8099ab2c) | | | no (`חדר לא סגור`) | yes, window 1.00 m |
Every detection (class, position, floor, room) is identical before/after on all 15 sheets. 4.10 / 9.01 `byFloor`
moved one item between floors in the after-run — from the in-progress `links/` changes of this sprint (links do not
read rooms), quantities identical. Per wet room (after): basement bath 3.73 + niche 0.71 m², P 7.74 m (mouth 0.76
open); first bath 5.04 + niche 0.61, P 8.79 (mouth 0.83 open); master bath 4.76, P 8.74, window 1.00.

### Tests / commands
`tests/test_rooms_s5.py` (9: synthetic bathroom niche — sub-room, open walls, parent perimeter / corners / area,
contract validation; dry parent needs a label or a drawn washer; `apply_fixtures` confirm / flag; evidence + labels;
window with a jogged frame (straight and U); Noah niches on ad257a1c / 8099ab2c; Noah master bath closed),
`tests/test_dependents.py` (10: rank DAG / no loops, dependents selection, master → MEP only, idempotent + debounced +
max wait, due decisions, hook on `InMemoryDocStore`, MEP sources never trigger).
```bash
uv run python -m kamutan_drawing.rooms.debug --v4 ad257a1c 8099ab2c   # niches + open walls (red) in rooms_v4_*.png
KAMUTAN_DEV_ARTIFACTS=/tmp/x uv run python scripts/ingest_local.py --force && uv run python scripts/boq_local.py --root /tmp/x --no-corrections
```

### Gaps
* Niches whose mouth is ≥ 0.9 m are not cut by the closing and stay inside the parent (not split, walls clad).
* Construction / master plans draw no machine in the niche: those niches are shape-only (yellow) until a plumbing
  sheet's washer confirms them — in the BOQ the canonical rooms come from the construction plan, so 5.02's niche rows
  stay yellow; a fixture → canonical-room confirmation would need the BOQ to map washers onto canonical niches.
* 5.03: corners near door jambs are excluded at 30 cm (the master bath's diagonal-wall corner is 15 cm from the door
  jamb; GT counts it) — a convention question for the owner (GT-D-008), not changed.
* 5.02 remaining −1.0 m²: wall faces are detected a few cm inside the GT faces (basement 3.73 vs 3.90 without niche,
  master bath 4.76 vs 5.25).
* The dependency requests need the API consumer (and the service snippet) to actually re-run anything; until then they
  accumulate as `pending` docs (bounded: one per sheet).

## Sprint 5 — marked PDF `export.marked_pdf` (Worker-Export)
FR-29 / E2E-13 / MK-01–02. Package `src/kamutan_drawing/export/` (+ `scripts/export_local.py`, `tests/test_export.py`).

### Flow
```
Pub/Sub push ─► app.py (type export.marked_pdf) ─► export.job.run_marked_pdf          (orchestrator: identity, docs, storage)
  1 jobs/{jobId} (org/project match) + exports/{exportId} (kind marked_pdf) must exist, else invalid_payload (nothing written);
    export already ready → redelivery no-op
  2 export + job → running; latest build (project boq.latestBuildId → boqBuilds/{id} → evidenceRef under …/boq/),
    boqLines, corrections; per sheet (sheetIds | every sheet with evidence; versionIds[sheetId] | currentVersionId, ready)
    the version's detections / links / rooms JSON (paths under the version prefix)  → export.plan.build_plan (pure)
  3 backgrounds: sheetSet upload (fileKind pdf, uploads/{set}/source.pdf, sha256 == version.sourceSha256) else the
    tile level closest to 150 dpi (PNG/JPEG/DXF, or a changed/missing source); hideTitleBlock → + primitives/text
  4 sandbox task `export_marked` (export.render): chunks of 8 pages → parts, then `assemble` (parts + legend pages)
  5 output (%PDF, ≤ 512 MB) → job.storagePath = orgs/{o}/projects/{p}/exports/{exportId}/marked.pdf (application/pdf)
    export doc {status ready, storagePath, pageCount, sizeBytes, versionIds, error null, finishedAt}; job succeeded + result
```
Errors: same semantics as the other jobs (retryable → export/job `queued` + HTTP 500 until 5 attempts; else `failed`
+ `error {code, message}` + HTTP 200). No build → `invalid_payload`; missing evidence file → `source_not_found`; any
pypdf / pdfium / Pillow failure on the customer file → `parse_crashed` (typed, inside the sandbox).

### What a page shows
* **Background**: the ORIGINAL vector page for PDF sources — pypdf `merge_transformed_page` into a fresh page of the
  display size; the ctm (`render.display_matrix`) normalises crop box + clockwise /Rotate exactly like
  `ingest.pdf_vector._page_to_mm`, so overlay mm = ingest mm (unit-tested for 0/90/180/270 with an offset crop box;
  Noah's /Rotate 270 sheets line up). Source /Annots and /AA are dropped; merged content streams are re-compressed.
  Raster / DXF sheets: the stitched tile level (Pillow).
* **Overlay** (reportlab, vector, on top): every evidence item of the latest build on the exported version —
  detections as a tinted box + outline in the line colour (concentric outlines when one item is evidence of several
  lines, e.g. a luminaire in 4.09 and 9.01), the line code as text above it (white halo), and the item's level glyph as
  a vector shape (● מאומת ▲ סביר ◆ לבדיקה, blue ● for verified / manual) — colour is never the only cue. Rooms
  (tiling lines) → hatch clipped to the polygon (angle varies per line on the same room) + dashed outline + code tag;
  link groups → thin dashed arcs (luminaire chain + each switch to its nearest luminaire) in the group's line colour;
  manual corrections (count points / measure polygon / anchor) from `corrections/{id}`. Evidence of another version
  of the sheet is not drawn (`result.stale`).
* **Palette** (`export/palette.py`): 12 colours, Okabe-Ito + Tol muted, no pure red; colour = f(code)
  (`(minor + 7·chapter) % 12`) → stable across exports; 12 consecutive codes of a chapter never collide.
* **Legend**: final page(s) (A4; landscape with > 2 floors): colour · סעיף · תיאור · כמות (qtyOverride wins, ✎) ·
  יחידה · ביטחון (shape + word) · סימונים (marks in this PDF, "—" for lines without drawing evidence) and, with
  `floorSplit`, one column per floor (byFloor). `floorSplit` also orders the pages by floor (else by discipline).
  Page tag top-right: floors · sheet title · number of marks (title omitted when hideTitleBlock).
* **Watermark**: diagonal (page diagonal angle), 20 % grey, on every page incl. the legend.
* **hideTitleBlock** = real redaction: the page is rendered by pdfium at 200 dpi and the title block painted white in
  the pixels (a white box over vectors would leave the text in the content stream); overlay stays vector; the sheet's
  compact legend is drawn into the freed box. Title block: `version.titleBlock.bboxMm` when present (contract request
  below), else searched in the sandbox on the stored primitives + text (`titleblock.read_title_block`, Noah 10/10
  found), else none → the page is REFUSED (see the security-gate follow-up below; the earlier "band under the
  drawing regions" guess is gone); `result.titleBlock` reports which.
* **Hebrew**: `export/bidi.py` — UAX #9 subset for one RTL line (numbers with separators, Latin runs, neutrals,
  mirrored brackets, nikud kept on its base), pure Python (python-bidi is LGPL). Hebrew needs no shaping. pdfium's
  text extraction of our pages returns the logical strings (asserted in the tests).

### Untrusted input (SEC-17)
Everything that touches customer bytes runs in the parser sandbox (`run_task("export_marked")`, same Limits as the
other jobs): pypdf opening + merging the original page (merging is parsing), pdfium rendering for redaction, Pillow
decoding tiles, msgpack primitives for the title-block search. The orchestrator only reads worker-made JSON
(evidence, detections, links, rooms — as `boq.build` does), copies the upload/tiles into the workdir, validates the
child output (`safe_output_path`, `%PDF-`, size, page count) and uploads it. Document-level objects of the source
(OpenAction / JS / embedded files / outlines / metadata) never reach the output: only page content + resources are
merged into fresh pages; page /Annots and /AA are removed.

### Edits outside `export/` (both minimal, additive)
* `service/app.py` (Worker-Cal owns the rest): 2 imports, `MARKED_PDF_TYPE: MarkedPdfJob` in the type→model map,
  one `elif isinstance(job, MarkedPdfJob)` branch calling `run_marked_pdf(limits, workdir_root)`, docstring line.
* `sandbox/tasks.py`: new task `export_marked` (3-line delegate to `export.render.run`) + its `TASKS` entry — the
  sandbox child only dispatches tasks from this table, so sandboxing the PDF merge needs this one registration.

### Dependencies (pyproject + uv.lock)
`pypdf>=6.20.1` (BSD-3-Clause), `reportlab>=5.0.1` (BSD; moved from the dev group to runtime; pulls
`charset-normalizer` MIT), dev `types-reportlab` (Apache-2.0, typeshed). No PyMuPDF.
**Font**: `export/fonts/DejaVuSans-heb.ttf` + `DejaVuSans-Bold-heb.ttf` (107 KB each) — DejaVu Sans from the OS
(`fonts-dejavu-core`), subset with fontTools to Latin-1 + Hebrew + punctuation + arrows + geometric shapes + dingbats;
license `export/fonts/LICENSE-DejaVu.txt` (Bitstream Vera terms + DejaVu changes public domain; modified copies may
not be named "Bitstream"/"Vera" — they are not). Bundled in the package: `uv build` includes it in the wheel (checked),
so the worker image needs **no Dockerfile change**; nothing is fetched at runtime.

### Local run (`scripts/export_local.py`)
Reads the production layout under `/home/claude/kamutan-data/artifacts` (+ uploads mapped to `sample-noah/{name}`),
writes nothing there (overlay stores), saves the PDF + PNGs of the first / legend pages.
| run | sheets | pages | size (sources 1.23 MB) | time | marks / arcs / areas |
| --- | --- | --- | --- | --- | --- |
| default (`debug/marked_noah.pdf`) | 10 with evidence | 10 + 2 legend | 1.27 MB (vector) | 9–20 s (shared box) | 189 / 39 / 17, stale 0, unresolved 0 |
| `--hide-title-block --floor-split --watermark …` (`debug/marked_noah_share.pdf`) | 10 | 12 | 7.96 MB (200-dpi raster) | 17–27 s | same; title block detected 10/10 |
Checked visually (`debug/marked_noah_p1.png`, `_p1_zoom.png`, `_p4.png`, `_p10_zoom.png`, `_p12.png`,
`marked_noah_share_p1.png`, `_share_p12.png`): marks sit on the symbols (incl. the /Rotate 270 sheets), codes and
glyphs readable, arcs on the lighting sheets, hatches in the wet rooms, legend Hebrew correct RTL, mask + sheet legend
+ watermark on the share variant.

### Tests / commands
`uv run pytest -q tests/test_export.py` — 29 tests, ~17 s: bidi cases, palette, display matrix vs the ingest frame
(4 rotations, offset crop box), plan (shared items, arcs, areas, manual geometry, stale evidence), end to end in the
sandbox on synthetic PDFs (rot 0/90: vectors kept, pixel colours at marks / labels / hatches, white paper elsewhere,
legend text), redaction (no text of the title block left, pixels white) + watermark, tiles background +
floor-split legend, stale evidence, redelivery / foreign job / no build / xlsx doc, hostile source → `parse_crashed`,
changed source → blank page, payload validation, contract mirror vs `json-schema/MarkedPdfJob.json`, app routing.

### Contract notes / requests (API agent)
* Mirrors `MarkedPdfJobSchema` as generated (incl. `versionIds`, `storagePath`, `options.legend: true`, watermark ≤
  200). Export doc: the worker writes `status` `running` → `ready` | `failed` (contracts `ExportStatus`; the brief's
  "succeeded" is `ready`), `storagePath`, `pageCount`, `sizeBytes`, `versionIds`, `error`, `finishedAt`, plus
  bookkeeping `startedAt` (please keep `ExportRecordSchema` non-strict or add `startedAt`). Job `result` carries
  the stats (marks, arcs, areas, stale, unresolved, backgrounds, rendered, titleBlock, bytes, durationMs).
* Request (ingest / pipeline owner): persist the title block found during classification on the version doc,
  additive `SheetVersion.titleBlock = {bboxMm: [x0, y0, x1, y1]}` (paper mm, y down) — the export (and the share tile
  masking) then needs no title-block search; the export already reads it when present.

### Requests to DevOps
None required (font ships inside the wheel). Optional: extend the image smoke check to
`python -c "import kamutan_drawing, pypdfium2, pypdf, reportlab, uvicorn"`.

### Gaps
* Dense clusters: code labels of adjacent items overlap (no label placement / collision avoidance yet).
* Redacted (hideTitleBlock) PDFs are large: ~0.8 MB per A3 page at 200 dpi (Flate RGB). MK-02's "< 1.5× source"
  holds for the vector export (1.03×), not for redacted share PDFs; options: 150 dpi, palette images, or redacting the
  content stream (needs a content-stream editor that clips text/paths — not license-clean today without PyMuPDF).
* Pinned versions (share links) older than the latest build's evidence show no marks (`result.stale`) — a share link
  should be paired with the build of its locked versions.
* Raster / DXF sheets use the tile pyramid at ~150 dpi (not the original PNG / a fresh DXF render).
* Run on 2026-10-15 alongside other agents: `tests/test_sandbox.py::test_fork_bomb…` flaked (peak 51 > 49 processes,
  load avg 9 on 2 vCPU); the links / rooms / understand failures in the full suite are in modules other agents were
  editing at the time; `ruff format --check` flagged `tests/test_calibration.py` and mypy `rooms/segment.py` then `ocr/glyphs.py` (not ours).
* CI run (21.10): ruff / format / mypy / bandit clean; pytest 496 passed, 11 failed — none in rooms / fixtures /
  lifecycle code: green→yellow expectations under the in-progress conservative calibration (test_understand_fixtures ×2,
  test_links ×5, test_boq confirmed floors, test_calibration link groups, test_legend_symbols spotting) and the
  sandbox fork-bomb test (box-dependent). Sprint-4 sample tests updated for niches (`test_rooms.py` min area,
  `test_rooms_v4.py` basement / wet rooms count niches separately).

## Sprint 5 — calibration (worker side), per-stage timings, performance (Worker-Cal)

Brief: `docs/agents/SPRINT5_BRIEF.md` §1 / §6.

### Calibration (`kamutan_drawing/calibration/`)
* `table.json` (`kamutan.calibration/1`, validated against `schema.json` + semantic rules: tp + fp = n, monotone
  `scoreMap`, conservative rule n ≥ 200 & fp = 0 for `greenAllowed`). **Produced by Data/QA's `kbench calibrate`
  from DEV only** (current `cal-gt-v0.4.1-draft-…`, conservative, no class allowed green — the largest class has
  n = 29). Class statistics only. `scripts/calibration_table.py` is a stopgap that now *refuses* to write the
  committed table (`--out` required).
* Loading: once per process (`default_table()`), `KAMUTAN_CALIBRATION_TABLE` overrides the path; a missing / invalid
  table logs an error and **fails closed** (empty conservative table, nothing green, version `fallback-empty`).
* `calibrate(class, raw_score, reasons, *, level=, raster=, human=, green_threshold=) -> (score, level, reasons)`
  (also `CalibrationTable.calibrate` → `Calibrated`), the shared helper for every producer of a level:
  score = class `scoreMap`, else the class's **domain** map (Data/QA's request; `domain_of`), else identity; level =
  min(heuristic level, level of the calibrated score — `ביטחון נמוך לאחר כיול` when it lowers it); raster / `רסטר`
  → never green; green on a class without `greenAllowed` → yellow + `כיול שמרני: אין מספיק נתוני אמת לסוג זה`;
  org `greenThreshold` (0.9–0.995) above the class Wilson LB → yellow + `כיול: מתחת לסף הירוק של הארגון`;
  `human=True` → green `אושר ידנית`. Never more permissive than the input level (property test, 2000 cases).
  Class keys: detection classes, `link:<kind>`, `room`.
* Applied in: `symbols.detect.score_detection` (vector + raster; `Detection.score_raw` → `scoreRaw` in
  `detections.json.gz`), fixtures (`understand._fixture_detection`, Worker-B's score = raw; `fixtures.json.gz` gets
  `score`/`scoreRaw` too), rooms (`understand._calibrate_rooms`, key `room`; **scale-conflict sheet → every room
  red** `קנה מידה סותר` — task arg `scaleConflict` from the page classification, unless the sheet is confirmed),
  link groups (`links.graph`, level only: `confidence` stays raw because contracts `LinkGroup` is strict — see
  requests), `links.floors.apply_confirmed_floors` (an item whose only chip was the floor goes back to green
  *through the table*, so confirmed floors no longer bypass the cap). Human accept / corrections stay green: they
  are applied by `boq/corrections.py` (`אושר ידנית`, not routed through the table).
* Service: `orgs/{o}.settings.greenThreshold` → task arg `greenThreshold`; `stats.calibration = {mode, version}` on
  every understood version (orchestrator's own table copy).

### Timings + other service work
* `stats.timingsMs = {render, primitives, ocr, legend, symbols, rooms, fixtures, links, artifacts, total}` (ms):
  page task (ingest → primitives, ocr + classify + regions → ocr, write), understand task (detect → symbols,
  fixtures + lifecycle → fixtures, crops + write + orchestrator uploads → artifacts), total = page wall clock in the
  orchestrator (sandbox start-up only in total). Sanitised (`stage_timings_ms`).
* `titleBlockMm {x,y,w,h}` **and** `titleBlock {bboxMm: [x0,y0,x1,y1]}` on the version doc when classification found
  the title block (page task `titleBlockMm`, checked to lie inside the page) — share tiles / marked PDF mask it.
* Worker-B's dependents hook wired exactly as specified (`_schedule_dependents` after each ready page;
  `referenceSources` recorded on the version from the wall files passed to `understand`).
* R-W1: `service/logging_setup.py` — JSON lines on stdout (`severity`, `message`, `time`, `logger`, sourceLocation,
  allow-listed extras `jobId/orgId/projectId/sheetId/versionId/code/llm`, messages capped), installed in
  `app_from_env` (`KAMUTAN_LOG_LEVEL`, default INFO). Message texts unchanged (alert filters).

### Performance
`scripts/perf_local.py --out DIR --repeats 3` (also driven by `kbench perf --run`): real pipeline per sheet, one org,
construction plans first; P50/P95 per stage, wall + CPU, peak RSS of the process tree. Hot spots fixed (all
**output-identical** — verified by hashing `text.json.gz` / primitives / glyph delta / classification on 5 sheets warm
and cold, and diffing understand artifacts on 5 sheets: every non-calibration field identical, the only diffs are
Worker-B's new niche rooms):
* OCR (`ocr/glyphs.py`, `ocr/shapes.py`): vectorised densify (`_linspace_t`, bit-identical to per-segment
  `linspace`), vectorised pair tests in `_link_lines` (applied in the set's order), vectorised glyph bitmap,
  stacked stroke arrays + broadcast cost matrix + exact bound-pruning in `shape_distance` lookups. Page CPU 8.8 → 4.9 s
  (1bbe4113), 8.9 → 4.8 s (c054fd3a), 4.5 → 2.3 s (24ab0ea0).
* Symbols: `marks.GlyphLibrary.read` one dense distance matrix per glyph (`cdist` + `minimum.reduceat`; equality vs
  the KD reference asserted on 1584 reads), pair readings memoised per sheet, sheet arrays cached;
  `_panels_from_labels` KD-tree partner search (was O(n²), 7.6 s on c054fd3a); `suggest_class` memoised. c054fd3a
  detect 30.2 → 12.8 s in-process.
* Thumbnails: `understand.BatchRender` renders clustered regions once instead of one pdfium call (~0.2 s fixed) per
  crop; crops are timed apart (`crops` → `artifacts`), so `links` is now the link graph only (10.5 → 0.9 s max).

| stage (s, 15 sheets × 3, single worker, shared 2-vCPU box) | before P50 / P95 / max | after P50 / P95 / max |
| --- | --- | --- |
| render | 2.68 / 4.84 / 6.25 | 3.21 / 5.43 / 7.14 |
| primitives | 0.81 / 2.24 / 2.86 | 0.98 / 2.63 / 3.13 |
| ocr | 5.91 / 18.88 / 21.81 | 5.02 / 13.08 / 15.10 |
| legend | 0.05 / 0.27 / 0.40 | 0.07 / 0.30 / 0.42 |
| symbols | 0.01 / 16.58 / 27.91 | 0.00 / 8.03 / 8.84 |
| rooms | 0.96 / 2.32 / 3.10 | 1.07 / 2.80 / 5.67 (Worker-B niches) |
| fixtures | 0.24 / 0.61 / 0.71 | 0.31 / 0.86 / 1.91 |
| links (before: incl. crops) | 0.00 / 4.83 / 10.55 | 0.00 / 0.88 / 0.97 |
| artifacts (after: incl. crops) | 0.03 / 0.09 / 0.12 | 0.61 / 6.89 / 7.30 |
| **page total** | 16.41 / **46.13** / 71.10 | 16.35 / **41.04** / 47.30 |
| page wall (incl. sandbox start) | 16.61 / 47.12 / 72.52 | 16.65 / 41.98 / 48.15 |
| peak RSS (tree) / set per repeat | 668 MB / 321 s | 631 MB / 307 s |
Both runs were on a box shared with other agents (load 4–8), so wall clock is noisy; the in-process CPU numbers
above are the reliable before/after. **A3 P95 41 s < 60 s, set 307 s < 600 s.** Rendering crops (~0.15 s per
cluster) and OCR remain the top stages; Tesseract (2 workers, OMP 1) is ~1/3 of OCR.

### Accuracy (kbench eval / eval-links on the perf roots, gt-v0.4.1-draft)
| | before | after |
| --- | --- | --- |
| semantic micro-F1 / items correct | 0.8472 / 0.7965 | 0.8472 / 0.7965 (identical) |
| green items (precision) | 20 (1.00, LB 0.84) | **0** (conservative: no class allowed) |
| review burden | 0.904 | 1.000 |
| ECE (score) | 0.104 | 0.056 |
| links exact R / P | 0.933 / 0.966 | 0.933 / 0.966 |
Burden 100 % is the honest consequence of conservative mode on one DEV project (≥ 200 items per class are needed).

### Tests / commands
`tests/test_calibration.py` (29: committed table, fail-closed loading, schema/semantic rejections, caps / ceilings /
human / org threshold, scoreMap + domain fallback, never-more-permissive property, isotonic, Wilson, build_table,
score_detection, floor confirmation through the table, rooms + scale conflict, fixtures, timings mapping, org
threshold, title block), `tests/test_logging_setup.py`, assertions in `test_understand_pipeline.py`
(`stats.calibration`, `timingsMs`, no green). Tests of the *heuristic* levels (test_links ×5, test_legend_symbols
spotting, test_understand_fixtures) use the `allow_green` fixture (`tests/calib_util.AllowAll`) and additionally
assert the conservative cap; `test_boq::test_confirmed_floors_remove_uncertainty` now expects the conservative chip.
CI sequence (`uv sync --locked --all-groups --all-extras && ruff check && ruff format --check && mypy==2.4.0 src &&
bandit -ll && pytest -q`): all green, 510 tests.

### Contract requests (API agent)
* `LinkGroup.confidenceRaw` (optional, 0..1) — then `confidence` can carry the calibrated value (today raw, level
  calibrated) without a strict-schema violation.
* Already merged, thank you: `Detection.scoreRaw`, `VersionStats.calibration` / `timingsMs`, `SheetVersion.titleBlockMm`
  / `titleBlock` / `referenceSources`.

### Requests / open
* BOQ owner (`boq/` read-only for me): (a) write a `rebuild` audit marker per build (skipped here — it belongs in
  `boq/build.py`); (b) `boq.build` should copy `stats.calibration` of the sheets into the build `stats`.
* Rooms have no score map (tiling domain has none); rooms are capped like every class.
* Cross-check with Data/QA: `kbench calibrate --fail-on-disallowed-green` on a fresh run must report 0 greens.

### Security-gate follow-up (docs/sprints/sprint-5-security-gate.md F-3, F-6, I-3)
* **F-3 fail closed.** With `hideTitleBlock`, a page is emitted only when its title block is known: the version's
  `titleBlock.bboxMm` / `titleBlockMm` (now written by the ingest) → else the sandbox search on primitives + text.
  No geometric guess. A sheet without one is left out of the PDF. Per sheet it is reported in the export doc as
  `titleBlockMasked` (bool: all exported sheets masked) + `titleBlockBySheet {sheetId: bool}`, and in the job's
  `result.titleBlockMasked` / `omittedSheets`. The legend says "N גיליונות הושמטו: לא נמצאה טבלת כותרת להסתרה". If
  no sheet can be masked, the export fails with `error.code = "title_block_not_found"` (non-retryable), the doc gets
  `titleBlockMasked: false`, and nothing is written to Storage. `versionIds` lists only the sheets in the PDF. The sheet
  title (title-block text) is blanked in the plan before it reaches the sandbox, whenever `hideTitleBlock` or a
  watermark is set.
* **F-6 share PDFs** (= any export with `watermark`): never the original vector page, even with
  `hideTitleBlock=false`. Every drawing page is a 150 dpi raster (`SHARE_DPI`; tiles at their level, blank pages a white
  raster) with the watermark burned into the pixels as a tiled 30° pattern (Pillow, bundled DejaVu, `Layout.BASIC` +
  our bidi), plus the reportlab text watermark on top. Legend pages are rasterised and burned the same way. The internal
  export (no watermark) stays vector; `hideTitleBlock` without a watermark stays a 200 dpi redaction raster.
* **I-3**: rasters never render source annotations (`draw_annots=False`).
* **Size** (`result.pageBytes {sheetId: bytes}`, `result.share`): Noah, hide + floor split + watermark: 10 drawing pages
  0.42–1.02 MB each, 7.80 MB total for 12 pages (sources 1.23 MB). Watermark only: 7.39 MB. Internal vector: 1.27 MB.
  MK-02's < 1.5× target is not met for share PDFs. Options, not done: JPEG backgrounds or palette images.
* Regression tests (`tests/test_export.py`, from the PoCs): no extractable client text in the masked box and no secret
  bytes in the file; deleting every BT…ET text object (`poc_strip_wm.py`) leaves the burned watermark on the drawing
  page and the legend page; a share PDF without `hideTitleBlock` embeds one image and no customer text, and has no sheet
  title; a source Square annotation is not painted; no title block → `title_block_not_found` + `titleBlockMasked:
  false`, nothing written; mixed sheets → only the masked sheet is in the PDF and the omission is reported.
* **API requests** (contracts owner): add `titleBlockMasked: boolean | null` and `titleBlockBySheet: Record<sheetId,
  boolean> | null` to `ExportRecordSchema`. Refuse or warn on `hideTitleBlock` share PDFs when `titleBlockMasked` is
  false, and map `title_block_not_found` to a Hebrew message in the dialog. For share links the worker treats the
  presence of `watermark` as "share": always set it for share PDFs.
* Checks (2026-10-21): ruff check / format clean, mypy (2.4.0) no issues, bandit clean, `pytest -q` 514 passed.

## Stage 10 — fix round (Worker-BOQ)

Brief: `docs/agents/STAGE10_FIX_BRIEF.md`. Defects: A-pipeline-07 / 08 / 10 / 12, A-LIVE-01 (worker side), A-LIVE-02
(worker-written counters). Status of each fix, tests and the Noah re-run: see "Results" below (filled at the end of the
round).

### Contract requests (API agent) — Stage 10
Everything is additive; the worker already writes / reads these shapes (extra fields are stripped by the non-strict
zod objects until the contract lists them).
1. **A-pipeline-08 / A-API-06 — approval invalidated by a rebuild.** Worker behaviour (`boq/build.py`
   `_approval_check`): an `approved` line whose computed `qty` (no `qtyOverride`) differs from the qty it was approved
   with → `status: "reviewed"`, `approvedBy/approvedAt: null` (same as the API's un-approve), level red, first reason
   `הכמות השתנתה מאז האישור (16 → 17)`, and
   `approvalInvalidated: {fromQty, toQty, approvedBy, approvedAt, buildId, at}` on the line (kept, with the reason
   refreshed to the current qty, while the line stays `reviewed`; removed on re-approval or when it goes back to
   draft). The build doc gets `approvalsInvalidated: [{lineId, code, fromQty, toQty}]` (≤ 500) and
   `stats.approvalsInvalidated` (count). Please: (a) `BoqLineSchema.approvalInvalidated` (nullable, optional) +
   mapper/DTO so the review UI can show it; (b) the export gate already blocks (`red && status !== 'approved'`) —
   keep it, and treat a legacy doc (`status: 'approved'`, `approvedQty` present and ≠ `qty`) as not approved too;
   (c) **audit**: the worker cannot append to the hash-chained audit log. Please emit one event per entry of
   `boqBuilds/{id}.approvalsInvalidated` (`entity: 'boqLines'`, `entityId: lineId`, `action: 'approval_invalidated'`,
   `actorId: 'system:boq.build'`, `after: {projectId, buildId, code, fromQty, toQty}`) idempotently when the API first
   sees the succeeded build (e.g. stamp `approvalsAuditedAt` on the build doc), and show it in the line history.
2. **A-pipeline-07 — new rule kind `template_chapter`** (`BOQ_RULE_KINDS` + `TemplateChapterMatchSchema`):
   `match = {chapters: ChapterCode[] (1..16), disciplines?: Discipline[] (≤ 8), quantity: number (> 0, ≤ 1000),
   excludeCodes?: ItemCode[] (≤ 64)}`, `itemCode: null`. Semantics: when the project has a current ready sheet of one
   of `disciplines` (absent = always), every active library item of those chapters (`item.chapter`, else the template
   chapter's `codePrefixes`) that no other rule produced becomes a line of `quantity` in the item's unit (else the
   rule's), never green, with the rule reasons; evidence = one whole-sheet item per triggering sheet
   (`detectionId: "sheet"`). New default rule (new id → created by the create-if-missing seeding, **no
   DEFAULT_BOQ_RULES_VERSION bump needed**):
   `{id: 'r_template_demolition', kind: 'template_chapter', match: {chapters: ['01'], disciplines: ['demolition'],
   quantity: 1}, itemCode: null, itemDescription: 'סעיפי הריסה ופינוי מהתבנית', unit: 'קומפלט', priority: 10,
   reasons: [ONE_OFF_SUGGESTION_REASON]}` — mirrored in `boq/rules.py` `DEFAULT_RULES` (the mirror test treats it as
   pending until `boq-defaults.json` has it, then requires equality).
3. **A-pipeline-12 — new rule kind `fixture_combination`** (`FixtureCombinationMatchSchema`): `match = {classes:
   SymbolClass[] (2..4, distinct), sameRoom: boolean, radiusMm?: number (real mm, 0..5000; default 1500), floors?,
   roomTypes?, roomNamePatterns?}`. One unit of `itemCode` per complete set (one live detection of each class, same
   room of its sheet when `sameRoom`, all within `radiusMm` of the set's first class); the members are consumed (not
   counted again by `plumbing_point` / `class_to_item`); incomplete sets fall through to the other rules. Example
   (custom rule, "אסלה תלויה + מיכל סמוי = 1 × 3.04"): `{kind: 'fixture_combination', match: {classes:
   ['fixture_wc_hung', 'cistern_concealed'], sameRoom: true}, itemCode: '3.04', unit: 'יחידה', priority: 150}`.
   Taxonomy request for that example (detection = Worker-Accuracy; corrections can already add / reclassify):
   `fixture_wc_hung` "אסלה תלויה", `cistern_concealed` "מיכל הדחה סמוי" (plumbing). No default rule.
4. **A-pipeline-12 — `BoqLine.byRoom`** (optional): `Array<{sheetId: DocId | null, roomId: string (≤ 128) | null,
   name: string (≤ 100) | null, type: RoomType | null, floor: string | null, qty: number}>` (≤ 200), sorted by floor
   order then name; `roomId: null` = items outside every room. Rooms are the **canonical** rooms of the floor (the same
   physical room has one entry whatever sheet the item came from). Please add the Excel sheet **"פירוט לפי חדר"**
   (`apps/api/src/boq/excel.ts`): one row per (line, room) — סעיף (TEXT), תאור, יחידה, קומה, חדר, כמות — plus a SUM
   per line that equals the line qty; lines without `byRoom` get one row "—" with the line qty.
5. **A-LIVE-01 — default library**: the worker resolves an item whose doc has `source: 'default'` (or
   `defaultsVersion`) by **exact code** (no description-similarity check), so the default library must use the
   default rules' item codes. Please add `'default'` to `ITEM_SOURCES`. With no item the worker keeps the rule's unit
   and description (see below); the build stats carry `library: {items, defaults}` (0 → the web can show the
   "ייבאו כתב כמויות / השתמשו בברירת המחדל" prompt).
6. **A-LIVE-02 — project counters**: the worker now writes `stats.sheets` (ingest: sheets with a current version)
   and `stats.{boqLines, green, yellow, red}` (each build, all lines incl. manual) on the project doc (merge).
   `reviewOpen` stays the API's. `toProject` (apps/api/src/db/mappers.ts) currently drops `stats` — please map it
   (missing fields → 0, `reviewOpen` from the queue if you compute it).

### Fixes (worker side)
* **A-pipeline-08** (`boq/build.py` `_approval_check`, `upsert_lines` → `Upserted`): behaviour in request 1 above.
  Not invalidated: same qty, or a `qtyOverride` on the line (the human quantity is what was approved). Reported once
  (the build that changed it); later rebuilds refresh the chip `(from → current)` while the line stays `reviewed`; a
  re-approval (`approved` + new `approvedAt`) starts a new baseline. `writes.approvalsInvalidated` / build
  `stats.approvalsInvalidated` count it. With the current API gate (`red && status !== 'approved'`) the line blocks the
  export until re-approved.
* **A-pipeline-07** (`boq/template.py`, kind `template_chapter`, default rule `r_template_demolition`): chapter 01
  library items (`chapter` "01", else code head "1.") offered as 1.0 in the item's unit (קומפלט), yellow, `הצעה –
  לאשר ידנית`, `ruleId r_template_demolition`, evidence = one `detectionId: "sheet"` item per current demolition sheet
  (byFloor = the lowest floor of those sheets). Items another rule already produced are not offered twice. Without a
  demolition plan nothing is offered. Runs after every other rule.
* **A-pipeline-10** (`boq/plumbing.py` `suggestion_units`): a one-off suggestion fired by a text pattern gets an
  evidence item `detectionId: "text_{n}"` (n = index of the line in the version's `text.json.gz`, placed at the text
  bbox centre, floor of the sheet). A room cue (e.g. a drawn courtyard) still wins over the text. **Web/API**: an
  evidence `detectionId` that is not a detection — `text_{n}`, `sheet`, a room id (since Sprint 4) — should open the
  sheet (and, for `text_{n}`, centre on that text line's `bboxMm`).
* **A-pipeline-12**: `byRoom` on every computed line (`aggregate._by_room`; canonical rooms via `match_room`, niche
  sub-rooms named "נישה" with type `niche`; per-item quantities split by item, other units go to the majority room of
  their items; the split sums to `qty`). Rule kind `fixture_combination` (`plumbing.combination_units`, before the
  plumbing points; members consumed via `dropped_by = combination:{ruleId}`). Excel sheet: request 4 (API).
* **A-LIVE-01** (`aggregate.add` / `_lines`): a line without a library item keeps the rule's unit (`מ"ר`, `מ"א`,
  `קומפלט`, `יחידה`) and description; a user-chosen code without an item takes the description / unit of the rule
  that targets that code, else the class name — never `פריט 5.01` / `יחידה` for an area line. Default-library items
  (`source: 'default'` or `defaultsVersion`) resolve by exact code. Build `stats.library {items, defaults}`.
* **A-LIVE-02**: `service/pipeline.py` writes `stats.sheets` after every ingest job (sheets with a current version,
  `supersededBy` / `status: superseded` excluded; only when the project doc exists); `boq.build` writes
  `stats.{boqLines, green, yellow, red}` (all lines incl. manual). The API must map `stats` (request 6).

### Results (Noah, `boq_local.py --no-corrections` on copies of the E2E-01 root, HEAD vs this round)
* Every line that existed before: **identical** qty, byFloor, level, unit, description, chapter (41/42); 3.15
  differs only in `evidenceCount` 0 → 1 (`text_…` on the plumbing sheet). Lines 42 → 52: + 1.01–1.10, each 1.0
  קומפלט, yellow, 3 evidence items (the three demolition plans). Project `stats` {boqLines 52, green 0, yellow 50,
  red 2}.
* E2E-08 shape: 3.04 = 3, `byRoom` = ground שירותים 1, first חדר רחצה (r_2) 1, first חדר רחצה (r_5) 1 (Data/QA's
  per-bathroom expectation); 5.02 split per bathroom + niches.
* E2E-12 shape: approve 4.01 (15) → `add` correction of a double socket → rebuild: 4.01 qty 16, `reviewed`,
  red, `הכמות השתנתה מאז האישור (15 → 16)`, build `approvalsInvalidated [{ln_4_01, 4.01, 15 → 16}]`.

### Tests / commands
`tests/test_boq_stage10.py` (chapter 01 offered / not offered / not twice; text-cue evidence + room cue wins; unit +
description without an item; default-library resolution by code; fixture combination incl. leftovers; byRoom on
canonical rooms, sums = qty; approved + override keeps approval; reason format; project counters from the build and
the ingest), `tests/test_boq.py` (approval invalidation end to end incl. the build doc list, no double report,
re-approval), `tests/test_boq_s4.py` (text trigger has evidence), `tests/test_boq_contracts.py` (pending-rule
tolerance: `PENDING_CONTRACT_RULES` until `boq-defaults.json` lists them, then strict equality). No pipeline-acceptance
xfail belongs to these defects (`benchmark/acceptance`: 9 passed, 3 xfailed = A-pipeline-05/11, Worker-Accuracy); the
API's `it.fails('A-API-06 …')` flips on the API side.

### Not done / open
* Excel "פירוט לפי חדר" and the export/audit parts of A-API-06 live in `apps/api` (requests 1, 4).
* Contracts for `template_chapter` / `fixture_combination` / `byRoom` / `approvalInvalidated` / item `source:
  'default'` (requests 1–5). Until they land, the worker-seeded `r_template_demolition` doc is skipped by the API's
  rule listing (`safeParse`).
* `fixture_wc_hung` / `cistern_concealed` are not detected classes (taxonomy + Worker-Accuracy); on Noah the WC is one
  class (`fixture_wc_concealed`), so the combination rule is proven on synthetic data only.
* Chapter-01 lump sums are attributed to the lowest demolition floor in `byFloor` (a lump sum has no floor; the
  contracts have no "project-wide" floor key).
* Checks (2026-11-01): ruff check clean, ruff format clean on my files (repo-wide `--check` flags only Worker-Accuracy's
  in-progress `symbols/qualifiers.py`), mypy 2.4.0 (CI way) no issues, bandit 1.9.4 `-ll` clean, `pytest -q` 528
  passed, `pytest ../../benchmark/acceptance` 9 passed / 3 xfailed.

### Follow-up for Worker-Accuracy's requests
* **Calibration re-cap of stored artifacts (A-LIVE-03)** — `boq/build.load_inputs` runs `pipeline.ceiling.cap_document`
  with this worker's `default_table()` (+ the org `settings.greenThreshold`) on every loaded `detections` / `links` /
  `rooms` document before aggregation. Raster = the sheet's classification carries `גיליון רסטר` / `רסטר`. It only
  lowers levels. Stored `אושר ידנית` items stay green, and corrections are applied afterwards in `aggregate`, so a
  reviewer's accept is still green. Build `stats.calibrationCapped {detections, links, rooms}`. Test:
  `test_boq_stage10.py::test_build_recaps_stored_greens_with_the_current_calibration_table` (3 stale greens capped; a
  stored human accept and a correction accept stay green). Noah (current conservative artifacts): 0 capped, no line
  changed.
* **4.14 from a fan switch in any group — tried, NOT shipped.** Variant: each new `switch_fan` in a non-
  `add_to_existing` group becomes its own 4.14 unit, and the group's other switches are matched as before.
  E2E-01 root: no change (4.14 1 → 1). Worker-Accuracy's `fix-accuracy/after` root (note-block fix: the master fan
  switch is now `switch_fan`, still paired with the fan as a `single` group): **4.09 16 → 15** (confirmed, GT 16) and
  **4.14 1 → 2** (GT 1); nothing else moved. Today the rule would double-count that unit. Ship it together with the
  arc-crossing re-pairing (Worker-Accuracy gap "4.10"), and re-verify then.

### Follow-up for the API's requests (apps/api/NOTES.md "Stage 10 fix round")
* **Superseded sheets (A-API-05)**: `boq.build` skips every sheet with `superseded == true` (the boolean is tested;
  `supersededBy` may be null) → `skippedSheets[sid] = "superseded"`. Ingest `stats.sheets` counts the same way.
* **Corrections follow the revision (E2E-12)**: `build.retarget_superseded` moves a correction made on a superseded
  sheet onto the sheet that replaced it, following chains of up to 8 revisions. `Correction.origin_sheet_id` keeps the
  original sheet, so the old detections are read from that sheet's version, and `Correction.on_version` makes it
  always re-match by anchor + class family: a shared version id "v1" never counts as the same version. If
  `supersededBy` is null, or the replacement is not in the build, the correction is reported unmatched (`הגיליון לא
  נכלל בבנייה`).
* **Imports override the default library**: `library_import.importer.deactivate_defaults` sets `active: false` on
  every `source: 'default'` item of a code the import brings. Nothing is deleted. A default item whose id equals the
  imported one becomes the imported item (active). Import stats `defaultsDeactivated`.
* The contracts mirror test is strict again (`PENDING_CONTRACT_RULES` removed). It passes with the published
  `r_template_demolition`.
* Contract doc nit for the API: `FixtureCombinationMatchSchema.radiusMm` is documented as *paper* mm. The worker
  treats it as **real** mm (divided by the sheet scale), like `faucetRadiusMm` / `roomMatchRadiusMm` — please fix the
  comment. The taxonomy classes `fixture_wc_hung` / `cistern_concealed` are not in `SymbolClass` yet, so the
  "אסלה תלויה + מיכל סמוי" example rule does not validate.
* Tests (`test_boq_stage10.py`): superseded sheets skipped + their correction re-matched on the replacement, with an
  orphan correction reported unmatched; import deactivates defaults (idempotent); written lines (with `byRoom` /
  `approvalInvalidated`) and a `fixture_combination` rule validate against the published JSON schemas.
* Checks after the follow-ups (2026-11-01): ruff check / format clean (my files), mypy 2.4.0 + bandit 1.9.4 clean,
  `pytest -q` 556 passed, 1 failed = `test_rooms_v4::test_sample_mep_basement_split_with_reference`. That test reads the
  shared `/home/claude/kamutan-data/artifacts` (stale data, listed in Worker-Accuracy's gaps) and is not touched by the
  BOQ. Noah E2E-01 root re-run: still only + 1.01–1.10 and 3.15 evidence 0 → 1; every other line identical.

## Stage 10 — fix round (Worker-Accuracy)

Brief: `docs/agents/STAGE10_FIX_BRIEF.md` (owns `symbols/ legend/ links/ parse/ ocr/ pipeline/ rooms/ fixtures/`). Defects:
`/home/claude/kamutan-data/acceptance/{pipeline,ui,live}/defects.md`. Tests: `tests/test_stage10_accuracy.py` (25) +
the flipped acceptance tests in `benchmark/acceptance/test_pipeline_acceptance.py` (no xfail left for my defects).

### Fixes
* **A-pipeline-01 (4.05 comms)** — `symbols/qualifiers.py` (new), wired in `symbols/detect.py`
  (`READ_QUALIFIER_OCR`, `_is_text_family`, `_resolve_by_ocr`). Members of a look-alike family (BEZEK / TV / TEL / רשת
  brackets) whose word the SHX reader did not read are decided after one OCR pass: per candidate, 8 narrow windows
  along the compass directions (start 0.45 × symbol size out, 2.1 sizes long, ±0.48 size wide; text-sized strokes
  only; the symbol's own stem dropped), each turned so the text reads the way a drawing is read (from the bottom or
  the right), all windows stacked into ONE image → Tesseract `eng` + `heb` (psm 6). Candidates still unread get ≤ 3
  on-axis windows read as single words (psm 8; ≤ 24 calls per sheet). Words are matched to the family's tokens
  (legend qualifier, or implied by the label: "לטלויזיה" → TV, "לטלפון" → TEL, "רשת" → רשת, "בזק" → BEZEK); short Latin
  tokens need the same length (TV exact). Greedy global assignment; a window's strokes name one symbol only; two
  members read equally well = no reading. A read member drops `דומה לסמל אחר` and gets the word as an annotation; a
  bare bracket (q < 0.85) is now kept when its word is read (this recovered the 2 missed data points). No reading →
  the previous rule, unchanged. Noah c054fd3a: tv 8 → tv 4 / data 4 / phone 2 = GT exactly. detect +1–3 s on the comms
  sheet.
* **Two-line notes** (`detect._note_block_text`): a nearby label is classified as its whole note block ("מפסק" over
  "למאוורר" = fan *switch*); "למאוורר" alone had refined the master pendant into a ceiling fan (fan precision 0.83 → 1.0;
  the switch becomes `switch_fan`).
* **A-pipeline-11** — the raster reason is `גיליון רסטר` everywhere (`classify/sheet.py`, `symbols/detect.py`,
  `calibration.R_RASTER`); the calibration ceiling and `kbench calibrate` still recognise the legacy `רסטר`
  (`calibration.RASTER_REASONS`, kbench `RASTER_REASONS`).
* **A-pipeline-06 (PNG only), partial** — `parse/raster.py`: `rule_sheet()` turns long horizontal / vertical ink runs
  (≥ 4 mm, ≤ 0.8 mm thick, at 8 px/mm) into line segments, so the title block's cells and the drawing regions are
  found as on a vector sheet (stored as the raster page's primitives); title-band OCR is up-sampled to 400 dpi; a
  Tesseract line is split at a vertical rule between two words, at gaps > 1.2 line heights, and after a label word
  (`:` read as `.` on scans). Noah PNGs at 200 dpi: c054fd3a electrical [basement, ground] (was "flooring", no floor),
  1bbe4113 lighting [basement, ground], b2046277 lighting [ground], 8099ab2c construction [first]; eb8be8a3
  electrical without a floor ("קרקע" misread), 08222cb2 no title block (landscape layout) — still yellow/red with
  reasons. **Detections on rasters are not fixed** (see Gaps).
* **A-pipeline-05 (DXF blocks)** — `parse/dxf.py` writes each INSERT's paper bbox (`bboxMm`: the block definition's
  extents, cached per block, through the INSERT's own transform). `symbols/blocks.py` (new) + `detect._block_detections`:
  a block is countable when a class-bearing label stands beside one of its INSERTs (legend sample = legend layer, a
  legend table, or a "מקרא" title above; not counted) or its name is a known label (SOCKET, SWITCH, LAMP…). **Block
  count** = plan INSERTs; **graphic count** = distinct places where the block's own exploded strokes are found
  (`spot_template` with a template from the legend sample; a loose copy on top of an INSERT is the same place). One
  detection per place (`source` block / vector), a vector detection of the same class at that place is dropped. Counts
  differ → every detection of the block is yellow with `ספירת בלוקים (N) שונה מהספירה הגרפית (M)`; a place without an
  INSERT also gets `סמל משורטט ללא בלוק`, an INSERT with no visible strokes `בלוק ללא שרטוט נראה`.
  `DetectResult.stats.blocks` = `[{block, class, blocks, graphic}]`.
* **A-pipeline-03/04 (geometry part only)** — `rooms/walls.py` records `stats.faceInsetMm` (median half pen width of the
  wall outlines + the 0.05 mm union pad); `rooms/segment._to_wall_faces` grows every face back by that much (≤ 0.5 mm),
  never past the middle of the wall it touches: the room polygon now sits on the wall *face* (the stroke's centre
  line) instead of the pen's inner edge. Guest WC IoU vs GT 0.941 → 0.982. The convention questions (courtyard
  GT-D-007, corners near doors GT-D-008, 4.09 GT-D-006) are unchanged.
* **A-UI-19** — `pipeline/floor_check.py` (new), called by the orchestrator when the drawing's floors (Sprint 4 wall
  alignment) replace the title's: classification reason `הקומות בשרטוט שונות מהכותרת (בשרטוט: …; בכותרת: …)`, green →
  yellow; `classification.floors` keeps the title reading, the sheet's `floors` the drawing's. Noah: 6fa88f92 ("ת.
  מאסטר"), c054fd3a, 1bbe4113 flagged.
* **A-LIVE-03** — findings: `calibration/table.json` + `schema.json` ship in the wheel (uv_build) and the Docker image
  (`COPY workers/drawing/` + `uv sync --no-editable`; the dockerignore drops `*.pdf/*.dxf/…`, not JSON); every worker
  producer of a level calls `calibrate` (detections vector + raster, fixtures, rooms, link groups, confirmed floors);
  the reprocess path creates a fresh version (`artifacts: {}`) and re-runs `understand`; the API and web pass levels
  through unchanged (web `CountsPanel` counts `detection.level`; its header shows BOQ-*line* stats, so header and panel
  measure different things — Web). The one real gap: the orchestrator wrote `stats.calibration` from *its* table but
  uploaded the sandbox's levels unchecked (the sandbox output is untrusted; the child never sees
  `KAMUTAN_CALIBRATION_TABLE`, and an older worker / image writes greens with no table at all). Most likely the live
  sheet was produced by a pre-Sprint-5 worker (no `stats.calibration` on its version doc → check it; reprocess fixes it).
  **Fix**: `pipeline/ceiling.py` (new) — `service/_understand` re-applies the orchestrator's table to every green item
  of `detections / rooms / links / fixtures` before upload (only lowers; human acceptances kept; raster never green),
  recomputes `stats.detections` and the level counts of `stats.links`, logs `calibration ceiling lowered sandbox greens …`. Tests: stale sandbox output
  through the real pipeline, wheel built + imported in a fresh interpreter (table version = committed, not
  `fallback-empty`), dockerignore check; `tests/test_service_links.py` now expects the stub's green group capped.

### Noah, before / after (same BOQ code for both; `scripts/ingest_local.py --force` into scratch roots from frozen
non-editable snapshots — before = `git archive HEAD`, after = this tree; `boq_local.py --no-corrections`; kbench
gt-v0.4.1-draft). Roots: `/home/claude/kamutan-data/acceptance/fix-accuracy/{before,after}/`.
| metric | before | after |
| --- | --- | --- |
| symbols micro-F1 (semantic / glyph) | 0.847 / 0.753 | **0.876 / 0.781** |
| items correct before review | 78.8 % (LB 73.0) | **81.9 % (LB 76.3)** |
| tv / data / phone F1 | 0.667 / 0 / 0 | **1.0 / 1.0 / 1.0** |
| ceiling_fan P | 0.833 | 1.000 |
| links exact R / P, kind acc | 0.933 / 0.966, 0.967 | unchanged |
| fixtures micro-F1 | 0.941 | 0.941 |
| tiling rooms: area / perimeter median PE | 0.118 / 0.134 | 0.091 / 0.122 (corners unchanged) |
| eval-boq 3/4/5/9.01 gated: exact, ΣAE | 26/41, 36.14 | 26/41, **33.10** |
| 4.05 (exp 11; drawing has 10) | 8 | **10** |
| 4.10 (exp 2) | 1 | 1 (not fixed, see Gaps) |
| 5.01 (57 ±3 %) | 56.30 | 57.19 |
| 5.02 (18.1 ±2 %) | 17.06 (−5.7 %) | 17.59 (−2.8 %) |
| 5.03 (15.6) | 12.20 | 12.20 (corner convention, owner) |
| 9.01 (43, disputed) | 43 | 44 |
Every other line identical. 9.01 +1: the master pendant is no longer a (false) ceiling fan; the old 43 hid another
extra luminaire. Page times 7–45 s (max 1bbe4113), set ≈ 300 s on the shared box.

### Gaps (not fixed)
* **4.10 (A-pipeline-02)**: the missing two-way is the master suite (GT 1bbe4113-G13: existing 2-way at the bed head +
  new 2-way → existing fan point). The stair two-way is correctly counted once (cross-sheet dedup). Two independent
  errors remain: the bed-head switch is detected as `switch_single` and its note "מפסק מחליף קיים" is not read (SHX
  noise), and at the dashed-arc junction below the fan switch the chaining pairs the fan switch with the fan and the
  new 2-way with the type-23 spot (the GT-D-005 area: GT reads the opposite pairing). A semantic re-pairing at arc
  crossings ("a 2-way needs a 2-way partner") was designed but needs the bed-head switch known as a 2-way first (OCR
  of that note). With it, 4.14 would move to the fan switch's group: needs the BOQ rule "fan switch anywhere → 4.14"
  (Worker-BOQ).
* **PNG detections (A-pipeline-06)**: still 0 on Noah PNGs → raster BOQ lines empty. The old NCC path finds the legend
  badly at 5 px/mm. A centre-line vectoriser (thinning + tracing, so the vector legend / chamfer machinery could run)
  was prototyped: 20 s per A3 and symbols touching walls lose their shape (merged into the wall skeleton); not
  shipped. Next step: thick-wall removal before thinning + full-page OCR for legend labels, or a learned detector.
* 5.02 −2.8 % is the courtyard (GT-D-007, owner) + niches; 5.03 is GT-D-008 (owner).
* Timing-budget tests (`test_integration_sample`, `test_understand_sample`, < 60 s) fail only when the shared 2-vCPU
  box is loaded (load 6–8 from other agents during this round; they failed the same at HEAD on the first run); `test_rooms_v4::test_sample_mep_basement_split_with_reference` reads the shared
  `/home/claude/kamutan-data/artifacts` (27.29 m² vs ≤ 27.0) and fails the same with the face growth off — stale data.

### Requests
* Worker-BOQ: `boq.build` reads stored artifacts of older versions — cap their greens with
  `pipeline.ceiling.cap_document` (same table) so a pre-calibration version cannot feed green evidence; 4.14 from a
  `switch_fan` in any group kind (see 4.10).
* Web: the review header shows BOQ-line stats while "ספירה לפי סוג" shows detection levels — label or align them.
* DevOps: optional build-time check in `infra/docker/worker-drawing.Dockerfile`:
  `python -c "from kamutan_drawing.calibration import load_table; load_table()"`.

## Sprint 6 — text & equipment items (Worker-Text)

Brief: `docs/agents/SPRINT6_BRIEF.md` (row Worker-Text). Package `kamutan_drawing.textitems` (pure; no I/O except
`from_version_dir`). The artifact shape was published first and the API mirrored it in
`packages/contracts/src/takeoff.ts` (`TextItemsArtifactSchema`, kinds without `detail` → detail boxes are not emitted).

### Contract requests (API agent) — artifact `text_items.json.gz` (`kamutan.textItems/1`), per version
Written by the `understand` task next to `detections.json.gz` (reported as `textItemsFile`, like `wallsFile`; the
orchestrator uploads it and sets `artifacts.textItems` — additive). Every field below is always present (null when
unknown):
```
{ schema: "kamutan.textItems/1", sheetId, discipline: Discipline|null, catalogVersion: int,
  items: [{
    id: "t_{n}",                       // stable per version (reading order)
    sheetId: DocId,
    kind: "note"|"callout"|"detail_ref"|"legend_row"|"panel_schedule"|"conduit",
    text: string (≤ 400),              // as read, lines of a note block joined with " / "
    normalized: string (≤ 400),        // Hebrew-normalised (finals folded, geresh/gershayim/quotes unified, spaces
                                       // collapsed); a detail_ref carries "פרט A → <detail box content>"
    bboxMm: {x,y,w,h},                 // the text block (conduit: the run's bbox)
    anchorMm: {x,y}|null,              // leader terminal / run end the item names (else null → use bbox centre)
    lineIdx: int[],                    // indexes into the version's text.json.gz lines (evidence `text_{n}`)
    floor: string|null, roomId: string|null,   // from the anchor (regions / rooms of the same version)
    lifecycle: "new"|"existing"|"replace"|"add"|"demolish"|null,   // "קיים/חדש/להחליף/להוסיף/פירוק" qualifiers
    qty: number|null, unit: "יחידה"|'מ"א'|null,   // the item's own quantity (0 = folded into `pairedWith`)
    lengthM: number|null,              // conduit: drawn length × scale; text "באורך 1.5 מ'" → 1.5
    matchedPattern: string|null,       // catalog entry id (textitems/catalog.py), null = unmatched note
    itemCode: string|null,             // reference code of that entry ("4.19"), null = unmatched
    role: "item"|"feed"|"switch"|null, pairedWith: "t_{m}"|null,
    corroborates: bool,                // the line is produced by symbols/links; this item is evidence only
    suggested: bool,                   // drawings show a trigger, not the item (BOQ: origin 'suggested')
    dedupe: "floor"|null,              // one unit per floor over ALL sheets (ventilator on 3 plans = 1)
    leaderMm: [{x,y}]|null,            // callout leader polyline (passthrough field)
    confidence: number 0..1, scoreRaw: number, level: "yellow"|"red", reasons: string[]   // never green (calibrate)
  }],
  stats: {items, matched, byCode: {code: qty}} }
```
`textitems.boq.text_units(docs)` (pure) turns the artifacts of a build into `{itemCode, qty, floor, sheetId,
roomId, itemIds[], level, reasons, suggested}` units with the pairing / cross-sheet de-dup already applied — Worker-BOQ
can call it from the `text_item` rule kind instead of re-implementing the semantics.

## Sprint 6 — Worker-Geometry (stairs, hatched regions, wall runs, courtyard, ceilings / valances, partial cladding)

Brief: `docs/agents/SPRINT6_BRIEF.md` (row Worker-Geometry). Package `kamutan_drawing.geometry` (pure; no I/O except
`debug.py` / `scripts/geometry_local.py`). Status: **artifact shape published first (below); implementation, Noah
before/after and gaps follow in this section.**

### Contract requests (API agent) — artifact `geometry.json.gz` (`kamutan.geometry/1`), per version
Written by the `understand` task on plan sheets (construction / architecture / master; demolition sheets for the
`demolished` regions), reported as `geometryFile` (like `wallsFile`); the orchestrator uploads it under the version
prefix and sets `artifacts.geometry` (additive, optional; readers fall back to the name). Coordinates paper mm,
origin top-left, y down; polygons are `[{x,y}]` (Firestore: no nested arrays); quantities in real units with the
region's scale. Every field is always present (null when unknown). Levels go through `calibration.calibrate` with the
class keys `geometry:<kind>` (not in the table → never green: **yellow at best** until there is GT).
```
{ schema: "kamutan.geometry/1", sheetId, discipline: Discipline|null, scaleDenominator: int|null,
  heights: [{floor, ceilingM, source: "label"|"level_mark"|"room"|"default"}],   // per floor of the sheet
  levels: [{valueM, atMm{x,y}}],                     // level marks read on the sheet (signs as read)
  stairs: [{ id: "st_{n}", floor, regionId, lifecycle: "new"|"existing"|"demolish"|"unknown",
             treads: int, risers: int|null, lines: int, numbered: bool, numbers: [int]|null,
             descending: bool,                        // numbered below the ±0.00 datum ("-1".."-11")
             widthM, goingM, runLengthM, polygonMm, bboxMm{x,y,w,h}, roomId|null,
             key: string,                             // cross-sheet identity (floor/lifecycle/treads/width/going)
             confidence, scoreRaw, level, reasons }],
  regions: [{ id: "hr_{n}", category: "gypsum"|"block"|"concrete"|"demolished"|"waterproofing"|"ceiling"
                 |"valance"|"closure"|"cladding"|"unknown",
              pattern: "solid"|"lines"|"cross"|"dashed_box", color: "#rrggbb",
              lifecycle, areaM2, perimeterM, polygonMm, bboxMm, floor, roomId|null, roomName|null,
              label: string|null, labelBboxMm|null, labelSource: "leader"|"near"|"legend"|null,
              confidence, scoreRaw, level, reasons }],
  wallRuns: [{ id: "wr_{n}", kind: "block_new"|"gypsum_single"|"gypsum_double"|"concrete_retaining"|"low_wall",
               closure: bool,                         // fills an existing opening ("סגירת דלת בבלוק")
               lifecycle, lengthM (centreline), thicknessM, heightM|null,
               heightSource: "label"|"level_mark"|"room"|"default"|null,
               areaM2|null (= lengthM × heightM, one face), polygonMm, bboxMm, floor, roomIds: [string],
               label|null, regionId|null, confidence, scoreRaw, level, reasons }],
  lines: [{ id: "ln_{n}", kind: "valance_curtain"|"valance_ventilator"|"valance"|"cistern_screen"|"window_closure",
            lengthM, heightM|null, polylineMm, bboxMm, floor, roomId|null, label|null,
            confidence, scoreRaw, level, reasons }],
  ceilings: [{ id: "cl_{n}", kind: "gypsum_ceiling", areaM2, polygonMm, bboxMm, floor, roomId|null, label|null,
               confidence, scoreRaw, level, reasons }],
  courtyards: [{ id: "cy_{n}", floor, floorAreaM2, polygonMm, bboxMm, stairId|null, wallRunIds: [string],
                 faces: [{kind: "retaining"|"building"|"open", lengthM, aMm{x,y}, bMm{x,y}}],
                 wallLengthM (retaining + building faces), wallHeightM|null, heightSource, wallAreaM2|null,
                 levels: {topM, bottomM}|null, label|null, confidence, scoreRaw, level, reasons }],
  measures: [{ key, unit: 'מ"ר'|'מ"א'|"יחידה"|"קומפלט", qty: number|null, computable: bool,
               reason: string|null,                   // why not computable (Hebrew, user-facing)
               estimate: {qty, method}|null,          // a usable estimator when not computable
               floor|null, refs: [ids of the items above], level, reasons }],
  stats: {stairs, regions, wallRuns, lines, ceilings, courtyards, seconds} }
```
`measures[].key` (semantic, never an item code — Worker-BOQ's `area_item` / `length_item` / `suggested_item`
`match` can select on `key`): `stair_treads` (new stairs), `retaining_wall_area`, `courtyard_wall_area`,
`courtyard_floor_area`, `courtyard_waterproofing` (קומפלט 1 when a courtyard with new retaining walls exists),
`block_wall_area`, `gypsum_partition_area`, `gypsum_double_partition_area`, `gypsum_ceiling_area`,
`valance_ventilator_length`, `valance_curtain_length`, `window_closure_area`, `plaster_new_walls_area`,
`kitchen_backsplash_area`, `wc_partial_cladding_area`, `demolished_wall_area`. A sheet's measures cover that sheet only;
**the same wall is drawn on the construction and the master sheet of a floor** — use
`geometry.project.geometry_units(docs)` (pure) which picks one authoritative sheet per floor (construction >
architecture > master; demolition only for `demolished_*`), de-duplicates stairs by `key` across floors (a courtyard
stair is drawn on the basement and the ground plan) and returns `{key, unit, qty|null, computable, reason, estimate,
byFloor, refs: [{sheetId, id}], level, reasons}` per key.

### Implementation (`src/kamutan_drawing/geometry/`, pure)
* `prims.py` — pen colour classes (red / yellow / green / neutral …) and lifecycle from colour + sheet kind (legend
  colour hints win; demolition sheet: every highlight = demolish; elsewhere yellow = demolish, red = new — the Sprint-2
  measurement); highlight fills; straight stroked segments; **plan zone** = the wall-network components
  (`rooms.walls.extract_walls`, openings off) that touch the plan's main rooms (named or ≥ 2 m²), grown 0.2 m — the
  1:5 / section details beside the plan (1470f005, the stair section of ad257a1c) are outside it.
* `hatches.py` — line hatch = ≥ 5 strokes of one colour, same direction (± 1.5°), overlapping, regular spacing
  0.4–3.5 paper mm; region = strokes widened by 0.55 × spacing, opened / closed with round joins (oblique strokes leave
  a saw-tooth); **area = Σ stroke length × spacing** (exact for a regular hatch; the outline over-estimates ≈ 8 %);
  crossing families → `cross`; pieces cut by a dimension merged (3.5 mm). Collinear strokes → chains; dashes
  (0.6–6 mm, gaps 0.3–3 mm) → dashed chains; dashed chains with two diagonals crossing inside → **dashed X box**
  (convex hull); parallel runs ≤ 0.25 m apart overlapping ≥ 60 % of the longer → one double line. NB the SHX reader
  "reads" dash strokes as `\ / |` glyphs: only text boxes with ≥ 2 letters / digits and strokes shorter than 0.6 × the
  line height are treated as text.
* `stairs.py` — flights = ≥ 4 parallel equal runs (0.6–2.5 m wide, ± 15 %) stepping regularly by 0.18–0.42 m (a
  double nosing line counts once); flights ≤ 1 m apart = one stair; step numbers ("-11 -10 … -1", one misread token
  tolerated) attached ≤ 0.3 m; treads = max |n| when ≥ half of 1..max is present, else the gaps between lines.
  Numbered below ±0.00 on the ground plan → the stair belongs to the basement (`descending`).
* `labels.py` — note blocks (`fixtures.labels.blocks`) with keyword flags (gypsum / double / block / concrete /
  demolished / waterproofing / ceiling ("ה.ת", "מזגן עילי", "מעל נגרות") / valance / curtain / ventilator / closure /
  opening / low / cladding / courtyard / cistern / window / partition) + leader terminals (`fixtures.leaders`); a note
  names an element by a leader ending on it (≤ 2.5 mm) else when ≤ 8 mm away; heights `H=140`, also "H" + "120" read
  apart; ceiling heights from level marks incl. the SHX form "2.55" over a bare "220"; level values.
* `analyze.py` — per region: regions (category from the note, else pattern + lifecycle: a new single-direction hatch
  = concrete), **wall runs** from new solid fills / new line hatches / closed new outlines (thickness & centreline
  from A = L·t, P ≈ 2(L + t); line hatch: L = drawn area / t), kind from the note (low / double / block / concrete /
  gypsum) else thickness (< 0.17 m gypsum single, else block; hatch → concrete), `closure` only with an opening word
  (דלת / פתח / חלון); height: note `H=` → room ceiling → floor level mark (+ reason **"גובה הקיר הונח כגובה התקרה
  בקומה"**) → default 2.60 (+ reason); low walls without H → no area. **Courtyard** = (bbox of new retaining runs + new
  stair) − retaining walls − building walls; faces retaining / building / open (an open stretch on a building face's
  line = an opening, counted); height = yard levels (highest − lowest level below ±0.00; unsigned levels on a
  basement sheet read as negative). **Ceilings** = new dashed X boxes. **Lines** = labelled new dashed / plain runs
  (valance curtain / ventilator, cistern screen ≤ 2.5 m, window closure ≤ 3 m; the first compatible note wins).
  Measures per floor (keys above; `window_closure_area` / `wc_partial_cladding_area` / `plaster_new_walls_area` are
  `computable: false` + estimate: window height 1.1 m (tiling convention sill 1.0 / head 2.1), screen height H or
  1.2 m, courtyard faces + both faces of new block walls). Levels: `calibrate("geometry:<kind>")` → yellow.
* `project.py` — `geometry_units(docs)`: one sheet per floor and key (construction > architecture > master;
  demolition only for `demolished_*`), stairs de-duplicated by key and an unnumbered view of a numbered stair (same
  width / going / lifecycle, treads ± 1, same or adjacent floor) dropped; every key returned (missing →
  `computable: false`, "לא נמצא בשרטוטים — להשלמה ידנית", red).
* Hooks (additive, small): `pipeline/understand.py` runs `_geometry` on construction / architecture / master /
  demolition sheets (`geometry=False` / args `geometry: false` switches it off) → `geometry.json.gz`, result keys
  `geometryFile` + `geometryStats`; `service/pipeline.py` uploads it (name checked, capped, `artifacts.geometry`);
  `pipeline/ceiling.py` caps every list of the document (class keys `geometry:<kind>`, measures `geometry:measure`).
* `scripts/geometry_local.py --root DIR` writes the artifact for every plan sheet of a local root (no re-ingest) and
  prints `geometry_units`. Scratch root with the Noah artifacts: `/home/claude/kamutan-data/acceptance/s6-geometry/`
  (`geometry_units.json` = the project-level output Worker-BOQ can read).

### Noah — before / after (gt-v0.6-draft `s6_lines.md`; before = `acceptance/fix-accuracy/after`, these lines not produced)
| line | BOQ | drawings give (GT) | before | after (`geometry_units`) | method |
| --- | --- | --- | --- | --- | --- |
| 5.04 stair treads | 11 | 11 | — | **11** (basement; drawn on 4 sheets, counted once) | 12 red tread lines + "-1..-11" on ad257a1c |
| 2.01 retaining walls | 11 m² | 10.6 | — | **9.04** (4.37 m × 2.07 m) | red 45° hatch L, 0.21 m; yard levels -0.50 / -2.57 |
| 2.03 kitchen door in block | 2 m² | 1.7–2.0 | — | **2.12** (0.80 m × 2.65 m, assumed = ceiling) | red fill 0.80 × 0.20 + "סגירת דלת בבלוק" |
| 5.08 courtyard waterproofing | 1 קומפלט | 1 | — | **1** (+ faces / height in the courtyard) | courtyard of the retaining walls |
| 7.01 gypsum ceiling | 4 m² | ≈3.4 | — | **3.32** (ground 2.02 + first 1.30) | dashed red X boxes |
| 7.02 ventilator valance | 4.3 m' | 4.27 | — | **4.27** | red dashed line + "סינר לונטה" |
| 7.03 window closure | 1.5 m² | width 1.20 | — | width **1.20**, `computable: false`, estimate 1.32 | red double line + note |
| 7.05 curtain valance | 7 m' | 6.41 | — | **6.41** | red dashed double line + "סינר גבס לוילון" |
| 7.06 gypsum partitions | 35.2 m² | ≈30 | — | **27.80** (basement 4.44 m × 2.20, ground lining 4.40 × 2.65, first 1.90 + 2 × 0.25 × 2.65) | red fills < 0.17 m |
| 7.07 double partition | 7.5 m² | 3.4 m, no height | — | **7.11** (3.23 m × 2.20) | red fill + "מחיצת גבס דו כרומי" |
| 5.07 guest-WC cladding | 1.2 m² | ≈1.0 | (2.0/1.2 only from demo room settings) | `computable: false`, estimate **0.98** (0.82 m × H 1.20) | red screen line + "מסתור ניאגרה H 120" in the WC |
| 8.02 plaster | 22 m² | estimate | — | `computable: false`, estimate **21.53** (courtyard faces 8.35 m × 2.07 + 2 × 2.12) | |
| 5.06 kitchen backsplash | 2 m² | not drawn | (2.0 only from demo room settings) | `computable: false`, "לא נמצא בשרטוטים" | — |
All items yellow (geometry classes are not in the calibration table). Heights assumed = ceiling say so in the reasons.
Rooms / fixtures / detections / tiling: no code change in `rooms/`, `fixtures/`, `boq/` — identical. Runtime 0.1–1.2 s
per plan sheet.

### Tests / commands
`tests/test_geometry.py` (20): colour / lifecycle, note flags & heights (incl. "2.55" over "220"), numbered descending
stair → basement, unnumbered stair, double nosing, solid runs by label / thickness + default-height reasons, level-mark
height flagged as assumed, details beside the plan ignored, demolished regions, courtyard (hatch, outline, yard
levels, faces), dashed X ceiling, valance / cistern screen ("H" + "120") / window closure, unlabelled lines dropped,
ids + JSON-schema validation (`packages/contracts/json-schema/GeometryArtifact.json`), `geometry_units` authority +
missing keys, stair de-dup (numbered + unnumbered view), orchestrator cap, garbage input, understand hook
(construction writes `geometry.json.gz`, electrical does not), Noah targets (skips without local artifacts).
```bash
uv run python scripts/geometry_local.py --root /home/claude/kamutan-data/acceptance/s6-geometry/artifacts
uv run pytest -q tests/test_geometry.py
```

### Contract requests (API agent)
* `GEOMETRY_MEASURE_KEYS`: I emit `demolished_wall_length` (m', centreline of demolished wall fills) instead of the
  listed `demolished_wall_area`, plus `valance_length` (a valance note without curtain / ventilator) — please list both
  (the key regex is open, so nothing fails today).
* Additive fields already written (passthrough): `regions[].roomType`, `lines[].roomType`, `courtyards[].waterproofing`,
  `courtyards[].faces[].opening`, `measures[].estimate.widthM` / `courtyardM2` / `blockM2` (extra estimate inputs).

### Gaps
* 2.01: centreline 4.37 m × 2.07 m (yard levels) vs the GT's outer lengths 4.7 m × 2.1–2.4 m → −18 % vs the BOQ. The
  height above the top level / footing is not drawn.
* 7.06: the BOQ's 35.2 m² is ≈ 1.27 × what the plans draw (27.8 m² at ceiling height); maybe full storey heights or
  both faces — owner convention (decided 05.11: "Owner decision 05.11 — 7.06 partitions" below). The basement low
  wall (H=140, outline) is not read: its "H=140" is not OCR'd.
* Heights: the SHX reader rarely reads "H=…"; partitions take the floor ceiling (ground / first 2.65 from the level
  marks, basement 2.20) — always with the "הונח" reason.
* Rooms (not changed here): on ad257a1c the kitchen polygon leaks ≈ 1.1 m² into the courtyard landing (courtyard door
  closed on the courtyard side) — the courtyard tolerates it.
* Ceiling plans proper (reflected ceiling sheets) and legend-defined hatch semantics are supported only through notes /
  legend colour hints; Noah has neither. Demolition-sheet regions are produced (`demolished_wall_length`) but not
  checked against GT.
* Shared-file note: a parallel edit of `pipeline/understand.py` dropped `_geometry` / `GEOMETRY_DISCIPLINES` once
  (NameError in `understand` → every sheet's understanding failed as `file_unreadable`). They now live at the end of
  the module ("Sprint 6 (Worker-Geometry) — keep this block here"); `tests/test_geometry.py::test_understand_writes_and_reports_the_geometry_artifact`
  catches it.
* Checks (2026-11-01): ruff / ruff format clean on my files, mypy 2.4.0 (`uv run --with mypy==2.4.0 mypy src`) no
  issues, bandit 1.9.4 `-ll` clean, `pytest tests/test_geometry.py` 20 passed; full suite (`--ignore=tests/fuzz`)
  622 passed / 3 failed before the hook fix — after it, the integration / understand sample tests pass except the
  < 60 s timing budgets on the loaded shared box (load 6–8), `test_rooms_v4::test_sample_mep_basement_split_with_reference`
  (stale shared artifacts, pre-existing) and the sandbox fork-bomb process cap (shared box).

### Flow (`textitems/extract.py`, hook `pipeline/understand.py::_text_items`, after rooms / fixtures)
1. text.json lines (index = `lineIdx`); title-block lines dropped (project / client names never leave it); lines in a
   legend table → `legend_row` (never counted).
2. Detail boxes: title "פרט A קנ"מ 1:20" + the description stacked under it (first gap ≤ 20 mm: the detail's drawing
   sits between) — not an item; its content is folded into every reference "פרט A" (`detail_ref`, `normalized =
   "פרט a → שישה שקעימ / נקודת רשת …"`). The SHX reader's slips in this word are tolerated (פ→ס, ר→ך/ד, A→א/ץ:
   "א.קוברה סךט א" on c054fd3a is a reference).
3. Note blocks: stacked + aligned lines (box clipped to 1.4 × `heightMm` — a stray symbol glyph had made "שקע בתקרה)"
   3 × font height); cut at an underline only when the lines are ≥ ½ line apart (a tight underline is the leader's
   shoulder: "משאבה לניקוז / מי גשמים"). Leader → `callout` + `anchorMm` (`fixtures.leaders.LeaderIndex`).
4. Conduit runs (`textitems/conduits.py`) when a legend row names "קוברה/צינור": one open dark smooth polyline
   (≥ 12 pieces, ≥ 8 mm, no turn > 35°, not a glyph path) with a small circle (r 0.2–1.1 mm) on ≥ 1 end; the notes
   ≤ 8 mm from its ends are its text; a run whose notes say "מקרן" is 4.27, the others 4.20. `lengthM` = drawn × scale.
5. Catalog (`textitems/catalog.py`, `CATALOG_VERSION` 2) per block, one item per (entry, spanned lines); context =
   spanned lines + next line (excludes, lifecycle, role, qty). Patterns are normalised like the text (a space also
   spans the " / " line join). Lifecycle: demolish > replace > add > existing > new.
6. Folding on the sheet: switch → nearest feed of the same entry/floor (qty 0 + `pairedWith`), `group_mm` (bell +
   push-button, by anchor or note-box gap), `per_floor`.
7. Level: `calibrate("text:{itemCode}", …, level ≤ yellow)`; red when the OCR confidence < 0.5; never green (no GT
   statistics for text classes yet). The orchestrator re-caps the artifact (`pipeline/ceiling.KINDS["text_items"]`).

`textitems/boq.py::text_units(docs)` folds a build's artifacts into units (skips qty 0 / corroborating, `dedupe` per
floor across sheets). Worker-BOQ implemented its own `boq/textitems.py` on the same fields (catalog items by code,
`corroborates`, `pairedWith`, per-floor) — both agree on Noah.

### Lines (Noah; GT `gt/noah/s6_lines.json` gt-v0.6-draft; before = Stage-10 root `acceptance/fix-accuracy/after`,
after = full `ingest_local.py --force` of the current tree into `acceptance/s6-text/after` + `boq_local.py`)
| line | before | after (GT) | how |
| --- | --- | --- | --- |
| 4.06 | 0 | **4** (4) | `detail_ref` "פרט A" ×4 resolved through the detail box (שישה שקעים …); box itself not counted |
| 4.08 | 0 | **1** (1) | note "צינורות חופשיים / מהריצפה:" (bullet list = content; plumbing "צינור גז … חופשי" excluded) |
| 4.12 | 3 | 3 (3) | links; "להוסיף מחלף" ×3 = corroborating evidence |
| 4.17 | 3 | 3 (3) | heater symbols; "מפסק לתנור" ×3 corroborating; legend row excluded |
| 4.18 | 1 | 1 (1) | symbol; "אינטרקום / יש להעביר צינור…" corroborating |
| 4.19 | 0 | **1** (1) | "הזנה / לונטה" (feed) + "מפסק לונטה" (switch, folded) |
| 4.20 | 0 | **5** (5) | conduit runs (ground 3, first 2) minus the projector run |
| 4.21 | 3 | 3 (3) | symbols re-classed by "שקע תלת פאזי"; notes corroborating |
| 4.22 | 1 | 1 (1) | symbol; "פעמון" + "פעמון / מעל הדלת" grouped = 1; "פעמון מיני" (luminaire) excluded |
| 4.23 | 1 | 1 (1) | symbol; "הזנה לדוד חשמל" + "מפסק טיימר / לדוד חשמל" paired |
| 4.24 | 1 | 1 (1) | panel detection; "לוח חשמל+מונה" corroborating (module count not on the drawings) |
| 4.25 | 0 | **1** (1) | "לוח תקשורת" as a note subject; "הכנה לשקע / בתוך לוח תקשורת" (ground) excluded |
| 4.26 | 0 | **1** (1) | "מפסק דוד קיים / להחליף לטיימר / גוויס" (lifecycle replace) |
| 4.27 | 0 | **1** (1) | conduit run ending at "קוברה+ / שקע בתקרה / למקרן" (drawn 4.2 m, BOQ 3.5 m convention) |
| 4.28 | 0 | **1 suggested** | not on the drawings: only "…עד הגעה ללוח חשמל" (existing panel, master + demolition) |
| 9.03 | 0 | **1 suggested** | pipe not drawn; ventilator ("ונטה") on electrical + master + construction = 1 per floor |
| 3.15 | 1 | 1 (1) | one-off rule; "משאבה לניקוז / מי גשמים" corroborating |
| 5.08 | 0 | **1** (1) | "+פרט איטום" on the basement construction plan (קומפלט) |

kbench eval-boq scope 3./4./5./9.01/9.03, gated (fresh root = cold org glyph store, like the before root): exact
**26/42 → 37/42** (0.619 → 0.881), ΣAE 34.1 → 6.1; coverage
present **52 → 75/77** (missing 2.02 / 8.02 = other workers). Ch04 + 9.01 + 9.03 only: 12/23 → 21/23 (left: 4.05,
4.10 — Worker-Accuracy gaps). Symbols micro-F1 glyph 0.781 → 0.781, semantic 0.876 → 0.871 and fixtures 0.941 →
0.922: one `ac_unit` on c054fd3a moved (fixtures/rooms path, `rooms/segment.py` changed in HEAD after the before root
was ingested; this round emits no detection). Links identical (28/30, 28/29, kind 1.0).
Re-run into the same root (warm glyph store, after Worker-Geometry's `_geometry` fix; 15/15 succeeded, 0 understanding
failures): the 18 lines above unchanged and exact, gated 35/42 — **4.12 3 → 4 and 4.09 16 → 15**, not from text items:
the warm store now reads "נק' קיימת" next to ground luminaire d_11 on b2046277 (cold read "היימת"), lifecycle → existing,
and its new 2-way switch's group becomes `add_to_existing` (links kind accuracy 29/30 → 28/30). Owner: links / BOQ
(the GT keeps that ground group `single`) — flagged to Worker-Accuracy / Worker-BOQ.
Incident: one of my edits to `pipeline/understand.py` (removing the conduit-detection helper by slicing between two
anchors) also removed Worker-Geometry's `_geometry` helper written between them; they restored it at the end of the
module (marker + guard test). None of my measurements ran in that window (ingest logs: 0 NameError / unreadable).
Tried and dropped: `conduit_cobra` detections for the runs — kbench scores no linear truth (truth n = 0), so the 6
runs were 6 FPs (semantic F1 0.876 → 0.866); 4.20 is counted from the text items instead. `socket_box_6` detections
for "פרט A": the leader terminals are 6–60 mm from the GT points (3 mm tolerance) → FPs; 4.06 stays text.

### Tests / commands
`tests/test_textitems.py` (25): normalisation + SHX-tolerant detail refs, counts / lengths / lifecycle, synthetic
electrical sheet (pairing, grouping, traps: legend rows, "פעמון מיני", "בתוך לוח תקשורת", detail box), disciplines,
title block, contract JSON schema (`TextItemsArtifact.json`), per-floor folding, catalog patterns portable + rule
mirror, conduit runs (circles, smoothness, grey, exclusion, projector), `text_units` across sheets, ceiling cap,
Noah sample (skipped without the local artifacts).
`uv run python scripts/text_items_local.py --root <artifacts> [--write] [--merge-lines OUT] [-v]` recomputes the
artifact from stored artifacts. Timing: text items 0.07–0.5 s per sheet.

### Edits outside `textitems/` (additive)
* `pipeline/understand.py`: `_text_items` hook (option `text_items` / task arg `textItems`), `TEXT_ITEMS_FILE`,
  result keys `textItemsFile`, `textItemStats`, timing `textItems`.
* `service/pipeline.py` (Worker-BOQ's): uploads `textItemsFile` like `wallsFile` (name checked), capped by the ceiling,
  `artifacts.textItems`. `pipeline/ceiling.py`: kind `text_items` (class key `text:{itemCode}`).

### Requests
* API: `boq.ts` evidence docs say `ti_…` — the artifact ids are `t_{n}` (contract `idWith('t_')`). No `text_item`
  rule targets 4.06 / 4.20 / 5.08: they come through Worker-BOQ's catalog fallback (fine; a rule would also do).
  `r_text_comms_panel` has `nearClasses: panel` + `consumeNear` — on Noah the panel detection (4.24) is not consumed
  (4.24 stays 1); keep `proximityMm` small or it would steal the 4.24 panel.
* Worker-BOQ: `stage_timings_ms` ignores the new `textItems` timing (fold it into `links` or `artifacts` if wanted).
  `aggregate.py` `produced_codes` (origin detected/text/geometry) — a corroborating item of a code produced only by a
  one-off rule became a 2nd unit in one intermediate run (3.15 = 2); it is 1 in the final run, re-check if it returns.
* Data/QA / kbench: the linear `conduit_cobra` truth is not scored by `kbench eval` — once it is, the runs can also be
  written as detections (code removed this round; `textitems.conduits.find_runs` gives the geometry).

### Gaps
* No panel schedules on Noah (scope `panel_schedule` accepted, no extractor yet).
* Text items need the SHX reader: notes it garbles (ground "הכנה לשקע / בתוך לוח תקשורת" read "|בהך לחתקשורת")
  are simply unmatched; rotated labels ("צ.קוברה" along the runs) are not needed (runs are geometric).
* Rasters: same code over Tesseract lines; no conduit runs (no vectors). Levels never green until text GT stats exist.
* 4.28 size / 4.24 module count / 4.20 & 4.27 nominal lengths are BOQ wording, not drawing facts.

## Sprint 6 — rule kinds text_item / area_item / length_item / suggested_item, origin, coverage (Worker-BOQ)

Brief: `docs/agents/SPRINT6_BRIEF.md` (row Worker-BOQ). Contracts (API agent, published during the sprint):
`library.ts` `TextItemMatchSchema` / `GeometryItemMatchSchema` (incl. `keys`) / `SuggestedItemMatchSchema` +
`SPRINT6_RULES` (`DEFAULT_BOQ_RULES_VERSION` 6), `takeoff.ts` (`normalizeHebrewText`, `kamutan.text-items/1`,
`kamutan.geometry/1`), `boq.ts` (line `origin` / `needsInput` / `quickAction`, evidence `kind` / `bboxMm` /
`geometryMm` / `stair`, build `stats.coverage`). `boq/rules.py` `DEFAULT_RULES` mirrors v6 exactly (the Sprint-6 block
is generated from `json-schema/defaults/boq-defaults.json`; the mirror test is strict and green).

### Modules (`boq/`, pure)
* `textitems.py` — `text_item`. `norm_he` = exact port of `normalizeHebrewText` (the contract's examples are tests);
  patterns are normalised the same way and searched case-insensitive. Sources per version: `text_items.json.gz` —
  the contract shape (`kamutan.text-items/1`, `ti_…`) **and** Worker-Text's published shape (`kamutan.textItems/1`,
  `t_…`, catalog fields `itemCode` / `qty` / `pairedWith` / `corroborates` / `suggested`) — else the OCR lines of
  `text.json.gz` (a line inside a `legend.json.gz` box has scope `legend`, any other line an unknown scope that
  satisfies `note` / `callout` / `any`). Scope `any` = everything but `title` (legend rows included, per contract).
  `consumeNear` consumes only a detection within `CONSUME_NEAR_MAX_MM` = 8 paper mm of the text (the rule's
  `proximityMm` stays the `nearClasses` filter): Noah's "לוח תקשורת" is 17 mm from the unit panel, which stays 4.24.
  `matchCatalogCode: false` turns the catalog-code match off.
  Qty modes per contract (`count` with capture group 1, `number_in_text`, `length_in_text_m` = `lengthsM[0]`, `one`);
  `proximityMm` merges repeated matches; `lifecycle` filter (a text without a qualifier passes); `nearClasses` = a live
  detection of the classes within `proximityMm` of the anchor / box, `consumeNear` drops it from every other rule.
  Text rules run right after the cross-sheet de-dup, before any counting rule, so consumption is effective.
  **Worker conventions** (not in the contract text — API please confirm or move into the contract):
  (1) per floor only one sheet counts (first of the rule's `disciplines`, then most matches) — a note drawn on the
  electrical and lighting plan of a floor is counted once; (2) a Worker-Text catalog item belongs to its own
  `itemCode`: a rule of that code counts it whatever its patterns (with the item's own qty: pairs already folded),
  rules of other codes never match it (the "‑צ.קוברה" bullet inside the 4.08 note is not a 4.20); evidence-only
  (`corroborates`), suggested and folded (`pairedWith`, qty 0) items are never counted by a text rule; (3) a catalog
  item counted by a text rule whose `anchorMm` is ≤ 1 mm from a detection's centre is that detection (consumed: the
  projector cobra run is 4.27, not also 4.20); (4) **catalog fill-in**: catalog items of a code no `text_item` rule
  targets are counted (origin `text`) when countable, or — evidence-only items — only when no other rule produced the
  code (the symbol was not detected); catalog *suggestions* of a code nothing produced become suggested lines with the
  item's qty as the estimate (9.03 vent duct, 4.28 main panel). Evidence `detectionId` = `text_{lineIdx[0]}` (the
  API resolves it), `kind: "text"`, `bboxMm`.
* `geometry.py` — `area_item` / `length_item`. `keys` (the default rules' selector) → Worker-Geometry's
  `geometry.project.geometry_units(docs, keys)` (one authoritative sheet per floor, stairs de-duplicated): computable →
  one unit per floor (origin `geometry`, evidence = the measure's shapes: `kind` geometry | stair, `geometryMm`,
  `stair {treads, risers}`, `quantity`; a measure without shapes → the sheet). **`computable: false`** (coordinator
  decision, replaces the contract's "estimate → yellow") → a suggested line, `needsInput`, qty 0, red, reasons = the
  measure's reason (e.g. the assumed / missing height) + the estimate as a hint ("הערכה: 1.32 מ"ר (…)"); a key no sheet
  carries → nothing (the code's `suggested_item` takes over). A suggested `estimate {kind: geometry, keys}` uses
  computable measures only. Without `keys`: feature selection on the artifact's collections (`stairs` / `regions` / `wallRuns` /
  `lines` / `ceilings` / `courtyards`, ids kept; categories = the producer's codes) by `source`, `categories`,
  `legendPatterns` (on the label), disciplines / floors / room types (canonical) / lifecycle, `measure` (`wall_area` =
  `areaM2` × sides, else length × (rule height, else feature height) × sides; no height → skipped), `minQty`; per-floor
  sheet authority; stairs de-duplicated by `key` (else same treads on adjacent floors). The room panel wins: a code
  produced by a tiling rule from `roomSettings` (5.06 / 5.07 partial cladding) gets no geometry units, and a geometry
  estimate never adds to a code another rule produced.
* `suggested.py` — `suggested_item`: triggers `sheet_discipline` / `text` (scope default `any`, legend rows ignored,
  per-floor authority) / `demolition` (a demolition sheet, else demolished geometry, else demolish detections) /
  `always`; estimates `fixed` / `geometry` (incl. `keys`) / `room_area`; `level` (yellow default; red without an
  estimate); `quickAction` (rule's, else contracts `defaultQuickActionFor`) with the trigger's sheet. Offered only when
  no other contribution of the item exists (any origin, manual measures included — so a quick-measure correction bound
  to the line replaces it) and only for items of the org's library (no "לא משויך" noise from default codes).
* `aggregate.py` — every contribution has an origin (rule kind → `text` / `geometry` / `suggested`; one-off and
  template lines are `suggested`; all-manual → `manual`; else `detected`); line origin = `manual` when all manual,
  else the first of detected > geometry > text > suggested. `needsInput` = a suggested line without a usable quantity →
  `qty: 0` (contracts; the eval / UI / Excel treat it as "no quantity": empty cell + "להשלמה ידנית"), `byFloor {}`,
  `byRoom []`, level red, chip `להשלמה ידנית`.
  `quickAction {kind, sheetId}` on every suggested line, null otherwise. Evidence of non-detection items carries `kind`
  (text / geometry / stair / sheet / room).
* `coverage.py` + `build.py` — build `stats.coverage {libraryCodes, produced, suggested, missing[], byChapter{chapterKey:
  {…, missing: count}}}` over every line after the build (obsolete lines don't count); also `stats.textItems`,
  `stats.geometry`, `stats.suggested`. The build reads `text_items.json.gz` (`artifacts.textItems` / `text_items`, else by
  name) and `legend.json.gz` (scopes), `geometry.json.gz` (`artifacts.geometry`, else by name), and the OCR text of every
  sheet when a text rule / text trigger exists.
* `scripts/boq_local.py` — JSON rows carry origin / needsInput / quickAction / unit / byRoom; prints the coverage.

Per-floor / per-room and the Stage-10 approval rules are unchanged: text / geometry units carry the floor of their
evidence (regions) and the room (sheet rooms → canonical), suggested lines the trigger's floor; an approved suggested
line keeps its approval while its estimate is unchanged and drops to `reviewed` when it moves (tested).

### Quick-measure / lineId (contracts "Corrections")
`build.bind_to_lines`: an active correction with `lineId` takes the line's code as `itemCode` (measure m² / m', count
clicks) → a manual contribution of that item: on a suggested / needsInput line it REPLACES the suggestion (suggested
lines are skipped once anything produced the item), on a computed line it ADDS. An `accept` bound by `lineId` alone to a
suggested line is the confirmed quantity (`quantity`, else the current estimate) → manual, verified (green), not
`needsInput`. Tested (`test_quick_measure_bound_by_line_id_…`). The orchestrator already sets `artifacts.textItems` /
`artifacts.geometry` from `textItemsFile` / `geometryFile` (service/pipeline.py).

### Results (Noah) — `gt/noah/tools/run_s6_eval.sh after` (clean fresh CLI ingest of the 15 sheets after Worker-Text /
Worker-Geometry finished, 0 understanding failures; BOQ with the demo room settings and with none) + `report_s6.py` → `gt/noah/eval_sprint6.md`
| run | present | exact | exact or within tol | computed from drawings, exact/within | suggested default qty, right | missing |
| --- | --- | --- | --- | --- | --- | --- |
| Stage 10 reference (E2E-01) | 42/77 | 34 | 35 | 35 | 0 | 35 |
| sprint start (HEAD code, fix-accuracy root, demo settings) | 52/77 | 43 | — | — | — | 25 |
| **after** (demo room settings) | **75/77** | **57** | **59** | **39** | 20 | 2 |
| **after, no user input** | **75/77** | 55 | 56 | **36** | 20 | 2 |
("before" / "before_nors" in `eval_sprint6.md` ran an early draft of this work at 15:32, not the sprint-start code.)
By computability (after): computable 46/56, partial 5/13, not on drawings 8/8. Newly computed from the drawings:
4.06 4 (ground 1 / first 3), 4.08 1, 4.19 1, 4.20 5 (ground 3 / first 2), 4.25 1, 4.26 1, 4.27 1, 5.04 11, 5.08 1,
7.02 4.27 m'. Computed but off: 2.01 9.04 (BOQ 11, incl. stair cheek), 2.03 2.12 (2), 7.01 3.32 (4), 7.04 1 (3),
7.05 6.41 (7, BOQ convention), 7.06 27.8 (35.2), 7.07 7.11 (7.5). Suggested: 1.01–1.10, 3.08–3.10, 3.14, 3.15, 4.28,
8.01, 8.03, 8.04, 9.03 at 1; 7.03 needsInput (hint 1.32 m²); with no room settings 5.06 / 5.07 needsInput (hint 0.98
m²). **No regression**: every line exact at sprint start is still exact. Missing: 2.02, 8.02 — default-rule issues (requests 1, 2); with those two rules edited as proposed (user rule docs
in a scratch root) the build is 77/77 and 8.02 gets the 21.5 m² hint.

### Contract / default-rule requests (API agent)
1. `r_suggest_slab_stairs` (2.02): add a pattern for the stair the drawings name — `גרם\s*מדרגות` (Noah: "קונטור גרם
   מדרגות", "מדרגה במישור הריצוף"); no current pattern matches, so 2.02 is missing.
2. Wording too far from the client items for library resolution (code match needs description similarity ≥ 0.45 for
   imported libraries): `r_geo_plaster_walls` / `r_suggest_plaster_walls` (8.02 — missing on Noah) and `r_text_vent_pipe`
   (9.03 — rescued only by Worker-Text's catalog suggestion). Proposal: "שתי שכבות טיח על קירות חצר אנגלית וקירות בלוק
   חדשים", "התקנת צינור אוורור 4\" למפוח ונטה". (Default-library orgs resolve by exact code and are not affected.)
3. `r_text_comms_panel` `consumeNear` with `proximityMm: 40` would take the unit's panel symbol away from 4.24 (the
   electric and the comms panel share one symbol with two labels, both 17 mm away). The worker now consumes only within
   8 mm (above); please document that cap in the contract, or give `consumeNear` its own radius.
4. Document the coordinator decision: `computable: false` → `needsInput` with the estimate as a hint (the library.ts
   comment still says "non-computable + estimate → yellow"), and a suggested `geometry` estimate uses computable
   measures only.
5. Worker conventions to adopt (or reject) in the contract text: per-floor sheet authority for text / geometry rules;
   catalog fill-in (Worker-Text items of codes no text rule targets: countable items count, evidence-only items only
   when nothing produced the code, catalog suggestions → suggested lines); a catalog item anchored on a detection
   consumes it; room-settings tiling wins over geometry of the same code.
6. 7.04 (`r_text_access_panel`) counts the explicit "פתח שירות" only (1 vs 3): GT = one access panel per concealed AC
   evaporator ("סגירת גבס למיזוג") — a `suggested_item` with an estimate per closure would match.

### Links: add_to_existing only for an *added* switch (`links/graph.py`, coordinator request)
Worker-Text's warm re-ingest gave 4.12 3 → 4 and 4.09 16 → 15: the warm glyph store reads "נק' קיימת" next to the
dining point d_11 (b2046277; cold store "היימת"), so every point of its group was existing → `add_to_existing`, and the
switch d_29 (GT `switch_single-10`, detected `switch_2way`) made it 4.12. GT check: the point **is** existing
(`b2046277-luminaire_ceiling-2`, "existing point (dining)") but the GT group `b2046277-G06` is `single` — a plain new
switch feeding an existing point, counted by the client as 4.09; GT `add_to_existing` groups are exactly the ones whose
switch carries "להוסיף מחלף" (1bbe4113-G08/09/10), and an existing + new 2-way pair is `two_way` (G13). So the GT is
right and the link rule was too broad: `add_to_existing` now requires a "להוסיף …" note on a switch or a fan switch
(the lone-switch "להוסיף" path is unchanged); otherwise the usual single / shared / two_way kinds with the
`R_MIXED` chip. Result (fresh root = cold store, then a second `ingest_local.py --force` into the same root = warm
store, `boq_local.py --no-corrections`): **4.09 16 / 16, 4.12 3 / 3**, every chapter-04 line identical cold vs warm;
`kbench eval-links` kind accuracy 29/30 both (the miss is the known master-suite G13, 4.10). Test:
`tests/test_links.py::test_plain_new_switch_to_an_existing_point_is_single_whatever_the_ocr_reads`.

### Tests / commands
`tests/test_boq_s6.py` (29): normalisation (contract examples), text_item scope / proximity / qty modes / per-floor /
nearClasses + consumeNear, Worker-Text catalog (code match, fill-in, evidence-only, suggestions, anchor consumption),
geometry keys (computed per floor with shapes, stairs, non-computable → needsInput + hint, missing → fallback),
feature selection (wall_area × sides, minQty, legendPatterns), suggested triggers / estimates / levels / skip rules /
library-only, quick-measure by lineId (replace / add / confirm), coverage, build end to end (line + evidence + build
docs validate against the JSON schemas), approval kept on an unchanged estimate, default-rule codes ⊂ default library
v2, consumeNear cap (4.24 kept). `tests/test_boq_contracts.py` mirror (rules v6) green.
Checks (2026-11-01): ruff check + format clean on my files (repo-wide `--check` flags only Worker-Geometry's
`geometry/*`, `scripts/geometry_local.py`, `tests/test_geometry.py`); mypy 2.4.0 the CI way: 0 errors in `boq/`
(15 remaining are all in Worker-Geometry's `geometry/`); bandit 1.9.4 `-ll` clean; `pytest -q`: 627 passed, 3 failed =
the A3 timing budgets (`test_understand_sample[b2046277]` 82.6 s, `test_integration_sample[1bbe4113]`, box loaded by
the concurrent ingest) and `test_rooms_v4::test_sample_mep_basement_split_with_reference` (stale shared artifacts,
known since Stage 10). No BOQ test fails.

### Gaps
* 2.02 / 8.02 missing until requests 1–2; 7.04 1 vs 3 (request 6).
* Geometry quantities that differ from the BOQ are Worker-Geometry measures (2.01 height, 7.01 / 7.06 / 7.07 extents,
  7.05 BOQ rounding) — passed through unchanged.
* Chapter 04 symbol lines (4.00 / 4.02 / 4.03 / 4.05 / 4.10, GT-D-001) and 9.01 (GT-D-002) unchanged (detection).
* Text / geometry de-dup across sheets is per floor and per discipline order; two sheets of the same discipline and
  floor (a revision that is not marked superseded) would both count.

## Sprint 7 — line rename across rebuilds, manual library items, ClamAV in the ingest path (Worker-BOQ)

> **Sprint 7: antivirus scan shelved by the owner (04.11), code kept dormant, enable with KAMUTAN_AV_SCAN=require.**
> Default mode is `off` everywhere (Cloud Run included; no "always required" rule any more), one INFO line per process,
> no per-job log; `/healthz` → `antivirus {mode: "off", engines: []}` (not degraded). The ClamAV infra (Dockerfile,
> entrypoint, CI, signatures workflow, ADR 0009, runbook) was reverted by the coordinator, so `require` also needs an
> image with clamd / clamscan + signatures again. `service/scan.py`, `file_infected` / `scan_unavailable` and the
> fake-scanner tests stay; real-ClamAV tests run only with `KAMUTAN_AV_TEST=1`. The bullets below describe the code as
> it behaves when turned on.

Brief: `docs/agents/SPRINT7_BRIEF.md` (row Worker-BOQ, items 2 and 6). Contracts: `packages/contracts/NOTES.md`
"Sprint 7 published" (`BOQ_LINE_PRESERVED_FIELDS` + `descriptionOverride*`, `file_infected`, `SheetSet.error`).
Image side (clamd, signature DB, entrypoint): DevOps, ADR 0009, `infra/docker/worker-drawing.Dockerfile`.

### 1. Line rename (`boq/build.py`)
* `PRESERVED` + `descriptionOverride`, `descriptionOverrideBy`, `descriptionOverrideAt`, `descriptionOverrideReason` —
  identical (same order) to contracts `BOQ_LINE_PRESERVED_FIELDS` (`test_boq_contracts.py::test_preserved_fields_mirror_contracts`
  parses `boq.ts`). The worker never writes or clears them: new lines don't carry the keys, rebuilt lines copy them from
  the stored doc, a restore (`null`, API) stays `null`. `description` stays the computed wording (library item / rule).
* Obsolete line: `has_human_marks()` = qtyOverride (0 counts) | descriptionOverride | note | locked → kept at qty 0, red,
  `הסעיף לא נמצא בבנייה האחרונה`, never deleted. A restored, otherwise untouched draft line is deleted as before.
* Race narrowed: each existing line is re-read (`_fresh`) right before its full-doc write, so a PATCH (rename, override,
  approval) that lands while the build aggregates survives. A PATCH inside the few ms between that read and the write can
  still be lost — the GCP store has no transaction here yet (open, see below).

### 2. Manual library items (`boq/rules.py`, `boq/aggregate.py`)
* `Item.manual` = `source == 'manual'`. `Library.resolve(code, …)`: a manual item of the **exact code** wins without the
  description-similarity check (several manual items of a code → most similar, then id); `Library.preferred(code)`
  (manual first, then id) for the Worker-Text catalog fill-in. So after "עדכן גם בספרייה" the next build resolves the code
  to the renamed item and the line's `description` is the new wording (`itemId` unchanged when the API edits in place).
* Unchanged: default items still resolve by exact code (A-LIVE-01); imported items still need description similarity ≥ 0.45
  for a same-code match (another org's numbering) and the similarity fallback (≥ 0.6) is as before; a manual item of
  another code never captures a rule; inactive items ignored; a renamed default (`source: manual` + `defaultsVersion`)
  counts in `stats.library.defaults` as before. Noah (`org-demo`, no manual items): code path identical → lines unchanged.
* The importer already never overwrites a `manual` item (same id) and only deactivates `source: 'default'` items.
* **API please**: rename the item in place (same id) or set `active: false` on the old one — two active items of a code
  are both offered by `template_chapter` (chapter 01). The worker prefers the manual one everywhere else.

### 3. ClamAV before anything parses an upload (`service/scan.py`, `service/pipeline.py::_fetch`, `library_import/importer.py`)
Order in `_fetch`: `malware` mark on the sheet set for this sha256 → `file_infected` at once (no read) · download ·
size · sha256 · **scan** · magic-byte sniff · sandbox. The library import scans after download / size, before `sniff` /
`boq_parse`.
* Engines: `ClamdScanner` (zINSTREAM, 1 MiB chunks, unix or tcp, per-scan deadline), `ClamscanScanner` (`clamscan -`
  on stdin, fixed argv, minimal env, `--database` optional), `FallbackScanner` (next engine only when one is
  *unavailable*, never on a verdict). Replies: `stream: OK` / `… <sig> FOUND` / anything else (e.g. `INSTREAM size limit
  exceeded. ERROR`) = no verdict. Signature names sanitised (`[A-Za-z0-9._:/+-]`, ≤ 120).
* Policy: `KAMUTAN_AV_SCAN` = `off` (default, shelved) | `require` | `auto`; `KAMUTAN_AV=off` = `off`. With `require`,
  fail closed: no verdict (no engine, connection refused, timeout, ERROR reply) → retryable **`scan_unavailable`** (job
  `queued`, HTTP 500, Pub/Sub redelivers; after 5 attempts final `failed`); the file is never parsed unscanned. `auto`
  without an engine logs WARNING `antivirus scan SKIPPED` per scan.
* Engine env (agreed with DevOps before the shelving): `KAMUTAN_AV` clamd (clamd only — no clamscan next to clamd's
  ~1.2 GB DB) | clamscan | unset (clamd if a socket exists, then clamscan); `KAMUTAN_CLAMD_SOCKET` (probe order starts
  with `/run/clamav/clamd.sock`), `KAMUTAN_CLAMSCAN_BIN`, `KAMUTAN_CLAMAV_DB`, `KAMUTAN_AV_TIMEOUT_S` (120). Aliases
  `KAMUTAN_CLAMD` (`unix:…` / `tcp:h:p`), `KAMUTAN_CLAMSCAN`.
* **Infected** → non-retryable **`file_infected`**, message = the signature name (contracts: `SheetSet.error {code:
  'file_infected', message: <signature>}`; the job — and, on a reprocess, the version — get the same error via
  `_record_failure`). Quarantine (`scan.quarantine`): first the mark `malware {status: 'infected', signature, engine,
  sha256, quarantinePath, at}` merged into the sheet set (library import: the job + `libraryImports/{id}` docs), then
  the bytes move to `orgs/{o}/projects/{p}/infected/{sheetSetId}/{sha256}.bin` (import:
  `orgs/{o}/infected/imports/{importId}/{sha256}.bin`), `application/octet-stream`, `private, no-store`, and the
  original upload is deleted. `orgs/*/quarantine/` is the *client upload slot* the worker IAM may not touch (infra/IAM.md),
  hence `infected/`. If the move fails the mark still blocks every later parse (logged ERROR). The extra `malware` field
  on the sheet-set doc is not in the contract (non-strict zod strips it).
* Initial upload: no version docs exist before the probe (page count unknown), so the error is on the job + sheet set
  (the API's `GET …/sheet-sets/:setId` shows it); a reprocess job's version gets it too.
* `/healthz` → `antivirus {mode, engines[], clamdPing?}`; `create_app` resolves one scanner per instance and passes it to
  ingest and `library.import`; `app_from_env` uses `scanner_from_env()`.
* No env defaults in dev tools / conftests any more (the `setdefault` lines in `cli.py`, `scripts/*_local.py`,
  `tests/conftest.py` and `benchmark/acceptance/conftest.py` were reverted: default off makes them unnecessary).
* Self-test: `python -m kamutan_drawing.service.scan --selftest` (EICAR assembled at run time; exit 0 = FOUND + clean OK,
  2 = engine unavailable, 3 = skipped, 1 = wrong verdict).

### Requests / coordination
* **DevOps**: the self-test / CI requests are moot while the scan is shelved (infra reverted by the coordinator).
* **API**: (a) `SheetSet.error.message` = signature name, as requested; the infected bytes are under `…/infected/` (for
  `storageBytes` release and the project purge, which must include that prefix). (b) In-place library rename (above).

### Tests / commands
`tests/test_boq_s7.py` (8): preserved across same-input / changed-qty rebuilds with approval invalidation, restore to
null, obsolete renamed line kept then deleted after restore, a rename PATCHed between the listing and the write survives,
written lines validate against the published `BoqLine.json`, manual item by exact code + precedence + inactive ignored,
default / imported matching unchanged, end-to-end library rename picked up by the next build (other lines identical).
`tests/test_scan.py` (22; real-ClamAV ones skip unless `KAMUTAN_AV_TEST=1`): fake scanner — infected upload quarantined (mark, move, delete, signature message, never
parsed: the sandbox is patched to fail), EICAR declared as PDF is `file_infected` not `unsupported_format` (scan before
the sniff), redelivery / reprocess short-circuit without a read, move failure still blocks, unavailable → retryable then
final, require without an engine fails closed, clean upload scanned once then parsed, push handler 200 / 500, library
import infected + unavailable; policy / env (default off incl. Cloud Run, require / auto on request, one INFO line, healthz not degraded); verdict parsing; EICAR not stored in the
source; a fake clamd (unix socket, INSTREAM framing, StreamMaxLength ERROR, timeout); a fake clamscan (FOUND / OK / exit
2 / timeout) + fallback; self-test exit codes; **real ClamAV 1.5.4** `clamscan` and `clamd` (both installed here) detect
the run-time EICAR with a generated hash DB (pass locally with `KAMUTAN_AV_TEST=1`). `tests/test_boq_contracts.py` +
preserved-fields mirror (10 green).

### Follow-up for Worker-Accuracy (Sprint 7 heights)
* **`stats.heights`** (`service/pipeline.py::clean_height_stats`): the understand result's `geometryStats.heights {read,
  used}` (untrusted → non-negative ints ≤ 1e6) → version `stats.heights`; written only when the sandbox reports it.
  **Contract request (API)**: add `heights: {read: count, used: count}` (optional) to `VersionStatsSchema`
  (`packages/contracts/src/sheets.ts`). zod there is non-strict (the field is stripped, not rejected, until then), but
  the generated `SheetVersion.json` has `additionalProperties: false` — `tests/pipeline_util.validate_version` tolerates
  `stats.heights` only while the schema lacks it (`pending_version_stats()`), strict again once it lands.
* **Stale height reasons** (`boq/geometry.py::key_units`): for a *computable* `keys` measure the evidence items no longer
  carry the stored artifact's own reasons — the line gets only the measure's reasons (the measure may have read its
  height from a mark or another sheet of the floor). Not-computable measures unchanged. Noah (copy of `s6qa/s7acc_final`,
  `boq_local.py --no-corrections`, `KAMUTAN_AV_SCAN=off`, same code with vs without this change): **only 7.03 differs** —
  reasons `["גובה הפתח לפי סימון בשרטוט (1.35 מ')", "גובה לפי אותו פריט בגיליון אחר של הקומה"]`, the stale
  `הגובה אינו מופיע בשרטוט` gone; qty 1.62 / level / byFloor / description of all 77 lines identical.
* Tests (`tests/test_boq_s7.py`): `test_computed_measure_keeps_only_its_own_reasons`,
  `test_version_stats_heights_from_geometry_stats` (cleaning + end-to-end through `process_sheet_version`).

## Sprint 7 — drawn heights, 7.04 access panels, two-way pairing (Worker-Accuracy)

Brief: `docs/agents/SPRINT7_BRIEF.md` items 3–4 (owns `ocr/ symbols/ links/ geometry/ rooms/ textitems/`). No edit of
`pipeline/understand.py` (the geometry / text-items hooks already call the changed modules; every "keep this block
here" marker untouched). Tests: `tests/test_sprint7_accuracy.py` (11).

### Heights (item 3, `geometry/`)
* **Sections** (`geometry/sections.py`, new): a tall thin highlight strip *outside* the plan zone (red hatch = cast
  wall, red fill = lining) with level marks beside it. The vertical scale is not written; the level marks give it
  (`mm_per_m = Δy / Δlevel`, every pair must agree ±12 %; values taken as read, else as depths below ±0.00 since the SHX
  reader drops "-"). Pieces of one strip cut by an element drawn across it (the AC outlet box) are merged (gap ≤ 0.6 m).
  The strip is named by the note pointing at it. Used for new retaining walls (concrete / courtyard strip: top of wall
  to the underside of the footing, reason says so) and for runs whose note says "ראה חתך" (strip with a shared flag).
  `heightSource: "section"`.
* **Opening / H marks** (`geometry/marks.py`, new): "U.K=75 / O.K=210" is written vertically beside openings; the glyph
  reader returns noise. Per item still lacking a drawn height (window closure lines, door closures in block, low walls /
  screens without H) the dark text-sized strokes within 12 mm are rendered alone, turned 0/270/90°, read by Tesseract
  `eng` with a whitelist `UOKH.=0123456789` (≤ 12 anchors × 3 calls per sheet; ≈ +1–2 s on sheets with anchors).
  Opening height = O.K − U.K (door: O.K). Conflicting readings in a box → none. `analyze(read_marks=False)` / injected
  `marks_ocr` for tests; Tesseract missing → no marks (previous behaviour).
* **"H" and the number read apart** (`labels._h_beside_number`): the number on the same row right after a lone "H"
  (the master low-wall note read "קיר נמוך / 140 / y H / 100" and took the "100" length dimension before).
* **Low wall drawn as three sides** (`analyze._outlined_walls` + `_u_closes`): a red U whose open short side butts into
  an existing wall is closed; a low wall with its height counts in `gypsum_partition_area` (thin / gypsum note) or
  `block_wall_area` (new `material` field on low walls, passthrough).
* **Shared across a floor's sheets** (`project.share_heights`, called by `geometry_units`): an item without a drawn
  height takes the drawn height of the same item (same kind / floor, length ± 3 % and 5 cm, thickness ± 3 cm) on
  another sheet; disagreeing donors → nothing; documents copied (pure), measures recomputed; `heightSource:
  "other_sheet"`. The construction plan stays the authority sheet.
* `lines[].heightSource` (label / opening_mark / other_sheet, passthrough); `stats.heights = {read, used}` in
  `geometry.json.gz` and `geometryStats` (the brief's `stats.heights`).
* Partitions: Noah's plans draw **no** H / section / ceiling plan for any partition — they keep the floor's ceiling
  from the level marks (basement H=220, ground / first 2.65) with the "הונח" reason. "ה.ת 40" (lowered ceiling) and
  "עד התקרה" (screen to the ceiling) are not used for partitions (no partition under them on Noah).

### 7.04 access panels (`textitems/catalog.py` `tx_ac_access_panel`, `extract._fold_access_panels`, catalog v3)
One panel per gypsum AC closure note ("סגירת גבס למיזוג") or AC ceiling box ("ה.ת … מזגן עילי", or the box's
"יש לבצע חיזוקים עבור מזגן עילי" — the warm glyph store reads the box's "H" as "ה" and splits "ה.ת 40" into a block of
its own; without this pattern warm gave 7.04 = 2), construction /
architecture plans only (the master copies them; a bare "מזגן עילי" is a wall unit on every MEP sheet; "פירוק"
excluded). An explicit "פתח שירות / ביקורת / אורבונד" note is the panel of a closure ≤ 40 mm away or of a closure that
says "ראה חתך" (the Noah living-wall section), else a panel of its own. The floor's first note carries the count (qty),
the others are folded into it (`pairedWith`) — because `r_text_access_panel` clusters at 300 mm and takes one quantity
per cluster. Noah: ground 2 (living lining + kitchen box; the section's "פתח שירות" folded), first 1 (corridor box).

### Two-way pairing (item 4, `links/graph.pair_two_ways`)
"A two-way needs a two-way partner": a circuit with one 2-way `S` + one other switch `F` and no 2-way partner, and a
lone 2-way `T` ≤ 30 mm away flagged `מחלף ללא מחלף שני` → `S`+`T` = `two_way` on `S`'s points, `F` takes `T`'s place
(the crossing arcs' exchange; = GT 1bbe4113-G13 / G14 as drawn). Added 2-ways ("להוסיף מחלף") never paired; a circuit
with 2+ other switches is left alone. **Does not fire on Noah**: the bed-head switch stays `switch_single`, because
"מפסק מחליף קיים" cannot be read — see Gaps.
Simulated with the bed-head switch as an existing 2-way (stored artifacts, `link_sheet` + `boq_local.py`): 4.10 1 → 2,
4.09 16, 4.11 5, 4.12 3, 4.16 2 unchanged, **4.14 1 → 0** — the fan switch then sits (as drawn) in the type-23 spot's
`single` group, and the BOQ rule counts 4.14 only for a `switch_fan` in an `add_to_existing` group.

### Noah (`gt/noah/tools/run_s6_eval.sh`; before = `s7acc_before` = tree at sprint start, after = `s7acc_final`, cold
glyph store, `KAMUTAN_AV_SCAN=off` (ClamAV landed mid-sprint; local clamscan exits 2); warm = 2nd ingest into the same
root, `s7acc_final_warm` — `gt/noah/eval/sprint6_s7acc_*.json|md`)
| line | BOQ | before | after | how |
| --- | --- | --- | --- | --- |
| 7.06 | 35.2 | 27.80 | **29.19** | + basement low wall 1.00 m × H=140 (was not detected); ground lining 4.40 × 2.65 now from the section (same value); other partitions: ceiling from level marks (no H drawn) |
| 7.07 | 7.5 | 7.11 | 7.11 | 3.23 m × 2.20 — the stair-soffit height is not drawn |
| 2.01 | 11 | 9.04 | **10.57** | 4.37 m × 2.42 m from the section (−0.50 to the footing underside; scale from −0.50/−0.70/−2.57) |
| 2.03 | 2 | 2.12 | 2.12 | 0.80 m × 2.65 — no door head mark at the kitchen door on any sheet |
| 7.03 | 1.5 | needsInput (hint 1.32) | **1.62** computed | 1.20 m × 1.35 m ("U.K=75 / O.K=210" on the ground master plan, shared to the construction sheet) |
| 5.07 | 1.2 | 1.2 demo settings / needsInput 0.98 | same | cladding extent not marked; screen H=120 read as before |
| 7.04 | 3 | 1 | **3** | ground 2 + first 1 |
| 4.10 | 2 | 1 | 1 | note unreadable (Gaps) |
| 4.09 / 4.11 / 4.12 / 4.14 / 4.16 | 16/5/3/1/2 | exact | exact (cold and warm) | |
Totals: exact 58 → **59**, exact-or-within 60 → **61** (no room settings 56 → 57, 57 → 58); warm store: 59 / 61, every
line identical to cold. Only 2.01 / 7.03 / 7.04 / 7.06 differ from before. (The warm "no room settings" build is not
clean: the cold run's demo settings stay stored in the root and `{}` does not clear them — warm reported with settings.)
Full suite: 670 passed, 2 failed = `test_integration_sample[1bbe4113]` < 60 s budget (75.9 s alone, load 6.5 on 2
vCPU; geometry / marks do not run on lighting sheets) and `test_rooms_v4::…basement_split_with_reference` (stale shared
artifacts, known since Stage 10). ruff / format / bandit clean, mypy 2.4.0 the CI way: the one error is in
`raster_symbols/legend.py` (Raster-Spike), as are the repo-wide ruff / format findings.

### Gaps
* **4.10**: on 1bbe4113 PDFium's path API returns only the lower half of every glyph of "מפסק מחליף קיים / H=65" (the
  segments stop at y = 237.5 mm; PDFium's *render* draws the whole note; not a clip in our parser — no other page
  object covers the band). The glyph reader therefore reads noise. Tried: Tesseract `heb` on a PDFium render of the
  note (12–32 px/mm, psm 6/7/11, dilated) — this SHX stick font is not read; word-spotting with the sheet's own "מחלף"
  (NCC) — not discriminative. Prototype removed. Owner of `ingest/` (PDF vector extraction): find where the glyph tops
  live (pattern / painted content?). Once the switch is known as a 2-way (reading or a reviewer correction), the pairing
  above applies.
* **4.14 with the pairing**: needs Worker-BOQ's "fan switch in any group → 4.14" (their Sprint 6 note, "ship together
  with the re-pairing"), AND d_17 (the lower bed-head circle, an existing single → pendant 21) is detected as
  `switch_fan` ("סוג עודכן לפי כיתוב סמוך") — with fan-anywhere it would add a false 4.14. Fix the refinement first.
* Partition heights (7.06 / 7.07) and the kitchen door head (2.03): not on the drawings. 7.06's 35.2 vs 29.2 drawn.
  (7.06 since 05.11: owner convention, see "Owner decision 05.11 — 7.06 partitions" below.)
* The 7.03 BOQ line still lists the construction item's own "הגובה אינו מופיע בשרטוט" chip (Worker-BOQ copies
  evidence-item reasons from the stored artifact, not from the project measure).

### Requests
* Worker-BOQ / orchestrator (`service/pipeline.py`): write `stats.heights` from `res.geometryStats.heights`
  (non-negative ints, untrusted) — API: add `heights: {read, used}` to `VersionStatsSchema`.
* Worker-BOQ: 4.14 fan-anywhere (above); `r_text_access_panel` could take catalog items' qty summed per cluster
  (today: the first catalog qty — hence the per-floor head item).
* API: `geometry.lines[].heightSource`, `wallRuns[].material` / `sectionBboxMm` / `heightMark` are passthrough fields.

### Tests / commands
`tests/test_sprint7_accuracy.py` (11): mark parsing / OCR crop + failure, window height from marks (and off), "H" + number
on the same row, U-shaped low wall (and a long open side rejected), section scale (signed / depths / inconsistent),
interrupted strip merged, heights shared across sheets (pure, authority kept, disagreeing donors), 7.04 folding (section
note, lone access note, AC box, master excluded), two-way pairing (+ 4 untouched cases). Updated: `test_geometry.py`
Noah 7.03 (computed 1.62), `test_textitems.py` Noah sample (+ 7.04: 3).

### DevOps → Worker-BOQ (Sprint 7): ClamAV image contract, done (ADR 0009)
* Image (`infra/docker/worker-drawing.Dockerfile`): ENV `KAMUTAN_AV=clamd`, `KAMUTAN_CLAMD_SOCKET=/run/clamav/clamd.sock`,
  `KAMUTAN_CLAMD_CONF=/etc/clamav/clamd.conf`, `KAMUTAN_CLAMSCAN_BIN=/usr/bin/clamscan`, `KAMUTAN_CLAMAV_DB=/var/lib/clamav`
  (read-only for uid 10001), `KAMUTAN_AV_TIMEOUT_S=120`. clamd limits: `StreamMaxLength 128M` (> 100 MiB upload),
  `MaxFileSize 128M`, `MaxScanSize 400M`, `AlertExceedsMax no`, `ReadTimeout 120`, `MaxThreads 2`, `ExitOnOOM yes`.
* Entrypoint (`infra/docker/worker-entrypoint.sh`): clamd answers PING **before** uvicorn starts. clamd dies → exit 70.
  `KAMUTAN_AV=clamscan|off` → no daemon. Matches your fallback ("off on Cloud Run → clamscan + baked DB").
  JSON log lines `clamd_ready` (DB versions, `loadSeconds`, `rssKb`) / `clamav_db_stale` / `clamd_exited` / `clamd_start_failed`.
* Your requests: (1) `python -m kamutan_drawing.service.scan --selftest` now runs in `infra/scripts/clamav-smoke.sh`
  (CI `docker` job, deploy, daily refresh): once via `docker exec` in the entrypoint container (clamd + baked DB) and
  once with `KAMUTAN_AV=clamscan`; skipped for images that do not have the module. (2) CI `python` job (workers/drawing):
  clamav + clamav-daemon installed with the services masked (no freshclam download), step
  `KAMUTAN_AV_TEST=1 uv run pytest -q tests/test_scan.py --deselect …::test_real_installed_engine_with_its_own_signatures`.
  The deselected test needs the official DB; the docker job covers real signatures. Local run: 20 passed, 1 deselected.
* Alert filter `file_infected` (log match on the worker): keep that word in the log line for an infected upload.

## Sprint 7 — raster symbol spike, E2E-05 (Raster-Spike)

Brief: `docs/agents/SPRINT7_BRIEF.md` item 5 (time-boxed). **Recommendation: No-go.** The prototype stays behind
`KAMUTAN_RASTER_SYMBOLS=1` (default **off**); with the flag off nothing changes (old `symbols/raster.py` path).

### What was built (`src/kamutan_drawing/raster_symbols/`, new)
* `image.py` — black-ink mask at 8 px/mm (grey < 120: grey furniture / hatching at ≈ 150–215 left out), long-line
  removal (openings with 7 mm line elements at 0/45/90/135°), large-fill removal, text-line mask (≥ 3 similar-sized
  components on one line, horizontal or vertical).
* `legend.py` — legend rows from pixels: ruled table (`legend.tables.find_tables_segs` on the raster's long
  horizontal runs), rules / borders removed with stroke crossings given back (symbols overshoot the 3.2 mm bands),
  per row Tesseract `heb` (band, then the label crop alone, binarised, white margin); components outside Hebrew words
  are symbol parts, grouped, and kept only if they line up in a column with ≥ 2 others; label = Hebrew words between
  this symbol and the next one to its left; one-edit correction against the class keywords (`שקש בודד` → socket);
  marker rows ("ראה הערה", "אביזר מוגן מים") become *negative* exemplars; a crop containing another glyph ("2X" + socket)
  becomes a qualified family member. The old raster legend finder (`symbols/raster.py`) missed socket_single,
  switch_single and socket_double on c054fd3a and 1bbe4113 (300 dpi probe); this one classifies all three on 4/4 legend
  sheets at 200 dpi (at 300 dpi the 1bbe4113 socket label is misread). Many labels are still misread (רמקול, מחלף,
  "שקע כח" on some sheets) → those glyphs get no class.
* `match.py` — template bank (glyph × 45° poses × mirror when asymmetric, rotational symmetry skipped) at the
  legend→plan scale (estimated: 1.0 unless 0.8 / 1.25 give ≥ 1.5× more strong hits), per-glyph full-sheet NCC
  response maps (OpenCV `matchTemplate` when importable — **not** a dependency — else a scipy FFT fallback), ink-share
  check (a solid fill / an empty edge is no symbol), KD-tree NMS (other-class runner-up → margin), "2X/3X" by Tesseract
  `eng` around sockets (0/90/270°).
* `template.py` (approach A) — every local maximum of a glyph's response map ≥ 0.8. `blobs.py` (approach B) —
  symbol-sized connected ink groups after stripping, each classified by the best glyph response around its centre ≥ 0.8.
* `__init__.py` — `detect_raster_symbols(...) -> DetectResult`; every item `source: raster`, reason `גיליון רסטר`,
  `score_detection(raster=True)` → never green (calibration ceiling). `KAMUTAN_RASTER_SYMBOLS_METHOD=blobs|template`.
* Hooks (additive): `pipeline/understand.py` (raster branch: new detector only when the flag is on);
  `sandbox/runner.ENV_ALLOW` + `KAMUTAN_RASTER_SYMBOLS`, `KAMUTAN_RASTER_SYMBOLS_METHOD` (plain switches; the child's
  environment is allow-listed, the flag would not reach the sandbox otherwise).

### Test set and harness (outside git, `/home/claude/kamutan-data/raster-spike/`)
`scripts/render_set.py`: the 15 Noah PDFs → `png200/`, `png300/` (pypdfium2, grayscale, display orientation = the GT
frame; the /Rotate 270 sheets come out portrait like the GT). `scripts/bench.py DPI` runs the shared stages once and
writes `bench/{template,blobs}_{dpi}/<sheet>/detections.json.gz`; `scripts/table.py` runs `kbench eval
--pred-detections` (gt-v0.4.1-draft, centre tolerance 3 mm) → `bench/table.md`; `scripts/tune.py` dumps per-class
score distributions (TP vs FP) → `bench/tune_200*.txt`; `scripts/diag.py` = best NCC of every glyph *at the GT points*.
Scored sheets: the four with a symbol legend (c054fd3a, eb8be8a3 electrical; 1bbe4113, b2046277 lighting).
OpenCV for the runs: `flock /tmp/kamutan-uv.lock uv pip install opencv-python-headless` (not in the lock; a `uv sync`
removes it again).

### Numbers (semantic class; kbench per-class over the 4 sheets)
| class (GT n) | A template 200 R / P | A template 300 R / P | B blobs 200 R / P | B blobs 300 R / P |
| --- | --- | --- | --- | --- |
| socket_single (23) | 0.26 / 0.43 | 0.30 / 0.17 | 0.22 / 0.38 | 0.17 / 0.44 |
| socket_double (16) | 0.19 / 1.00 | 0 / – | 0.19 / 1.00 | 0 / – |
| switch_single (30) | 0 / 0 (5 FP) | 0 / 0 | 0 / 0 | 0 / – |
| luminaire_ceiling (22) | 0 / – | 0 / – | 0 / – | 0 / – |
| socket_power (7) | 1.00 / 0.64 | 0.71 / 0.83 | 0.86 / 0.60 | 0.57 / 0.80 |
| micro, all classes | R 0.09 P 0.18 | R 0.07 P 0.18 | R 0.08 P 0.52 | R 0.04 P 0.50 |
| time per A3, wall / CPU | 88 / 49 s | 92 / 57 s | 84 / 47 s | 86 / 54 s |

Full per-class tables: `bench/table.md`. Times on the shared 2-vCPU box (load 5–8 from other agents; CPU s is the
fairer number): legend 6–10 s (Tesseract), scale 5–9 s, response maps 50–90 s (≈ 100–300 poses × full-sheet NCC at
8 px/mm with OpenCV; the scipy fallback is ≈ 3× slower), candidates + NMS + 2X OCR 1–14 s. dpi barely matters: the
search runs at 8 px/mm either way; 300 dpi only changes the binarisation (thin lines a little fatter) and is not better.

What the threshold sweep shows (`tune_200_v4.txt`, glyph-level, 200 dpi): socket glyph P 0.89 / 1.00 at NCC 0.80 / 0.85
but only 16 / 11 of ≈ 60 socket-glyph GT points; switch_single never above 0.17 P at any threshold; luminaire_ceiling
≤ 0.06. Diagnostic at the GT points (`diag.py`, c054fd3a): true sockets reach NCC 0.79–0.91, power sockets 0.92–0.95,
switches 0.68–0.80 — and dimension text, door swings, frame corners, letters reach the same values. Stripping walls
before the NCC (v3) lifts precision but cuts socket TP 50 → 11 (the socket's flat side *is* the wall line).

### Why No-go
* Gate: precision ≥ 0.9 on socket_single, socket_double, switch_single, luminaire_ceiling. Best observed: 0.43 / 1.00
  (3 TP) / 0.00 / – . Two of the four main classes are at zero recall, and on the lighting sheets nothing useful fires.
* The simple glyphs (switch = 2.4 mm circle + tick, ceiling point = circle + cross) are not separable from text and
  drawing clutter by correlation alone at any threshold; sockets are separable only at ≈ 25 % recall.
* socket_single vs socket_double depends on reading "2X" beside the symbol (plan text is rotated and touches leaders);
  per-socket Tesseract finds it rarely (3/16).
* An empty yellow BOQ is safer than a BOQ with 40–60 % wrong items that all look plausible.

### What production quality would take (estimate)
1. **A learned detector** (small one-stage detector or a patch classifier over candidate windows) trained on renders of
   our own vector sheets: every vector sheet with confirmed detections is a free labelled raster (render at 150–300
   dpi, random blur / noise / skew / JPEG to mimic scans). Needs a few hundred sheets across ≥ 5 offices for the legend
   variety; Noah alone (4 legend sheets, ≈ 200 symbols) is far too small. Legend exemplars then condition it
   (few-shot / siamese matching on the crop) rather than act as raw templates. 4–6 weeks incl. a labelled raster DEV set.
2. **Full-page OCR first** (Hebrew + digits/Latin, rotated text) and mask text before symbol search; also gives the
   2X/3X/TV/TEL qualifiers and H= annotations the vector path relies on. Tesseract on these SHX-like fonts is weak
   (several labels per legend misread even on clean crops): a better OCR engine or the VLM gateway (LLM opt-in) for labels.
3. Vectorisation as the alternative path (Stage 10 tried centre-line tracing): only worth it with thick-wall removal
   and the text mask above, so the existing vector legend/chamfer machinery can run; still 20 s+ per A3.
4. Real scanned / photographed sheets in the test set (ours are clean renders; real uploads are worse).
Until then: keep raster sheets at "0 detections + reason", and offer manual counting / "upload the PDF" in the UI.

### Tests / commands
`tests/test_raster_symbols.py` (7): flag default off + method parsing, sandbox env allow-list (flags, no secrets),
rotate_mask, NMS runner-up, structure stripping keeps a 3 mm ring, synthetic legend sheet at 200 dpi (legend classes,
≥ 5 placed symbols found, all `source: raster`, never green, `גיליון רסטר`) for `blobs` and `template` (`template`
skipped without OpenCV: the scipy fallback takes ≈ 75 s). Gates: ruff, ruff format, mypy (`uv run --with mypy==2.4.0
mypy src`), bandit `-ll` clean.
```
cd workers/drawing
.venv/bin/python /home/claude/kamutan-data/raster-spike/scripts/render_set.py
.venv/bin/python /home/claude/kamutan-data/raster-spike/scripts/bench.py 200      # then 300
python3 /home/claude/kamutan-data/raster-spike/scripts/table.py
KAMUTAN_RASTER_SYMBOLS=1 uv run python scripts/ingest_local.py …                 # pipeline path (PNG input)
```

### Gaps / notes for others
* `pipeline/understand.py` and `sandbox/runner.py` got additive edits (flag check, env allow-list) — owners please keep
  them when merging.
* OpenCV is optional and absent from `uv.lock` / the image; if the flag is ever enabled in production, add
  `opencv-python-headless` (≈ 40 MB) as an extra (DevOps image budget) — the scipy fallback is correct but slower.
* Pipeline path checked on one sheet (`scripts/pipeline_one.py`, `cli.ingest_file` through the sandbox, flag on):
  c054fd3a 200 dpi → electrical, 19 detections, all yellow with `גיליון רסטר`, 86 s. Not run on all 15 PNGs (time box);
  the bench harness calls the same functions without title-block / region exclusion (the pipeline passes both).
* Full suite: 678 passed, 3 skipped, 1 failed — `test_rooms_v4::test_sample_mep_basement_split_with_reference`, the
  known stale-shared-artifacts failure (Stage 10 notes; not touched here, CI skips it).

## Owner decision 05.11 — 7.06 partitions (length × full storey height × both faces)

Convention, as configuration (not a constant): `GeometryItemMatch.faces` (1|2) and `heightMode` ('storey'|'drawn')
on a `keys` rule over the partition measures (`gypsum_partition_area`, `gypsum_double_partition_area`). Default rule
`r_geo_gypsum_partition` (7.06): `faces: 2, heightMode: 'storey'` (contracts rules **v8**, `sides: 1` dropped — it was
ignored with `keys`). Both absent = the measure as produced (one face, drawn / assumed height): every other rule and
7.07 are unchanged.

* **Lining vs partition** (`geometry/analyze._linings`, after the section heights; new wall-run fields `lining`
  (bool | null) and `wallContactM`): for every gypsum run / low wall the long faces (edges ≥ 1.5 t, ends trimmed by the
  probe) are probed 6 cm outwards against the wall mass = the wall network (`extract_walls`) + the cavities of outlined
  walls (holes < 0.4 m wide: an existing wall drawn as two lines) + new block / concrete runs − new gypsum runs − walls
  drawn as demolished (the master plan draws the new first-floor partition beside the yellow wall it replaces). A wall
  behind ≥ 60 % of one face (covered ≥ 0.6 × probed / 2) → `lining: true` (one gypsum face). No wall network → null
  (counted with the rule's faces).
* **Convention** (`analyze.convention_items`, `measures(doc, faces=, height_mode=)`, `project.geometry_units(...,
  faces=, height_mode=)`, pure): faces = 1 for a lining, else the rule's; `storey` = the storey's floor-to-ceiling
  height (the room's ceiling when the item took it, else the floor's ceiling from the level marks; default 2.60 said
  so) for storey-high partitions — a low wall, or a drawn height (label / section / mark / other sheet) more than 5 cm
  below the storey, keeps its drawn height; the "הונח … לבדיקה" reason is replaced by "גובה המחיצה = גובה הקומה
  מהרצפה עד התקרה (h)". Only computable re-measured (key, floor) measures replace the stored ones (a stored
  non-computable measure keeps its reason / estimate). Convention measures carry `items` (per element: sheetId, id,
  lengthM, heightM, heightSource ("storey" when the storey height was used), faces, lining, areaM2, reason).
* **BOQ** (`boq/geometry.key_units`): each evidence item gets its element's `quantity` (m², instead of an even share)
  and `reason` — "מחיצה דו-צדדית בגובה קומה" / "חיפוי חד-צדדי" / "מחיצה דו-צדדית בגובה המסומן בשרטוט" (low wall);
  the line's reasons carry them too. Contracts (additive): `BoqEvidenceItem.reason` (≤ 200), `WallRun.lining` /
  `wallContactM`, `GeometryItemMatch.faces` / `heightMode`, `GEOMETRY_HEIGHT_MODES`, `DEFAULT_BOQ_RULES_VERSION` 8.
* **7.07 kept as is** (no faces / heightMode): "מחיצת גבס דו כרומי" already prices both skins per m² of partition, and
  its height follows the stair soffit (not storey-high): BOQ 7.5 vs 7.11 one face; two faces would give 14.2.

### Noah (`run_s6_eval.sh s7_706`, clean CLI ingest, `KAMUTAN_AV_SCAN=off`; before = `s7acc_final`)
| element (authority sheet) | length m | height m | faces | m² |
| --- | --- | --- | --- | --- |
| basement partition bedroom / living + bath return (ad257a1c wr_2) | 4.44 | 2.20 storey (H=220) | 2 | 19.55 |
| basement kitchen low wall "קיר נמוך H=140" (ad257a1c wr_4) | 1.00 | 1.40 drawn | 2 | 2.80 |
| ground AC lining "סגירת גבס למיזוג אוויר בקיר" (1470f005 wr_2) | 4.40 | 2.65 storey (= section) | 1 lining | 11.66 |
| first bath / bedroom partition (8099ab2c wr_3) | 1.90 | 2.65 storey | 2 | 10.07 |
| first parents' bath niche pieces (8099ab2c wr_1, wr_2) | 2 × 0.25 | 2.65 storey | 1 lining | 2 × 0.67 |
| **7.06** | | | | **29.19 → 45.40** (BOQ 35.2: −17 % → +29 %) |
Only 7.06 changed (all 77 lines compared, with and without room settings); exact 59 / within 61 (nors 57 / 58) as
before; gated ΣAE 36.46 → 40.65 (7.06 AE 6.0 → 10.2). Not tuned. Why 45.4 ≠ 35.2: the convention doubles the three
free-standing pieces (basement 4.44 m, first 1.90 m, low wall); with the AC lining at one face the honest total is
45.4. The GT's own note says it is open whether the AC lining belongs in 7.06 — without it the same convention gives
33.8 (two faces) ≈ 35.2, which suggests the client's quantity leaves the lining out (or prices it elsewhere); a
question for the owner, not a code change.

### Tests / commands
`tests/test_partition_convention.py` (9): lining vs free-standing vs low wall on a synthetic plan, a partition beside
a demolished wall is not a lining, measures without / with the convention (storey, drawn, faces 1, room ceiling,
default ceiling, no height), `geometry_units` breakdown, default 7.06 rule → per-evidence m² + reason and 7.07
unchanged, a rule without the convention unchanged. `test_geometry.py::test_noah_7_06_owner_convention` (Noah
classification + 45.4). Contracts: `sprint6.test.ts` "Owner decision 05.11"; `corrections.test.ts` version 8.
Checks (05.11): ruff / ruff format clean (src + tests), mypy 2.4.0 the CI way no issues, bandit 1.9.4 `-ll` clean;
full suite (`--ignore=tests/fuzz`) 687 passed, 4 skipped, 1 failed = `test_rooms_v4::…basement_split_with_reference`
(the known stale-shared-artifacts failure); `pnpm turbo run lint typecheck test --filter=@kamutan/contracts
--filter=@kamutan/api` green (contracts 148 + 3 new, API 399).
