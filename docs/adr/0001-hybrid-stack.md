# ADR-0001: סטאק היברידי — React ב-Vercel, NestJS, Python workers, Supabase EU

- **סטטוס:** התקבל
- **תאריך:** 2026-10-11
- **מקורות:** 04_architecture ("תקציר ההחלטות", "רכיבי המערכת", "תשתית ופריסה"), 06_security (אזור נתונים)

## הקשר

המוצר משלב UI עשיר בעברית (RTL, מציג שרטוטים A0 ב-WebGL), לוגיקה עסקית והרשאות multi-tenant, וצנרת עיבוד גאומטרי ו-OCR כבדה שהאקוסיסטם הטבעי שלה הוא Python (numpy, shapely, pypdfium2, ezdxf, Tesseract). כל נתוני הלקוח צריכים להישאר ב-EU, והתקציב הוא כמה מאות דולרים בחודש.

## אפשרויות שנשקלו

1. **הכל ב-TypeScript** (כולל עיבוד) — ספריות גאומטריה ו-OCR חלשות; היינו ממחזרים Python בכל מקרה.
2. **הכל ב-Python** (FastAPI + פרונט) — מאבדים שיתוף טיפוסים עם הפרונט ואת NestJS Guards/DI להרשאות.
3. **היברידי** — TS לפרונט ול-API, Python ל-workers, חוזה משותף אחד.

## החלטה

אפשרות 3:

- `apps/web`: React + Vite + TS + Tailwind + shadcn, נכסים סטטיים ב-**Vercel** (אין נתוני לקוח ב-Vercel).
- `apps/api`: **NestJS** כ-API יחיד שמחזיק לוגיקה עסקית והרשאות; ניגש ל-DB בהקשר המשתמש (RLS נאכף).
- `workers/drawing`: **Python 3.12 + uv**, מאזין לתורי **BullMQ על Redis 7** (ספריית `bullmq` הרשמית ל-Python).
- **Supabase eu-central-1**: Postgres (PostGIS, pgvector, RLS), Auth, Storage, Realtime.
- API ו-workers ב-**Railway (EU West)**; Cloud Run נשמר כנתיב הגדלה ל-cpu-heavy.
- חוזה אחד: `packages/contracts` (Zod) → JSON Schema → pydantic. payloads של jobs מכילים מזהים בלבד.
- Monorepo: pnpm workspaces + Turborepo ל-TS, uv ל-Python.

## השלכות

- (+) כל שכבה בשפה שמתאימה לה; ה-API נשאר גבול האמון היחיד.
- (+) כל הנתונים ב-EU; עלות משוערת ~240–390$ לחודש.
- (−) שני runtimes ושתי שרשראות אספקה (npm + PyPI) — מכוסות ב-CI (osv-scanner, Dependabot, Semgrep, Bandit).
- (−) סנכרון טיפוסים בין TS ל-Python דורש generator ובדיקת diff ב-CI.
- (−) Railway הוא SPOF ומגבלות משאבים ל-A0 — images ניידים, מעבר ל-Cloud Run אם p95 גיליון A0 > 3 דקות.
