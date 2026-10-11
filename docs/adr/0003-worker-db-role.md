# ADR-0003: role ייעודי ומוגבל ל-worker ב-DB, לא service_role

- **סטטוס:** התקבל
- **תאריך:** 2026-10-11
- **מקורות:** 08_workplan_v2 §2 (הכרעה 3), 06_security (SEC-08, SEC-17, SEC-24), review_consistency (סתירה 1), 07_test_plan (RL-04 — לעדכן)

## הקשר

ה-worker מריץ פענוח של קבצים עוינים (PDF/DWG/DXF/PNG) ולכן נחשב **חצי-אמין**. 04_architecture נתן לו `service_role`, שעוקף RLS לכל הארגונים: ניצול אחד של parser = גישה לכל נתוני כל הלקוחות ותנועה רוחבית.

## החלטה

- ל-worker יש **Postgres role ייעודי** (`kamutan_worker`, `LOGIN`, `NOBYPASSRLS`, לא superuser, לא חבר ב-`service_role`/`authenticated`).
- הרשאות: `SELECT/INSERT/UPDATE` רק על טבלאות הצנרת (jobs, artifacts, detections, ocr, וכו') ו-`SELECT` מצומצם על מה שהצנרת קוראת. אין גישה ל-`auth.*`, `audit_log` (חוץ מפונקציית כתיבה), הגדרות ארגון, קישורי שיתוף או משתמשים.
- **כל כתיבה מציינת `org_id`** שחייב להתאים ל-job: נאכף ב-RLS/trigger מול טבלת `jobs` (job פעיל, אותו org).
- payload ב-Redis מכיל **מזהים בלבד**; ה-worker מאמת אותם מול ה-DB לפני העבודה.
- Storage: גישה דרך signed URLs שה-API מנפיק ל-job, או דרך מפתח Storage מוגבל לנתיבי `org/{org_id}/...` של ה-job — לא service_role.
- Realtime: התקדמות מתפרסמת דרך עדכון `jobs` (ה-API משדר) ולא במפתח service.
- תהליכי הפענוח עצמם (subprocess ב-sandbox) **לא מקבלים שום credential** — רק קובץ מקומי.
- connection string: `KAMUTAN_WORKER_DB_URL` (`sslmode=require`), סוד נפרד לכל סביבה. חוק Semgrep `kamutan-worker-no-service-role` חוסם `SUPABASE_SERVICE_ROLE_KEY` תחת `workers/**`.

## השלכות

- (+) ניצול parser מוגבל לטבלאות הצנרת; RLS ממשיך לחול.
- (−) מיגרציה ייעודית ל-role ולמדיניות, ובדיקות בידוד ל-role (cross-org write נכשל). בדיקה RL-04 ב-07 מתעדכנת בהתאם.
- (−) פרסום Realtime ישיר מה-worker לא זמין; מקבלים hop דרך ה-API (latency קטן).
- שער ספרינט 1 (06): role ייעודי פעיל ונבדק.
