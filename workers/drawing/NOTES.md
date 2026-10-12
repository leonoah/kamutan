# workers/drawing — NOTES (Sprint 0, ingest & OCR agent)

Python 3.12+ package `kamutan_drawing` (uv). Runs as the Cloud Run worker (ADR 0008): Pub/Sub push →
`POST /pubsub/ingest` → `process_sheet_version(job, storage, store)`.

## What is here

| module | what |
| --- | --- |
| `ingest/pdf_vector.py` | pypdfium2 (not PyMuPDF — licence, decision #1). Every path object → segments (move/line/bezier, beziers kept as control points **and** flattened ×8), stroke/fill RGBA, draw mode, width (mm), dash array (mm), closed flag. Coordinates: **paper mm, origin top-left, y down**, crop box + `/Rotate` applied exactly as the renderer does (tested for 0/90/180/270). Columnar numpy output (`VectorSheet`) + `sheet_stats` + `save_npz`. Accepts a path or bytes. |
| `render/raster.py` | page render, mm-region crop render (pdfium crop, memory ∝ region), 256 px tiles + `manifest.json`. |
| `ocr/glyphs.py` | SHX text from strokes: candidate strokes → connected components per style (colour+width) → underline removal → lines (2-phase: letters, then small marks ׳ ״ : . = attached to exactly one line) → glyphs (stacked/near-touching components merged) → normalised stroke key (quantised 1/8 line height, relative to baseline) + 24×16 bitmap feature. Horizontal and ±90° text. |
| `ocr/dictionary.py` | glyph dictionary: cluster by exact key; label each cluster by **voting** Tesseract (`heb` and `eng`) char boxes over every occurrence (clean vector re-render of the line, 30 lines per Tesseract call, Hungarian box↔glyph matching); geometric vetoes (letter-height one-piece glyph ≠ punctuation, short glyph ≠ digit/Latin, descender decides ך/ד ן/ו ף/פ ץ/צ, one tick = ׳ two = ״); Latin context (`alt` label used next to confident Latin or before `=`); deterministic read with word gaps + minimal bidi; `text_spans`. |
| `ocr/tess.py`, `ocr/textutil.py` | Tesseract CLI wrapper (makebox), vector line rendering, bidi visual→logical, normalisation, Levenshtein/CER. |
| `titleblock/classify.py` | label-cell title block reader (fuzzy labels, cells from ruling lines) + discipline/floor/scale/date classification with confidence. |
| `scale/detect.py` | declared scale parse + independent estimate from dimension strings (number above a parallel line, cm) + other `1:N` found in text. |
| `service/` | `contracts.py` (pydantic mirror of `packages/contracts` `IngestSheetVersionJob` v2, incl. the storagePath-belongs-to-org check; a test diffs it against `json-schema/IngestSheetVersionJob.json`), `ports.py` (BlobStorage/StatusStore protocols + in-memory fakes), `gcp.py` (GCS/Firestore adapters, lazy imports, ADC only — **not exercised**, Google APIs are blocked here), `pipeline.py` (`process_sheet_version`), `app.py` (FastAPI: `POST /pubsub/ingest`, `GET /healthz`). |
| `spikes/` | `shx_spike.py` (extract / label / eval), `classify_sheets.py`, `ground_truth/` (hand transcription + generators), `SHX_SPIKE_REPORT.md`, `SHEET_CLASSIFICATION.md`, `results/*.json`. |

## How to run

```bash
cd workers/drawing
flock /tmp/kamutan-uv.lock uv sync                      # deps (+ dev: pytest, reportlab, ezdxf, httpx)
uv run pytest -q                                         # all tests; sample-data tests skip without KAMUTAN_DATA_DIR
KAMUTAN_DATA_DIR=/home/claude/kamutan-data uv run python spikes/shx_spike.py   # extract+label+eval (~6 min, 2 vCPU)
uv run python spikes/classify_sheets.py                  # -> spikes/SHEET_CLASSIFICATION.md
uv run uvicorn --factory kamutan_drawing.service.app:app_from_env --port 8080   # Cloud Run entry (needs ADC)
```
Spike intermediates (they contain drawing content) go to `$KAMUTAN_SPIKE_OUT` (default `/tmp/kamutan-spike`), never the repo.

## Service semantics
- Pub/Sub push envelope → base64 JSON job → pydantic validation. Malformed/invalid payloads, missing source,
  sha256 mismatch, unreadable PDF, unsupported kind → `200 {"status":"rejected"}` (acked, no infinite redelivery) and
  `jobs/{jobId}.status=failed` with `error.code`. Unexpected exceptions → `500` (Pub/Sub retries, then DLQ).
- Artifacts only under `orgs/{orgId}/projects/{projectId}/derived/{versionId}/`: `primitives.npz`, `ingest_stats.json`,
  `work_150.png`, `thumb.png`, `tiles/{c}_{r}.png` + `tiles/manifest.json`, `text_spans.json`, `glyph_dictionary.json`,
  `title_block.json`. The version doc gets `status`, `artifacts`, `stats` (classification without title-block PII).
- Push auth: rely on Cloud Run IAM (`--no-allow-unauthenticated`, push SA has `run.invoker`); app does not re-verify OIDC.

## DWG / DXF
- `ezdxf` installs fine (dev dep for now) and round-trips Hebrew `TEXT` + block `INSERT`s (`tests/test_dxf_note.py`) —
  in DXF the SHX problem disappears (real text) and blocks are free symbols.
- LibreDWG (`dwg2dxf`) is **not available** in this sandbox; DWG ingest is not implemented. Plan per decision #2:
  `dwg2dxf` as a separate sandboxed CLI in the worker image, then the ezdxf path. `fileKind=dwg|dxf|png` currently fail with
  `unsupported_kind`.

## Known gaps / TODO
- Glyph dictionary is built **per sheet set** in the spike and **per sheet** in `process_sheet_version` (no persistent
  org-level `glyph_dictionary` store yet; per-sheet voting has fewer votes → somewhat lower accuracy than the spike).
- Latin in tiny fonts (UP DOWN, E1405, W50), `Ø`, and a few symbol clusters are still misread — see the report;
  needs the one-time VLM labelling batch (designed, not implemented: no LLM access in Sprint 0).
- Text extraction is ~4–5 s/sheet (pure Python loops over pdfium segments + union-find); fine for A3, optimise for A0.
- A0 tiling should render by region (decision #12) — `render_region` exists, `pipeline` still renders whole page at 150 dpi.
- Ground truth for title blocks takes bounding boxes from detected spans (text is hand-read); see report caveats.
- `spikes/ground_truth/shx_gt.json` contains project text (incl. the project name) — keep the repo private.
