#!/usr/bin/env bash
# Kamutan restore drill (SEC-38; targets SEC-36: RPO 24 h, RTO 8 working hours). Runbook: docs/runbooks/restore-drill.md
#
# Restores the latest Firestore backup into an ISOLATED database, verifies it, exercises a Cloud Storage
# object-versioning restore on a canary object, spot-checks the off-project Storage mirror, and records timings.
# It never writes to the production database and never touches customer objects (the Storage canary lives
# under _drill/ in the main bucket and is removed at the end).
#
# Modes:
#   --mode export (default)  newest managed export in --backup-bucket (setup-backups.sh §3) -> new database
#                            "drill-<ts>" in --scratch-project (gcloud firestore import). Proves the off-project copy.
#   --mode backup            newest Firestore scheduled backup (setup-backups.sh §1) -> new database "drill-<ts>"
#                            in --project (gcloud firestore databases restore; same-project only by design).
#
# Usage:
#   infra/scripts/restore-drill.sh --project kamutan-fba67 --scratch-project kamutan-drill \
#       --backup-bucket kamutan-fba67-firestore-backup-eu [--storage-backup-bucket kamutan-fba67-storage-backup-eu]
#       [--mode export|backup] [--fresh-export] [--database '(default)'] [--location eur3]
#       [--storage-bucket kamutan-fba67.firebasestorage.app] [--groups orgs,members,...] [--out DIR]
#       [--keep] [--yes] [--dry-run]
#   --fresh-export  take a new export first (measures export time too; RPO is then ~0 by construction —
#                   the quarterly drill should restore the newest *scheduled* export instead).
#   --keep          do not delete the restored database at the end (default: delete, after confirmation).
#   --yes           no interactive confirmation for the cleanup.
#   --dry-run       print every command, run nothing, still writes the report skeleton (no credentials needed).
# Needs: gcloud (logged in as an owner, never a key file), jq, curl, sha256sum.
# Output: <out>/results.json and <out>/results.md (fill the "human" fields of the runbook table from them).

set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/lib/common.sh
. "$here/lib/common.sh"

PROJECT=kamutan-fba67
SCRATCH_PROJECT=""
DATABASE='(default)'
LOCATION=eur3
MODE="export"
BACKUP_BUCKET=""
STORAGE_BUCKET=""
STORAGE_BACKUP_BUCKET=""
FRESH_EXPORT=0
KEEP=0
ASSUME_YES=0
GROUPS_CSV="orgs,members,projects,sheetSets,sheets,versions,legendEntries,reviewItems,corrections,boqLines,boqBuilds,shareLinks,auditLog,jobs"
TS=$(date -u +%Y%m%d-%H%M%S)
OUT=""

usage() { sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=$2; shift 2 ;;
    --scratch-project) SCRATCH_PROJECT=$2; shift 2 ;;
    --database) DATABASE=$2; shift 2 ;;
    --location) LOCATION=$2; shift 2 ;;
    --mode) MODE=$2; shift 2 ;;
    --backup-bucket) BACKUP_BUCKET=$2; shift 2 ;;
    --storage-bucket) STORAGE_BUCKET=$2; shift 2 ;;
    --storage-backup-bucket) STORAGE_BACKUP_BUCKET=$2; shift 2 ;;
    --groups) GROUPS_CSV=$2; shift 2 ;;
    --fresh-export) FRESH_EXPORT=1; shift ;;
    --out) OUT=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
case "$MODE" in
  export)
    [ -n "$SCRATCH_PROJECT" ] || die "--scratch-project is required for --mode export"
    [ "$SCRATCH_PROJECT" != "$PROJECT" ] || die "--scratch-project must not be the production project"
    [ -n "$BACKUP_BUCKET" ] || die "--backup-bucket is required for --mode export"
    TARGET_PROJECT=$SCRATCH_PROJECT
    ;;
  backup) TARGET_PROJECT=$PROJECT ;;
  *) die "--mode must be export or backup" ;;
esac
STORAGE_BUCKET=${STORAGE_BUCKET:-$PROJECT.firebasestorage.app}
DRILL_DB="drill-$TS"
OUT=${OUT:-./restore-drill-$TS}
export DRY_RUN
require_tools gcloud jq curl sha256sum
mkdir -p "$OUT"
IFS=',' read -r -a GROUPS_ARR <<<"$GROUPS_CSV"

