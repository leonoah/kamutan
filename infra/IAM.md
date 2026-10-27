# IAM — least-privilege identities for Kamutan on Google Cloud (Sprint 1)

Platform per ADR 0008: Firebase project `kamutan-fba67`, region `europe-west1`, Firestore `eur3`,
bucket `kamutan-fba67.firebasestorage.app`, Pub/Sub topic `ingest`, Cloud Run worker `kamutan-worker`,
API = Cloud Functions 2nd gen `api`. Requirements: SEC-17 (sandbox), SEC-19/20 (private storage, signed
URLs), SEC-24 (worker identity, secrets), SEC-49 (OIDC deploy, no key files), ADR 0008 §authz-3.

Everything below is for the **owner** to paste (an agent never holds these permissions, SEC-53). Run it
in Cloud Shell or with `gcloud auth login` as a project Owner. Commands are idempotent-ish: a "create"
that already exists fails harmlessly; bindings are additive.

Identities at a glance:

| Identity | Used by | May | May NOT |
| --- | --- | --- | --- |
| `kamutan-worker@` | Cloud Run `kamutan-worker` runtime | read/write objects under `orgs/` (except any `orgs/*/quarantine/`), read/write Firestore | list the bucket, touch quarantine, publish, read secrets, act as another SA |
| `kamutan-pubsub-push@` | Pub/Sub push subscription (OIDC token) | invoke `kamutan-worker` | anything else |
| `kamutan-api@` | Cloud Functions `api`, `apiJobs`, `reprocessDependents` runtime | Firestore, objects under `orgs/`, publish to `ingest` and `api-jobs` only, read `UPLOAD_TOKEN_SECRET` only, sign its own V4 URLs, revoke Firebase Auth refresh tokens (custom role `kamutanAuthRevoke`), invoke `apiJobs` (Eventarc trigger identity) | list the bucket, other topics/secrets, create/delete Auth users, deploy |
| `kamutan-purge@` | Cloud Run job `kamutan-offboard-purge` (SEC-52) | Firestore, list + delete objects in the bucket | publish, secrets, Auth, act as another SA |
| `kamutan-scheduler@` | Cloud Scheduler → run the purge job | `run.jobs.run` on that one job | anything else |
| `kamutan-deploy@` | GitHub Actions via Workload Identity Federation (no key) | deploy rules/indexes/hosting/functions (incl. the scheduled one), deploy the worker revision, update the purge job image | read data, change IAM, act as SAs other than the runtime SAs |

## 0. Variables, APIs, bucket hardening

```bash
PROJECT=kamutan-fba67
REGION=europe-west1
BUCKET=kamutan-fba67.firebasestorage.app
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
REPO=leonoah/kamutan
WORKER_SA=kamutan-worker@$PROJECT.iam.gserviceaccount.com
PUSH_SA=kamutan-pubsub-push@$PROJECT.iam.gserviceaccount.com
PURGE_SA=kamutan-purge@$PROJECT.iam.gserviceaccount.com
SCHED_SA=kamutan-scheduler@$PROJECT.iam.gserviceaccount.com
API_SA=kamutan-api@$PROJECT.iam.gserviceaccount.com
DEPLOY_SA=kamutan-deploy@$PROJECT.iam.gserviceaccount.com
PUBSUB_AGENT=service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com
gcloud config set project "$PROJECT"

gcloud services enable run.googleapis.com pubsub.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com cloudfunctions.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com firebaserules.googleapis.com firebasehosting.googleapis.com \
  billingbudgets.googleapis.com policytroubleshooter.googleapis.com \
  eventarc.googleapis.com cloudscheduler.googleapis.com identitytoolkit.googleapis.com

# SEC-19: no ACLs, no public access, ever. (Firebase Storage rules, download tokens and V4 signed URLs keep working.)
gcloud storage buckets update "gs://$BUCKET" --uniform-bucket-level-access --public-access-prevention

# Service accounts (no keys are ever created for them).
gcloud iam service-accounts create kamutan-worker      --display-name="Kamutan drawing worker (Cloud Run)"
gcloud iam service-accounts create kamutan-pubsub-push --display-name="Pub/Sub push -> kamutan-worker (OIDC)"
gcloud iam service-accounts create kamutan-api         --display-name="Kamutan API (Cloud Functions gen2)"
gcloud iam service-accounts create kamutan-deploy      --display-name="GitHub Actions deploy (WIF)"
gcloud iam service-accounts create kamutan-purge       --display-name="Kamutan offboarding purge (Cloud Run job)"
gcloud iam service-accounts create kamutan-scheduler   --display-name="Cloud Scheduler -> kamutan-offboard-purge"
```

