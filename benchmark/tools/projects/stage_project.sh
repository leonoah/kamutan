#!/usr/bin/env bash
# Sprint-10 Data/QA: stage one project for ingest_local.py + kbench manifest.
#   bash benchmark/tools/projects/stage_project.sh <project>
# Reads  $KAMUTAN_DATA_DIR/projects/<project>/*.pdf  (customer files, outside git)
# Writes $KAMUTAN_DATA_DIR/sample-<project>/sheet_<sha8>.pdf (symlinks), files.tsv (id → file name),
#        sheet_meta.json (discipline / floors from the Hebrew file names), and benchmark/manifests/<project>.json
#        (ids, sizes, sha256, meta — no customer content; the xls is not listed because its name carries the client name).
set -euo pipefail
P=${1:?project}
DATA=${KAMUTAN_DATA_DIR:-/home/claude/kamutan-data}
HERE=$(cd "$(dirname "$0")" && pwd); BENCH=$(cd "$HERE/../.." && pwd)
S=$DATA/sample-$P
mkdir -p "$S"; rm -f "$S"/sheet_*.pdf; : > "$S/files.tsv"
for f in "$DATA/projects/$P/"*.pdf; do
  id=$(sha256sum "$f" | cut -c1-8)
  ln -s "$f" "$S/sheet_$id.pdf"
  printf "sheet_%s\t%s\n" "$id" "$(basename "$f")" >> "$S/files.tsv"
done
python3 - "$S" <<'PY'
import json, sys
from pathlib import Path
s = Path(sys.argv[1])
disc = {"חשמל": "electrical", "תאורה": "lighting", "אינסטלציה": "plumbing", "בניה": "construction", "הריסה": "demolition",
        "תקרה": "ceiling", "העמדה": "furniture", "גיליון בריכה": "pool", "בריכה": "pool", "אחרי טופס 4": "post_permit"}
floors = {"קומת קרקע": ["ground"], "קומה א": ["first"], "קומת מרתף": ["basement"], "כל הקומות": ["basement", "ground", "first"]}
meta = {}
for ln in (s / "files.tsv").read_text(encoding="utf-8").splitlines():
    sid, name = ln.split("\t")
    base = name.removesuffix(".pdf")
    d = next((v for k, v in disc.items() if base.startswith(k)), None)
    f = next((v for k, v in floors.items() if k in base), [])
    meta[sid.removeprefix("sheet_")] = {"discipline": d, "floors": f, "orientation": "landscape"}
(s / "sheet_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"{len(meta)} sheets staged in {s}")
PY
cd "$BENCH" && uv run kbench manifest "$S" --project "$P" --out "manifests/$P.json" --sheet-meta "$S/sheet_meta.json" 2>&1 | grep -v UV_NATIVE || true
