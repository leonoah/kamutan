# Sprint 9 — Synthetic drawings benchmark, legend vocabulary, input-quality gate

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (own dirs, `flock` for installs, NO git commits, NOTES.md, tests
green, mypy the CI way), SPRINT6–8 briefs (interfaces still valid), docs/sprints/sprint-8-report.md. **Git: ONE branch,
`main`.** Never run state-changing git commands. Noah evals need `KAMUTAN_AV_SCAN=off`.

**Owner request (07.11):** the owner collected 17 sample drawings from the web
(`/home/claude/kamutan-data/web-samples/`, README.txt lists sources) and asked to learn from them and improve detection.
They are low-res raster screenshots (≈30 dpi for a full sheet, some mirrored / dark CAD-viewer screenshots / crops) with
no BOQ — not trainable. Agreed plan: (1) a **synthetic drawing generator** with exact ground truth by construction, used
as a regression / weakness-finding benchmark (NOT for green calibration — greens stay calibrated on real projects only);
(2) a **legend vocabulary** harvested from the readable legends of the web samples (and Noah), so legends of other
designers map to the right classes; (3) an **input-quality gate** so bad rasters are flagged clearly instead of
producing wrong counts. Web samples and generated datasets live OUTSIDE git (`/home/claude/kamutan-data/`); generator
code, style catalog (our own redrawn symbols — never copied images) and small fixtures go in git.

## 1. Synthetic generator (`synth/`, new top-level uv package `kamutan-synth`)
- Apartment / house floor plans: rooms (with Hebrew names), walls (block / gypsum / concrete, thickness), doors, windows,
  stairs, furniture outlines, dimensions, grid, title block + revisions table, sheet frame, notes with leaders, clouds.
- Disciplines: electrical (sockets: regular / dedicated / waterproof / 3-phase / AC, switches 1-2-3 gang / two-way /
  shutter, data / phone / TV / intercom, panel, junction, speaker, cobra), lighting (ceiling / wall / recessed / strip /
  pendant / fan, type tags), plumbing & water (WC, basin, shower, bath, kitchen sink, floor drain, water points HW/CW,
  pipes with diameters). Mounting heights `H=…`, quantities `2X`, qualifiers קיים / חדש / להחליף.
- **Styles:** several symbol styles per class (inspired by the vocabulary in the web samples + Noah, redrawn by us),
  colours / lineweights / layers, fonts incl. SHX-like stroke fonts and Hebrew TTF, rotations, mirrored blocks,
  exploded vs block symbols, symbols touching walls / hatches / leaders, crowded labels.
- Outputs per sheet: vector PDF (the main target), DXF (ezdxf; DWG stays deferred), and raster renders (dpi 72–300, JPEG
  noise, skew, mirrored, dark background) for the quality gate / raster work.
- **Ground truth by construction:** `gt.json` per sheet (every symbol: class, bbox mm, rotation, style id, floor, room,
  heights, qty multiplier; walls with lengths / kinds; rooms with polygons / areas; legend rows) + `boq_truth.json`
  in the BOQ format kbench already reads. Deterministic from a seed; difficulty knobs (`easy|medium|hard`).
- CLI: `kamutan-synth generate --n 300 --seed … --out /home/claude/kamutan-data/synth/v1`. Fast (target ≤ 2 s/sheet).

## 2. Benchmark (`benchmark/`)
- `kbench eval-synth <dataset>`: runs the drawing worker locally on each sheet (same path as Noah evals), scores symbol
  detection (per class, per style, per difficulty / perturbation: P/R/F1 with IoU/centre matching), legend reading
  (rows → class), heights, walls / areas, and the BOQ vs `boq_truth.json`. Writes a report (md + json) with the worst
  styles / perturbations and example crops. Baseline run on a 300-sheet set + a small fixed CI subset (≤ 20 sheets,
  generated in CI from a seed, ≤ 3 min) that becomes a regression gate (thresholds = baseline − margin).

## 3. Legend vocabulary + input-quality gate (workers/drawing: `legend/`, `classify/`, `ingest/`, `raster_symbols/`)
- Read every legible legend in the web samples (render / zoom and read them yourself) and Noah; build a curated
  vocabulary: label variants (Hebrew spellings, abbreviations, English) → canonical class, symbol-shape notes. Wire it
  into legend-row → class mapping; unit tests per variant. No regression on Noah (cold + warm).
- Hand GT for the readable web samples (counts per class from their own legend, where legible) in
  `/home/claude/kamutan-data/gt/web/` — for future raster / Claude-vision measurement.
- **Quality gate** on raster input (PNG/JPG and image-only PDF pages): estimate effective dpi (from sheet size / text
  height), mirrored text, inverted / dark background, screenshot UI chrome, partial crop (no frame / title block),
  blur. Result `quality {ok|warn|reject, issues:[{kind, detail}]}` on the version; `reject` → no symbol counts, clear
  Hebrew message; `warn` → items capped red/yellow with the reason. Tune on the web samples + synthetic rasters.

## 4. Fix round (after the baseline)
The orchestrator assigns the top weaknesses from the synthetic baseline to Worker-Accuracy; fixes must not regress Noah.

## Shared interfaces (additive; API owns contracts)
- Sheet version `quality?: {status:'ok'|'warn'|'reject', effectiveDpi?, issues:[{kind:'low_resolution'|'mirrored'|
  'dark_background'|'screenshot'|'partial_crop'|'blurred', detail?}]}`; job / version error `input_quality_rejected`.

## Ownership
| agent | owns | delivers |
| --- | --- | --- |
| Synth | new `synth/` package (+ root workspace wiring, CI job hook proposal in NOTES) | item 1 |
| Bench | `benchmark/` | item 2 (start with a harness against a small sample from Synth, coordinate in NOTES) |
| Worker-Legend | workers/drawing `legend/`, `classify/`, `ingest/`, `raster_symbols/` | item 3 |
| Product (API + Web) | packages/contracts, apps/api, apps/web | `quality` contract + API surfacing + UI (hub / processing panel / sheet view: Hebrew messages per issue, what to do: "העלה PDF מקורי"), Playwright both modes |

Final report per agent: what was built, tests, numbers, open issues.