Shared IAM Condition for object access (bucket-level binding): objects under `orgs/`, but **not** in any
org's quarantine (`orgs/{org}/quarantine/...`, packages/contracts `storagePaths.quarantine`):

```bash
OBJ="projects/_/buckets/$BUCKET/objects/"
ORGS_NOT_QUARANTINE="resource.name.startsWith(\"${OBJ}orgs/\") && resource.name.extract(\"${OBJ}orgs/{org}/quarantine/\") == \"\""
ORGS_ANY="resource.name.startsWith(\"${OBJ}orgs/\")"
```

Notes on conditions:
- A prefix condition never matches `storage.objects.list` (list is evaluated on the bucket), so these SAs
  **cannot list** — by design. The worker and API address objects by deterministic paths (contracts
  `storagePaths`), overwrite on retry and never enumerate. If a future cleanup job needs listing, give *that*
  job its own SA.
- Overwriting an object needs `create` **and** `delete`; `roles/storage.objectAdmin` has both. A stricter
  alternative is a custom role with exactly `storage.objects.{get,create,delete}` (see §6).
- IAM cannot scope per org (one SA serves all tenants). Per-org isolation for the service identities is
  enforced in code: every job carries `orgId`; the worker rejects a job whose `storagePath` does not start
  with `orgs/{orgId}/projects/{projectId}/` and writes only under that sheet version's artifact prefix
  (`service/contracts.py`, tested); the API derives `orgId` from the caller's membership, never from input.

## 1. Worker — `kamutan-worker@` (Cloud Run runtime)

```bash
# Storage: object admin on orgs/** minus quarantine (reads the verified upload, writes artifacts).
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$WORKER_SA" --role=roles/storage.objectAdmin \
  --condition="expression=$ORGS_NOT_QUARANTINE,title=worker-orgs-prefix,description=objects under orgs/ except quarantine"

# Firestore: read/write documents (jobs/*, sheets/*, versions/*). Firestore IAM has no per-path scoping;
# the Admin SDK bypasses Security Rules, so path discipline is enforced in the worker (see above).
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$WORKER_SA" --role=roles/datastore.user --condition=None
```

Pub/Sub: with a **push** subscription the worker needs **no** Pub/Sub role at all (Pub/Sub calls it). Only if
the worker is ever switched to *pull*, grant subscriber on its one subscription — never at project level:

```bash
# ONLY for a pull-based worker (not the current design):
gcloud pubsub subscriptions add-iam-policy-binding ingest-worker-push \
  --member="serviceAccount:$WORKER_SA" --role=roles/pubsub.subscriber
```

Deploy settings for the service (the deploy job runs this; values that matter for security):

```bash
gcloud run deploy kamutan-worker --region="$REGION" \
  --image="$REGION-docker.pkg.dev/$PROJECT/kamutan/worker-drawing@sha256:<digest>" \
  --service-account="$WORKER_SA" \
  --no-allow-unauthenticated \
  --ingress=internal \
  --cpu=2 --memory=4Gi --concurrency=1 --timeout=900 --max-instances=5 \
  --no-cpu-throttling \
  --set-env-vars=KAMUTAN_BUCKET=$BUCKET,GOOGLE_CLOUD_PROJECT=$PROJECT
#  --ingress=internal: Pub/Sub push from the same project counts as internal traffic; the public internet cannot reach it.
#  No secrets in the environment (SEC-17/24): the worker authenticates with its runtime SA via the metadata server.
#  The parser sandbox (SEC-17) runs inside the container: child process, rlimits, scrubbed env, no network namespace.
```

