# Runbook — backup & restore drill (SEC-36, SEC-37, SEC-38)

Targets: **RPO 24 h, RTO 8 working hours** (SEC-36). Drill before the beta, then once a quarter, with the measured
times written down (SEC-38). Run by a human owner from Cloud Shell; agents never run it against production (SEC-53).

| What | Where |
| --- | --- |
| One-time backup setup (IaC as gcloud) | `infra/scripts/setup-backups.sh` |
| Drill script | `infra/scripts/restore-drill.sh` (`--dry-run` prints every command) |
| Drill records | `docs/runbooks/drills/YYYY-MM-DD.md` (copy of `results.md` + the human fields below; no customer data) |
| Alerts if backups stop | Cloud Scheduler job failure → Cloud Monitoring (see §5) |

## 1. What is backed up

| Data | Mechanism | Frequency / retention | Restores to |
| --- | --- | --- | --- |
| Firestore `(default)` (all orgs, members, projects, BOQ, corrections, share links, **auditLog**) | Firestore **scheduled backups** (managed, same region `eur3`) | daily, kept 4 weeks | new database in the same project (`gcloud firestore databases restore`) |
| Firestore `(default)` | **managed export** (Cloud Scheduler → `exportDocuments`) to `gs://<project>-firestore-backup-eu` in the **separate backup project** (SEC-36 "separate account"); 30-day retention policy, deleted at 31 days | daily 01:30 UTC | any project/database (`gcloud firestore import`) |
| Cloud Storage `orgs/**` (originals, derived artifacts, exports) | **object versioning** on the main bucket; noncurrent versions kept 30 days (max 5 per object) | continuous | same object (copy an old generation back) |
| Cloud Storage `orgs/**` | daily **Storage Transfer Service** mirror to `gs://<project>-storage-backup-eu` (backup project), versioned, noncurrent kept 30 days | daily | `gcloud storage rsync` back |
| Security Rules, indexes, hosting config, function/worker code | Git (`firebase/`, `firebase.json`, images by digest) | every commit | redeploy (`deploy.yml`) |
| Secrets (`UPLOAD_TOKEN_SECRET`, LLM key) | Secret Manager (versions) | — | rotate (runbook to be written, SEC-25) |

Deletion promise (SEC-51 / DPA): a deleted project or offboarded org disappears from live data within 30 days and from
every backup above within a further ≤ 31 days (4-week backups, 31-day exports, 30-day noncurrent versions).

## 2. One-time setup (owner)

```bash
# 0) A separate GCP project for backups (billing enabled), e.g. kamutan-backup-eu, and a scratch project for drills,
#    e.g. kamutan-drill (Firestore API enabled; no app deployed; delete its databases after each drill).
gcloud projects create kamutan-backup-eu && gcloud projects create kamutan-drill   # then link billing in the console
# 1) Review, then run for real:
infra/scripts/setup-backups.sh --project kamutan-fba67 --backup-project kamutan-backup-eu --dry-run
infra/scripts/setup-backups.sh --project kamutan-fba67 --backup-project kamutan-backup-eu
gcloud scheduler jobs run kamutan-firestore-export --project kamutan-fba67 --location europe-west1   # first export now
# 2) After the first successful drill, lock the export bucket's retention (irreversible):
gcloud storage buckets update gs://kamutan-fba67-firestore-backup-eu --lock-retention-period
```

Check before the first drill: `setup-backups.sh` **replaces** the main bucket's lifecycle rules — merge by hand if a
quarantine-TTL rule exists by then. If `gcloud firestore export` refuses the `EU` bucket location for the `eur3`
database, recreate the export bucket in the location the error names and rerun §3 of the script.

## 3. The drill (quarterly, ~1–2 h for MVP data volumes)

```bash
cd kamutan   # a checkout of main in Cloud Shell
infra/scripts/restore-drill.sh --project kamutan-fba67 --scratch-project kamutan-drill \
  --backup-bucket kamutan-fba67-firestore-backup-eu --storage-backup-bucket kamutan-fba67-storage-backup-eu \
  --out drill-$(date +%F)
# Alternate quarters: --mode backup (restores the newest scheduled backup into a new database in the prod project;
# nothing reads it, and the script deletes it at the end).
```

What the script does and records (`results.json` / `results.md`):

1. **Preflight** — active account, source database, versioning on the main bucket.
2. **Locate backup** — newest export folder (or scheduled backup) → `backup.takenAt`; **RPO measured** = drill start −
   backup time (check: ≤ 24 h).
3. **Source counts** — document counts per collection group (orgs, members, projects, sheetSets, sheets, versions,
   legendEntries, reviewItems, corrections, boqLines, boqBuilds, shareLinks, auditLog, jobs). Exact (stale read at the
   backup minute) when the backup is < 55 min old, otherwise today's counts with a 5 % tolerance.