# ------------------------------------------------------------------ bookkeeping
declare -A T_START T_END
PHASES=()
CHECKS_JSON="[]"
phase_start() {
  PHASES+=("$1")
  T_START[$1]=$(now_epoch)
  log "== phase: $1"
}
phase_end() { T_END[$1]=$(now_epoch); }
check() { # check NAME ok|fail|skip DETAIL
  CHECKS_JSON=$(jq -c --arg n "$1" --arg s "$2" --arg d "$3" '. + [{name: $n, status: $s, detail: $d}]' <<<"$CHECKS_JSON")
  if [ "$2" = fail ]; then warn "CHECK FAILED: $1 — $3"; else log "check $1: $2 ${3:+($3)}"; fi
}

# Firestore count via REST runAggregationQuery (collection group, all descendants). Prints an integer.
# The access token is fetched inside the call and never printed.
fs_count() { # project database group [readTime]
  local project=$1 db=$2 group=$3 read_time=${4:-}
  local url="https://firestore.googleapis.com/v1/projects/$project/databases/$db/documents:runAggregationQuery"
  local body
  body=$(jq -cn --arg g "$group" --arg rt "$read_time" '{structuredAggregationQuery: {structuredQuery: {from: [{collectionId: $g, allDescendants: true}]}, aggregations: [{alias: "n", count: {}}]}} + (if $rt == "" then {} else {readTime: $rt} end)')
  # shellcheck disable=SC2016 # the token command is printed literally, never expanded
  printf '+ curl -sS -X POST %q -H "Authorization: Bearer $(gcloud auth print-access-token)" -d %q\n' "$url" "$body" >&2
  if [ "$DRY_RUN" = 1 ]; then
    echo 0
    return 0
  fi
  curl -sS --fail-with-body -X POST "$url" -H "Authorization: Bearer $(gcloud auth print-access-token)" \
    -H 'Content-Type: application/json' -d "$body" | jq -r '.[0].result.aggregateFields.n.integerValue // "0"'
}

DRILL_START=$(now_epoch)
PH_TIME=$(date -u -d "@$((DRILL_START - 3600))" +%Y-%m-%dT%H:%M:%S) # dry-run placeholder: a backup 1 h old
log "Kamutan restore drill $TS — mode=$MODE source=$PROJECT/$DATABASE target=$TARGET_PROJECT/$DRILL_DB dry_run=$DRY_RUN"

# ------------------------------------------------------------------ 0. preflight
phase_start preflight
run gcloud auth list --filter=status:ACTIVE --format='value(account)'
run gcloud firestore databases describe --database="$DATABASE" --project "$PROJECT" --format='value(name,locationId,pointInTimeRecoveryEnablement)'
capture VERSIONING True gcloud storage buckets describe "gs://$STORAGE_BUCKET" --format='value(versioning_enabled)'
if [ "$VERSIONING" = True ]; then
  check storage_versioning_enabled ok "gs://$STORAGE_BUCKET"
else
  check storage_versioning_enabled fail "versioning is off on gs://$STORAGE_BUCKET (run setup-backups.sh §4)"
fi
phase_end preflight

# ------------------------------------------------------------------ 1. locate the backup (RPO)
phase_start locate_backup
BACKUP_REF=""
BACKUP_TIME=""
if [ "$MODE" = export ]; then
  if [ "$FRESH_EXPORT" = 1 ]; then
    phase_start fresh_export
    capture EXPORT_JSON '{"metadata":{"outputUriPrefix":"gs://BUCKET/'"$PH_TIME"'_00000","startTime":"'"$PH_TIME"'Z"}}' \
      gcloud firestore export "gs://$BACKUP_BUCKET" --project "$PROJECT" --database="$DATABASE" --format=json
    BACKUP_REF=$(jq -r '.metadata.outputUriPrefix // .response.outputUriPrefix' <<<"$EXPORT_JSON")
    BACKUP_TIME=$(jq -r '.metadata.startTime // empty' <<<"$EXPORT_JSON")
    phase_end fresh_export
  else
    # Folders are named <ISO time>_<n>/ by Firestore when outputUriPrefix is the bucket root.
    capture LISTING "gs://$BACKUP_BUCKET/${PH_TIME}_00000/" gcloud storage ls "gs://$BACKUP_BUCKET/"
    BACKUP_REF=$(grep -E '/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+_[0-9]+/$' <<<"$LISTING" | sort | tail -n 1 | sed 's#/$##')
    [ -n "$BACKUP_REF" ] || die "no export folder found in gs://$BACKUP_BUCKET"
    BACKUP_TIME="$(basename "$BACKUP_REF" | sed -E 's/_[0-9]+$//')Z"
    BACKUP_TIME=${BACKUP_TIME/ZZ/Z}
  fi
