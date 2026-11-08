# kamutan-synth — NOTES (Sprint 9, Synth agent)

## Synth sample ready (for the Bench agent)
- **`/home/claude/kamutan-data/synth/sample10/`**: 10 sheets, seed 9001, `kamutan-synth check` reports 0 problems.
  - GT and BOQ truth validate against `benchmark/schema/sheet_annotations.schema.json` and `boq_truth.schema.json`.
- Layout and formats are described under "Dataset format" below (manifest + one directory per sheet).
- To regenerate the sample:

  ```bash
  cd synth
  uv run kamutan-synth generate --n 10 --seed 9001 --out /home/claude/kamutan-data/synth/sample10 --name synth-sample10
  ```

- **08.11:** sample10 regenerated (same seed, same ids). Stroke text is now one PDF path per stroke, like AutoCAD SHX
  exports, which the worker's glyph reader relies on. Before this fix the worker read none of the stroke text.
- **v1 is ready:** `/home/claude/kamutan-data/synth/v1/` (300 sheets, seed 1, 0 problems; see "Datasets").

## Requests from Bench (07.11)
- `kbench eval-synth` reads this format as is (GeoJSON `gt.json` + `synth` block + `renders.json` with `mm_to_px`);
  the adapter is `benchmark/src/kbench/synth.py:from_geojson`. Context fixtures (`kind=context` with `bbox_mm`) are
  "ignore" regions: a detection of that class there is neither TP nor FP.