## 2. Pub/Sub — topic, push subscription with OIDC, DLQ, max delivery attempts

```bash
gcloud pubsub topics create ingest     --message-retention-duration=7d
gcloud pubsub topics create ingest-dlq --message-retention-duration=14d
# Keep dead letters inspectable (otherwise a topic without subscriptions drops them).
gcloud pubsub subscriptions create ingest-dlq-hold --topic=ingest-dlq \
  --message-retention-duration=14d --expiration-period=never --ack-deadline=60

WORKER_URL=$(gcloud run services describe kamutan-worker --region="$REGION" --format='value(status.url)')

# Push identity may invoke ONLY the worker service.
gcloud run services add-iam-policy-binding kamutan-worker --region="$REGION" \
  --member="serviceAccount:$PUSH_SA" --role=roles/run.invoker

# Pub/Sub's service agent mints the OIDC token for the push SA (needed on projects created before 2021-04-08; harmless otherwise).
gcloud iam service-accounts add-iam-policy-binding "$PUSH_SA" \
  --member="serviceAccount:$PUBSUB_AGENT" --role=roles/iam.serviceAccountTokenCreator

gcloud pubsub subscriptions create ingest-worker-push --topic=ingest \
  --push-endpoint="$WORKER_URL/pubsub/ingest" \
  --push-auth-service-account="$PUSH_SA" \
  --push-auth-token-audience="$WORKER_URL" \
  --ack-deadline=600 \
  --min-retry-delay=10s --max-retry-delay=600s \
  --dead-letter-topic=ingest-dlq --max-delivery-attempts=5 \
  --message-retention-duration=7d --expiration-period=never

# Dead-lettering permissions for the Pub/Sub service agent (forward to DLQ + ack the original).
gcloud pubsub topics add-iam-policy-binding ingest-dlq \
  --member="serviceAccount:$PUBSUB_AGENT" --role=roles/pubsub.publisher
gcloud pubsub subscriptions add-iam-policy-binding ingest-worker-push \
  --member="serviceAccount:$PUBSUB_AGENT" --role=roles/pubsub.subscriber
```

Semantics (matches `workers/drawing/src/kamutan_drawing/service/app.py`): permanent errors → `200 rejected`
(acked, job `failed`); transient → `5xx`, redelivered with backoff up to 5 attempts, then `ingest-dlq`.
Alert on `subscription/dead_letter_message_count > 0` for `ingest-worker-push` (Cloud Monitoring).

### 2b. Topic `api-jobs` (Sprint 5: the API's own background jobs → function `apiJobs`)

The topic carries `offboarding.export` jobs (contracts `TOPICS.apiJobs`). `firebase deploy` would create it on the
first deploy of `apiJobs`, but creating it here keeps topic creation out of the deploy SA's rights.
Delivery: Eventarc push subscription created by the function deploy; the function has `retry: false` (a failed export
is marked `failed` and requested again), so no DLQ is needed.

```bash
gcloud pubsub topics create api-jobs --message-retention-duration=1d
```

## 3. API — `kamutan-api@` (Cloud Functions gen2 runtime)

The function must run as this SA, not the default compute SA (which has Editor on older projects):
**API owner action:** add `serviceAccount: 'kamutan-api@kamutan-fba67.iam.gserviceaccount.com'` to the
`onRequest({...})` options in `apps/api/src/function.ts`.

