# Runbook — offboarding purge (SEC-52 steps 3–5)

An org offboarded through `POST /v1/orgs/:orgId/offboarding` gets `status: offboarding` and `deleteAfter = +30 days`
(sessions and share links are revoked immediately). The **purge** hard-deletes every org past `deleteAfter`:
Storage prefix `orgs/{orgId}/` first, then the Firestore subtree `orgs/{orgId}` + its `jobs` + `shareTokens`, and writes
a content-free tombstone `offboardingCertificates/{orgId}` (counts, inventory hashes, audit head, timestamps). It is
idempotent and safe to re-run (a crash after the Storage step leaves the org doc, so the next run finishes it).

| What | Where |
| --- | --- |
| Script | `apps/api/src/scripts/offboard-purge.ts` → `dist/scripts/offboard-purge.js` (`--org`, `--dry-run`, `--out`, `--now`) |
| Image | `infra/docker/api-jobs.Dockerfile` (built, Trivy-scanned and pushed by `_deploy-env.yml`; the job image is updated by digest on every deploy) |
| Runtime | Cloud Run job `kamutan-offboard-purge`, SA `kamutan-purge@` (Firestore user + bucket object admin; it must list) |
| Schedule | Cloud Scheduler `kamutan-offboard-purge-daily`, **03:07 UTC daily**, SA `kamutan-scheduler@` (can only start the job, no argument overrides) |
| Setup | `infra/scripts/setup-api-jobs.sh --purge-image <digest>` (= infra/IAM.md §3b) |
| Alert | "Kamutan: offboarding purge failed" (`infra/monitoring/setup-alerts.sh`) |

## Daily check (only when the alert fires)

```bash
R=europe-west1; P=kamutan-fba67
gcloud run jobs executions list --job kamutan-offboard-purge --region $R --project $P --limit 5
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="kamutan-offboard-purge"' \
  --project $P --freshness=2d --limit 50 --format='value(timestamp,jsonPayload.msg,jsonPayload.orgId,jsonPayload.error)'
```

The last line of every run is `{"msg":"done","due":N,"purged":M,"dryRun":false}`; `due > purged` or
`offboard-purge failed` → fix the cause and run it again (below). Typical causes: permission drift on `kamutan-purge@`
(re-run `setup-api-jobs.sh`), Firestore/Storage transient errors (just re-run).

## Manual runs (Owner)

```bash
# What would be purged now (no deletion):
gcloud run jobs execute kamutan-offboard-purge --region $R --project $P --args=--dry-run --wait
# One org only (it must already be past deleteAfter):
gcloud run jobs execute kamutan-offboard-purge --region $R --project $P --args=--org,<orgId> --wait
```

`--args` needs `run.jobs.runWithOverrides` (Owner / run.developer); the scheduler cannot pass arguments.

## Deletion certificate for the customer

The certificate (`kamutan.deletion-certificate/1`, self-hashed `certificateSha256`) is stored as the Firestore document
`offboardingCertificates/{orgId}` and also printed on stdout of the run. The printed copy is pretty-printed, so Cloud
Logging splits it into one entry per line (request R-A9: print it as a single JSON line); take it from Firestore:

```bash
curl -sS -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firestore.googleapis.com/v1/projects/$P/databases/(default)/documents/offboardingCertificates/<orgId>"
# or Firebase console → Firestore → offboardingCertificates → <orgId>
```

Send it to the org's admin contact with the note that backups expire the data within a further ≤ 31 days
(docs/runbooks/restore-drill.md §1: scheduled backups 4 weeks, exports 31 days, noncurrent Storage versions 30 days).

## Interaction with backups and restores

- The purge runs at 03:07 UTC, after the 01:30 nightly Firestore export, so the last export before deletion still
  contains the org (needed if a purge was a mistake: restore that org's documents from the export within 31 days,
  docs/runbooks/restore-drill.md §6 "some documents").
- A **full** database restore from a backup older than a purge brings purged orgs back. After any such restore, run the
  purge again immediately (`--dry-run` first) — the restored org docs still carry `status: offboarding` and the old
  `deleteAfter`, so they are due at once; Storage objects restored from the mirror are removed by the same run.

## Never

- Never run the script with `--now` in the future against production to "speed up" a deletion: the 30-day grace is a
  contractual promise to the customer (they may still download their export).
- Never give `kamutan-purge@` to anything else; it is the only identity that can list and delete across all orgs.
