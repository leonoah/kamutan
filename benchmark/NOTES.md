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
uv run pytest -q                                   # 45 tests
uv run kbench validate $KAMUTAN_DATA_DIR/gt/noah   # schema + gt-lint
uv run kbench eval --truth T --pred P --out results/m.json --report results/m.md \
    [--iou 0.5 --center-tol-mm 3 --small-symbol-mm 8 --match-mode auto|iou|center] \
    [--include-draft] [--keep-disputed] [--gt-version ..] [--model-version ..] [--code-sha ..]
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