```bash
# Firestore (all API writes go through firebase-admin; rules do not apply to it).
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$API_SA" --role=roles/datastore.user --condition=None

# Storage: orgs/** INCLUDING quarantine (verify magic bytes + sha256, move to projects/{p}/uploads/, delete quarantine).
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$API_SA" --role=roles/storage.objectAdmin \
  --condition="expression=$ORGS_ANY,title=api-orgs-prefix,description=objects under orgs/ only"

# V4 signed URLs without a key file: the Admin SDK calls iamcredentials signBlob AS ITSELF.
# Bound on the SA resource (not the project), so it can only sign as kamutan-api.
gcloud iam service-accounts add-iam-policy-binding "$API_SA" \
  --member="serviceAccount:$API_SA" --role=roles/iam.serviceAccountTokenCreator

# Publish ingest jobs — this topic only.
gcloud pubsub topics add-iam-policy-binding ingest \
  --member="serviceAccount:$API_SA" --role=roles/pubsub.publisher

# Its one secret only.
gcloud secrets add-iam-policy-binding UPLOAD_TOKEN_SECRET \
  --member="serviceAccount:$API_SA" --role=roles/secretmanager.secretAccessor
```

Sprint 5 additions (functions `apiJobs` + `reprocessDependents`, offboarding):

```bash
# Publish the API's own background jobs (offboarding export) — this topic only.
gcloud pubsub topics add-iam-policy-binding api-jobs \
  --member="serviceAccount:$API_SA" --role=roles/pubsub.publisher

# SEC-52: offboarding revokes every member's refresh tokens (admin.auth().revokeRefreshTokens = accounts:update).
# Custom role instead of roles/firebaseauth.admin: no create/delete users, no config changes.
gcloud iam roles create kamutanAuthRevoke --project="$PROJECT" --title="Kamutan revoke Auth sessions" \
  --description="revokeRefreshTokens for offboarding (SEC-52)" \
  --permissions=firebaseauth.users.get,firebaseauth.users.update --stage=GA
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$API_SA" \
  --role="projects/$PROJECT/roles/kamutanAuthRevoke" --condition=None

# After the first deploy of the functions: the Eventarc trigger of `apiJobs` and the Cloud Scheduler job of
# `reprocessDependents` push AS the function's runtime SA, which must be allowed to invoke those two services
# (Cloud Run service names are the lower-cased function ids).
for SVC in apijobs reprocessdependents; do
  gcloud run services add-iam-policy-binding "$SVC" --region="$REGION" \
    --member="serviceAccount:$API_SA" --role=roles/run.invoker
done
# Pub/Sub may mint OIDC tokens for the trigger identity (projects created before 2021-04-08; harmless otherwise).
gcloud iam service-accounts add-iam-policy-binding "$API_SA" \
  --member="serviceAccount:$PUBSUB_AGENT" --role=roles/iam.serviceAccountTokenCreator
```

**API owner action (request R-A8, `docs/security/sprint-5-requests.md`):** `serviceAccount: kamutan-api@…` must be set
on **all three** exports in `function.ts` (`api`, `apiJobs`, `reprocessDependents`), e.g. once via
`setGlobalOptions({ serviceAccount })`; otherwise they run as the default compute SA and none of the bindings above
apply. Verify after deploy:
`gcloud functions describe <fn> --gen2 --region=$REGION --format='value(serviceConfig.serviceAccountEmail)'`.

## 3b. Offboarding purge — Cloud Run job `kamutan-offboard-purge` (SEC-52 steps 3–5), daily

Hard-deletes orgs whose `status == offboarding` and `deleteAfter <= now` (`apps/api/src/scripts/offboard-purge.ts`,
image `infra/docker/api-jobs.Dockerfile`). It needs to **list** `orgs/{org}/` (the API SA cannot list by design), so
it gets its own identity. Created once here; CI only updates the image (`_deploy-env.yml`). Runbook:
`docs/runbooks/offboarding-purge.md`.

