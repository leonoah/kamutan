# כמותן (Kamutan)

כתב כמויות אוטומטי משרטוטים, עם ביטחון מכויל ותיקון על גבי השרטוט.

- מסמכי אפיון: `docs/spec/`
- החלטות ארכיטקטורה: `docs/adr/`

## מבנה
| תיקייה | תוכן |
| --- | --- |
| `apps/web` | React + Vite + Tailwind (RTL) |
| `apps/api` | NestJS API |
| `workers/drawing` | Python: עיבוד שרטוטים |
| `packages/contracts` | חוזי Zod משותפים |
| `supabase/` | מיגרציות SQL, מדיניות RLS ובדיקות |
| `benchmark/` | kbench: מדידת דיוק מול מאגר האמת |

שרטוטי לקוחות לעולם לא נשמרים בגיט. נתוני הדוגמה נמצאים מחוץ לריפו (`KAMUTAN_DATA_DIR`).
