# מדיניות אבטחה — כמותן (Kamutan)

המסמך המחייב הוא [`docs/spec/06_security.md`](docs/spec/06_security.md). כאן מופיעים רק דיווח, היקף וכללי עבודה בריפו.

## דיווח על חולשה

- **אל תפתחו Issue ציבורי ואל תכתבו פרטי חולשה ב-PR.**
- חברי צוות (הריפו פרטי): פתחו **טיוטת Security Advisory** ב-GitHub → Security → Advisories → New draft advisory.
- חוקרים חיצוניים ושותפים: אימייל לכתובת האבטחה שמופיעה ב-`/.well-known/security.txt` של האפליקציה (תוגדר לפני הבטא, ראו `infra/NOTES.md`).
- כללו: רכיב, גרסה או commit, צעדי שחזור, השפעה צפויה. **אל תצרפו נתוני לקוח אמיתיים או שרטוטים.**
- זמני תגובה (יעד): אישור קבלה תוך 2 ימי עבודה; הערכת חומרה תוך 5 ימי עבודה; תיקון Critical/High תוך 7 ימים.
- תגובה לאירוע לפי 06_security.md ("תגובה לאירועים"): מנהל האירוע הוא **אדם** (בעל המוצר), לא סוכן AI.

## היקף

| בהיקף | מחוץ להיקף |
| --- | --- |
| `apps/web`, `apps/api`, `workers/drawing`, `packages/*`, `supabase/` (RLS, מיגרציות, storage policies), `infra/`, `.github/workflows` | שירותי צד שלישי עצמם (Supabase, Vercel, Railway, GitHub, ספקי LLM) — לדווח להם ישירות |
| בידוד tenants (RLS/IDOR), העלאה ופענוח קבצים (sandbox), קישורי שיתוף, LLM gateway (דליפה, prompt injection), שרשרת אספקה ו-CI | DoS נפחי, הנדסה חברתית, סריקות אוטומטיות בלי הוכחת השפעה |

בדיקות אקטיביות מותרות רק מול סביבת staging ובתיאום מראש. אסור לגשת לנתונים של ארגון שאינו שלכם.

## כללי עבודה בריפו (תקציר)

- סודות: רק ב-secret store של הפלטפורמה (GitHub Environments, Railway, Vercel). אף פעם לא בקוד, ב-fixtures, בלוגים או בהקשר של סוכן AI (SEC-24, SEC-53). `gitleaks` רץ ב-pre-commit וב-CI.
- שרטוטי לקוחות, PDF/DWG/DXF וכתבי כמויות אמיתיים **לא נכנסים לגיט** (SEC-54). נתוני דוגמה נקראים דרך `KAMUTAN_DATA_DIR`.
- שינוי ב-`.github/`, `infra/`, `supabase/migrations/`, `apps/api/src/auth/`, `llm_gateway` או `docs/adr/` דורש אישור אנושי (CODEOWNERS, SEC-47).
- תלות חדשה: מוצדקת, מתוחזקת, רישיון תואם (ללא AGPL/GPL מקושר — ADR-0002), ואישור אנושי.
- אם סוד דלף: מסובבים אותו מיד (runbook ב-06_security.md), ורק אחר כך מנקים היסטוריה.
