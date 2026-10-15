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
| `kamutan-api@` | Cloud Function `api` runtime | Firestore, objects under `orgs/`, publish to `ingest` only, read `UPLOAD_TOKEN_SECRET` only, sign its own V4 URLs | list the bucket, other topics/secrets, deploy |
| `kamutan-deploy@` | GitHub Actions via Workload Identity Federation (no key) | deploy rules/indexes/hosting/function, deploy the worker revision | read data, change IAM, act as SAs other than the two runtime SAs |

## 0. Variables, APIs, bucket hardening

```bash
PROJECT=kamutan-fba67
REGION=europe-west1
BUCKET=kamutan-fba67.firebasestorage.app
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
REPO=leonoah/kamutan
WORKER_SA=kamutan-worker@$PROJECT.iam.gserviceaccount.com
PUSH_SA=kamutan-pubsub-push@$PROJECT.iam.gserviceaccount.com
API_SA=kamutan-api@$PROJECT.iam.gserviceaccount.com
DEPLOY_SA=kamutan-deploy@$PROJECT.iam.gserviceaccount.com
PUBSUB_AGENT=service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com
gcloud config set project "$PROJECT"

gcloud services enable run.googleapis.com pubsub.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com cloudfunctions.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com firebaserules.googleapis.com firebasehosting.googleapis.com \
  billingbudgets.googleapis.com policytroubleshooter.googleapis.com

# SEC-19: no ACLs, no public access, ever. (Firebase Storage rules, download tokens and V4 signed URLs keep working.)
gcloud storage buckets update "gs://$BUCKET" --uniform-bucket-level-access --public-access-prevention

# Service accounts (no keys are ever created for them).
gcloud iam service-accounts create kamutan-worker      --display-name="Kamutan drawing worker (Cloud Run)"
gcloud iam service-accounts create kamutan-pubsub-push --display-name="Pub/Sub push -> kamutan-worker (OIDC)"
gcloud iam service-accounts create kamutan-api         --display-name="Kamutan API (Cloud Functions gen2)"
gcloud iam service-accounts create kamutan-deploy      --display-name="GitHub Actions deploy (WIF)"
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

Firebase ID-token verification needs no IAM (public keys). The API never needs `firebaseauth.admin` for
Sprint 1. Signed URL TTLs: tiles 15 min (brief) — SEC-20 asks 5 min; reconcile in the API (owner decision).

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

# Worker image + revision (resource-scoped):
gcloud artifacts repositories create kamutan --repository-format=docker --location="$REGION" \
  --description="Kamutan images (deploy by digest)"
gcloud artifacts repositories add-iam-policy-binding kamutan --location="$REGION" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/artifactregistry.writer
gcloud run services add-iam-policy-binding kamutan-worker --region="$REGION" \
  --member="serviceAccount:$DEPLOY_SA" --role=roles/run.developer
gcloud iam service-accounts add-iam-policy-binding "$WORKER_SA" \
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
  --filter="bindings.members:(kamutan-worker OR kamutan-api OR kamutan-deploy OR kamutan-pubsub-push)" \
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
```
