#!/usr/bin/env bash
# Sprint-10 Data/QA: fresh full CLI ingest of one project + BOQ build + kbench eval-boq, parametrised by project.
#   bash benchmark/tools/projects/run_eval.sh <project> <label> [--skip-ingest]
#     project = rubel | achituv | yahav (staged with stage_project.sh) | noah (sample-noah, boq_sample.xls)
#   -> $KAMUTAN_DATA_DIR/s10qa/<project>/<label>/{artifacts,artifacts_orig,ingest.log,boq*.log,boq-lines*.json}
#   -> $KAMUTAN_DATA_DIR/gt/<project>/eval/<label>{,_orig}.json + .md (kbench; report.py renames .md → .kbench.md)
# Two builds per project, both --no-corrections:
#   rubel / achituv / yahav (both with an EMPTY room-settings file, i.e. "without touch"):
#     <label>      library imported from gt/<p>/eval/xls_patched/boq.xlsx (header cell ' ' → 'סעיף', patch_xls.py);
#     <label>_orig library imported from the ORIGINAL xls as shipped.
#   noah (replaces gt/noah/tools/run_s6_eval.sh; Noah library = boq_sample.xls):
#     <label>      boq_local.py's built-in demo room settings (what E2E-01 / the Sprint-6..9 headline used);
#     <label>_nors empty room settings (no user input at all).
# ingest_local.py / boq_local.py hard-code org-demo / p-noah, so every project's artifacts live under …/p-noah/.
# KAMUTAN_AV_SCAN=off is set here (no ClamAV on the dev box). One project at a time: the box is shared (2 vCPU).
set -uo pipefail
PROJ=${1:?project}; TAG=${2:?label}; SKIP=${3:-}
DATA=${KAMUTAN_DATA_DIR:-/home/claude/kamutan-data}
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
B=$DATA/s10qa/$PROJ/$TAG; R=$B/artifacts; G=$DATA/gt/$PROJ
W=$REPO/workers/drawing; K=$REPO/benchmark
P=orgs/org-demo/projects/p-noah/boq/boq-lines.json
export KAMUTAN_AV_SCAN=off
if [ "$PROJ" = noah ]; then XLS_ORIG=$DATA/sample-noah/boq_sample.xls; else XLS_ORIG=$(ls "$DATA/projects/$PROJ/"*.xls | head -1); fi
XLS_PATCHED=$G/eval/xls_patched/boq.xlsx
mkdir -p "$B" "$G/eval"
if [ "$SKIP" != "--skip-ingest" ]; then
  rm -rf "$R"; mkdir -p "$R"; date -Iseconds > "$B/t_start"
  start=$(date +%s)
  ( cd "$W" && KAMUTAN_DATA_DIR=$DATA/sample-$PROJ KAMUTAN_DEV_ARTIFACTS="$R" timeout 5400 .venv/bin/python scripts/ingest_local.py --force ) > "$B/ingest.log" 2>&1
  echo "ingest exit=$? wall=$(( $(date +%s) - start ))s" | tee -a "$B/ingest.log"
fi
[ -f "$B/t_start" ] || date -Iseconds > "$B/t_start"
echo '{}' > "$B/empty_room_settings.json"
if [ "$PROJ" != noah ] && [ ! -f "$XLS_PATCHED" ]; then
  ( cd "$K" && uv run python -I "$HERE/patch_xls.py" "$XLS_ORIG" "$XLS_PATCHED" 2>&1 | grep -v UV_NATIVE )
fi
# the suffixed build runs first, on a copy of the pristine ingest root, so no library / room settings leak between builds
if [ "$PROJ" = noah ]; then VARIANTS="nors rs"; else VARIANTS="orig patched"; fi
for variant in $VARIANTS; do
  rs=(--room-settings "$B/empty_room_settings.json")
  case $variant in
    patched) xls=$XLS_PATCHED; suf="" ;;
    orig)    xls=$XLS_ORIG; suf="_orig" ;;
    rs)      xls=$XLS_ORIG; suf=""; rs=() ;;          # built-in demo room settings
    nors)    xls=$XLS_ORIG; suf="_nors" ;;
  esac
  RV=$B/artifacts$suf
  if [ -n "$suf" ]; then rm -rf "$RV"; cp -r "$R" "$RV"; fi   # separate doc store per build (atomic writes, ~40 MB)
  ( cd "$W" && .venv/bin/python scripts/boq_local.py --root "$RV" --xls "$xls" --truth "$G/boq_truth.json" --no-corrections \
      "${rs[@]}" --build-id "s10-$PROJ-$TAG$suf" --json "$B/boq$suf.json" \
      --chapters 1. 2. 3. 4. 5. 7. 8. 9. ) > "$B/boq$suf.log" 2>&1
  echo "build$suf rc=$?"; cp "$RV/$P" "$B/boq-lines$suf.json"
  ( cd "$K" && uv run kbench eval-boq --truth "$G" --pred-lines "$B/boq-lines$suf.json" --scope all \
      --model-version "$(git -C "$REPO" rev-parse --short HEAD)@$(cat "$B/t_start")$suf" \
      --out "$G/eval/$TAG$suf.json" --report "$G/eval/$TAG$suf.md" 2>&1 | grep -v UV_NATIVE )
done
echo "done: $G/eval/$TAG.json ($VARIANTS)"
