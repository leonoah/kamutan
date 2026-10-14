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