```bash
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$PURGE_SA" --role=roles/datastore.user --condition=None
# Unconditioned on purpose: list is a bucket-level permission (prefix conditions never match it).
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$PURGE_SA" --role=roles/storage.objectAdmin

# First image: push one manually or let a deploy run once (the job step warns until the job exists), then:
IMAGE="$REGION-docker.pkg.dev/$PROJECT/kamutan/api-jobs@sha256:<digest from the deploy summary>"
gcloud run jobs create kamutan-offboard-purge --region="$REGION" --image="$IMAGE" \
  --service-account="$PURGE_SA" --tasks=1 --max-retries=1 --task-timeout=3600s --memory=1Gi --cpu=1 \
  --set-env-vars=NODE_ENV=production,GOOGLE_CLOUD_PROJECT=$PROJECT,FIREBASE_STORAGE_BUCKET=$BUCKET,LOG_LEVEL=info

# Daily trigger 03:07 UTC (after the 01:30 Firestore export, so the last export before deletion holds the org).
gcloud run jobs add-iam-policy-binding kamutan-offboard-purge --region="$REGION" \
  --member="serviceAccount:$SCHED_SA" --role=roles/run.invoker
gcloud scheduler jobs create http kamutan-offboard-purge-daily --location="$REGION" \
  --schedule="7 3 * * *" --time-zone=Etc/UTC --attempt-deadline=180s \
  --uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/kamutan-offboard-purge:run" \
  --http-method=POST --oauth-service-account-email="$SCHED_SA" \
  --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform
```

(`roles/run.invoker` on a job includes `run.jobs.run`; `run.jobs.runWithOverrides` — needed for `--args` — is not
granted to the scheduler, so it can only start the default, full purge.)


Firebase ID-token verification needs no IAM (public keys). Since Sprint 5 the API revokes refresh tokens on
offboarding (custom role `kamutanAuthRevoke`, §3), never `roles/firebaseauth.admin`. Signed URL TTLs: tiles 15 min (brief) — SEC-20 asks 5 min; reconcile in the API (owner decision).

## 3d. Bucket CORS (signed-URL reads from the browser)

The viewer fetches tiles / thumbnails / overlays with `fetch()` from `https://storage.googleapis.com/<bucket>/…` using
the API's V4 signed URLs. A browser blocks those responses unless the bucket answers with
`Access-Control-Allow-Origin` for the web origin (Firebase Hosting does not do this for you). Symptom without it:
`has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header` on every tile, viewer stays blank.
Uploads (Firebase SDK, `firebasestorage.googleapis.com`) are not affected.

```bash
gcloud storage buckets update "gs://$BUCKET" --cors-file=infra/storage-cors.json
gcloud storage buckets describe "gs://$BUCKET" --format="default(cors_config)"
```

`infra/storage-cors.json` lists the staging origins (`<project>.web.app`, `<project>.firebaseapp.com`). Add the custom
domain(s) there when one is attached, and use the production project's own origins for the production bucket.

## 3c. Direct invocation of `api` and the client-IP chain (Sprint-5 gate F-2)

**Proxy chain** (what `TRUST_PROXY_HOPS=2`, the API default, assumes):

```
browser ──► Firebase Hosting edge ──► Google Front End ──► Cloud Functions gen2 / Cloud Run `api` (Express)
             appends <client IP>        appends <Hosting edge IP>
X-Forwarded-For seen by Express:  [anything the client sent…], <client IP>, <Hosting edge IP>
req.ip = 2nd entry from the right = <client IP>   (entries the client prepended are ignored)
```

Direct call to the function's own URL (`https://api-<hash>-ew.a.run.app`, `https://europe-west1-<project>.cloudfunctions.net/api`):
`[client value], <client IP>` → with 2 trusted hops `req.ip` = the **client-chosen** value. So a caller who bypasses
Hosting can still pick the IP used for the share rate limit / unknown-token lockout and the `share.view` `ipPrefix`.
(Token guessing stays infeasible — 256-bit tokens; the per-token limit and the `share-bruteforce` alert, which counts
404/410/429 regardless of IP, still apply.)

