# Sprint 2 — Understanding: brief for all agents

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (rules: own dirs only, `flock /tmp/kamutan-pnpm.lock pnpm …` /
`flock /tmp/kamutan-uv.lock uv …` for installs, NO git commits, NOTES.md, tests must pass), docs/agents/SPRINT1_BRIEF.md
(Sprint-1 interfaces still valid), docs/adr/0008-firebase-platform.md, docs/sprints/sprint-1-report.md,
workers/drawing/NOTES.md, docs/spec/04_architecture.md §"צנרת עיבוד השרטוטים", docs/spec/05_ux.md (legend confirmation,
review workspace, confidence language), docs/spec/07_test_plan.md (metrics), docs/spec/08_workplan_v2.md §2 decisions.
Branch: `sprint-2/understanding` (orchestrator commits).

**Sprint goal (demo):** "the legend is recognised and the symbols and rooms are marked on the drawing".
For every electrical / lighting / plumbing sheet: find the legend (מקרא), read each legend row (symbol + Hebrew label),
spot every instance of each legend symbol on the drawing, assign each instance to a room and floor, tell existing / new /
demolish, and show it all on the viewer with the 3-level confidence language. Unknown symbols are grouped and asked once.
Security gate (06_security, sprint 2): single LLM gateway with per-org kill switch, JSON-schema-validated output,
log scrubbing, title-block region never sent; per-org cache.

Sample data: /home/claude/kamutan-data/sample-noah/ (15 PDFs). Local artifacts: /home/claude/kamutan-data/artifacts/
(produced by `workers/drawing/scripts/ingest_local.py`). Ground truth (outside git): /home/claude/kamutan-data/gt/noah/.
Sheets with legends: electrical eb8be8a3 (ground), c054fd3a (basement+first); lighting b2046277 (ground, also a
lighting-fixture table types 1–29), 1bbe4113 (basement+first); plumbing 8d51ed5a / 24ab0ea0 / 2a308827.
Coordinates: paper mm, origin top-left, y down. Points are `{x,y}` objects (Firestore cannot store nested arrays).
Item codes are TEXT. Row confidence = lowest level of its items.

## Shared interfaces (exact; all agents follow them)

### New artifacts per version (Storage, next to tiles) — gzip JSON
`orgs/{o}/projects/{p}/sheets/{s}/versions/{v}/legend.json.gz`
```json
{ "schema": "kamutan.legend/1",
  "legends": [ { "id": "lg0", "bboxMm": {"x":0,"y":0,"w":0,"h":0}, "title": "מקרא", "confidence": 0.9 } ],
  "entries": [ { "id": "le_<sheetId>_<n>", "legendId": "lg0",
      "symbolBboxMm": {"x":0,"y":0,"w":0,"h":0}, "labelBboxMm": {"x":0,"y":0,"w":0,"h":0},
      "label": "שקע כפול", "labelConfidence": 0.93,
      "suggestedClass": "socket_double", "classConfidence": 0.8,
      "signature": "<stable hash of normalised symbol strokes>",
      "thumb": "legend/le_<sheetId>_<n>.webp" } ] }
```
`detections.json.gz`
```json
{ "schema": "kamutan.detections/1",
  "detections": [ { "id": "d_<n>", "class": "socket_double", "legendEntryId": "le_…|null",
      "centerMm": {"x":0,"y":0}, "bboxMm": {"x":0,"y":0,"w":0,"h":0}, "angleDeg": 0,
      "score": 0.0, "level": "green|yellow|red", "reasons": ["…Hebrew reason chip…"],
      "roomId": "r_<n>|null", "floor": "ground|basement|first|…|null",
      "lifecycle": "existing|new|demolish|unknown", "supply": "contractor|client|existing|null",
      "annotations": ["2X", "H=30"], "clusterId": "u_<n>|null" } ],
  "unknownClusters": [ { "id": "u_<n>", "signature": "…", "count": 7, "exemplarBboxMm": {…}, "thumb": "unknown/u_<n>.webp" } ] }
```
`rooms.json.gz`
```json
{ "schema": "kamutan.rooms/1",
  "rooms": [ { "id": "r_<n>", "name": "סלון", "nameConfidence": 0.9, "floor": "ground|null",
      "polygonMm": [{"x":0,"y":0}], "areaM2": 0.0, "perimeterM": 0.0,
      "confidence": 0.0, "level": "green|yellow|red", "reasons": [] } ] }
```
`legend/{entryId}.webp`, `unknown/{clusterId}.webp`: small crops (≤ 256 px) for the UI.
Areas/perimeters use the region's scale (m², m). Levels: green ≥ 0.85 with no warning reason, red < 0.5, else yellow;
every non-green carries ≥ 1 reason. Raster sheets are capped at yellow. Calibration comes in Sprint 5 — scores now are
heuristic, so be conservative.

