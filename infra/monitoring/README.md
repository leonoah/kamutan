# Monitoring & alerts (SEC-43)

`infra/monitoring/setup-alerts.sh` creates the log-based metrics and Cloud Monitoring alert policies below in one
project (run once per environment, as Owner, from Cloud Shell). `--dry-run` prints every command and every policy
JSON without touching anything (CI runs it in the `infra-scripts` job).

```bash
infra/monitoring/setup-alerts.sh --project kamutan-fba67 --notification-email security@<domain>
```

Log sources: API = Cloud Functions gen2 → Cloud Run service `api`, pino JSON (`jsonPayload.msg`,
`jsonPayload.res.statusCode`, `jsonPayload.req.path`, `uid`, `orgId`; headers and tokens redacted). Worker = Cloud Run
`kamutan-worker`, Python log lines (`textPayload`). Filters also match `jsonPayload.message` for when the worker moves
to structured logs (request R-W1 in `docs/security/sprint-5-requests.md`). Log retention: `_Default` bucket 90 days.

Thresholds are starting points for a beta with a handful of orgs; tune after two weeks of baseline traffic
(Metrics Explorer → `logging/user/kamutan_*`).

| Alert | Source (metric / filter) | Fires when | Severity |
| --- | --- | --- | --- |
| <a id="auth-failures"></a>Auth failure spike | `kamutan_api_401` | > 50 API 401s / 5 min | WARNING |
| <a id="guard-denials"></a>Guard denials | `kamutan_api_403` (role / MFA guard) | > 30 / 5 min | WARNING |
| <a id="tenant-probing"></a>Tenant probing | `kamutan_api_404_private` (non-members get 404, SEC-10) | > 100 / 10 min | WARNING |
| <a id="share-views"></a>Share-link views spike | `kamutan_share_views` (GET `/api/v1/public/share/…`) | > 300 / 10 min | WARNING |
| <a id="share-bruteforce"></a>Share-link brute force | `kamutan_share_throttled` (404/410/429 on public share) | > 50 / 10 min | WARNING |
| <a id="uploads"></a>Rejected uploads | `kamutan_upload_rejected` (magic bytes) | > 20 / 1 h | WARNING |
| <a id="sandbox"></a>Sandbox limit hits | `kamutan_sandbox_limits` (`parse_*` limit codes) | > 5 / 15 min | WARNING |
| Sandbox crash on signal | log match `failed: parse_crashed` / `sandbox child exited rc=-N` | any | ERROR |
| Worker container killed | log match Cloud Run OOM / terminated on signal | any | ERROR |
| <a id="llm-budget"></a>LLM budget exceeded | log match `llm_call … "status": "budget_exceeded"` | any (5-min rate limit) | WARNING |
| LLM cost (dashboard) | `kamutan_llm_cost_usd` distribution (from `costUsd`) | chart only; spend cap = provider limit + GCP budget (infra/IAM.md §5) | — |
| <a id="audit-chain"></a>Audit chain broken | log match `audit chain verification FAILED` (API, SEC-35) | any | CRITICAL |
| <a id="purge"></a>Offboarding purge failed | Cloud Run job `kamutan-offboard-purge` error / `offboard-purge failed`, or its Scheduler trigger failed | any | ERROR |
| <a id="background"></a>API background function errors | `apijobs` / `reprocessdependents` services, severity ≥ ERROR | any | WARNING |
| <a id="admin-changes"></a>IAM / key / rules change | Admin Activity audit log: `SetIamPolicy`, SA key/SA create, Security Rules release, bucket IAM — not by `kamutan-deploy@` | any | CRITICAL |
| Direct Firestore write | Data Access audit log, writer not in {`kamutan-api@`, `kamutan-worker@`, `kamutan-backup@`} | any | CRITICAL |

The last row covers both "admin role changed by hand" (there is no member-management endpoint yet, so any change
to `orgs/*/members/*` is a console / Admin SDK write) and SEC-43's "privileged key used outside the allow-list". It
needs Firestore **Data Access audit logs** (`DATA_WRITE`), off by default and billed per entry — enable once:

```bash
gcloud projects get-iam-policy kamutan-fba67 --format=yaml > /tmp/policy.yaml
# add under the top level (keep existing auditConfigs):
#   auditConfigs:
#   - service: firestore.googleapis.com
#     auditLogConfigs:
#     - logType: DATA_WRITE
gcloud projects set-iam-policy kamutan-fba67 /tmp/policy.yaml
```

Not covered here (owner / later):

- **Login failures at Firebase Auth** happen between the browser and `identitytoolkit.googleapis.com`; the API only
  sees bad or revoked tokens (the 401 alert). With an Identity Platform upgrade, enable its audit logs and add a log
  alert on `SignInWithPassword` errors. Firebase Auth has built-in sign-in throttling either way.
- **Infected file** (ClamAV, SEC-15): no scanner exists yet (Sprint-1 gate G3 open).
- **Sentry** (SEC-34/43) is not wired; these alerts use Cloud Logging only.
- **App-level audit events** (share link create/revoke, settings, offboarding) are Firestore documents, not logs.
  Request R-A2 asks the API to also emit a content-free `audit` log line so they can be alerted on.

## Response (short form — full process in docs/spec/06_security.md "תגובה לאירועים")

1. Open a private incident ticket, note the alert time and the policy name.
2. In Logs Explorer, open the policy's filter for ±30 min; group by `jsonPayload.uid`, `jsonPayload.orgId`, client IP
   (`httpRequest.remoteIp` in the Cloud Run request log).
3. Contain: revoke sessions (`auth.revokeRefreshTokens` via the admin script), revoke share links (API
   `DELETE /v1/projects/:pid/share-links/:id`), set the org `llmEnabled=false`, scale the worker to 0, block an IP with
   a Cloud Armor rule if needed.
4. Severity per 06_security: cross-tenant access, audit-chain break or sandbox escape → SEV1 (customers notified
   within 24 h); leaked share link / admin compromise → SEV2.
5. Close the alert only with a written cause; tune the threshold in `setup-alerts.sh` (not in the console) so the
   repo stays the source of truth.
