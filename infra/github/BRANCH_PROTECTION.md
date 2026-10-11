# GitHub: הגדרות ריפו ו-branch protection ל-`leonoah/kamutan`

ההגדרות האלה מממשות את SEC-24, SEC-47, SEC-48, SEC-55. ה-API לא זמין מהסביבה של הסוכנים, ולכן **בעל הריפו (אדם) מגדיר אותן ידנית** בממשק של GitHub. סוכנים לא מקבלים הרשאת admin ולא משנים את ההגדרות האלה.

> **תלות בתוכנית GitHub (לבדוק לפני שמתחילים):** בריפו **פרטי** של חשבון אישי, branch protection / rulesets (ולכן אכיפת CODEOWNERS) דורשים **GitHub Pro** לפחות. Environments עם secrets בריפו פרטי דורשים Pro/Team, ו-**required reviewers** על environment בריפו פרטי זמין כיום רק בתוכניות מתקדמות (Enterprise — בדקו את דף התמחור העדכני). אם התוכנית לא תומכת — ראו "חלופה" בסוף הסעיף של Environments.

## 0. לפני הכל: זהות נפרדת לסוכנים

GitHub לא מאפשר לאשר PR שפתחת בעצמך. אם הסוכנים פותחים PR עם הטוקן של `@leonoah`, אף אחד לא יוכל לאשר אותם והאכיפה תיתקע.

1. צרו **משתמש מכונה** (למשל `kamutan-bot`) או **GitHub App** לסוכנים.
2. הזמינו אותו לריפו בתפקיד **Write** (לא Maintain/Admin).
3. צרו לו **fine-grained PAT** מוגבל לריפו `leonoah/kamutan` בלבד, עם: Contents — Read and write, Pull requests — Read and write, Metadata — Read. **בלי** Administration, Workflows, Secrets, Environments (SEC-55).
4. `@leonoah` נשאר הבעלים היחיד ב-CODEOWNERS ומאשר PR בנתיבים רגישים.

## 1. Settings → General

- **Default branch:** `main`.
- Pull Requests:
  - ✅ Allow squash merging (ברירת מחדל: "Pull request title and description").
  - ❌ Allow merge commits.
  - ❌ Allow rebase merging (אופציונלי; linear history נשמר ב-squash).
  - ✅ Always suggest updating pull request branches.
  - ✅ Automatically delete head branches.
  - ❌ Allow auto-merge (עד שיש ביטחון בתהליך).

## 2. Settings → Rules → Rulesets → New branch ruleset (מומלץ על פני "classic")

- **Ruleset name:** `main-protection`
- **Enforcement status:** Active
- **Bypass list:** ריק. (לא להוסיף את עצמכם — גם האדמין עובר דרך PR. במקרה חירום משנים זמנית ומתעדים ב-audit.)
- **Target branches:** Add target → *Include default branch*.
- **Rules:**
  - ✅ Restrict deletions
  - ✅ Require linear history
  - ✅ Require a pull request before merging
    - Required approvals: **1**
    - ✅ Dismiss stale pull request approvals when new commits are pushed
    - ✅ **Require review from Code Owners**
    - ✅ Require approval of the most recent reviewable push
    - ✅ Require conversation resolution before merging
    - Allowed merge methods: **Squash**
  - ✅ Require status checks to pass
    - ✅ Require branches to be up to date before merging
    - Add check: **`ci-gate`** (source: GitHub Actions). זה ה-job המסכם ב-`.github/workflows/ci.yml`; הוא נכשל אם אחד מה-jobs (node, python, db, gitleaks, Semgrep, osv, docker, benchmark) נכשל, ומתעלם מ-jobs שדולגו לפי path filter.
    - (הבדיקה תופיע ברשימה רק אחרי ריצה ראשונה של CI — פתחו PR ראשון ואז הוסיפו.)
  - ✅ Block force pushes
  - ✅ Require signed commits — **אופציונלי** (SEC-46 "Should"). אם מפעילים — גם לבוט צריך מפתח חתימה.

**אם משתמשים ב-Classic branch protection** (Settings → Branches → Add rule, pattern `main`): אותן אפשרויות, ובנוסף ✅ "Do not allow bypassing the above settings".

## 3. Settings → Actions → General

