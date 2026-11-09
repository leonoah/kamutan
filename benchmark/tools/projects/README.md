# Sprint-10 project GT + baseline tools (Data/QA)

Code only — customer files and GT stay outside git under `$KAMUTAN_DATA_DIR` (default `/home/claude/kamutan-data`):
`projects/<p>/*.pdf + *.xls` (as received), `sample-<p>/sheet_<sha8>.pdf` (symlinks, see `stage_project.sh`),
`gt/<p>/` (boq_truth.json, lines.md, disputes.json, designer_counts.json, expected_counts.json, eval/), `s10qa/<p>/<label>/`.

| file | does |
| --- | --- |
| `stage_project.sh <p>` | `sample-<p>/sheet_<sha8>.pdf` symlinks + `files.tsv` + `sheet_meta.json` (discipline/floors from the file names) + `manifests/<p>.json` |
| `build_boq_truth.py <p> <xls>` | designer xls (sheet כמויות) → `gt/<p>/boq_truth.json` + `lines.md` (float codes, duplicates, בוטל, לא לסיכום, חדר/סט) |
| `patch_xls.py <in.xls> <out.xlsx>` | one-sheet copy with the header cell ' ' → 'סעיף' (the shipped files lack it) |
| `catalogue.py` | kind / group / Kamutan-support per designer line type (regex table) |
| `build_aux.py` | `gt/<p>/designer_counts.json` (aux sheets = Noah copies → not_available), `disputes.json` seeds GT-D-1xx, `gt/splits.json` if missing |
| `noah_disputes_recover.py` | re-adds GT-D-005..009 + the Sprint-2..8 hypotheses to `gt/noah/disputes.json` (after `scripts/build_noah_draft_gt.py`); all `lines: []` |
| `build_expected_counts.py` | countable BOQ lines → `gt/<p>/expected_counts.json` (totals + detection classes; cross-check GT) |
| `run_eval.sh <p> <label>` | fresh `ingest_local.py --force` + 2 × `boq_local.py --no-corrections` + `kbench eval-boq --scope all`. New projects: own library, empty room settings (`<label>` header-repaired xlsx, `<label>_orig` shipped xls). **noah** (replaces the lost `gt/noah/tools/run_s6_eval.sh`): `<label>` demo room settings, `<label>_nors` none |
| `report.py` | `gt/<p>/eval/baseline.md` per project (noah included) + `gt/eval_sprint10_<label>.md` side by side, gated/disputed table, catalogue diff of the new projects (replaces `report_s6.py` at BOQ level) |

Run the Python tools with the benchmark venv (`uv run python -I tools/projects/x.py …`); `run_eval.sh` needs
`workers/drawing/.venv` and sets `KAMUTAN_AV_SCAN=off`. One project at a time on the shared box.

Full rebuild after a data loss (needs `projects/<p>/` and `sample-noah/` back):

```bash
cd benchmark
KAMUTAN_DATA_DIR=/home/claude/kamutan-data uv run python scripts/build_noah_draft_gt.py
uv run python -I tools/projects/noah_disputes_recover.py
for p in rubel achituv yahav; do bash tools/projects/stage_project.sh $p
  uv run python -I tools/projects/build_boq_truth.py $p "$KAMUTAN_DATA_DIR/projects/$p/"*.xls; done
uv run python -I tools/projects/build_aux.py && uv run python tools/projects/build_expected_counts.py
for p in noah rubel achituv yahav; do bash tools/projects/run_eval.sh $p baseline; done   # one at a time
uv run python tools/projects/report.py
```
