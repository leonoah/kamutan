# infra — NOTES (DevOps + Security, Sprint 0)

> **עדכון (ADR 0008, 11.10.2026):** הפלטפורמה עברה ל-Firebase + Cloud Run. החלקים על Railway, Supabase ו-Vercel
> בקובץ הזה (ובצ'קליסט למטה) היסטוריים בלבד. הפריסה והזהויות: `infra/IAM.md`, ‏`.github/workflows/deploy.yml`
> ו-`.github/workflows/_deploy-env.yml`.

## מה נבנה

| קובץ | תוכן |
| --- | --- |
| `.github/workflows/ci.yml` | CI על PR ו-push ל-main: `node` (pnpm 9 / Node 22, turbo lint/typecheck/test/build), `python` (matrix: `workers/drawing`, `benchmark` — ruff, ruff format, mypy, Bandit, pytest דרך uv), `db` (סוויטת RLS ב-vitest + PGlite), `secrets-scan` (gitleaks על כל ההיסטוריה), `semgrep` (p/owasp-top-ten, p/typescript, p/python, p/github-actions + `.semgrep.yml`), `osv` (osv-scanner על `pnpm-lock.yaml` ושני `uv.lock`), `docker` (build + Trivy, רק כשנתיבים רלוונטיים משתנים), `benchmark` (placeholder, רק כש-`workers/**`/`benchmark/**` משתנים, מדלג אם אין סודות `KAMUTAN_DATA_*`), ו-`ci-gate` — הבדיקה היחידה שמסמנים כ-required. |
| `.github/workflows/deploy.yml` | Stub: CI ירוק על main → staging; tag `v*` → staging → production; environments `staging`/`production` עם אישור ידני. בלי סודות inline; כל שלב מדלג אם הסוד לא מוגדר. |
| `.github/CODEOWNERS` | `@leonoah` על migrations, RLS/policies, `.github/`, `infra/`, auth/privileged/storage ב-API, `llm_gateway`, `sandbox`, `docs/adr/`, וקבצי האבטחה בשורש. |
| `.github/PULL_REQUEST_TEMPLATE.md` | צ'קליסט האבטחה מ-06_security (עברית). |
| `.github/dependabot.yml` | npm, uv (`workers/drawing`, `benchmark`), github-actions, docker — שבועי. |
| `.semgrep.yml` | חוקים מותאמים: `dangerouslySetInnerHTML`, service_role מחוץ ל-wrapper (API) ובכלל ב-worker, PyMuPDF אסור, LibreDWG בלי linking, SDK של LLM רק ב-`llm_gateway`, אין לוג של prompts, `shell=True`, `pull_request_target`. |
| `.gitleaks.toml` | ברירת המחדל של gitleaks + חוקים ל-service_role ו-Postgres URL עם סיסמה; allowlist ל-`.env.example`, lockfiles, סיסמת ברירת המחדל של Supabase מקומי. |
| `.pre-commit-config.yaml` | gitleaks, ruff, בדיקות YAML/JSON/TOML, מפתחות פרטיים, קבצים גדולים, **חסימת PDF/DWG/DXF/XLS** ו-`.env`, prettier --check. |
| `.editorconfig`, `SECURITY.md` | |
| `infra/docker/api.Dockerfile` | node:22-slim multi-stage, `pnpm deploy --prod`, משתמש `node`, healthcheck ל-`/v1/health`. משמש גם ל-export worker. |
| `infra/docker/worker-drawing.Dockerfile` | python:3.12-slim + tesseract-ocr(-heb,-eng), venv של uv בלי dev, uid 10001, tini, בדיקת heb/eng ב-build. |
| `infra/docker/*.Dockerfile.dockerignore` | ignore לכל Dockerfile (BuildKit), כולל חסימת PDF/DWG/DXF. |
| `infra/docker/docker-compose.dev.yml` | api + worker + redis (סיסמה, לא חשוף), read-only, cap_drop ALL, no-new-privileges; Supabase רץ בנפרד דרך `supabase start`. |
| `infra/railway/*.railway.json` | config-as-code ל-4 שירותים: `api`, `export-worker`, `worker-drawing-heavy`, `worker-drawing-light`. |
| `infra/github/BRANCH_PROTECTION.md` | הגדרות ריפו מדויקות ללחיצה. |
| `docs/adr/0001–0007` | ADRs (עברית, MADR מקוצר). |

## איך מריצים מקומית

```bash
# Lint ל-workflows (כולל shellcheck)
pipx install actionlint-py shellcheck-py   # או: uv tool install actionlint-py
actionlint .github/workflows/*.yml

# סודות
gitleaks git . --config .gitleaks.toml --redact
gitleaks dir . --config .gitleaks.toml --redact

# SAST
semgrep scan --config .semgrep.yml --config p/owasp-top-ten --config p/typescript --config p/python --error

# SCA
osv-scanner scan source -L pnpm-lock.yaml -L workers/drawing/uv.lock -L benchmark/uv.lock

# pre-commit
pre-commit install && pre-commit run --all-files

# Docker (מהשורש)
supabase start
docker compose -f infra/docker/docker-compose.dev.yml up --build
```

## צ'קליסט לבעלים — מה צריך להגדיר (לפי הסדר)

### 1. GitHub (`leonoah/kamutan`, פרטי)
- [ ] לוודא תוכנית שתומכת ב-branch protection בריפו פרטי (Pro ומעלה). ראו `infra/github/BRANCH_PROTECTION.md`.
- [ ] ליצור משתמש מכונה/App לסוכנים (`kamutan-bot`, Write, fine-grained PAT לריפו בלבד).
- [ ] Ruleset `main-protection` עם `ci-gate` כבדיקה חובה ו-Code Owners review.
- [ ] Actions: workflow permissions = read-only; לא לאפשר ל-Actions ליצור/לאשר PR.
- [ ] Environments: `staging`, `production` עם required reviewer `@leonoah`.
- [ ] Dependabot alerts + security updates.

### 2. GitHub secrets / variables

| שם | רמה | ערך |
| --- | --- | --- |
| `KAMUTAN_DATA_URL` | repository | URL למאגר benchmark מוצפן (אחרי הסכמה בכתב ואנונימיזציה, SEC-54). אופציונלי. |
| `KAMUTAN_DATA_KEY` | repository | מפתח `age` לפענוח המאגר. אופציונלי. |
| `SUPABASE_ACCESS_TOKEN` | environment (staging, production) | Personal access token של Supabase (Account → Access Tokens). עדיף טוקן נפרד לכל סביבה. |
| `SUPABASE_DB_PASSWORD` | environment | סיסמת ה-DB של הפרויקט המתאים. |
| `SUPABASE_PROJECT_REF` | environment **variable** | ref של הפרויקט (לא סוד). |
| `RAILWAY_TOKEN` | environment | **Project token** של Railway לסביבה המתאימה (לא account token). |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | environment `production` | רק אם מקדמים ל-production מה-workflow (ספרינט 5). אחרת Vercel Git integration. |

אף סוד לא נמסר לסוכנים (SEC-53). רוטציה כל 90 יום (SEC-25).

### 3. Supabase
- [ ] **שלושה פרויקטים נפרדים** (SEC-25): dev (אופציונלי — מקומי דרך CLI), `kamutan-staging`, `kamutan-prod`. אזור **eu-central-1 (Frankfurt)**, תוכנית Pro.
- [ ] Auth: Confirm email; סיסמה מינימום 10 + leaked password protection; MFA (TOTP) מופעל; CAPTCHA (Turnstile) בהרשמה ושחזור; JWT expiry ≤ 3600; refresh token rotation + reuse detection.
- [ ] Extensions: PostGIS, pgvector (המיגרציות יפעילו).
- [ ] ליצור את ה-role `kamutan_worker` (המיגרציה של צוות ה-DB) ולהגדיר לו סיסמה ידנית → `KAMUTAN_WORKER_DB_URL` ב-Railway (ADR-0003).
- [ ] Storage: כל ה-buckets פרטיים (SEC-19).
- [ ] Network restrictions / SSL enforcement: ✅ Enforce SSL.
- [ ] DPA עם Supabase.

### 4. Vercel (`apps/web`)
- [ ] New Project → Import `leonoah/kamutan`.
- [ ] **Root Directory:** `apps/web`. Framework: Vite. Install: `pnpm install --frozen-lockfile`. Build: `pnpm turbo run build --filter=@kamutan/web`. Output: `dist`. Node 22.
- [ ] ✅ "Include files outside the root directory in the Build Step" (monorepo, `packages/*`).
- [ ] Env (לכל סביבה): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (מפתח anon/publishable בלבד — **לעולם לא service_role**), `VITE_API_URL`, `VITE_SENTRY_DSN`, `VITE_POSTHOG_KEY` (EU host).
- [ ] Preview deployments: ✅ Vercel Authentication (Deployment Protection) כדי שה-previews לא יהיו ציבוריים.
- [ ] כותרות CSP ב-Report-Only (SEC-40) — דרך `vercel.json` של צוות ה-web.

### 5. Railway (EU West)
- [ ] פרויקט `kamutan`, environments: `staging`, `production`.
- [ ] שירותים, כל אחד עם **Settings → Config-as-code path**:
  - `api` → `infra/railway/api.railway.json` (Public networking: כן, דומיין API)
  - `export-worker` → `infra/railway/export-worker.railway.json` (בלי public networking)
  - `worker-drawing-heavy` → `infra/railway/worker-drawing-heavy.railway.json` (2 vCPU / 4GB, `KAMUTAN_WORKER_POOL=cpu-heavy`, בלי public networking)
  - `worker-drawing-light` → `infra/railway/worker-drawing-light.railway.json` (`KAMUTAN_WORKER_POOL=cpu-light`, בלי public networking)
  - `redis` → Railway Redis template, **Private networking בלבד**, עם סיסמה (SEC-21).
- [ ] Region: EU West לכל השירותים (Settings → Region).
- [ ] Variables לכל שירות (לפי `apps/api/.env.example` ו-`workers/drawing/README.md`): `DATABASE_URL` (sslmode=require), `SUPABASE_URL`, `SUPABASE_JWT_SECRET`/JWKS, `REDIS_URL` (private), `UPLOAD_TOKEN_SECRET`, `SENTRY_DSN`; ל-worker: `KAMUTAN_WORKER_DB_URL` (role ייעודי), `REDIS_URL`, `KAMUTAN_LLM_ENABLED=false` עד DPA. `SUPABASE_SERVICE_ROLE_KEY` **רק** ב-`api`/`export-worker` ולא ב-workers.
- [ ] Project token לכל environment → `RAILWAY_TOKEN` ב-GitHub environment המתאים.

### 6. Sentry (EU data region)
- [ ] ארגון ב-**EU (de.sentry.io)**. פרויקטים: `kamutan-web`, `kamutan-api`, `kamutan-worker`.
- [ ] DSN לכל פרויקט → Vercel (`VITE_SENTRY_DSN`) ו-Railway (`SENTRY_DSN`).
- [ ] Data scrubbing: ✅ Data Scrubber, ✅ Scrub IP addresses; בקוד `sendDefaultPii=false` + `beforeSend` (SEC-34).
- [ ] התראות SEC-43 (שגיאות חדשות, DLQ, חריגות sandbox).
- [ ] DPA עם Sentry.

### 7. אחר (לפני ספרינט 2 / בטא)
- [ ] AWS Bedrock eu-central-1 (Claude) עם IAM user/role מוגבל ל-`bedrock:InvokeModel` באזור אחד + DPA (ADR-0007).
- [ ] PostHog EU Cloud, Grafana Cloud (EU).
- [ ] דומיין + `/.well-known/security.txt` עם כתובת אבטחה (SECURITY.md).
- [ ] חשבון ענן נפרד לגיבוי `pg_dump` מוצפן (SEC-36).
- [ ] החלטה משפטית על LibreDWG/ODA (ADR-0002).

## פערים ידועים / TODO

- **Actions מקובעות לפי major tag**, לא SHA (SEC-48). להחליף ל-SHA בספרינט 1 ולהפעיל "Require actions to be pinned".
- **Base images לפי tag**, לא digest (SEC-46). Dependabot docker מוגדר.
- **לא נבנו images מקומית:** אין גישה ל-Docker Hub/GHCR מסביבת הפיתוח. ה-Dockerfiles עברו hadolint נקי וה-compose עבר `docker compose config`; build אמיתי ירוץ ב-job `docker` ב-CI.
- `worker-drawing.Dockerfile` מריץ `python -m kamutan_drawing` — ה-entrypoint (`__main__.py`) עדיין לא קיים בחבילה (צוות ה-worker). בדיקת ה-build (`import kamutan_drawing, pypdfium2`) לא תלויה בו.
- `workers/drawing/.python-version` הוא 3.13 אבל ה-image הוא 3.12 (לפי הבריף); ה-Dockerfile קובע `UV_PYTHON=python3.12` (`requires-python >=3.12` מאפשר). `benchmark` דורש 3.13 ולכן לא נארז ב-image.
- LibreDWG עדיין לא ב-image (ספרינט 1, ADR-0002).
- sandbox לפענוח (nsjail / `unshare -n`) — ספרינט 1 (SEC-17). `util-linux` (unshare) כבר ב-image; ב-Railway לא מובטחות הרשאות ל-namespaces — לבדוק בספייק.
- job ה-benchmark הוא placeholder (הורדה/פענוח של המאגר ו-`kbench run` מסומנים TODO).
- `prettier` לא נמצא ב-devDependencies של השורש — ה-hook `prettier-check` ייכשל עד שיתווסף (קובץ של המתזמר).
- osv.dev ו-semgrep.dev חסומים מסביבת הסוכנים; osv-scanner אומת שהוא מפענח את שלושת ה-lockfiles (669 + 17 + 19 חבילות) אבל השאילתה ל-osv.dev נחסמה; חוקי ה-registry של Semgrep ירוצו רק ב-CI.
- Trivy ב-CI חוסם על Critical/High שיש להם תיקון; SBOM (Syft) — ב-deploy, ספרינט 1.

---

## Sprint 5 — readiness (DevOps/Security)

| קובץ | תוכן |
| --- | --- |
| `firebase.json` | CSP **enforce** (אפליקציה + מדיניות קשוחה יותר ל-`/s/**`), Report-Only למועמדת קשוחה יותר, HSTS שנתיים, `Permissions-Policy`, `Referrer-Policy`, `X-Robots-Tag` + `no-store` ל-`/s/**`, `no-cache` לנתיבי SPA, CSP גם על `/assets/**`, בלי כפילויות מפתחות בין בלוקים, `**/*.map` לא נפרסים, `.well-known/` נפרס (רשימת dotfiles מפורשת ב-`hosting.ignore` במקום `**/.*`). פירוט: `docs/security/csp.md`. |
| `infra/scripts/check-hosting-headers.mjs` | בדיקה סטטית של הכותרות (CI job `node`). |
| `infra/scripts/csp-verify.mjs` | שרת HTTPS עם הכותרות של `firebase.json` + Chromium; נכשל על הפרת CSP אכיפה. |
| `.github/workflows/dast.yml`, `.zap/rules.tsv`, `infra/scripts/zap_gate.py` | DAST לילי + ידני: Hosting emulator + API בזיכרון, ZAP baseline (web, API) + ZAP API scan, שער 0 High, דוחות כ-artifact. |
| `infra/scripts/setup-backups.sh`, `infra/scripts/restore-drill.sh`, `infra/scripts/lib/common.sh` | גיבויים כ-IaC (gcloud) ותרגיל שחזור עם `--dry-run`; runbook: `docs/runbooks/restore-drill.md`. |
| `infra/monitoring/setup-alerts.sh`, `infra/monitoring/README.md` | התראות SEC-43 כקוד (8 מטריקות, 13 מדיניות). |
| `.github/workflows/ci.yml` | job חדש `infra-scripts` (shellcheck, dry-runs, self-test לשער ZAP) בתוך `ci-gate`; בדיקת כותרות ב-job `node`. |
| `.github/CODEOWNERS` | `firebase.json`, `.firebaserc`, `firebase/`, `.zap/`, `docs/security/`, `docs/runbooks/`, קוד share/public/offboarding ב-API. |
| `docs/security/` | `pentest-scope.md`, `beta-checklist.md`, `csp.md`, `sprint-5-requests.md` (בקשות לסוכני API/Worker/Web). |

הרצה מקומית:

```bash
node infra/scripts/check-hosting-headers.mjs
NODE_PATH=/opt/npm-tools/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  node infra/scripts/csp-verify.mjs --dist apps/web/dist            # או --mock עם build של VITE_USE_MOCKS=true
bash infra/scripts/restore-drill.sh --project kamutan-fba67 --scratch-project kamutan-drill \
  --backup-bucket kamutan-fba67-firestore-backup-eu --dry-run
bash infra/scripts/setup-backups.sh --project kamutan-fba67 --backup-project kamutan-backup-eu --dry-run
bash infra/monitoring/setup-alerts.sh --project kamutan-fba67 --notification-email security@example.com --dry-run
python3 infra/scripts/zap_gate_selftest.py
uvx --from actionlint-py actionlint .github/workflows/*.yml
```

פערים: תמונת ZAP לפי `:stable` (ghcr חסום מכאן; ה-digest נרשם ב-summary של כל ריצה — לקבע אחרי הריצה הראשונה);
DAST לא מאומת (משתמשים) עד שיש staging; `deploy.yml` עדיין stub עד WIF; תרגיל השחזור וההתראות לא הורצו מול GCP.

### Sprint 5 follow-up (21.10.2026)

| קובץ | תוכן |
| --- | --- |
| `.github/workflows/_deploy-env.yml`, `deploy.yml` | build + Trivy + push של `api-jobs`, `gcloud run jobs update kamutan-offboard-purge` לפי digest (רק update; אם ה-job לא קיים — warning); `firebase deploy --only functions:api:api,functions:api:apiJobs,functions:api:reprocessDependents` (רשימה מפורשת). |
| `infra/docker/api-jobs.Dockerfile` (+ `.dockerignore`) | תמונת Node 22 slim, non-root, prod deps בלבד, `ENTRYPOINT node dist/scripts/offboard-purge.js`. נבנית גם ב-CI (matrix `docker`). |
| `infra/scripts/setup-api-jobs.sh` | topic `api-jobs` + publisher ל-API, role מותאם `kamutanAuthRevoke` (revokeRefreshTokens), run.invoker לפונקציות, SA `kamutan-purge@`/`kamutan-scheduler@`, Cloud Run job + Scheduler יומי 03:07 UTC, הרשאות deploy. `--dry-run` רץ ב-CI (`infra-scripts`). |
| `infra/IAM.md` | §2b, §3 (תוספות Sprint 5), §3b (purge), §4 (הרשאות deploy), §7 (אימות). |
| `infra/monitoring/setup-alerts.sh` | התראות purge נכשל / שגיאות apiJobs+reprocessDependents (15 מדיניות). |
| `docs/runbooks/offboarding-purge.md`, `docs/security/licence-inventory.md` | runbook ל-purge; מלאי רישוי. |
| `firebase.json` | `hosting.ignore` מפורש (dotfiles) כדי ש-`.well-known/security.txt` של ה-web ייפרס; ה-rewrite הישן הוסר. |

לא אומת מכאן: build של התמונה (Docker Hub חסום) — ה-job `docker` ב-CI הוא הבדיקה הראשונה; הרשאות ה-deploy ל-onSchedule/Eventarc
(`cloudscheduler.admin`, `pubsub.viewer`, `eventarc.developer`) — לאמת בפריסה הראשונה ולצמצם אם אפשר.
