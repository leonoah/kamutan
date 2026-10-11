# infra — NOTES (DevOps + Security, Sprint 0)

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