### Version doc additions (Firestore)
- `progress.stage` gains `legend`, `detect`, `rooms` (order: ingest, render, ocr, classify, scale, legend, detect, rooms, done).
- `artifacts.legend`, `artifacts.detections`, `artifacts.rooms`: storage paths (relative to the version prefix is NOT
  allowed — full object paths like the other artifacts).
- `stats.detections = {total, green, yellow, red, unknown, byClass: {class: n}}`, `stats.rooms = n`, `stats.legendEntries = n`.

### Legend entries in Firestore (project level, so they are reused across sheets)
`orgs/{o}/projects/{p}/legendEntries/{entryId}`:
`{ sheetId, versionId, label, labelConfidence, suggestedClass, class (null until confirmed), itemCode (TEXT|null),
   signature, thumbPath, status: 'suggested'|'confirmed'|'ignored', confirmedBy?, confirmedAt?, updatedAt }`
Worker writes `suggested` entries (never overwrites a `confirmed`/`ignored` entry with the same signature — it links to it).
Clients write only via the API. Org-level memory of confirmed mappings: `orgs/{o}/symbolMappings/{signature}`
`{ class, itemCode|null, label, confirmedBy, confirmedAt, uses }` — written by the API on confirm; the worker reads it to
pre-fill `suggestedClass` with high confidence ("learn once, reuse").

### Class taxonomy
Use `benchmark/schema/classes.json` class ids. Unknown → `class: "unknown"` + `clusterId`.

### LLM gateway (Python, `workers/drawing/src/kamutan_drawing/llm_gateway/`)
`LlmGateway.call(org_id: str, purpose: Literal['legend_label','glyph_label','symbol_name'], images: list[bytes],
 prompt_vars: dict, schema: dict) -> GatewayResult` (`ok|disabled|budget_exceeded|refused|error`, `data`, `cached`,
`cost_usd`). Providers: `anthropic` (HTTP, key from env `KAMUTAN_LLM_API_KEY`, model from env), `disabled`, `fake`
(tests). Policy: org setting `llmEnabled` (default false), monthly budget, cache by sha256(model+purpose+images+vars)
per org (`orgs/{o}/llm-cache/…` in Storage), output must validate against `schema` (1 repair retry), the caller passes
a `region_kind` and the gateway REFUSES `title_block`; logs record purpose, org, sizes, cost, cache hit — never image
bytes or returned text. No API key exists in this environment: everything must work (lower confidence) with
`disabled`, and be tested with `fake`.

## Ownership
| agent | owns | delivers |
| --- | --- | --- |
| Worker-A (legend + symbols + integration) | workers/drawing: `legend/`, `symbols/`, `pipeline/` + `service/pipeline.py` integration, `scripts/ingest_local.py` | legend detection/parsing, legend-conditioned symbol spotting on vectors (+ raster fallback), annotations (2X/3X/H=), unknown clusters, writing artifacts + Firestore |
| Worker-B (rooms + lifecycle + LLM gateway) | workers/drawing: `rooms/`, `lifecycle/`, `llm_gateway/` (pure modules + tests; Worker-A calls them) | room segmentation + names + area, existing/new/demolish classifier, gateway |
| API | apps/api, packages/contracts, firebase/ (rules + tests) | contracts for the new shapes, overlay endpoint (signed URLs for legend/detections/rooms + thumbs), legend-entries list/patch (confirm/ignore/assign class+itemCode, writes symbolMappings + audit), rules |
| Web | apps/web, packages/viewer | legend confirmation screen, unknown-symbol resolution ("מה זה?" once per cluster), viewer overlay layers (detections by level with ●▲◆ shapes, rooms with name + area, lifecycle toggles), click → details popover; mock mode reads local artifacts |
| Data/QA | benchmark/, /home/claude/kamutan-data/gt/noah/ | independent point ground truth for the 4 electrical/lighting sheets + rooms on 3 architecture sheets; kbench adapter for `kamutan.detections/1` and `kamutan.rooms/1`; evaluation report |

Worker-B's module APIs (Worker-A calls exactly these):
- `rooms.segment(prims: VectorSheet, text: list[TextLine], region_polygons: list[Region], scale_denominator: int|None) -> list[Room]`
- `lifecycle.classify(prims: VectorSheet, bboxes_mm: list[BBox], legend_hints: dict) -> list[LifecycleResult(lifecycle, confidence, reasons)]`
- `llm_gateway.from_env(org_settings_reader) -> LlmGateway`
(Use the existing types in `ingest/pdf_vector.py`, `pipeline/artifacts.py`, `ocr/reader.py`; if a type is missing,
define it in `kamutan_drawing/types_sprint2.py` — Worker-B creates that file first thing, Worker-A imports it.)