4. **Restore** — export mode: new database `drill-<ts>` in the scratch project + `gcloud firestore import`; backup mode:
   `gcloud firestore databases restore`. Timed (core of the RTO).
5. **Verify** — the same counts on the restored database; non-empty `orgs`.
6. **Storage** — canary object under `_drill/<ts>/` in the main bucket: write v1, overwrite with v2, delete, restore
   generation v1, compare SHA-256, remove all versions. Then 5 random `orgs/**` objects compared (MD5) with the mirror.
7. **Report + cleanup** — writes the reports, deletes the restored database (asks first; `--keep` to inspect).

Then by hand (5–10 min), on the restored database (`--keep`):

- Open 2–3 known projects in the Firestore console of the scratch project: BOQ lines, corrections, share links present.
- **Audit chain**: run the API's chain verification against the restored data (needs R-A3 below) or spot-check that
  the newest `auditLog` documents' `prevHash` matches the previous document's `hash`.

## 4. Recording the result (fill in, commit as `docs/runbooks/drills/YYYY-MM-DD.md`)

| Field | Value |
| --- | --- |
| Date / operator | |
| Mode (export / backup) and backup reference | from `results.md` |
| RPO measured (backup age) | `measured.rpoSeconds` — pass if ≤ 86 400 s |
| Restore operation duration | `measured.restoreSeconds` |
| Verification (script + manual) | `measured.verifySeconds` + manual minutes |
| Estimated cut-over (redeploy API/worker to the restored DB, smoke test) | minutes (see §6) |
| **RTO estimate** = detection→decision (assume 60 min) + restore + verification + cut-over | pass if ≤ 8 h |
| Checks failed / follow-ups | |

Pre-beta drill: **not yet run** (needs the owner's GCP setup). The dry-run is exercised on every PR by the CI job
`infra-scripts`.

## 5. Monitoring the backups themselves

- Cloud Scheduler job `kamutan-firestore-export`: Monitoring → Alerting → create a policy on
  `cloudscheduler.googleapis.com/job/attempt_count` with `response_code != 200`, or a log-match alert on
  `resource.type="cloud_scheduler_job" AND severity>=ERROR` (add to `infra/monitoring/setup-alerts.sh` once the job
  exists).
- Weekly glance: `gcloud firestore backups list --location=eur3` shows a READY backup from the last 24 h;
  `gcloud storage ls gs://kamutan-fba67-firestore-backup-eu/ | tail -3` shows last night's folder.

## 6. Real recovery (not the drill)

Declare an incident first (06_security "תגובה לאירועים"); preserve evidence (export the damaged database before
changing anything: `gcloud firestore export gs://<backup-bucket>/forensic-$(date +%F)`).

**Firestore — whole database lost or corrupted.**
1. Pick the restore point (newest backup before the damage).
2. Restore into a **new** database: `gcloud firestore databases restore --source-backup=<name>
   --destination-database=recovered-<date>` (or `gcloud firestore databases create` + `gcloud firestore import <export>`).
3. Deploy the Security Rules and indexes to it (`firebase.json` `firestore` → list form with `"database"`).
4. Point the API and worker at it — **today they always use `(default)`**: either (a) delete `(default)` after the
   forensic export and restore into `(default)` (destructive; database ids can be reused only after the delete
   completes), or (b) once requests R-A3/R-W2 land, set `FIRESTORE_DATABASE_ID=recovered-<date>` and redeploy
   (preferred, reversible).
5. Smoke test (login, project list, BOQ, share link), then announce. Data written after the restore point is lost
   (≤ 24 h); tell affected orgs.

**Firestore — some documents** (bad migration, one org): import only the affected collection groups into a scratch
database (`gcloud firestore import <export> --collection-ids=boqLines,corrections`), then copy the documents back with
a reviewed one-off Admin-SDK script that writes an audit event.

**Cloud Storage — objects deleted or overwritten** (bug, compromised credential):
```bash
B=kamutan-fba67.firebasestorage.app
gcloud storage ls --all-versions "gs://$B/orgs/<org>/**" > versions.txt     # live + noncurrent generations
# for each object, copy the newest noncurrent generation that predates the incident back over the live name:
gcloud storage cp "gs://$B/<path>#<generation>" "gs://$B/<path>"
# whole prefix from the off-project mirror instead (versions in the mirror too):
gcloud storage rsync --recursive "gs://kamutan-fba67-storage-backup-eu/orgs/<org>" "gs://$B/orgs/<org>"
```
Derived artifacts (tiles, detections) can also be regenerated by reprocessing from the originals.

## 7. Open items

- Pre-beta drill to be run by the owner (needs §2). Record it in `docs/runbooks/drills/`.
- R-A3 / R-W2 (configurable Firestore database id) shorten the RTO and make recovery non-destructive.
- PITR (SEC-36 Should): `gcloud firestore databases update --database='(default)' --enable-pitr` lowers RPO to minutes
  (7-day window, extra cost) — recommended once paying customers exist.
