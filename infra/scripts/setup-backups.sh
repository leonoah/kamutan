#!/usr/bin/env bash
# Backup configuration for Kamutan (SEC-35, SEC-36, SEC-37, SEC-51) — owner runs this once per environment.
#
# What it sets up (idempotent-ish: existing resources make "create" warn, not fail):
#   1. Firestore scheduled backups (managed, same region): daily, retention 4 weeks (<= the 30-day deletion
#      promise in SEC-51/DPA). Restore = new database in the same project (restore-drill.sh --mode backup).
#   2. A SEPARATE backup project (SEC-36 "separate account") with two buckets, location EU, uniform access,
#      public access prevention:
#      - <backup-bucket>  Firestore exports: 30-day retention policy (objects cannot be deleted/overwritten
#        earlier — ransomware / compromised-admin protection), lifecycle delete at 31 days;
#      - <storage-backup-bucket>  copy of Cloud Storage orgs/: versioning, noncurrent versions deleted after
#        30 days (no retention policy: the daily transfer must be able to overwrite and to delete).
#   3. Nightly Firestore managed export into <backup-bucket> via Cloud Scheduler (OAuth as a dedicated SA that can
#      only run exports) — the off-project copy used by restore-drill.sh --mode export.
#   4. Cloud Storage: object versioning + 30-day noncurrent-version lifecycle on the main bucket (SEC-37), and a
#      daily Storage Transfer Service job mirroring orgs/ into <storage-backup-bucket> (objects deleted at the
#      source become noncurrent there and expire after 30 days, so offboarding deletion reaches backups, SEC-51).
#   5. Weekly audit-log export is covered by (3): auditLog lives in Firestore and is in every nightly export.
#
# Usage:
#   infra/scripts/setup-backups.sh --project kamutan-fba67 --backup-project kamutan-backup-eu [--dry-run]
#        [--bucket kamutan-fba67.firebasestorage.app] [--backup-bucket <name>] [--storage-backup-bucket <name>]
#        [--database '(default)']
#        [--scheduler-region europe-west1] [--export-time "30 1 * * *"]
# --dry-run prints every gcloud command and changes nothing (no credentials needed).
#
# Prerequisites (owner): Owner on both projects, billing enabled on the backup project, gcloud >= 470.

set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/lib/common.sh
. "$here/lib/common.sh"

PROJECT=kamutan-fba67
BACKUP_PROJECT=""
BUCKET=""
BACKUP_BUCKET=""
STORAGE_BACKUP_BUCKET=""
DATABASE='(default)'
FS_LOCATION=eur3
BUCKET_LOCATION=EU
SCHED_REGION=europe-west1
EXPORT_CRON="30 1 * * *" # 01:30 UTC daily (before the 02:43 DAST run; RPO <= 24 h)
BACKUP_RETENTION=4w
OBJECT_RETENTION_DAYS=30

usage() { sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=$2; shift 2 ;;
    --backup-project) BACKUP_PROJECT=$2; shift 2 ;;
    --bucket) BUCKET=$2; shift 2 ;;
    --backup-bucket) BACKUP_BUCKET=$2; shift 2 ;;
    --storage-backup-bucket) STORAGE_BACKUP_BUCKET=$2; shift 2 ;;
    --database) DATABASE=$2; shift 2 ;;
    --scheduler-region) SCHED_REGION=$2; shift 2 ;;
    --export-time) EXPORT_CRON=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[ -n "$BACKUP_PROJECT" ] || die "--backup-project is required (a separate GCP project, SEC-36)"
[ "$BACKUP_PROJECT" != "$PROJECT" ] || die "--backup-project must differ from --project"
BUCKET=${BUCKET:-$PROJECT.firebasestorage.app}
BACKUP_BUCKET=${BACKUP_BUCKET:-$PROJECT-firestore-backup-eu}
STORAGE_BACKUP_BUCKET=${STORAGE_BACKUP_BUCKET:-$PROJECT-storage-backup-eu}
require_tools gcloud
export DRY_RUN

EXPORT_SA=kamutan-backup@$PROJECT.iam.gserviceaccount.com
capture PROJECT_NUMBER 123456789012 gcloud projects describe "$PROJECT" --format='value(projectNumber)'
FS_AGENT=service-$PROJECT_NUMBER@gcp-sa-firestore.iam.gserviceaccount.com
capture BACKUP_PROJECT_NUMBER 210987654321 gcloud projects describe "$BACKUP_PROJECT" --format='value(projectNumber)'
STS_AGENT=project-$BACKUP_PROJECT_NUMBER@storage-transfer-service.iam.gserviceaccount.com

log "== 0. APIs"
run gcloud services enable firestore.googleapis.com cloudscheduler.googleapis.com --project "$PROJECT"
run gcloud services enable storage.googleapis.com storagetransfer.googleapis.com --project "$BACKUP_PROJECT"

log "== 1. Firestore scheduled backups (daily, $BACKUP_RETENTION)"
try gcloud firestore backups schedules create --project "$PROJECT" --database="$DATABASE" \
  --recurrence=daily --retention="$BACKUP_RETENTION"
run gcloud firestore backups schedules list --project "$PROJECT" --database="$DATABASE"

log "== 2. Backup buckets in the separate project"
try gcloud storage buckets create "gs://$BACKUP_BUCKET" --project "$BACKUP_PROJECT" --location="$BUCKET_LOCATION" \
  --uniform-bucket-level-access --public-access-prevention --default-storage-class=NEARLINE
