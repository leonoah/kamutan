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
**Approved line whose qty changed**: status kept, chip `הכמות השתנתה מאז האישור`, level red; baseline
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