else
  capture BACKUPS_JSON '[{"name":"projects/P/locations/eur3/backups/BACKUP","database":"projects/P/databases/(default)","snapshotTime":"'"$PH_TIME"'Z","state":"READY"}]' \
    gcloud firestore backups list --project "$PROJECT" --location="$LOCATION" --format=json
  sel=$(jq -c --arg db "$DATABASE" '[.[] | select(.state == "READY" and (.database | endswith("/databases/" + $db)))] | sort_by(.snapshotTime) | last // empty' <<<"$BACKUPS_JSON")
  [ -n "$sel" ] || die "no READY scheduled backup for database $DATABASE in $LOCATION"
  BACKUP_REF=$(jq -r .name <<<"$sel")
  BACKUP_TIME=$(jq -r .snapshotTime <<<"$sel")
fi
BACKUP_EPOCH=$(date -u -d "$BACKUP_TIME" +%s 2>/dev/null || echo "$DRILL_START")
RPO_S=$((DRILL_START - BACKUP_EPOCH))
log "backup: $BACKUP_REF (taken $BACKUP_TIME, age ${RPO_S}s)"
if [ "$RPO_S" -le 86400 ]; then
  check rpo_within_24h ok "backup age ${RPO_S}s"
else
  check rpo_within_24h fail "newest backup is ${RPO_S}s old (> 24 h)"
fi
phase_end locate_backup

# ------------------------------------------------------------------ 2. source counts (exact at backup time when possible)
phase_start source_counts
age_s=$(($(now_epoch) - BACKUP_EPOCH))
READ_TIME=""
COUNT_MODE=current
if [ "$age_s" -lt 3300 ]; then
  # Stale reads are allowed up to 1 h without PITR (whole minutes); round the backup time down to the minute.
  READ_TIME=$(date -u -d "@$((BACKUP_EPOCH / 60 * 60))" +%Y-%m-%dT%H:%M:%SZ)
  COUNT_MODE="at-backup-time"
fi
declare -A SRC_COUNT DST_COUNT
for g in "${GROUPS_ARR[@]}"; do SRC_COUNT[$g]=$(fs_count "$PROJECT" "$DATABASE" "$g" "$READ_TIME"); done
phase_end source_counts

# ------------------------------------------------------------------ 3. restore into an isolated database (RTO core)
phase_start restore
if [ "$MODE" = export ]; then
  capture SCRATCH_NUMBER 999999999999 gcloud projects describe "$SCRATCH_PROJECT" --format='value(projectNumber)'
  run gcloud services enable firestore.googleapis.com --project "$SCRATCH_PROJECT"
  run gcloud firestore databases create --database="$DRILL_DB" --location="$LOCATION" --type=firestore-native \
    --project "$SCRATCH_PROJECT"
  # The scratch project's Firestore service agent must read the export files.
  run gcloud storage buckets add-iam-policy-binding "gs://$BACKUP_BUCKET" \
    --member="serviceAccount:service-$SCRATCH_NUMBER@gcp-sa-firestore.iam.gserviceaccount.com" \
    --role=roles/storage.objectViewer
  run gcloud firestore import "$BACKUP_REF" --database="$DRILL_DB" --project "$SCRATCH_PROJECT"
else
  run gcloud firestore databases restore --source-backup="$BACKUP_REF" --destination-database="$DRILL_DB" \
    --project "$PROJECT"
  # Restore is a long-running operation on the new database: wait until no operation is pending.
  if [ "$DRY_RUN" != 1 ]; then
    for _ in $(seq 1 480); do
      pending=$(gcloud firestore operations list --database="$DRILL_DB" --project "$PROJECT" \
        --format='value(done)' 2>/dev/null | grep -civ true || true)
      [ "$pending" = 0 ] && break
      sleep 30
    done
  fi
fi
phase_end restore

