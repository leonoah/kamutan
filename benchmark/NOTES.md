# kbench: benchmark and ground truth (Sprint 0)

This package measures accuracy against the ground truth, following `docs/spec/07_test_plan.md`
("מאגר האמת", "מדדי דיוק", "Benchmark ו-CI") and the decisions in `08_workplan_v2.md` §2:
- coordinates are paper millimetres with the y axis pointing down;
- item codes are TEXT;
- annotations are stored as GeoJSON outside git.

## What is here (repo, no customer content)

| path | content |
| --- | --- |
| `schema/sheet_annotations.schema.json` | One GeoJSON FeatureCollection per sheet, for both truth and predictions. Top-level `kamutan` metadata: sheet_id, units=mm, y_axis=down, scale, input_type, scale_conflict. Feature properties: id, class, kind, legend_entry, room_id, floor, lifecycle (existing/new/demolish), supply (contractor/client/existing), link_group, boq_code (TEXT), annotator, status (draft/verified/adjudicated). Predictions also carry confidence and level. |
| `schema/boq_truth.schema.json` | One BOQ per project. Lines: code (TEXT, numbers rejected), description, unit, quantity, evidence ids, derivation, breakdown, gt_status, dispute_id (optional), category, tolerance_pe, flags. Also `change_orders` and `auxiliary`. |
| `schema/disputes.schema.json` | Dispute register; `status` is `"open — awaiting owner"`, `resolved` or `withdrawn`. |
| `schema/classes.json` | Taxonomy subset with domain and `core` flag (core classes get the per-class F1 gate). |
| `src/kbench/` | Library and CLI (modules listed below). |
| `scripts/build_noah_draft_gt.py` | Rebuilds the draft Noah `boq_truth.json` + `disputes.json` into `$KAMUTAN_DATA_DIR/gt/noah`. |
| `manifests/noah.json` | File ids, sizes, sha256, discipline/floors/rotation per sheet. No content. |
| `tests/` | pytest + hypothesis, on synthetic fixtures only (`tests/fixtures/make_fixtures.py`). |

Modules in `src/kbench/`:
- `matching.py`: Hungarian matching.
- `metrics.py`: all metrics.
- `stats.py`: Wilson bound, ECE, AUC.
- `regression.py`: regression gate.
- `boq_xls.py`: legacy xls parser.
- `validate.py`: schema checks + gt-lint.
- `report.py`: Markdown report.
- `cli.py`: command line.
- `worker.py`: Sprint-2 adapter for the worker's own artifacts (`kamutan.detections/1`, `kamutan.rooms/1`, `kamutan.legend/1`) and the evaluation built on it (see below).

**Ground truth outside git: `/home/claude/kamutan-data/gt/noah/`**

| file | content |
| --- | --- |
| `boq_truth.json` | All 77 lines from `boq_sample.xls`, all **draft**. The 11 lines of GT-D-001..004 are `disputed`. 19 lines are flagged. |
| `disputes.json` | GT-D-001..004, all `open — awaiting owner`. |
| `sheets/eb8be8a3.geojson` | One fully annotated example region: ground-floor kitchen, 11 socket items + 1 context region, status=draft. |
| `draft_counts.md` | Draft per-floor counts of sockets, luminaires, switches and plumbing vs the BOQ, with confidence. |

## How to run

```bash
cd benchmark
flock /tmp/kamutan-uv.lock uv sync
uv run pytest -q                                   # 95 tests (15 golden tests skip without worker output)
uv run kbench validate $KAMUTAN_DATA_DIR/gt/noah   # schema + gt-lint
uv run kbench eval --truth T --pred P --out results/m.json --report results/m.md \
    [--iou 0.5 --center-tol-mm 3 --small-symbol-mm 8 --match-mode auto|iou|center] \
    [--include-draft] [--keep-disputed] [--gt-version ..] [--model-version ..] [--code-sha ..]
uv run kbench eval --truth $KAMUTAN_DATA_DIR/gt/noah --pred-detections $KAMUTAN_DATA_DIR/artifacts \
    --out results/w.json --report results/w.md [--center-tol-mm 3 --room-iou 0.5 --legend-tol-mm 4] \
    [--pred-rooms DIR] [--truth-legends DIR] [--sheet-map map.json] [--include-missing-sheets]
uv run kbench compare --current results/m.json --baseline baseline.json [--thresholds t.json] \
    --out gate.json --report gate.md               # exit 0 pass / 1 regression / 2 not comparable
uv run kbench parse-boq-xls boq.xls --project noah --out boq_truth.json
uv run kbench manifest $KAMUTAN_DATA_DIR/sample-noah --project noah --out manifests/noah.json --sheet-meta meta.json
KAMUTAN_DATA_DIR=/home/claude/kamutan-data uv run python scripts/build_noah_draft_gt.py
```

