#!/usr/bin/env bash
# SEC-43 alerts on Google Cloud Monitoring — log-based metrics + alert policies. Owner runs once per environment.
# Docs, thresholds and responses: infra/monitoring/README.md.
#
# Usage:
#   infra/monitoring/setup-alerts.sh --project kamutan-fba67 --notification-email security@<domain> [--dry-run]
#        [--api-service api] [--worker-service kamutan-worker] [--channel projects/<p>/notificationChannels/<id>]
# --dry-run prints every gcloud command and the generated policy JSON; nothing is created (no credentials needed).
# Idempotent: metrics are created or updated; a policy whose displayName already exists is updated in place.
#
# Log sources (ADR 0008): the API is Cloud Functions gen2 = Cloud Run service "api" logging pino JSON
# (jsonPayload.msg, jsonPayload.res.statusCode, jsonPayload.req.path, uid, orgId); the worker is Cloud Run
# "kamutan-worker" logging Python text lines (textPayload) — filters also match jsonPayload.message so they keep
# working once the worker switches to structured JSON (docs/security/sprint-5-requests.md R-W1).

set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/lib/common.sh
. "$here/../scripts/lib/common.sh"

PROJECT=kamutan-fba67
EMAIL=""
CHANNEL=""
API_SERVICE=api
WORKER_SERVICE=kamutan-worker

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT=$2; shift 2 ;;
    --notification-email) EMAIL=$2; shift 2 ;;
    --channel) CHANNEL=$2; shift 2 ;;
    --api-service) API_SERVICE=$2; shift 2 ;;
    --worker-service) WORKER_SERVICE=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
[ -n "$EMAIL" ] || [ -n "$CHANNEL" ] || die "--notification-email or --channel is required"
require_tools gcloud jq
export DRY_RUN
API_SA=kamutan-api@$PROJECT.iam.gserviceaccount.com
WORKER_SA=kamutan-worker@$PROJECT.iam.gserviceaccount.com
BACKUP_SA=kamutan-backup@$PROJECT.iam.gserviceaccount.com
DEPLOY_SA=kamutan-deploy@$PROJECT.iam.gserviceaccount.com

API="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$API_SERVICE\""
WORKER="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"$WORKER_SERVICE\""
# Worker text (today) or structured message (after R-W1).
wmatch() { printf '(textPayload=~"%s" OR jsonPayload.message=~"%s")' "$1" "$1"; }

run gcloud services enable monitoring.googleapis.com logging.googleapis.com --project "$PROJECT"
# SEC-43: operational logs kept 30–90 days (default bucket is 30 days; 90 keeps a quarter for investigations).
run gcloud logging buckets update _Default --location=global --retention-days=90 --project "$PROJECT"

# ------------------------------------------------------------------ notification channel
if [ -z "$CHANNEL" ]; then
  capture CHANNEL "projects/$PROJECT/notificationChannels/DRYRUN" gcloud beta monitoring channels list \
    --project "$PROJECT" --filter="type=\"email\" AND labels.email_address=\"$EMAIL\"" --format='value(name)' --limit=1
  if [ -z "$CHANNEL" ]; then
    capture CHANNEL "projects/$PROJECT/notificationChannels/DRYRUN" gcloud beta monitoring channels create \
      --project "$PROJECT" --type=email --display-name="Kamutan security ($EMAIL)" \
      --channel-labels=email_address="$EMAIL" --format='value(name)'
  fi
fi
log "notification channel: $CHANNEL"

# ------------------------------------------------------------------ log-based metrics
metric() { # name description filter
  local name=$1 desc=$2 filter=$3
  if [ "$DRY_RUN" != 1 ] && gcloud logging metrics describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    run gcloud logging metrics update "$name" --project "$PROJECT" --description="$desc" --log-filter="$filter"
  else
    run gcloud logging metrics create "$name" --project "$PROJECT" --description="$desc" --log-filter="$filter"
  fi
}