# ------------------------------------------------------------------ 4. verify restored data
phase_start verify
mismatch=0
for g in "${GROUPS_ARR[@]}"; do
  DST_COUNT[$g]=$(fs_count "$TARGET_PROJECT" "$DRILL_DB" "$g")
  src=${SRC_COUNT[$g]} dst=${DST_COUNT[$g]}
  if [ "$COUNT_MODE" = at-backup-time ]; then
    [ "$src" = "$dst" ] || mismatch=1
  else
    # Source moved on since the backup: accept a restored count within 5 % (or 10 docs) of today's.
    diff=$((src > dst ? src - dst : dst - src))
    lim=$((src / 20 > 10 ? src / 20 : 10))
    [ "$diff" -le "$lim" ] || mismatch=1
  fi
done
if [ "$mismatch" = 0 ]; then
  check document_counts ok "$COUNT_MODE"
else
  check document_counts fail "counts differ ($COUNT_MODE), see table"
fi
if [ "${DST_COUNT[orgs]:-0}" -gt 0 ] || [ "$DRY_RUN" = 1 ]; then
  check restored_db_not_empty ok "orgs=${DST_COUNT[orgs]:-0}"
else
  check restored_db_not_empty fail "no orgs in the restored database"
fi
phase_end verify

# ------------------------------------------------------------------ 5. Cloud Storage: versioned-object restore on a canary
phase_start storage_restore
CANARY="gs://$STORAGE_BUCKET/_drill/$TS/canary.bin"
tmpd=$(mktemp -d)
trap 'rm -rf "$tmpd"' EXIT
head -c 65536 /dev/urandom >"$tmpd/v1"
head -c 65536 /dev/urandom >"$tmpd/v2"
SHA1=$(sha256sum "$tmpd/v1" | cut -d' ' -f1)
run gcloud storage cp "$tmpd/v1" "$CANARY"
capture GEN1 1700000000000001 gcloud storage objects describe "$CANARY" --format='value(generation)'
run gcloud storage cp "$tmpd/v2" "$CANARY"
run gcloud storage rm "$CANARY" # live version gone: simulates an accidental overwrite + delete
run gcloud storage ls --all-versions "$CANARY"
run gcloud storage cp "$CANARY#$GEN1" "$CANARY" # restore = copy the old generation over the live name
run gcloud storage cp "$CANARY" "$tmpd/restored"
if [ "$DRY_RUN" = 1 ]; then
  check storage_version_restore ok "dry-run"
elif [ "$(sha256sum "$tmpd/restored" | cut -d' ' -f1)" = "$SHA1" ]; then
  check storage_version_restore ok "generation $GEN1 restored, sha256 matches"
else
  check storage_version_restore fail "restored canary differs from v1"
fi
run gcloud storage rm --all-versions "gs://$STORAGE_BUCKET/_drill/$TS/**"
phase_end storage_restore