**Why not simply restrict ingress / invoker:** Firebase Hosting rewrites reach the function over Google's public path
without an identity token. Our understanding (not verifiable from the dev sandbox — test on staging, below) is that
Hosting rewrites need the function to keep **ingress `all`** and the **`allUsers` invoker** (`invoker: 'public'` in
`function.ts`): `ALLOW_INTERNAL_AND_GCLB` ingress or an IAM-only invoker would make every `/api/**` request through
Hosting fail with 403/404. Note also that the ingress of a 2nd-gen function is part of the code
(`onRequest({ ingressSettings })` in `apps/api/src/function.ts`): a manual `gcloud run services update --ingress` would
be reverted by the next `firebase deploy`, so the setting belongs to the API agent (request R-A10).

Staging experiment (Owner, 10 min) — decides between options A and B:

```bash
gcloud run services update api --region=$REGION --ingress=internal-and-cloud-load-balancing   # staging project!
curl -s -o /dev/null -w '%{http_code}\n' https://<staging>.web.app/api/v1/health   # via Hosting
curl -s -o /dev/null -w '%{http_code}\n' "$(gcloud run services describe api --region=$REGION --format='value(status.url)')/api/v1/health"   # direct
gcloud run services update api --region=$REGION --ingress=all                                   # revert
```

- **A — Hosting still works (200 via Hosting, 404/403 direct):** API sets `ingressSettings: 'ALLOW_INTERNAL_AND_GCLB'`
  on `api` in `function.ts` (R-A10); F-2 residual closed; `TRUST_PROXY_HOPS=2` stays correct.
- **B — Hosting fails (expected):** keep ingress `all` for beta and accept the residual with the compensating controls
  above (per-token limit, IP-independent `share-bruteforce` alert, request R-A10 for a global unknown-token circuit
  breaker that does not depend on the client IP). Post-beta hardening: an external Application Load Balancer
  (serverless NEG → `api`, Cloud Armor rate-limit + preconfigured WAF rules) on the custom domain's `/api/*`, with the
  function's ingress `internal-and-cloud-load-balancing`; Hosting keeps serving the SPA and `/api/**` is routed by the
  LB instead of a Hosting rewrite. The external ALB appends `<client IP>, <LB IP>` to X-Forwarded-For, so
  `TRUST_PROXY_HOPS=2` stays right — confirm by logging one request's XFF on staging before relying on it
  (≈ USD 20/month + Cloud Armor).

`_deploy-env.yml` reports after every deploy whether the function's own URL answers directly ("F-2 direct invocation"
notice in the run summary), so the state is visible per environment.

## 4. Deploy — `kamutan-deploy@` via Workload Identity Federation (GitHub OIDC, no keys)

```bash
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc github-oidc --location=global \
  --workload-identity-pool=github --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.environment=assertion.environment,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == '$REPO' && assertion.environment in ['staging', 'production']"

POOL=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github
# Only jobs that run in the protected `production`/`staging` GitHub Environments (required reviewer) can impersonate.
for ENV in staging production; do
  gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/$POOL/attribute.environment/$ENV"
done

# What `firebase deploy --only firestore:rules,firestore:indexes,storage,functions:api,hosting` needs:
for ROLE in roles/firebaserules.admin roles/datastore.indexAdmin roles/firebasehosting.admin \
            roles/cloudfunctions.developer roles/serviceusage.serviceUsageConsumer roles/firebase.viewer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" --role="$ROLE" --condition=None
done
# Functions gen2 builds with Cloud Build and deploys a Cloud Run service that runs AS kamutan-api:
gcloud iam service-accounts add-iam-policy-binding "$API_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser
gcloud secrets add-iam-policy-binding UPLOAD_TOKEN_SECRET \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/secretmanager.viewer

# Sprint 5 functions: `reprocessDependents` (onSchedule) makes firebase deploy create/update a Cloud Scheduler job,
# `apiJobs` (onMessagePublished) checks the existing `api-jobs` topic (§2b) and creates an Eventarc trigger.
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" \
  --role=roles/cloudscheduler.admin --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" \
  --role=roles/pubsub.viewer --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOY_SA" \
  --role=roles/eventarc.developer --condition=None

# Worker image + revision (resource-scoped):
gcloud artifacts repositories create kamutan --repository-format=docker --location="$REGION" \
  --description="Kamutan images (deploy by digest)"
gcloud artifacts repositories add-iam-policy-binding kamutan --location="$REGION" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/artifactregistry.writer
gcloud run services add-iam-policy-binding kamutan-worker --region="$REGION" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/run.developer
gcloud iam service-accounts add-iam-policy-binding "$WORKER_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser
# Purge job image updates (§3b; run after the job exists). jobs update keeps the job's SA, but still needs actAs.
gcloud run jobs add-iam-policy-binding kamutan-offboard-purge --region="$REGION" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/run.developer
gcloud iam service-accounts add-iam-policy-binding "$PURGE_SA" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/iam.serviceAccountUser
```