- **Actions permissions:** Allow `leonoah`, and select non-`leonoah`, actions and reusable workflows:
  - ✅ Allow actions created by GitHub
  - ❌ Allow actions by Marketplace verified creators (לא מסמנים). במקום זה, בשדה "Allow specified actions and reusable workflows" רשימה מפורשת:
    ```
    pnpm/action-setup@*,
    astral-sh/setup-uv@*,
    dorny/paths-filter@*,
    docker/setup-buildx-action@*,
    docker/build-push-action@*,
    docker/login-action@*,
    aquasecurity/trivy-action@*,
    ```
  - ✅ Require actions to be pinned to a full-length commit SHA — להפעיל **אחרי** שמקבעים SHA (TODO ספרינט 1, SEC-48).
- **Fork pull request workflows from outside collaborators:** Require approval for all outside collaborators.
- **Workflow permissions:** ✅ **Read repository contents and packages permissions** (ברירת מחדל read-only).
- ❌ **Allow GitHub Actions to create and approve pull requests.**

## 4. Settings → Environments

צרו שתי סביבות. השמות חייבים להתאים ל-`.github/workflows/deploy.yml`.

### `staging`
- **Required reviewers:** `@leonoah`. ✅ Prevent self-review — **לא** (אתם המאשרים היחידים).
- **Deployment branches and tags:** Selected branches and tags → `main`, ותבנית תגית `v*`.
- **Environment secrets:** `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `RAILWAY_TOKEN` (טוקן פרויקט/סביבה, לא account token).
- **Environment variables:** `SUPABASE_PROJECT_REF` (ref של פרויקט ה-staging).

### `production`
- **Required reviewers:** `@leonoah`.
- **Wait timer:** 0 (אופציונלי 5 דקות).
- **Deployment branches and tags:** Selected → תבנית תגית `v*` בלבד (ו-`main` ל-workflow_dispatch).
- **Environment secrets/variables:** אותם שמות כמו ב-staging, עם ערכי production (פרויקט Supabase נפרד, SEC-25).

**חלופה אם required reviewers לא זמין בתוכנית:** אל תגדירו secrets של production ב-GitHub בכלל; פריסת production מתבצעת ידנית מ-Railway/Vercel/Supabase dashboard על ידי הבעלים, לפי ה-tag. ה-workflow ידלג על השלבים (הוא בודק אם הסוד קיים).

## 5. Settings → Secrets and variables → Actions (repository level)

רק סודות שאינם של סביבה, ורק אם צריך:

| שם | למה | מי משתמש |
| --- | --- | --- |
| `KAMUTAN_DATA_URL` | כתובת (signed URL קצר / bucket פרטי) למאגר ה-benchmark המוצפן | job `benchmark` ב-CI |
| `KAMUTAN_DATA_KEY` | מפתח `age` לפענוח המאגר | job `benchmark` ב-CI |

אם אין אותם, job ה-benchmark מדלג בצורה מסודרת. **לא להגדיר כאן סודות production.** סודות repository-level זמינים ל-PR מהריפו עצמו (לא מ-forks) — לכן רק נתוני benchmark מאושרים ואנונימיים (SEC-54).

## 6. Settings → Code security

- ✅ Dependency graph
- ✅ Dependabot alerts
- ✅ Dependabot security updates
- ✅ Grouped security updates
- ✅ Secret scanning + **Push protection** — בריפו פרטי דורש GitHub Secret Protection (בתשלום). אם לא זמין: gitleaks ב-pre-commit וב-CI מכסים (SEC-24).
- Code scanning (CodeQL) — אופציונלי; ריפו פרטי דורש GitHub Code Security. Semgrep ב-CI מכסה את SEC-50.

## 7. Settings → Collaborators and teams

| חשבון | תפקיד |
| --- | --- |
| `leonoah` | Admin (אדם, בעלים, CODEOWNER) |
| `kamutan-bot` (סוכנים) | Write |
| שותפים / סוקרים אנושיים נוספים | Triage או Write לפי צורך |

## 8. בדיקת קבלה (אחרי ההגדרה)

1. PR מהבוט שמשנה `.github/workflows/ci.yml` → מבקש review מ-`@leonoah` ולא ניתן למזג בלי אישור.
2. PR עם `ci-gate` אדום → כפתור Merge חסום.
3. `git push --force origin main` → נדחה.
4. PR עם קובץ `.env` שמכיל מפתח → gitleaks נכשל ב-CI.
5. הרצת `Deploy` ל-production → נעצרת ב-"Waiting for review".