Directory layout for `--truth` and `--pred`: `sheets/<sheet_id>.geojson`, plus `boq_truth.json` (or
`boq.json`), plus an optional `disputes.json`. To aggregate several projects, repeat the `--truth`/`--pred`
pair.

## Metric definitions, as implemented

### Matching
- Hungarian assignment, run per sheet and per class. It maximises the number of matches first, then quality.
- For GT items 8 mm or larger, a pair is valid when IoU ≥ 0.5.
- For GT items smaller than 8 mm, or Point geometries, a pair is valid when the centre distance is ≤ 3 mm.
- All three thresholds can be changed from the CLI.
- A wrong-class detection counts as FP in the predicted class and FN in the true class, and is recorded in the confusion matrix. Unmatched items appear there as `<missed>` and `<background>`.

### Detection
- P, R and F1 per class, with F1 = 2TP / (2TP + FP + FN).
- Micro scores are reported over all classes and per domain.
- Macro F1 averages only classes with at least 20 GT items.

### BOQ count error
- Applies to unit "יחידה": AE = |Q̂ − Q| and PE = AE / max(Q, 1).
- Reported as ΣAE per chapter, median and P90 of PE, and the number of lines with AE > 0.
- A missing predicted line counts as Q̂ = 0.

### Area and length error
- PE = AE / A.
- Tolerances: flooring 2%, cladding 3%, length 2%, other area 2%. A line can override this with `tolerance_pe` or `category`.
- Room polygon IoU is reported using shapely.

### Line exact-match
- Computed over confirmed (and user_input) lines only. `--include-draft` adds draft lines, for smoke runs only.
- Lump-sum lines are correct when proposed with the GT quantity.
- A line that was not proposed is wrong.
- Extra lines are reported separately.
- Codes are compared as text, so a prediction "4.1" does **not** satisfy truth "4.10".