GitHub side (Environment **variables**, not secrets — already referenced by `deploy.yml`):
`GCP_WORKLOAD_IDENTITY_PROVIDER = projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-oidc`,
`GCP_DEPLOY_SERVICE_ACCOUNT = kamutan-deploy@kamutan-fba67.iam.gserviceaccount.com`, on both `staging` and
`production` Environments with required reviewer `@leonoah`. Deploy jobs keep `id-token: write` only.

The implementation lives in `.github/workflows/_deploy-env.yml` (called by `deploy.yml` for both environments).
Besides the two variables above it reads these **Environment variables** (all non-secret):

| Variable | Needed | Meaning |
| --- | --- | --- |
| `GCP_PROJECT_ID` | yes | Firebase/GCP project of that environment (staging and production are separate projects, SEC-25). |
| `GCP_REGION` | no | Default `europe-west1`. |
| `GCP_STORAGE_BUCKET` | no | Default `<project>.firebasestorage.app`. |
| `VITE_FIREBASE_API_KEY`, `_AUTH_DOMAIN`, `_PROJECT_ID`, `_STORAGE_BUCKET`, `_MESSAGING_SENDER_ID`, `_APP_ID`, `_MEASUREMENT_ID` | for every project except the one in `apps/web/.env.firebase` | Public web config of that environment's project. The job fails if the web config's project differs from `GCP_PROJECT_ID`, so a staging deploy can never ship a bundle that talks to production. |
| `GCP_FIRESTORE_BACKUP_BUCKET` | no (production) | Bucket for the pre-deploy `gcloud firestore export`. Also grant `roles/datastore.importExportAdmin` on the project and `roles/storage.objectAdmin` on that bucket to `$DEPLOY_SA`; without the variable production deploys with a warning and no backup. |

The deploy job only **updates** `kamutan-worker` (`gcloud run services update --image …@sha256:…`); it fails with a clear
message when the service does not exist yet, so CI can never create an unauthenticated service.

Caveats: the first `firebase deploy` from CI may report one more missing permission (firebase-tools checks
vary by version); add exactly that permission, never `roles/editor` / `roles/firebase.admin`. The very first
`gcloud run deploy kamutan-worker` (service does not exist yet) needs `run.services.create` at project level —
run it once by hand as Owner, then CI only updates it. SEC-25 wants separate staging/prod projects: repeat
§0–§4 per project with that project's id.

## 5. Budget alert (ADR 0008: Blaze requires one)

```bash
BILLING=$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')
gcloud billing budgets create --billing-account="$BILLING" \
  --display-name="kamutan-fba67 monthly" \
  --budget-amount=100USD \
  --filter-projects="projects/$PROJECT" \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 --threshold-rule=percent=1.0,basis=forecasted-spend
# E-mails go to Billing Account Administrators/Users. Budgets alert only; they do not cap spend.
# Hard stops: Cloud Run --max-instances (above), Functions maxInstances, Pub/Sub max delivery attempts.
```

