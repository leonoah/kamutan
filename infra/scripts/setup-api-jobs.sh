#!/usr/bin/env bash
# Sprint 5 IAM + infrastructure for the API background work (infra/IAM.md §2b, §3 "Sprint 5 additions", §3b, §4).
#   - topic `api-jobs` + publisher for kamutan-api@ (function `apiJobs`, offboarding export);
#   - custom role kamutanAuthRevoke (firebaseauth.users.get/update) for kamutan-api@ (revokeRefreshTokens, SEC-52);
#   - run.invoker for kamutan-api@ on the `apijobs` / `reprocessdependents` services (trigger identities) — only once
#     the functions exist (first deploy), otherwise skipped with a warning;
#   - kamutan-purge@ + Cloud Run job `kamutan-offboard-purge` + kamutan-scheduler@ + daily Cloud Scheduler trigger;
#   - deploy SA rights for the scheduled/Pub/Sub functions and the purge job image.
# Prerequisite: infra/IAM.md §0–§4 (service accounts, Artifact Registry, WIF) done; for the purge job an image digest.
#
# Usage:
#   infra/scripts/setup-api-jobs.sh --project kamutan-fba67 [--region europe-west1] [--bucket <bucket>]
#        [--purge-image <region>-docker.pkg.dev/<project>/kamutan/api-jobs@sha256:...] [--schedule "7 3 * * *"] [--dry-run]
# Without --purge-image the purge job is not created (the rest is). --dry-run prints every command, changes nothing.

set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/lib/common.sh
. "$here/lib/common.sh"

PROJECT=kamutan-fba67
REGION=europe-west1
BUCKET=""
PURGE_IMAGE=""
SCHEDULE="7 3 * * *" # 03:07 UTC daily, after the 01:30 Firestore export

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=$2; shift 2 ;;
    --region) REGION=$2; shift 2 ;;
    --bucket) BUCKET=$2; shift 2 ;;
    --purge-image) PURGE_IMAGE=$2; shift 2 ;;
    --schedule) SCHEDULE=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
BUCKET=${BUCKET:-$PROJECT.firebasestorage.app}
if [ -n "$PURGE_IMAGE" ] && ! [[ "$PURGE_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  die "--purge-image must be pinned by digest (…@sha256:<64 hex>)"
fi
require_tools gcloud
export DRY_RUN

API_SA=kamutan-api@$PROJECT.iam.gserviceaccount.com
DEPLOY_SA=kamutan-deploy@$PROJECT.iam.gserviceaccount.com
PURGE_SA=kamutan-purge@$PROJECT.iam.gserviceaccount.com
SCHED_SA=kamutan-scheduler@$PROJECT.iam.gserviceaccount.com
capture PROJECT_NUMBER 123456789012 gcloud projects describe "$PROJECT" --format='value(projectNumber)'
PUBSUB_AGENT=service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com
P=(--project "$PROJECT")

log "== APIs"
run gcloud services enable eventarc.googleapis.com cloudscheduler.googleapis.com identitytoolkit.googleapis.com \
  run.googleapis.com pubsub.googleapis.com "${P[@]}"

log "== §2b topic api-jobs"
try gcloud pubsub topics create api-jobs --message-retention-duration=1d "${P[@]}"
run gcloud pubsub topics add-iam-policy-binding api-jobs "${P[@]}" \
  --member="serviceAccount:$API_SA" --role=roles/pubsub.publisher

log "== §3 revoke Firebase Auth sessions (custom role, not firebaseauth.admin)"
try gcloud iam roles create kamutanAuthRevoke "${P[@]}" --title="Kamutan revoke Auth sessions" \
  --description="revokeRefreshTokens for offboarding (SEC-52)" \
  --permissions=firebaseauth.users.get,firebaseauth.users.update --stage=GA
run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$API_SA" \
  --role="projects/$PROJECT/roles/kamutanAuthRevoke" --condition=None
run gcloud iam service-accounts add-iam-policy-binding "$API_SA" "${P[@]}" \
  --member="serviceAccount:$PUBSUB_AGENT" --role=roles/iam.serviceAccountTokenCreator
for svc in apijobs reprocessdependents; do
  if [ "$DRY_RUN" = 1 ] || gcloud run services describe "$svc" --region="$REGION" "${P[@]}" >/dev/null 2>&1; then
    run gcloud run services add-iam-policy-binding "$svc" --region="$REGION" "${P[@]}" \
      --member="serviceAccount:$API_SA" --role=roles/run.invoker
  else
    warn "service $svc not deployed yet — rerun this script after the first deploy of the functions"
  fi
done

log "== §4 deploy SA: scheduled + Pub/Sub functions"
for role in roles/cloudscheduler.admin roles/pubsub.viewer roles/eventarc.developer; do
  run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" --role="$role" --condition=None
done

log "== §3b purge identity"
try gcloud iam service-accounts create kamutan-purge "${P[@]}" --display-name="Kamutan offboarding purge (Cloud Run job)"
try gcloud iam service-accounts create kamutan-scheduler "${P[@]}" --display-name="Cloud Scheduler -> kamutan-offboard-purge"
run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$PURGE_SA" \
  --role=roles/datastore.user --condition=None
run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$PURGE_SA" --role=roles/storage.objectAdmin

if [ -z "$PURGE_IMAGE" ]; then
  warn "no --purge-image: job kamutan-offboard-purge and its schedule are NOT created (offboarded orgs are not purged)"
  log "done (partial)"
  exit 0
fi

log "== §3b purge job + daily schedule"
try gcloud run jobs create kamutan-offboard-purge --region="$REGION" "${P[@]}" --image="$PURGE_IMAGE" \
  --service-account="$PURGE_SA" --tasks=1 --max-retries=1 --task-timeout=3600s --memory=1Gi --cpu=1 \
  --set-env-vars="NODE_ENV=production,GOOGLE_CLOUD_PROJECT=$PROJECT,FIREBASE_STORAGE_BUCKET=$BUCKET,LOG_LEVEL=info"
run gcloud run jobs add-iam-policy-binding kamutan-offboard-purge --region="$REGION" "${P[@]}" \
  --member="serviceAccount:$SCHED_SA" --role=roles/run.invoker
run gcloud run jobs add-iam-policy-binding kamutan-offboard-purge --region="$REGION" "${P[@]}" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/run.developer
run gcloud iam service-accounts add-iam-policy-binding "$PURGE_SA" "${P[@]}" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser
try gcloud scheduler jobs create http kamutan-offboard-purge-daily --location="$REGION" "${P[@]}" \
  --schedule="$SCHEDULE" --time-zone=Etc/UTC --attempt-deadline=180s \
  --uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/kamutan-offboard-purge:run" \
  --http-method=POST --oauth-service-account-email="$SCHED_SA" \
  --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform

log "== verify"
run gcloud run jobs describe kamutan-offboard-purge --region="$REGION" "${P[@]}" \
  --format='value(template.template.serviceAccount)'
run gcloud scheduler jobs describe kamutan-offboard-purge-daily --location="$REGION" "${P[@]}" --format='value(schedule,state)'
log "First safe run (Owner): gcloud run jobs execute kamutan-offboard-purge --region $REGION --project $PROJECT --args=--dry-run --wait"