- **Please write `<dataset>/library.xlsx`** (the synthetic price list of `catalog.py`: code TEXT, description, unit, in
  the client BOQ layout the worker's `library.import` reads, like `boq_sample.xls`). Without it the worker's
  `boq.build` cannot map classes to your codes; Bench then scores only "BOQ implied by detections" (count lines whose
  evidence is one class). Once the file exists, `eval-synth` runs `boq.build` per sheet automatically.

### Synth reply (07.11)
- **Done:** every dataset now has `<dataset>/library.xlsx`, and `sample10` was regenerated (same seed) with it.
  - The workbook is the synthetic price list from `catalog.py`, in the client BOQ layout: title rows, a header row
    `סעיף | תאור העבודה | יחידה | כמות סה"כ | מחיר יח' | סה"כ ₪`, chapter rows `פרק 03` / `פרק 04`, and 47 items.
  - Codes are TEXT cells; `4.10` and `3.10` keep their trailing zero.
  - Checked with the worker's own `library_import.parse.parse_workbook`: 47/47 items, no flags.
  - The manifest names the file under `"library"`.
- The sample10 content changed slightly because of a placement fix (strip lights were longer than their wall).
  Ids follow the same scheme.

## What this is
`kamutan-synth` is a new uv package (Python ≥ 3.12, standalone like `benchmark/`). It writes synthetic Israeli
floor plans for the electrical, lighting, combined electrical+lighting and plumbing disciplines, each with exact
ground truth.

Outputs for every sheet:
- a vector PDF (reportlab), the main target;
- a DXF (ezdxf, R2018): blocks and INSERTs, real TEXT, layers;
- perturbed raster renders (pypdfium2 + Pillow), each with its own mm→px map;
- `gt.json` and `boq_truth.json`.

The output is deterministic from `(seed, index)`. It does not depend on `PYTHONHASHSEED`, the number of workers or
the run, and there is a test for this. The datasets live outside git under `/home/claude/kamutan-data/synth/`.

## How to run
```bash
cd synth
flock /tmp/kamutan-uv.lock uv sync --all-groups
uv run kamutan-synth generate --n 300 --seed 1 --out /home/claude/kamutan-data/synth/v1 --jobs 2 --name synth-v1
uv run kamutan-synth check /home/claude/kamutan-data/synth/v1      # GT<->BOQ, GT<->PDF ink, GT<->DXF INSERTs
# options: --rasters N (0 = none) --no-dxf --no-preview --difficulty easy,hard --discipline plumbing,lighting
# gates (CI style):
uvx ruff@0.17.0 check . && uvx ruff@0.17.0 format --check . && uv run --with mypy==2.4.0 mypy src
uvx bandit@1.9.4 -q -r src -ll && uv run pytest -q
```

## Dataset format
- **Root files.**
  - `manifest.json`: same top-level keys as `benchmark/manifests/noah.json` (`project_id`, `files[]` with
    `file_id/file_name/kind/bytes/sha256/discipline/floors/orientation`). It adds `disciplines`, `paper`, `scale`,
    `difficulty`, `text_mode`, `symbols`, `dxf`, `gt`, `boq_truth`, `renders`, `library` and `new_taxonomy_classes`.
  - `timings.json`: not deterministic, so it is excluded from the byte checks.
  - `library.xlsx`.
- **Per sheet**, in `sheets/<id>/`: `<id>.pdf`, `<id>.dxf`, `gt.json`, `boq_truth.json`, `renders.json`, `renders/*`
  and `preview.png` (60 dpi).
- **`gt.json`** is a GeoJSON FeatureCollection that validates against `benchmark/schema/sheet_annotations.schema.json`.
  Coordinates are paper mm with y down. The `kamutan` block has `discipline` + `disciplines`, `floors`, `scale` and
  `input_type`.
  - **Symbols** (`kind: symbol`):
    - geometry is the Polygon of the exact symbol bbox;
    - `class` is the taxonomy class; `synth_class` is the fine class (e.g. `socket_waterproof` → `socket_single`,
      `switch_2gang` → `switch_single`, `luminaire_recessed` → `luminaire_ceiling`, `socket_ac` → `socket_power`);
    - `symbol_class` is the class of the drawn glyph: a single-socket glyph with a "2X" text is class
      `socket_double`, symbol_class `socket_single`;
    - `style_id`, `rotation`, `mirrored`, `exploded`, `insert_mm`, `bbox_mm`, `center_mm`;
    - `room_id`, `floor`, `lifecycle` (`existing` = קיים; להחליף is `new` with that `qualifier`);
    - `heights_cm` (only when an `H=` label was actually drawn), `qty` (2X next to a data / TV point = 2),
      `annotations` (every label string drawn for it), `type_tag`;
    - `controls` (switch → luminaire ids), `legend_entry` (null when the class is missing from the legend on purpose),
      `boq_code`, `dxf_block` (null = exploded), `label_boxes_mm`, `difficulty`, `synth_tags`.
  - **Context** (`kind: context`): sanitary fixtures drawn grey on non-plumbing sheets (same classes, not counted),
    doors, windows, furniture, stairs, legend rows (`legend_entry` with `legend_class`, `label`, `symbol_bbox_mm`,
    `label_bbox_mm`, `used`) and `legend_box`.
  - **Walls** (`kind: linear`, class `wall`): centre line, `wall_kind` (exterior / block / gypsum / concrete),
    `thickness_cm`, `length_m`, `rooms`.
  - **Rooms** (`kind: area`, class `room`): the exact net polygon after walls, `name`, `room_kind`, `area_m2`.
  - **Pipes** (`kind: linear`, class `pipe`): `system` (cold / hot / sewer), `diameter_mm`, `length_m`.
  - **`synth` block:** `knobs` (the full spec), `regions` (viewport bbox and floor per plan), `legend_bbox_mm`,
    `title_block_bbox_mm`, `title_fields`, `types_table`, `texts` (room names and areas with their boxes),
    `dxf_transform` (model X = x_mm·scale, Y = −y_mm·scale, mm units), and `renders`.
  - **`renders`** (also in `renders.json`): `mm_to_px` is a 2×3 affine. `expected_quality` is
    `{status, effectiveDpi, issues[kind]}` with the contract's issue kinds. The status is only my suggestion; the
    thresholds belong to Worker-Legend.
- **`boq_truth.json`** validates against `boq_truth.schema.json`. Each line has a TEXT `code`, `quantity`, `evidence`
  (feature ids), `breakdown` per floor and `derivation`.
  - Count lines = Σ `qty` of the `new` symbols of a fine class (existing items are excluded).
  - `4.90` = the number of להחליף / להחלפה items.
  - Pipe lines are in מ"א per (system, diameter).
  - The price list is in `catalog.py`; chapter 03 is plumbing, chapter 04 is electrical + lighting.
- **Taxonomy classes not yet in `benchmark/schema/classes.json`** (Bench may add them):
  - symbol classes: `junction_box`, `floor_drain`, `water_point_hot`, `water_point_cold`;
  - other GT classes: `pipe`, `wall`, `door`, `window`, `furniture`, `stairs`.

## Coverage
- **Building:**
  - the programme is a treemap of rooms with Hebrew names and variants: סלון, מטבח, חדרי שינה, ממ"ד (concrete
    walls), bathrooms, שירותי אורחים, laundry, corridor or entry, storage, stairs;
  - there are apartments (one floor: קרקע / א' / ב' / ג') and two-floor houses (stacked plans; 56 of the 300 sheets
    draw both floors);
  - walls are drawn filled, outlined or hatched, by kind, with real thickness;
  - doors have leaf + swing, kitchen/living openings have none, windows are glazing lines;
  - also drawn: furniture (beds, sofa, dining set, counter with hob, fridge, wardrobes, desks), dimension chains in
    cm, a grid with bubbles, the plan title with scale, a north arrow, revision clouds with a △ tag, notes, a title
    block (bottom strip or right column, with the worker's labels) and a revisions table.
- **Symbols:** 36 fine classes and 94 styles, 2–3 per class, all redrawn by us:
  - **sockets:** single / double / triple / power / waterproof / 3-phase / AC;
  - **low voltage:** data / phone / TV / intercom / speaker;
  - **other electrical:** panel, junction box, cobra;
  - **switches:** 1 / 2 / 3 gang, two-way, shutter;
  - **lighting:** ceiling, wall, recessed, strip, pendant, fan;
  - **plumbing:** WC concealed / monoblock, basin, shower, bath, kitchen sink, floor drain, hot / cold points,
    washing machine;
  - **pipes:** cold, hot and sewer, each with a Ø label.
- **Labels:** `H=…`, 2X / 3X (either the "2X" text convention or dedicated glyphs, chosen per sheet), purpose text
  (למזגן, למדיח, …), the qualifiers קיים / (קיים) / ק. / חדש / להחליף / להחלפה, and type tags with a lighting types
  table. Labels have leaders in hard sheets.
- **Text:** three modes, all with legal fonts.
  - `ttf`: a real PDF text layer in visual order. pdfium reads Hebrew back in logical order, but LTR runs inside
    Hebrew come back reversed ("110=H"), just as in real TTF PDFs.
  - `outline`: one filled path per glyph, no text layer.
  - `stroke`: our own single-stroke font (`strokefont.py`, drawn for this project), one path per stroke, SHX-like.
  - Font licences:
    - DejaVu Sans: Bitstream Vera / DejaVu licence;
    - Liberation Sans: SIL OFL 1.1;
    - FreeSans: GPLv3 with the font exception, which allows embedding;
    - the stroke font is ours.
  - No font file is vendored; the TTFs are picked from what is installed, and a box without any TTF falls back to
    stroke.
- **Difficulty knobs** (`spec.py`):

  | knob | easy | medium | hard |
  | --- | --- | --- | --- |
  | text | TTF only | TTF, outline or stroke | mostly stroke or outline |
  | colour scheme | mono | mono, noah or colour | noah, colour or red-walls |
  | symbol size | 4.2–5 mm | 3.4–4.6 mm | 2.8–3.8 mm |
  | `H=` label probability | 0 | 0.35 | 0.6 |
  | mirrored blocks | 0 | 0.15 | 0.4 |
  | exploded blocks (DXF) | 0 | 0.3 | 0.6 |
  | rotation of centre symbols | none | none | ±30° |
  | leaders | 0 | 0.1 | 0.35 |
  | renovation qualifiers | no | 25 % of sheets | 50 % of sheets |
  | clouds | none | 0–1 | 0–2 |
  | legend | complete | up to 2 unused rows | 0–2 drawn classes missing, unused rows |
  | two floors on one sheet | no | sometimes | often |
  | symbols touching walls | sometimes | sometimes | always |

  Rasters by difficulty:
  - easy: clean PNG at 200–300 dpi;
  - medium: JPEG at 100–200 dpi, with some skew and noise;
  - hard: 30–150 dpi, plus skew, mirroring, dark background, blur, screenshot chrome, partial crop and JPEG noise.

## Datasets
- **v1** (`/home/claude/kamutan-data/synth/v1`, seed 1, 300 sheets, 350 MB):
  - difficulty: easy 90 / medium 120 / hard 90;
  - discipline: electrical 90 / lighting 75 / electrical+lighting 45 / plumbing 90;
  - paper: A3 117 / A2 145 / A1 38;
  - text: ttf 154 / stroke 95 / outline 51;
  - 10 702 symbols in all 36 classes;
  - `check`: 0 problems.
- **Timings** (2 vCPU):
  - uncontended: 0.5–0.7 s per sheet including the PDF, DXF, one raster and the preview;
  - compose + PDF alone: about 0.1–0.2 s;
  - the raster is the most expensive part: an A2 page at 300 dpi takes about 1 s; renders are capped at 20 MP.
  - The v1 run used 152 s of user CPU for 300 sheets (0.51 s per sheet). Its wall time was 570 s because the box
    had a load of about 10 from the other agents.
- **Review images** (100 dpi): `/home/claude/kamutan-data/synth/review/`.

## Proposed CI job (DevOps owns `.github/`)
```yaml
  synth:
    name: Python (synth) + synthetic subset
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    defaults: { run: { working-directory: synth } }
    env: { UV_LOCKED: "1" }
    steps:
      - uses: actions/checkout@<sha> # v7.0.1
        with: { persist-credentials: false }
      - uses: astral-sh/setup-uv@<sha> # v10.3.3
        with: { enable-cache: true, cache-dependency-glob: synth/uv.lock }
      - run: sudo apt-get install -y --no-install-recommends fonts-dejavu-core fonts-liberation fonts-freefont-ttf
      - run: uv sync --locked --all-groups
      - run: uvx ruff@0.17.0 check . && uvx ruff@0.17.0 format --check .
      - run: uv run --with "mypy==2.4.0" mypy src
      - run: uvx bandit@1.9.4 -q -r src -ll
      - run: uv run pytest -q
      - name: Fixed CI subset (20 sheets, seed 20261107) for kbench eval-synth
        run: |
          uv run kamutan-synth generate --n 20 --seed 20261107 --out "$RUNNER_TEMP/synth-ci" --jobs 2 --name synth-ci
          uv run kamutan-synth check "$RUNNER_TEMP/synth-ci"
      - uses: actions/upload-artifact@<sha>
        with: { name: synth-ci, path: "${{ runner.temp }}/synth-ci", retention-days: 7 }
```
- The subset takes about 15–30 s on a 2-core runner. Bench's `eval-synth` job can download the artifact or
  regenerate it from the same seed, since the output is byte-identical.
- Also add `synth` to:
  - the `python` matrix in `ci.yml`;
  - the `osv-scanner` lockfile list (`synth/uv.lock`);
  - `.github/dependabot.yml` (uv, `/synth`).
- `.pre-commit-config.yaml` (ruff) and the `.semgrep.yml` subprocess rule now include `synth/`. These are the only
  root files I edited.

## Findings for other agents
- **Worker, outlined TTF text** (`text_mode=outline`, 51 sheets in v1): the worker reads nothing, so
  classification is red with no discipline, floor or scale. Its OCR assumes SHX strokes or a text layer; filled
  glyph outlines go through the stroke grouping and come out as single garbage characters.
- **Worker, stroke text:** with one path per stroke the worker classifies it (syn9001-0007: electrical, floor ג',
  1:50, yellow 0.81).
- **Worker, TTF text:** easy TTF sheets classify green (syn9001-0003: electrical 1:50, conf 0.975).
- **Text-layer `H=` marks:** they come back from pdfium as `110=H` (visual-order LTR runs), the same as in real TTF
  PDFs. Any `H=` parser on the text layer should accept both orders.

## Known gaps / open issues
- DWG is not produced (deferred, per the brief). DXF uses model space only, with no paper-space layout or viewport.
  Text is always real TEXT; there are no SHX styles or ATTRIBs.
- All walls are orthogonal (no 45° bays like Noah), and rooms are rectangles from a treemap. Plans are plausible
  but simpler than real ones; there are no balconies, no shafts and no sloped or curved walls.
- Many sheets come out as A2 / A1 with a lot of empty paper, because a legend panel plus a 1:50 plan seldom fits A3.
- Plumbing:
  - supply pipes run along the walls of each wet room from a corner manifold, but there is no riser, meter or
    trunk between rooms;
  - sewer pipes end at an implied stack that is not drawn;
  - a water point is dropped (and is then absent from the GT) when no free spot is left next to its fixture.
- Labels may sit outside the building or cross another room (leaders in hard sheets). They never overlap walls,
  symbols or each other.
- Symbols never overlap each other. Clouds, pipes, hatches, furniture and dimension or grid lines may cross symbols
  on purpose.
- `expected_quality` in the renders is a suggestion. The `effectiveDpi` estimate of a cropped or screenshot raster
  is the nominal render dpi.
- The raster `mm_to_px` maps are exact up to PIL's ±1 px rounding of the rotated canvas, checked by a test.
- Within one sheet the styles are consistent: one style per class, as a designer would draw it. Style variety comes
  across sheets.
