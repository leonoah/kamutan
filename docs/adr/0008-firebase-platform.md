# ADR 0008 — מעבר מ-Supabase ל-Firebase

- סטטוס: התקבל (11.10.2026), החלטת הבעלים
- מחליף: את חלקי Supabase ב-ADR 0001, 0003, 0005; מעדכן את 0006 ו-0007

## הקשר

הבעלים בחר לעבוד עם Firebase (פרויקט `kamutan-fba67`). כתוצאה מכך אין SQL, אין RLS ואין PostGIS. ההרשאות עוברות ל-Security Rules ולבדיקות בצד השרת, והגיאומטריה נשמרת כקבצים.

## החלטה

| שכבה | קודם | עכשיו |
| --- | --- | --- |
| Auth | Supabase Auth | **Firebase Auth** (סיסמה, קישור במייל, Google). ה-API מאמת ID tokens עם `firebase-admin` |
| DB | Postgres + RLS + PostGIS | **Cloud Firestore**, מיקום `eur3` (אירופה). הרשאות: Security Rules לקריאות מהלקוח, וכל כתיבה רגישה עוברת דרך ה-API |
| גיאומטריה | עמודות PostGIS | **קבצים ב-Storage** לכל גרסת גיליון (`primitives`, `detections`, `rooms` כ-JSON דחוס). ב-Firestore נשמרים רק סיכומים, פריטי בדיקה ותיקונים. שאילתות מרחביות (חדר מכיל סמל, לאסו) מחושבות ב-worker ובדפדפן |
| קבצים | Supabase Storage | **Cloud Storage for Firebase**, bucket `kamutan-fba67.firebasestorage.app`. נתיבים `orgs/{orgId}/...`, עם rules שבודקות חברות דרך Firestore |
| API | NestJS ב-Railway | **NestJS בתוך Cloud Functions 2nd gen** (`api`, ‏europe-west1), מאחורי Firebase Hosting rewrite `/api/**`, באותו origin ובלי CORS |
| תור | BullMQ + Redis | **Pub/Sub**: topic `ingest`, עם push subscription מאומת ל-worker ו-DLQ. אין Redis |
| Workers | Python ב-Railway | **Cloud Run** (קונטיינר עם Tesseract ו-heb), ‏europe-west1. Cloud Functions לא מתאימות כי אין בהן חבילות מערכת |
| Realtime | Supabase Realtime | **Firestore listeners**: התקדמות jobs ועדכוני שורות ישירות בלקוח |
| Hosting | Vercel | **Firebase Hosting** (preview channels לכל PR) |
| פריסה | Railway / Vercel | **GitHub Actions**: `firebase deploy` (rules, hosting, functions) ו-`gcloud run deploy` (worker). מכאן אין גישה ישירה ל-Google APIs |

### מודל נתונים (Firestore)

```
orgs/{orgId}                                  name, settings (llmEnabled, blockExportOnRed, greenThreshold)
orgs/{orgId}/members/{uid}                    role: admin|editor|reviewer|viewer
orgs/{orgId}/projects/{projectId}             name, address, templateId, floors[], stats
  .../sheetSets/{setId}                       fileKind, sha256, storagePath, status
  .../sheets/{sheetId}                        discipline, floorRegions[], scale, titleBlock (ללא PII), currentVersionId
  .../sheets/{sheetId}/versions/{versionId}   status, artifacts{primitives, tiles, detections, rooms}, stats
  .../legendEntries/{entryId}                 sheetId, label, templateRef, itemCode (טקסט)
  .../reviewItems/{itemId}                    רק פריטים צהובים/אדומים ואשכולות: level, reasons[], clusterId, status
  .../corrections/{correctionId}              מי, מה, מתי; גובר על פלט אוטומטי (לא נדרס בריצה חוזרת)
  .../boqLines/{lineId}                       code (TEXT), qty, unit, level, status draft|reviewed|approved, evidenceRef
  .../shareLinks/{linkId}                     tokenHash, versionLock, expiresAt, revokedAt (נכתב רק דרך ה-API)
orgs/{orgId}/itemLibrary/{itemId}, boqTemplates/{id}, symbolMappings/{id}
orgs/{orgId}/auditLog/{eventId}               רק השרת כותב, הלקוח לא יכול לעדכן או למחוק
jobs/{jobId}                                  orgId, type, status, progress (הלקוח קורא לפי orgId)
```

### עקרונות הרשאה

1. כל מסמך תחת `orgs/{orgId}`. בקריאה, ה-rules בודקות `exists(members/{uid})`.
2. **כתיבה מהלקוח מותרת רק במקומות מוגדרים:** תיקונים ו-reviewItems.status (עורך ובודק), ושינויי סטטוס בשורות כתב הכמויות (בודק). כל השאר (יצירת פרויקט, העלאה סופית, שיתוף, חברות בארגון, audit) עובר דרך ה-API עם `firebase-admin`.
3. **ה-worker** רץ עם service account ייעודי בהרשאות מינימליות (Firestore user ו-Storage object admin על ה-bucket בלבד). זה המקביל ל-ADR 0003. כל job נושא `orgId`, וה-worker כותב רק תחת הנתיב הזה.
4. **קישורי שיתוף:** רק דרך ה-API (ADR 0005 בעינו). הצופה החיצוני לא מקבל גישה ל-Firestore בכלל.

## השלכות

- **בדיקות:** בדיקות ה-rules רצות ב-GitHub Actions עם Firebase Emulator Suite, כי ההורדה חסומה בסביבת הפיתוח. בבדיקות יחידה משתמשים ב-repositories בזיכרון.
- **גיאומטריה בקבצים:** מורידה את עלות Firestore (אלפי פריטים לגיליון), אבל מחייבת לנהל גרסאות של קבצי ה-artifact ולהשתמש ב-signed URLs קצרים.
- **תשלום:** נדרשת **תוכנית Blaze**, בשביל Functions, Cloud Run ו-Pub/Sub. ההערכה ל-MVP היא כמה עשרות דולרים בחודש. חובה להגדיר התראת תקציב.
- **תיקייה ישנה:** `supabase/` נמחקת. דרישות האבטחה (SEC) עוברות מיפוי ל-rules ולבדיקות שרת.