### Items correct before review
- Class-agnostic matching first. A predicted item is correct only if all of these match: class, boq_code, lifecycle, floor, and (for area/linear items) PE within tolerance.
- Rate = correct / (#predicted + #FN), reported with the Wilson LB95.
- Room correctness is measured but not gated.

### Calibration
- Reliability uses 10 equal-mass bins. ECE, MCE and Brier are reported, overall, per level and per domain.
- P_green is reported with the two-sided Wilson LB95, z = 1.96.
- Minimum-sample rule: `pass` requires LB ≥ 0.98 **and** n ≥ the smallest n that could reach 0.98 with zero errors (189, derived, not hard-coded).
- Per-domain check: domains with at least 200 greens need LB ≥ 0.96.
- Conservative-calibration eligibility: green is allowed only for classes with at least 200 items and precision 1.0. Any violating classes are listed.
- Ceiling rules are a hard failure and make `eval` exit 1:
  - any green item on a raster sheet;
  - any non-red area or linear item on a scale-conflict sheet.

### Review burden
- Burden = (yellow + red) / all items.
- Also reported: yield of review, and the AUC of risk = 1 − confidence for detecting wrong items.

### Disputes
- Lines referenced by an open dispute (or marked `gt_status=disputed`) are excluded from every gating metric.
- So are their evidence items, plus any predictions matched to those items or assigned to those lines.
- `--keep-disputed` turns the exclusion off, for diagnostics.

### Regression gate
- Blocking thresholds, from the test-plan table:
  - micro-F1 drops by more than 0.5 pt;
  - F1 of a core class drops by more than 1.5 pt (a class that vanishes counts as 0);
  - ItemsCorrect drops by more than 0.5 pt;
  - P_green drops at all to below 0.98, or drops by more than 0.5 pt;
  - ECE rises by more than 0.01;
  - any confirmed smoke line that was correct becomes wrong;
  - burden rises by more than 3 pt (only a warning if P_green rose at the same time);
  - P95 sheet time rises by more than 20%;
  - any run failure;
  - any ceiling violation.
- A different `gt_version` means the runs are not comparable: exit 2.

## Worker artifacts (Sprint 2): `kbench eval --pred-detections`

- **Input.** `DIR/<sheet>/detections.json.gz` or the worker storage layout
  `DIR/**/sheets/<sheetId>/versions/<v>/detections.json.gz` (newest file wins). `rooms.json.gz` and `legend.json.gz`
  are read from the same folder (or `--pred-rooms`). Worker ids like `noah-eb8be8a3-p0` map to the truth id that
  they contain (`--sheet-map` overrides).
- **Mapping.** Each detection becomes a Point at `centerMm` (bbox centre if missing): `class`, `score` → confidence,
  `level`, `floor`, `lifecycle`, `roomId`, `annotations`. Each room becomes a Polygon (`polygonMm`) with `name`,
  `areaM2`, `floor`, `level`.
- **Symbols.** Centre-distance matching, default **3 mm paper** (`--center-tol-mm`), per class. Reported twice:
  - *semantic*: truth `class` (e.g. `socket_3phase`);
  - *glyph level*: truth `symbol_class`, the legend row the drawn glyph belongs to. Predicted classes are mapped to
    glyphs where the truth uses exactly one glyph for that class. Text-only truth items (no glyph) are excluded.
  Also reported: count error per sheet, floor and class; green-bucket precision with the Wilson LB95, under two
  definitions (detection-correct = matched with the right class; items-correct = test-plan item definition);
  precision per level; review burden; items-correct.
- **Rooms.** Hungarian matching on polygon IoU (≥ `--room-iou`, default 0.5). Reported: IoU, area PE against the truth
  `area_m2` (1:50), name accuracy (predicted name in the truth `names` list, normalised), unmatched rooms.
  Matched predicted room ids are rewritten to truth ids, so each detection's `roomId` is scored ("room accuracy").
- **Legend.** Truth rows come from `legends/legend_<sheet>.geojson` (`class=legend_entry`, symbol box geometry,
  `legend_class`, `label`). Rows are matched by symbol-box centre distance (default 4 mm). Reported: row recall, entry
  precision, class accuracy, exact label rate, mean character error rate.
- Sheets with truth but no predictions are listed and excluded unless `--include-missing-sheets`.

### Sprint-2 ground truth (outside git, `gt/noah`, `gt-v0.2-draft`, frozen in `GT_FREEZE.json`)

- `sheets/{eb8be8a3,c054fd3a,b2046277,1bbe4113}.geojson`: a Point per symbol instance, status `draft-verified`
  (two independent visual passes, reconciled in `reconcile_log.md`, every point rendered back onto the sheet).
  Properties include `symbol_class`, `floor`, `room_id`, `lifecycle`, `annotations` (2X/3X/H=), and `fixture_type` for
  luminaires. Cobra conduits are LineStrings (`kind=linear`). The room polygons on these sheets are translated from the
  architecture sheets.
- `sheets/{08222cb2,6fa88f92}.geojson`: room polygons with names, `area_m2` and `perimeter_m` at 1:50, and
  `uncertainty_mm`.
- `legends/legend_<sheet>.geojson`: 20 legend rows per sheet.
- `tools/build_sheet_gt.py` rebuilds all of it from the annotation tables.

Schema and taxonomy changes:
- `status` gains `draft-verified`.
- New optional `symbol_class`.
- New classes: `note_point`, `bezek_point`, `waterproof_marker`, `switch_cross`, `switch_shutter`, `conduit_cobra`,
  `water_heater_feed`, `legend_entry`, `legend_box`, `unknown`. These are the legend rows of the Noah electrical and
  lighting sheets that had no class.

## Sprint 3: link groups, BOQ lines, Excel fidelity

New modules: `links.py` (link-group truth + worker adapter + metrics + implied composite counts), `boq_lines.py`
(worker `boq-lines.json` vs `boq_truth.json`), `excel_check.py` (xlsx export vs the sample `.xls` layout).
New schema: `schema/links.schema.json` (`kamutan.links-truth/1`); `disputes.schema.json` gains optional `link_groups`
and allows `lines: []` (a dispute that only concerns link groups or a rule question excludes no BOQ line).

```bash
uv run kbench eval-links --truth $GT --pred-links $KAMUTAN_DATA_DIR/artifacts --out l.json --report l.md
uv run kbench eval-boq --truth $GT --pred-lines $KAMUTAN_DATA_DIR/artifacts/boq-lines.json --out b.json --report b.md
uv run kbench links-implied --truth $GT [--skip-existing-points|--skip-existing-switches|--alt]
uv run kbench excel-check --sample boq_sample.xls --export export.xlsx [--lines boq-lines.json] --report x.md
```

### Link-group truth (`gt/<p>/links/<sheet>.json`)
- One group = the switches that control the same set of light points (a connected component of the dashed-arc
  graph). Ids are the point-GT feature ids. Every switch is in exactly one group; every luminaire in one group or in
  `unlinked_luminaires` (existing points without an arc). `kbench validate` lints this.
- `kind`: single | two_way | shared | sensor | add_to_existing. Cross-sheet copies carry `cross_sheet_duplicate_of`.
  Ambiguous groups carry `dispute_id` (+ `alt_readings`) and are excluded from gating.

### Link metrics (`eval-links`)
- Predicted detections (the `detections.json.gz` next to `links.json.gz`) are mapped to truth ids by Hungarian
  centre-distance matching (3 mm) per family (switches; luminaires + fans), class-agnostic inside the family.
- group exact match (recall over truth groups, precision over predicted groups): same switch set AND same luminaire set;
- switch -> point assignment accuracy (per truth switch); luminaire -> switch accuracy;
- composite-kind accuracy (truth group vs the predicted group with the largest id overlap) + kind confusion;
- green-group precision (exact-match rate of green groups; LK-06 "never a wrong green").

### BOQ-line metrics (`eval-boq`)
- Scope: chapter 4 + `9.01` (configurable `--scope`). Per line AE, PE = AE / max(Q, 1), exact; Q̂ = sum of `qty` over
  predicted lines with the same TEXT code (`qtyOverride` ignored: "before review"); not proposed = 0.
- Gated = in-scope lines not disputed; disputed lines are reported, never gated. Extra codes reported separately.
- Per floor where the truth has a `breakdown` (Noah chapter 4 has none, so this is empty on Noah).
- Green-line precision: green lines on gated or extra codes, correct = exact on a gated truth line.

### Implied composite counts (`links-implied`)
Default rules: single -> 4.09, two_way -> 4.10, shared 2/3 points -> 4.11/4.16, add_to_existing -> 4.12 (2-way) /
4.14 (fan switch), sensor -> 4.15, a fan switch anywhere -> one 4.14; cross-sheet duplicates skipped; 9.01 = all
luminaire positions (linked + unlinked) − ceiling fans − cross-sheet duplicates.

### Excel fidelity (`excel-check`)
Checklist X01–X18 (see the module docstring): sheet name, RTL, title rows, header order (extra columns only at the
edges), chapter headers + notes, codes as TEXT with trailing zeros, natural order, units, empty prices, line/chapter/grand
total formulas, ₪ format, extra sheets, formula-injection text, and optionally quantities vs `boq-lines.json`.

### Sprint-3 ground truth: `gt-v0.3-draft` (frozen in `GT_FREEZE.json`, before reading any worker link/BOQ output)
- `links/{b2046277,1bbe4113}.json`: 31 groups (13 + 18), 9 unlinked existing points; two passes (visual + vector
  dash chaining), reconciled in `reconcile_log.md#sprint-3`; `tools/build_links_gt.py` rebuilds them.
- Disputes GT-D-005 (master fan-switch arc ends at the type-23 spot; link group excluded) and GT-D-006 (4.09 implied
  17 vs BOQ 16; informational, no line excluded); GT-D-002 hypothesis updated (9.01 = 49 − 5 fans − 1 duplicate).
- Caveat: `scripts/build_noah_draft_gt.py` regenerates `disputes.json` from Sprint-0 data and would drop the Sprint-2/3
  hypotheses and GT-D-005/006; do not re-run it against the frozen GT.

## Sprint 4: plumbing fixtures, tiling rooms, chapters 03 + 05

New modules: `plumbing.py` (fixture subset, implied chapter-03 counts), `tiling.py` (room type / wet / openings /
perimeter / corners metrics vs the wet-room truth, expected tiling quantities under explicit rules). `boq_lines.py`
gains tolerance-aware scoring for area/length lines (`within_tol`: cladding 3%, flooring 2%, length 2%; count and
lump-sum lines stay exact) and an optional `--expected` reference column. `worker.rooms_to_features` passes the
Sprint-4 room fields through (`type`, `wet`, `openings`, `externalCorners`, `walls`).

```bash
uv run kbench plumbing-implied --truth $GT [--report r.md]                      # chapter 03 implied by the fixture GT
uv run kbench eval-fixtures --truth $GT --pred-detections $ART --out f.json --report f.md [--center-tol-mm 3]
uv run kbench eval-tiling-rooms --truth $GT --pred-rooms $ART --out t.json --report t.md
uv run kbench tiling-expected --truth $GT [--height 2.6] [--clad-niches] [--courtyard none|landing|whole]
uv run kbench eval-boq --truth $GT --pred-lines boq-lines.json --scope 3. --scope 5. \
    --expected $GT/tiling/expected_tiling.json --out b.json --report b.md
```

Taxonomy (`schema/classes.json`): + `fixture_shower`, `fixture_bath`, `fixture_kitchen_sink`,
`fixture_washing_machine` (plumbing, core), `garden_tap` (plumbing; any cold-water point of the 3.06 kind: garden tap
or Tami-4), `ac_unit` (**domain `hvac`**: AC positions read from the electrical / plumbing sheets drive 3.01 drains but
are not sanitary fixtures; keeps the plumbing micro-F1 about fixtures). `sheet_annotations.schema.json` domain enum
gains `hvac`.

### Fixture metrics (`eval-fixtures`)
Truth and predictions restricted to the plumbing + hvac classes; the Sprint-2 worker evaluation is reused (centre
distance per class, default 3 mm; counts per sheet/floor/class; green precision; items-correct). Fixtures have no
legend glyph: glyph level = class. Fixtures are large (WC/bath 8-32 mm): also report `--center-tol-mm 8`.

### Implied plumbing (`plumbing-implied`)
Only `authoritative: true` points (plumbing sheets) count; master-sheet copies and the electrical AC sockets are for
detection metrics only. Rules: see the module docstring (3.01 ac_unit; 3.02 basin with `faucet_wall` within 5 mm or
`faucet: wall`; 3.03 other basins + kitchen sinks; 3.04/3.07 WC kinds; 3.05 WM; 3.06 garden_tap; 3.11/3.12/3.13
shower/bath routed by room name / floor). One-offs 3.08-3.10, 3.14-3.15 are not derivable.

### Tiling rooms (`eval-tiling-rooms`)
Truth rooms per architecture sheet = the wet rooms of `tiling/wet_rooms.json` (refined polygons) + every other frozen
room polygon (type from its names, `wet = false`). Hungarian IoU matching (>= 0.5). Type accuracy (open-plan rooms
accept any named space), wet P/R/F1 (truth wet = bathroom | wc; the courtyard is `courtyard`, not wet), and for matched
wet rooms: area PE, perimeter PE, external-corner AE, openings (Hungarian on centre distance <= 10 mm within kind;
width within 5 cm).

### Sprint-4 ground truth: `gt-v0.4-draft` (frozen before reading worker Sprint-4 output)
- `sheets/{8d51ed5a,24ab0ea0,2a308827}.geojson` (plumbing, authoritative): 30 points — 9 ac_unit (drain marks),
  5 basins, 2 kitchen sinks, 3 concealed WCs, 1 monoblock, 2 showers, 1 bath, 2 WMs, 3 wall faucets, 2 cold-water
  points (garden tap + Tami-4). Two passes (visual + vector), reconciled (`reconcile_log.md#sprint-4`).
- `sheets/{08222cb2,6fa88f92}.geojson` + 13 fixtures as drawn on the master sheets (`authoritative: false`).
- `sheets/{eb8be8a3,c054fd3a}.geojson` + 9 `ac_unit` at the AC sockets (`authoritative: false`).
- `tiling/wet_rooms.json`: guest WC, 3 bathrooms (incl. laundry niches as sub-polygons), English yard (landing sub-area);
  inner faces snapped to the vector wall outlines; openings, reflex corners, ceilings from level marks.
- `tiling/expected_tiling.json`: cladding/corner sweep over height x niche rule, floor candidates, recommended defaults.
- Disputes: GT-D-003/004 sprint-4 hypotheses (drawings = BOQ); GT-D-007 (5.02 courtyard), GT-D-008 (5.01/5.03
  height/niche/corner assumptions), both informational (`lines: []`).
- Builder: `tools/build_plumbing_tiling_gt.py` (run after `build_sheet_gt.py`).

## Known gaps

- **No `kbench run`.** The pipeline does not exist yet. `eval` scores prediction files written in the annotation schema, and the workers must emit that format.
- Not implemented yet:
  - the bootstrap significance test (1,000 resamples by project) — with one project, every threshold breach blocks;
  - `confusion.csv`;
  - `errors.jsonl` with crops;
  - the reliability PNG;
  - `bench_runs` storage.

  The metrics JSON contains per-item records (`items`, `fn_items`) that these can be built from.
- Polygon IoU is used for room items only. Symbol matching uses bbox IoU or centre distance.
- The Noah GT is **draft** and has no confirmed lines. Gating metrics on Noah therefore need `--include-draft` until a human verifies the lines and attaches evidence ids. Only the one example region has geometry.
- Lighting and electrical counts in `draft_counts.md` come from visual inspection by an agent. The switch counts are low confidence.
- `4.00` (xls 4.0) is an ambiguous code reconstruction and needs owner confirmation. So does the chapter-number vs code-major mismatch in chapters 06–08.
- Class names like `socket_box_6`, `socket_prep` and `heater_feed` were added to `classes.json` for Noah. They are provisional until the taxonomy owner signs off.