metric kamutan_api_401 "SEC-43 auth failures: API requests rejected 401 (missing/invalid/revoked ID token)" \
  "$API AND jsonPayload.res.statusCode=401"
metric kamutan_api_403 "SEC-43 guard denials: API requests rejected 403 (role / MFA guard)" \
  "$API AND jsonPayload.res.statusCode=403"
metric kamutan_api_404_private "SEC-43 tenant probing: 404 on authenticated API routes (non-members get 404, SEC-10)" \
  "$API AND jsonPayload.res.statusCode=404 AND NOT jsonPayload.req.path=~\"^/api/v1/public/\""
metric kamutan_share_views "SEC-43 share-link traffic: GET on the public share API" \
  "$API AND jsonPayload.req.method=\"GET\" AND jsonPayload.req.path=~\"^/api/v1/public/share/\""
metric kamutan_share_throttled "SEC-29/43 share-link brute force: 404/410/429 on the public share API" \
  "$API AND jsonPayload.req.path=~\"^/api/v1/public/share/\" AND jsonPayload.res.statusCode=(404 OR 410 OR 429)"
metric kamutan_upload_rejected "SEC-14/43 rejected uploads (magic bytes / type mismatch)" \
  "$API AND jsonPayload.msg=~\"magic-bytes rejection\""
metric kamutan_sandbox_limits "SEC-17/43 parser sandbox limit hits and crashes" \
  "$WORKER AND $(wmatch 'failed: (parse_crashed|parse_memory_limit|parse_cpu_limit|parse_timeout|parse_output_too_large)')"
metric kamutan_llm_budget_exceeded "SEC-42/43 LLM calls refused because the org budget is exhausted" \
  "$WORKER AND $(wmatch 'llm_call .*\"status\": \"budget_exceeded\"')"

# Distribution metric: LLM cost per call (USD) for dashboards / daily-cost alert.
cost_cfg=$(mktemp)
trap 'rm -f "$cost_cfg"' EXIT
jq -n --arg f "$WORKER AND $(wmatch 'llm_call ')" '{
  name: "kamutan_llm_cost_usd",
  description: "SEC-43 LLM cost per gateway call (USD), parsed from the llm_call log line",
  filter: $f,
  metricDescriptor: {metricKind: "DELTA", valueType: "DISTRIBUTION", unit: "1"},
  valueExtractor: "REGEXP_EXTRACT(textPayload, \"\\\"costUsd\\\": ([0-9.]+)\")",
  bucketOptions: {exponentialBuckets: {numFiniteBuckets: 20, growthFactor: 2, scale: 0.0005}}
}' >"$cost_cfg"
[ "$DRY_RUN" = 1 ] && cat "$cost_cfg"
if [ "$DRY_RUN" != 1 ] && gcloud logging metrics describe kamutan_llm_cost_usd --project "$PROJECT" >/dev/null 2>&1; then
  run gcloud logging metrics update kamutan_llm_cost_usd --project "$PROJECT" --config-from-file="$cost_cfg"
else
  run gcloud logging metrics create kamutan_llm_cost_usd --project "$PROJECT" --config-from-file="$cost_cfg"
fi

# ------------------------------------------------------------------ alert policies
upsert_policy() { # json
  local json=$1 name existing f
  name=$(jq -r .displayName <<<"$json")
  f=$(mktemp)
  printf '%s\n' "$json" >"$f"
  [ "$DRY_RUN" = 1 ] && cat "$f"
  existing=""
  if [ "$DRY_RUN" != 1 ]; then
    existing=$(gcloud alpha monitoring policies list --project "$PROJECT" \
      --filter="displayName=\"$name\"" --format='value(name)' --limit=1)
  fi
  if [ -n "$existing" ]; then
    run gcloud alpha monitoring policies update "$existing" --project "$PROJECT" --policy-from-file="$f"
  else
    run gcloud alpha monitoring policies create --project "$PROJECT" --policy-from-file="$f"
  fi
  rm -f "$f"
}