Benchmark dataset for CI (`KAMUTAN_DATA_URL` / `KAMUTAN_DATA_KEY`, nightly.yml): store an `age`-encrypted
tarball in a **separate private bucket** with no IAM for any runtime SA; the owner mints a short-lived signed URL
(`gcloud storage sign-url --duration=7d ...` with an impersonated SA) and rotates it. Only after written consent
and anonymisation (SEC-54).

## 6. Optional hardening

```bash
# Stricter than objectAdmin for the worker: exactly get/create/delete (no update of ACL/metadata, no IAM getters).
gcloud iam roles create kamutanWorkerObjects --project="$PROJECT" --title="Kamutan worker objects" \
  --permissions=storage.objects.get,storage.objects.create,storage.objects.delete --stage=GA
# then bind projects/$PROJECT/roles/kamutanWorkerObjects instead of roles/storage.objectAdmin (same condition).

# Stop new default service accounts from getting Editor (org policy; needs an Organization):
#   constraints/iam.automaticIamGrantsForDefaultServiceAccounts = enforced
# Disallow SA key creation (SEC-49):
#   constraints/iam.disableServiceAccountKeyCreation = enforced
```

**Existing key file:** `/home/claude/kamutan-data/secrets/firebase-sa.json` (outside git) is a service-account key.
After the runtime SAs above are in place, delete that key in the console (IAM → Service Accounts → Keys) and
do not create new ones; nothing in CI or runtime should need it (ADC / WIF only).

## 7. Verify

```bash
gcloud storage buckets get-iam-policy "gs://$BUCKET" --format=json | jq '.bindings[] | select(.condition != null)'
gcloud projects get-iam-policy "$PROJECT" --flatten=bindings[].members \
  --filter="bindings.members:(kamutan-worker OR kamutan-api OR kamutan-deploy OR kamutan-pubsub-push OR kamutan-purge OR kamutan-scheduler)" \
  --format="table(bindings.role, bindings.members)"
# The worker must be DENIED on quarantine and ALLOWED on artifacts:
gcloud policy-intelligence troubleshoot-policy iam \
  "//storage.googleapis.com/projects/_/buckets/$BUCKET/objects/orgs/o1/quarantine/00000000-0000-4000-8000-000000000000" \
  --principal-email="$WORKER_SA" --permission=storage.objects.get
gcloud policy-intelligence troubleshoot-policy iam \
  "//storage.googleapis.com/projects/_/buckets/$BUCKET/objects/orgs/o1/projects/p1/sheets/s1/versions/v1/thumbnail.webp" \
  --principal-email="$WORKER_SA" --permission=storage.objects.create
gcloud pubsub subscriptions describe ingest-worker-push \
  --format="yaml(pushConfig, deadLetterPolicy, retryPolicy, ackDeadlineSeconds)"
# Sprint 5: all three functions run as kamutan-api (R-A8); the API may revoke sessions; purge job identity + schedule.
for FN in api apiJobs reprocessDependents; do
  gcloud functions describe "$FN" --gen2 --region="$REGION" --format='value(name,serviceConfig.serviceAccountEmail)'
done
gcloud policy-intelligence troubleshoot-policy iam "//cloudresourcemanager.googleapis.com/projects/$PROJECT" \
  --principal-email="$API_SA" --permission=firebaseauth.users.update
gcloud pubsub topics get-iam-policy api-jobs
gcloud run jobs describe kamutan-offboard-purge --region="$REGION" --format='value(template.template.serviceAccount)'
gcloud scheduler jobs describe kamutan-offboard-purge-daily --location="$REGION" --format='value(schedule,state)'
gcloud run jobs execute kamutan-offboard-purge --region="$REGION" --args=--dry-run --wait   # as Owner: lists due orgs only
```