# ------------------------------------------------------------------ 6. off-project Storage mirror spot check (SEC-37)
if [ -n "$STORAGE_BACKUP_BUCKET" ]; then
  phase_start storage_mirror
  capture SAMPLE "gs://$STORAGE_BUCKET/orgs/o/projects/p/uploads/f.pdf" \
    bash -c "gcloud storage ls --recursive 'gs://$STORAGE_BUCKET/orgs/**' 2>/dev/null | head -n 5000 | shuf -n 5 || true"
  ok=0 total=0
  while IFS= read -r obj; do
    [ -n "$obj" ] || continue
    total=$((total + 1))
    rel=${obj#gs://"$STORAGE_BUCKET"/}
    capture H1 x gcloud storage objects describe "$obj" --format='value(md5_hash)'
    capture H2 x gcloud storage objects describe "gs://$STORAGE_BACKUP_BUCKET/$rel" --format='value(md5_hash)'
    [ "$H1" = "$H2" ] && ok=$((ok + 1))
  done <<<"$SAMPLE"
  if [ "$ok" = "$total" ]; then
    check storage_mirror_sample ok "$ok/$total objects identical in gs://$STORAGE_BACKUP_BUCKET"
  else
    check storage_mirror_sample fail "$ok/$total identical (objects newer than the last daily transfer may differ)"
  fi
  phase_end storage_mirror
fi

DRILL_END=$(now_epoch)

# ------------------------------------------------------------------ 7. report
RESTORE_S=$((T_END[restore] - T_START[restore]))
VERIFY_S=$((T_END[verify] - T_START[verify]))
phases_json="{}"
for p in "${PHASES[@]}"; do
  phases_json=$(jq -c --arg p "$p" --argjson s "${T_START[$p]}" --argjson e "${T_END[$p]:-$DRILL_END}" \
    '. + {($p): {start: ($s | todate), end: ($e | todate), seconds: ($e - $s)}}' <<<"$phases_json")
done
counts_json="{}"
for g in "${GROUPS_ARR[@]}"; do
  counts_json=$(jq -c --arg g "$g" --argjson s "${SRC_COUNT[$g]:-0}" --argjson d "${DST_COUNT[$g]:-0}" '. + {($g): {source: $s, restored: $d}}' <<<"$counts_json")
done
jq -n --arg ts "$TS" --arg mode "$MODE" --arg project "$PROJECT" --arg target "$TARGET_PROJECT/$DRILL_DB" \
  --arg backup "$BACKUP_REF" --arg backupTime "$BACKUP_TIME" --argjson rpo "$RPO_S" --argjson restore "$RESTORE_S" \
  --argjson verify "$VERIFY_S" --argjson total "$((DRILL_END - DRILL_START))" --arg countMode "$COUNT_MODE" \
  --argjson phases "$phases_json" --argjson counts "$counts_json" --argjson checks "$CHECKS_JSON" \
  --argjson dry "$([ "$DRY_RUN" = 1 ] && echo true || echo false)" \
  '{drill: $ts, dryRun: $dry, mode: $mode, sourceProject: $project, restoredInto: $target,
    backup: {ref: $backup, takenAt: $backupTime},
    measured: {rpoSeconds: $rpo, restoreSeconds: $restore, verifySeconds: $verify, drillSeconds: $total,
               targets: {rpoSeconds: 86400, rtoSeconds: 28800}},
    countMode: $countMode, counts: $counts, phases: $phases, checks: $checks,
    passed: ([$checks[] | select(.status == "fail")] | length == 0)}' >"$OUT/results.json"

{
  echo "# Restore drill $TS ($MODE$([ "$DRY_RUN" = 1 ] && echo ", DRY RUN"))"
  echo
  echo "| Field | Value |"
  echo "| --- | --- |"
  echo "| Source | \`$PROJECT/$DATABASE\` |"
  echo "| Restored into | \`$TARGET_PROJECT/$DRILL_DB\` |"
  echo "| Backup | \`$BACKUP_REF\` taken $BACKUP_TIME |"
  echo "| RPO measured (backup age at drill start) | ${RPO_S}s (target ≤ 86400 s) |"
  echo "| Restore (import/restore op) | ${RESTORE_S}s |"
  echo "| Verification | ${VERIFY_S}s |"
  echo "| Whole drill | $((DRILL_END - DRILL_START))s |"
  echo
  echo "| Collection group | Source ($COUNT_MODE) | Restored |"
  echo "| --- | --- | --- |"
  for g in "${GROUPS_ARR[@]}"; do echo "| $g | ${SRC_COUNT[$g]:-0} | ${DST_COUNT[$g]:-0} |"; done
  echo
  echo "| Check | Status | Detail |"
  echo "| --- | --- | --- |"
  jq -r '.[] | "| \(.name) | \(.status) | \(.detail) |"' <<<"$CHECKS_JSON"
} >"$OUT/results.md"
log "report: $OUT/results.json, $OUT/results.md"

# ------------------------------------------------------------------ 8. cleanup
if [ "$KEEP" = 1 ]; then
  log "--keep: restored database $TARGET_PROJECT/$DRILL_DB left in place — delete it after inspection:"
  log "  gcloud firestore databases delete --database=$DRILL_DB --project $TARGET_PROJECT"
else
  if [ "$ASSUME_YES" != 1 ] && [ "$DRY_RUN" != 1 ]; then
    read -r -p "Delete the restored database $TARGET_PROJECT/$DRILL_DB now? [y/N] " ans
    [ "$ans" = y ] || [ "$ans" = Y ] || {
      log "kept $DRILL_DB"
      exit 0
    }
  fi
  run gcloud firestore databases delete --database="$DRILL_DB" --project "$TARGET_PROJECT" --quiet
fi

if jq -e '.passed' "$OUT/results.json" >/dev/null; then
  log "DRILL PASSED"
else
  log "DRILL FAILED — see $OUT/results.md"
  exit 1
fi