doc() { printf 'Kamutan SEC-43 alert. Runbook: infra/monitoring/README.md#%s. %s' "$1" "$2"; }

# Rate alert on a log-based counter metric: sum over <window> > <threshold>.
rate_policy() { # displayName metric threshold windowSeconds severity anchor docText
  jq -n --arg dn "$1" --arg m "$2" --argjson t "$3" --arg w "$4s" --arg sev "$5" --arg ch "$CHANNEL" \
    --arg doc "$(doc "$6" "$7")" '{
    displayName: $dn, combiner: "OR", severity: $sev,
    conditions: [{displayName: ($dn + " (> " + ($t|tostring) + " in " + $w + ")"), conditionThreshold: {
      filter: ("metric.type=\"logging.googleapis.com/user/" + $m + "\" AND resource.type=\"cloud_run_revision\""),
      aggregations: [{alignmentPeriod: $w, perSeriesAligner: "ALIGN_SUM", crossSeriesReducer: "REDUCE_SUM"}],
      comparison: "COMPARISON_GT", thresholdValue: $t, duration: "0s", trigger: {count: 1}}}],
    alertStrategy: {autoClose: "3600s"},
    notificationChannels: [$ch],
    documentation: {content: $doc, mimeType: "text/markdown"}}'
}

# Immediate alert on a matching log entry (rate-limited notifications).
log_policy() { # displayName filter severity anchor docText
  jq -n --arg dn "$1" --arg f "$2" --arg sev "$3" --arg ch "$CHANNEL" --arg doc "$(doc "$4" "$5")" '{
    displayName: $dn, combiner: "OR", severity: $sev,
    conditions: [{displayName: $dn, conditionMatchedLog: {filter: $f}}],
    alertStrategy: {notificationRateLimit: {period: "300s"}, autoClose: "3600s"},
    notificationChannels: [$ch],
    documentation: {content: $doc, mimeType: "text/markdown"}}'
}

upsert_policy "$(rate_policy "Kamutan: auth failure spike" kamutan_api_401 50 300 WARNING auth-failures \
  "More than 50 API 401s in 5 min: token stuffing, a broken client release, or revoked sessions retrying.")"
upsert_policy "$(rate_policy "Kamutan: guard denials" kamutan_api_403 30 300 WARNING guard-denials \
  "More than 30 API 403s in 5 min: privilege probing (role/MFA guard). Check uid/orgId labels in the logs.")"
upsert_policy "$(rate_policy "Kamutan: tenant probing (404s)" kamutan_api_404_private 100 600 WARNING tenant-probing \
  "More than 100 404s on private routes in 10 min: possible id enumeration across tenants.")"
upsert_policy "$(rate_policy "Kamutan: share-link views spike" kamutan_share_views 300 600 WARNING share-views \
  "More than 300 public share requests in 10 min: a leaked link being scraped. Revoke it (API DELETE share-links/:id).")"
upsert_policy "$(rate_policy "Kamutan: share-link brute force" kamutan_share_throttled 50 600 WARNING share-bruteforce \
  "More than 50 unknown/expired/throttled share requests in 10 min: token guessing (per-IP lockout is active).")"
upsert_policy "$(rate_policy "Kamutan: rejected uploads spike" kamutan_upload_rejected 20 3600 WARNING uploads \
  "More than 20 magic-bytes rejections in 1 h: hostile files or a misbehaving client.")"
upsert_policy "$(rate_policy "Kamutan: sandbox limit hits" kamutan_sandbox_limits 5 900 WARNING sandbox \
  "More than 5 parser sandbox limit hits/crashes in 15 min: possible exploitation attempt or parser DoS (SEC-17).")"
upsert_policy "$(log_policy "Kamutan: parser sandbox crashed (signal)" \
  "$WORKER AND $(wmatch '(failed: parse_crashed|sandbox child exited rc=-)')" ERROR sandbox \
  "A parser child died on a signal. Treat as a possible exploit (SEV2 until triaged): keep the input, check the job's org.")"