# Retention policy (no versioning: GCS does not allow both). Objects are immutable for 30 days.
run gcloud storage buckets update "gs://$BACKUP_BUCKET" \
  --retention-period="${OBJECT_RETENTION_DAYS}d"
lifecycle=$(mktemp)
trap 'rm -f "$lifecycle" "${storagelc:-}" "${mainlc:-}"' EXIT
cat >"$lifecycle" <<JSON
{"rule": [{"action": {"type": "Delete"}, "condition": {"age": $((OBJECT_RETENTION_DAYS + 1))}}]}
JSON
run gcloud storage buckets update "gs://$BACKUP_BUCKET" --lifecycle-file="$lifecycle"
# Do NOT lock the retention policy until a restore drill has passed: a locked policy cannot be shortened.
#   gcloud storage buckets update gs://$BACKUP_BUCKET --lock-retention-period
try gcloud storage buckets create "gs://$STORAGE_BACKUP_BUCKET" --project "$BACKUP_PROJECT" --location="$BUCKET_LOCATION" \
  --uniform-bucket-level-access --public-access-prevention --default-storage-class=NEARLINE
run gcloud storage buckets update "gs://$STORAGE_BACKUP_BUCKET" --versioning
storagelc=$(mktemp)
cat >"$storagelc" <<JSON
{"rule": [{"action": {"type": "Delete"}, "condition": {"isLive": false, "daysSinceNoncurrentTime": $OBJECT_RETENTION_DAYS}}]}
JSON
run gcloud storage buckets update "gs://$STORAGE_BACKUP_BUCKET" --lifecycle-file="$storagelc"

log "== 3. Nightly managed export (Cloud Scheduler -> Firestore exportDocuments)"
try gcloud iam service-accounts create kamutan-backup --project "$PROJECT" \
  --display-name="Kamutan nightly Firestore export (Cloud Scheduler)"
# roles/datastore.importExportAdmin = export/import only (no document reads through the API).
run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$EXPORT_SA" \
  --role=roles/datastore.importExportAdmin --condition=None
# The Firestore service agent writes the export files into the other project's bucket.
run gcloud storage buckets add-iam-policy-binding "gs://$BACKUP_BUCKET" \
  --member="serviceAccount:$FS_AGENT" --role=roles/storage.objectAdmin
# outputUriPrefix = bucket root: Firestore adds a timestamped folder per export (no overwrite).
db_path=$([ "$DATABASE" = '(default)' ] && printf '(default)' || printf '%s' "$DATABASE")
try gcloud scheduler jobs create http kamutan-firestore-export --project "$PROJECT" --location="$SCHED_REGION" \
  --schedule="$EXPORT_CRON" --time-zone=Etc/UTC --attempt-deadline=30m \
  --uri="https://firestore.googleapis.com/v1/projects/$PROJECT/databases/$db_path:exportDocuments" \
  --http-method=POST --headers=Content-Type=application/json \
  --message-body="{\"outputUriPrefix\":\"gs://$BACKUP_BUCKET\"}" \
  --oauth-service-account-email="$EXPORT_SA" --oauth-token-scope=https://www.googleapis.com/auth/datastore

log "== 4. Cloud Storage: versioning on the main bucket + daily copy to the backup bucket"
run gcloud storage buckets update "gs://$BUCKET" --versioning
mainlc=$(mktemp)
cat >"$mainlc" <<'JSON'
{"rule": [
  {"action": {"type": "Delete"}, "condition": {"isLive": false, "daysSinceNoncurrentTime": 30}},
  {"action": {"type": "Delete"}, "condition": {"isLive": false, "numNewerVersions": 5}}
]}
JSON
# NOTE: this REPLACES the bucket's lifecycle config. Merge by hand if other rules exist (e.g. quarantine TTL):
#   gcloud storage buckets describe gs://$BUCKET --format='json(lifecycle_config)'
run gcloud storage buckets update "gs://$BUCKET" --lifecycle-file="$mainlc"
run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$STS_AGENT" --role=roles/storage.objectViewer
run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$STS_AGENT" --role=roles/storage.legacyBucketReader
run gcloud storage buckets add-iam-policy-binding "gs://$STORAGE_BACKUP_BUCKET" \
  --member="serviceAccount:$STS_AGENT" --role=roles/storage.objectAdmin
try gcloud transfer jobs create "gs://$BUCKET" "gs://$STORAGE_BACKUP_BUCKET" --project "$BACKUP_PROJECT" \
  --name=transferJobs/kamutan-storage-daily --description="Kamutan orgs/ daily mirror (SEC-37)" \
  --include-prefixes=orgs/ --schedule-repeats-every=1d --overwrite-when=different \
  --delete-from=destination-if-unique

log "== 5. Verify"
run gcloud firestore backups list --project "$PROJECT" --location="$FS_LOCATION"
run gcloud scheduler jobs describe kamutan-firestore-export --project "$PROJECT" --location="$SCHED_REGION"
for b in "$BACKUP_BUCKET" "$STORAGE_BACKUP_BUCKET"; do
  run gcloud storage buckets describe "gs://$b" \
    --format="yaml(name,location,versioning_enabled,retention_policy,public_access_prevention,lifecycle_config)"
done
log "Trigger a first export now:  gcloud scheduler jobs run kamutan-firestore-export --project $PROJECT --location $SCHED_REGION"
log "Then run the drill:           infra/scripts/restore-drill.sh --project $PROJECT --scratch-project <scratch> --backup-bucket $BACKUP_BUCKET --storage-backup-bucket $STORAGE_BACKUP_BUCKET"