upsert_policy "$(log_policy "Kamutan: worker container killed (OOM / signal)" \
  "$WORKER AND textPayload=~\"(Memory limit of .* exceeded|Container terminated on signal)\"" ERROR sandbox \
  "Cloud Run killed the worker container. A sandbox limit did not hold or memory is undersized.")"
upsert_policy "$(log_policy "Kamutan: LLM budget exceeded" \
  "$WORKER AND $(wmatch 'llm_call .*\"status\": \"budget_exceeded\"')" WARNING llm-budget \
  "An org exhausted its monthly LLM budget (denial-of-wallet guard SEC-42). The pipeline fell back to local OCR.")"
upsert_policy "$(log_policy "Kamutan: audit chain broken" \
  "$API AND jsonPayload.msg=\"audit chain verification FAILED\"" CRITICAL audit-chain \
  "The audit hash chain verification failed (SEC-35): possible tampering. SEV1 until explained; preserve evidence.")"
upsert_policy "$(log_policy "Kamutan: GCP IAM / key / rules change" \
  "logName=\"projects/$PROJECT/logs/cloudaudit.googleapis.com%2Factivity\" AND (protoPayload.methodName=(\"SetIamPolicy\" OR \"google.iam.admin.v1.CreateServiceAccountKey\" OR \"google.iam.admin.v1.CreateServiceAccount\" OR \"google.firebase.rules.v1.FirebaseRulesService.UpdateRelease\" OR \"google.firebase.rules.v1.FirebaseRulesService.CreateRelease\") OR protoPayload.methodName=~\"storage.setIamPermissions\") AND NOT protoPayload.authenticationInfo.principalEmail=\"$DEPLOY_SA\"" \
  CRITICAL admin-changes \
  "IAM policy, service-account key or Security Rules changed outside the deploy pipeline (SEC-43 admin permission changes).")"
# Needs Firestore Data Access audit logs (DATA_WRITE) — see README §admin-changes for the one-time command.
upsert_policy "$(log_policy "Kamutan: direct Firestore write by unexpected principal" \
  "logName=\"projects/$PROJECT/logs/cloudaudit.googleapis.com%2Fdata_access\" AND protoPayload.serviceName=\"firestore.googleapis.com\" AND protoPayload.methodName=~\"(Commit|Write|BatchWrite|UpdateDocument|CreateDocument|DeleteDocument)\" AND NOT protoPayload.authenticationInfo.principalEmail=(\"$API_SA\" OR \"$WORKER_SA\" OR \"$BACKUP_SA\")" \
  CRITICAL admin-changes \
  "Production Firestore written by a principal other than the API/worker/backup service accounts (console edit, leaked admin key, member role change by hand).")"

# Sprint 5 background work: offboarding purge job (SEC-52), apiJobs (offboarding export), reprocessDependents.
upsert_policy "$(log_policy "Kamutan: offboarding purge failed" \
  "(resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"kamutan-offboard-purge\" AND (severity>=ERROR OR jsonPayload.msg=\"offboard-purge failed\")) OR (resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"kamutan-offboard-purge-daily\" AND severity>=ERROR)" \
  ERROR purge \
  "The daily purge of offboarded orgs failed or was not started. Deletion within 30 days (SEC-52/DPA) is at risk: docs/runbooks/offboarding-purge.md.")"
upsert_policy "$(log_policy "Kamutan: API background function errors" \
  "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=(\"apijobs\" OR \"reprocessdependents\") AND severity>=ERROR" \
  WARNING background \
  "apiJobs (offboarding export ZIP) or reprocessDependents (dependent sheet re-runs) logged an error.")"

log "done: metrics + policies in $PROJECT -> $CHANNEL"
log "LLM spend cap: also set the provider-side monthly limit and the GCP budget (infra/IAM.md §5)."
