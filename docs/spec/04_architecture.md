# מסמך ארכיטקטורה — "כמותן" (שלב 4)

גרסה 1.0, 11.10.2026. מבוסס על ה-PRD (01), תוכנית העבודה (02), מסמך הסטאק של הלקוח ו-15 גיליונות הדוגמה (בית משפחת נח: A3, AutoCAD 2017, קנ"מ 1:50, טקסט עברי מצויר כקווי SHX בלי שכבת טקסט, טבלאות מקרא בגיליונות חשמל ותאורה, קשתות מקווקוות בין מפסק לגוף תאורה, אדום להריסה וצהוב לבנייה חדשה).

## תקציר ההחלטות

- **ארכיטקטורה היברידית בשלוש שכבות:** React + Vite + TS + Tailwind + shadcn ב-Vercel, NestJS כ-API יחיד שמחזיק את כל הלוגיקה העסקית וההרשאות, ו-Python workers לעיבוד שרטוטים שמתחברים לאותו Redis דרך BullMQ (ספריית `bullmq` הרשמית ל-Python). ה-workers כותבים ישירות ל-Postgres עם service role, אבל רק לטבלאות הצנרת.
- **Supabase (אזור eu-central-1, פרנקפורט)** משמש ל-Auth, ל-Postgres (עם PostGIS ו-pgvector) ול-Storage. ה-API וה-workers רצים ב-Railway, אזור EU West. Cloud Run נשמר כנתיב להגדלה של workers כבדים. כל המידע נשאר באירופה.
- **הגיאומטריה נשמרת ב-PostGIS** (SRID 0, מילימטרים על הנייר, ציר y כלפי מטה). כך יש אינדקס מרחבי, שאילתות "איזה סמל בתוך איזה חדר" ב-SQL, ולאסו בצד השרת. גאומטריה גולמית כבדה (כל הנתיבים של הגיליון) נשמרת כקובץ Parquet/MsgPack ב-Storage ולא ב-DB.
- **"וקטור קודם, רסטר אחר כך":** כל הזיהוי ב-PDF וקטורי וב-DXF נעשה על הפרימיטיבים הגאומטריים (קטעים, קשתות, צבע, עובי, דפוס קו). רסטר ו-CV משמשים רק לקבצי PNG ולאזורים שנכשלו. זה מה שמאפשר להגיע ל-95% ול"קבלה" מדויקת לכל פריט.
- **OCR עברי ל-SHX: "מילון גליפים" לכל פרויקט.** טקסט SHX מצויר תמיד באותם רצפי קווים לכל אות. לכן מקבצים גליפים וקטוריים לפי hash מנורמל, מתייגים כל גליף ייחודי פעם אחת (OCR מקומי, ואם צריך VLM על תמונה חתוכה), ומשם הקריאה דטרמיניסטית וזולה. VLM נקרא רק על אזורים חתוכים, ותוצאותיו נשמרות במטמון לפי hash.
- **מציג השרטוטים מבוסס Deck.gl** (OrthographicView): אריחי רסטר WebP שמרונדרים מראש, ומעליהם שכבות וקטוריות ב-WebGL עם picking ב-GPU. ספרייה אחת לאריחים ול-overlay, עד A0 ב-60fps.
- **ביטחון = מודל מאפיינים מכויל.** לכל פריט מחושב וקטור מאפיינים, מודל logistic (ובהמשך LightGBM) נותן ציון, וכיול isotonic על holdout. ירוק ניתן רק כשהחסם התחתון (Wilson 95%) של הדיוק בתא הכיול הוא 98% ומעלה. עד שיש 30 פרויקטי אמת עובדים במצב "כיול שמרני".
- **שער AI אחד (`llm_gateway`)** הוא הדרך היחידה ל-LLM/VLM. הוא אוכף מדיניות לכל ארגון (כיבוי, תקציב, ספק), משתמש רק בספקים בתנאי no-training ו-zero-retention באזור EU (Claude דרך AWS Bedrock ב-eu-central-1 כברירת מחדל, Gemini דרך Vertex europe-west כחלופה), ושומר מטמון לפי hash. המערכת חייבת לעבוד, באיכות נמוכה יותר, גם כשה-AI כבוי.

## רכיבי המערכת

| רכיב | אחריות | טכנולוגיה | פריסה |
| --- | --- | --- | --- |
| Web App | מעטפת RTL, פרויקטים, העלאה, טבלת כתב כמויות, תור בדיקה, הגדרות | React 18, Vite, TS, Tailwind, shadcn/ui, Radix, TanStack Query, Zustand, React Router, i18next | Vercel (סטטי + preview לכל PR) |
| Drawing Viewer | אריחים, overlay, בחירה, לאסו, מדידה, כיול קנ"מ | Deck.gl 9 (`TileLayer`, `BitmapLayer`, `PolygonLayer`, `ScatterplotLayer`, `PathLayer`), flatbush | חבילה בתוך ה-Web App (`packages/viewer`) |
| Core API | הרשאות, ארגונים, פרויקטים, ספרייה, תבניות, כתב כמויות, תיקונים, שיתוף, ייצוא, הזמנת jobs | NestJS 10, Drizzle ORM, Zod, `@nestjs/bullmq`, pino | Railway (EU West), 1–2 instances |
| Export Worker | ייצוא Excel ו-PDF מסומן | Node (באותו קוד של ה-API, process נפרד), exceljs, pdf-lib | Railway |
| Drawing Workers | כל צנרת העיבוד: קליטה, אריחים, OCR, מקרא, זיהוי, חדרים, קישורים, כמויות, ביטחון | Python 3.12, uv, PyMuPDF, ezdxf, shapely 2, numpy, OpenCV, scikit-learn, `bullmq` (Python), pydantic v2 | Railway: שני pools (`cpu-light`, `cpu-heavy`) |
| Queue | תורי jobs, retries, rate-limit, התקדמות | Redis 7 + BullMQ | Railway Redis (EU) |
| DB | נתוני המוצר, גאומטריה, embeddings, audit | Supabase Postgres 15 + PostGIS + pgvector + RLS | Supabase eu-central-1 |
| Auth | משתמשים, magic link / סיסמה / Google, JWT | Supabase Auth; claims של ארגון דרך custom access token hook | Supabase |
| Storage | קבצי מקור, אריחים, artifacts של הצנרת, ייצואים | Supabase Storage (S3-compatible), RLS על `storage.objects` לפי prefix של ארגון | Supabase |
| Realtime | התקדמות jobs, עדכוני שורות ותיקונים בין משתמשים | Supabase Realtime (Broadcast + Postgres Changes) | Supabase |
| LLM Gateway | ניתוב מודלים, מדיניות ארגון, מטמון, עלויות, לוג | חבילת Python `llm_gateway` (מבוססת LiteLLM SDK) בתוך ה-workers | חלק מה-workers |
| Observability | שגיאות, traces, אנליטיקה, benchmark | Sentry, OpenTelemetry → Grafana Cloud, PostHog EU, Metabase/Grafana ל-benchmark | SaaS (אזורי EU) |

**למה לא שירות AI נפרד ב-MVP:** כל קריאות ה-LLM נעשות מתוך הצנרת ב-Python. שירות נפרד היה מוסיף hop ופריסה בלי ערך. ה-gateway הוא מודול עם ממשק יציב, ואפשר להוציא אותו לשירות בשלב ב'.

**למה Drizzle ולא Prisma:** RLS דורש להריץ כל טרנזקציה עם `set_config('request.jwt.claims', …)` ו-`set local role authenticated`. Drizzle נותן שליטה מלאה ב-SQL ובטרנזקציות, עובד טוב עם PostGIS דרך `sql` טמפלייט, ומשתמש במיגרציות SQL של Supabase CLI כמקור אמת.

## צנרת עיבוד השרטוטים

הצנרת היא DAG של שלבים. כל שלב מקבל artifacts מגורסה (`sheet_version_id`) וכותב artifact חדש ל-Storage בנתיב `org/{org}/sv/{sheet_version}/{stage}/{stage_version}.{ext}`, וגם רשומות ל-DB לפי הצורך. כל שלב דטרמיניסטי לפי (hash הקלט, גרסת השלב, הגדרות), ולכן אפשר לשמור במטמון ולהריץ מחדש שלב בודד. מערכת הקואורדינטות הקנונית היא **מ"מ על הנייר, ראשית בפינה השמאלית העליונה, y כלפי מטה**. מידות בעולם = מ"מ נייר × מכנה קנ"מ.

### שלב 0 — קליטה (Ingest)
- **קלט:** קובץ מקור (PDF / DWG / DXF / PNG / JPG), עד 100MB.
- **אלגוריתם:**
  - **PDF וקטורי:** PyMuPDF. `page.get_drawings()` מחזיר נתיבים עם צבע stroke/fill, עובי, dashes ו-closePath. `get_text("rawdict")` מחזיר טקסט אם קיים (בשרטוטים שלנו לא קיים). אם הקובץ כולל OCG (שכבות PDF מ-AutoCAD), שמות השכבות נשמרים לכל נתיב. הנתיבים מומרים לפרימיטיבים: segment, arc (התאמת Bezier לקשת מעגלית), circle, polyline, fill.
  - **DXF:** ezdxf. נשמרים בלוקים (`INSERT` עם שם, מיקום, סיבוב, scale ו-ATTRIBs), שכבות, linetypes, צבעי ACI/true color, טקסט (`TEXT`/`MTEXT`, כולל עברית אמיתית) ו-hatches. כל layout של paper space הופך לגיליון. ב-DWG/DXF בלוקים הם "סמלים בחינם", ולכן ביטחון הזיהוי גבוה.
  - **DWG:** המרה ל-DXF לפני ezdxf. **ODA File Converter** הוא הממיר האמין ביותר, אבל הרישיון שלו מתיר שימוש חינמי רק בתנאים מוגבלים, ושימוש מסחרי בשרת (SaaS) דורש חברות בתשלום ב-ODA. **החלטה ל-MVP:** LibreDWG (`dwg2dxf`, GPLv3. כשמריצים בשרת בלי הפצה אין חובת קוד פתוח) בקונטיינר מבודד. אם ההמרה נכשלת, מבקשים מהמשתמש לייצא DXF או PDF. רכישת ODA היא החלטה פתוחה (ראו טבלת הסיכונים).
  - **PNG/JPG:** OpenCV: deskew (Hough), נרמול ניגודיות, binarization (Sauvola), הפרדת צבעים (k-means ב-Lab). וקטוריזציה חלקית: LSD לקווים ו-HoughCircles לעיגולים. דגל `is_raster=true` מגביל את כל הפריטים ל"סביר" לכל היותר.
  - **פיצול:** כל עמוד PDF או layout הוא `sheet`. אם יש כמה גיליונות בעמוד, מפצלים לפי מסגרות (מלבנים גדולים סגורים).
- **פלט:** `primitives.parquet` (id, type, geometry WKB, stroke_rgb, fill_rgb, width, dash_pattern, layer, block_ref), `source_meta.json`, רשומות `sheets` ו-`sheet_versions`.
- **אותות ביטחון:** `source_kind` (dxf > pdf_vector > raster), `has_text_layer`, `has_ocg_layers`, `primitive_count`.
- **כשלים:** PDF מוצפן, PDF שהוא בעצם תמונה סרוקה (מזוהה כשיש פחות מ-50 נתיבים ותמונה אחת גדולה, ואז עוברים למסלול raster), DWG שלא מומר, גיליון עם יותר מ-2 מיליון פרימיטיבים (מפשטים ומתריעים).

### שלב 1 — רינדור ואריחים (Tiling)
- **קלט:** קובץ המקור והעמוד.
- **אלגוריתם:** רינדור PyMuPDF (DXF דרך `ezdxf.addons.drawing` ל-PDF ואז אותו מסלול) לפירמידת אריחים 512×512 WebP. הרמה המקסימלית היא 400dpi (ל-A0 בערך 18,700×13,200px, 9 רמות). רינדור "גרסת עבודה" אחת של 300dpi PNG גרייסקייל משמש ל-CV ול-OCR, ותמונה ממוזערת ברוחב 1024px משמשת לרשימות.
- **פלט:** `tiles/{z}/{x}_{y}.webp`, `tiles/manifest.json` (רוחב, גובה, רמות, מ"מ לפיקסל), `work_300.png`, `thumb.webp`.
- **אותות:** אין.
- **כשלים:** זיכרון ב-A0 (פותרים ברינדור לפי clip של אזורים ולא עמוד שלם), זמן (שלב מקבילי לפי רמות).

### שלב 2 — אשכולות טקסט ו-OCR עברי (SHX)
- **קלט:** `primitives.parquet` ו-`work_300.png`.
- **אלגוריתם:**
  1. **איתור טקסט וקטורי:** פרימיטיבים קצרים (מתחת ל-3 מ"מ), דקים ובעלי צפיפות גבוהה מקובצים ל"גליפים" לפי סמיכות (DBSCAN על bbox). גליפים מקובצים לשורות לפי baseline משותף וגובה אחיד. מגדירים כיוון RTL ומזהים שורות מסובבות 90°.
  2. **מילון גליפים:** כל גליף מנורמל (תרגום, scale לגובה שורה, סדר קטעים קנוני) ומקבל hash גאומטרי עם טולרנס (קוונטיזציה ל-1/16 גובה). בפרויקט יש בדרך כלל 150–400 גליפים ייחודיים (אותיות עבריות, ספרות, סימנים) לכל גופן SHX.
  3. **תיוג גליפים:** מרנדרים כל גליף ייחודי ומריצים OCR מקומי על "שורת דוגמה" שמכילה אותו. מועמדים: **Tesseract 5 (`heb`+`eng`)** ו-**PaddleOCR**. (Surya תומך היטב בעברית, אבל הרישיון שלו GPL עם מגבלות מסחריות על המשקולות, ולכן הוא רק לניסוי.) גליף שלא הוכרע ב-OCR המקומי נשלח ל-VLM בתמונת אצווה ("אלו 40 גליפים ממוספרים, מה כל אחד?"). המיפוי hash→תו נשמר ברמת ארגון (`glyph_dictionary`), ולכן משרד שעובד עם אותו גופן משלם פעם אחת.
  4. **קריאת שורות:** שרשור תווים לפי מיקום, RTL לעברית ו-LTR לרצפי ספרות ולטינית (bidi). מספרים ויחידות מנורמלים (`+0.02`, `H=30`, `1:50`).
  5. **מסלול חלופי לרסטר ולאזורים שנכשלו:** חיתוך bbox של השורה ב-400dpi, ואז Tesseract. אם `conf<0.7` והאזור חשוב (מקרא, טבלת כותרת, שם חדר), עוברים ל-VLM.
- **פלט:** טבלת `text_spans` (bbox, טקסט, כיוון, גובה, מקור: dxf/glyph/ocr/vlm, conf) ו-`glyph_dictionary`.
- **אותות:** `ocr_conf`, `ocr_source`, שיעור הגליפים הלא מזוהים בשורה, התאמה למילון מונחים (שמות חדרים, מונחי חשמל).
- **כשלים:** אותיות מחוברות או חופפות לקווי שרטוט, טקסט מסובב באלכסון, גופנים שונים בגיליון אחד, ניקוד ומירכאות. מענה: מילון מונחי תחום ותיקון לפי Levenshtein.

### שלב 3 — טבלת כותרת וסיווג גיליון
- **קלט:** `text_spans` ופרימיטיבים.
- **אלגוריתם:** איתור טבלת הכותרת כרשת מלבנים צפופה בשוליים (בדוגמה: רצועה תחתונה עם התאים "שם הפרויקט", "שם הגיליון", "קנה מידה", "תאריך", "סטטוס", "תאור והערות"). זיהוי זוגות "תווית → ערך" לפי סמיכות בתא. סיווג התחום לפי מילות מפתח בשם הגיליון ("ת. חשמל", "ת. תאורה", "ת. אינסטלציה", "ת. הריסה", "ת. בניה", "ת. אדריכלות"), עם גיבוי של מסווג קל לפי היסטוגרמת צבעים ונוכחות מקרא. קומה: "קומת קרקע", "קומה א'", "מרתף". אם הביטחון נמוך, נשלחת לVLM תמונה חתוכה של טבלת הכותרת עם JSON schema.
- **פלט:** `sheets.discipline`, `floor`, `sheet_number`, `title`, `scale_declared`, `date`, `revision`, ו-`title_block_bbox`.
- **אותות:** `classification_conf` והסכמה בין כלל המילים לבין המסווג.
- **כשלים:** טבלת כותרת לא סטנדרטית, כמה תחומים בגיליון אחד (למשל "חשמל ותאורה"). במקרה כזה הגיליון מקבל כמה תחומים.

### שלב 4 — קנה מידה והצלבה
- **קלט:** `scale_declared`, פרימיטיבים, `text_spans`.
- **אלגוריתם:** שלושה מקורות. (א) הערך שהוצהר בטבלת הכותרת. (ב) קווי מידה: קו עם סימני קצה (tick/חץ) וטקסט מספרי מקביל, ויחס בין הערך לבין האורך במ"מ נייר. לוקחים חציון על כל קווי המידה. (ג) מוסכמות: עובי קיר חיצוני (20–30 ס"מ) ורוחב דלת (70–90 ס"מ) כבדיקת שפיות. ב-DXF ה-viewport scale ידוע במדויק.
- **פלט:** `sheet_versions.scale` (מכנה), `scale_source`, `scale_conflict` (bool), `px_per_mm`.
- **אותות:** הסכמה בין המקורות (סטייה מתחת ל-2% נחשבת הסכמה), מספר קווי המידה.
- **כשלים:** גיליון עם כמה קני מידה (פרט 1:5 לצד תכנית 1:50, כמו בגיליון הבנייה בדוגמה). מזהים viewports או אזורים לפי מסגרות פנימיות וכותרות "1:5", וקנה המידה נשמר ברמת אזור (`scale_regions`). סתירה מורידה את כל השטחים בגיליון ל"לבדיקה" ופותחת את כלי הכיול בשתי לחיצות.

### שלב 5 — איתור ופענוח המקרא
- **קלט:** פרימיטיבים, `text_spans`, תחום הגיליון.
- **אלגוריתם:** מחפשים טבלאות: רשת של קווים אופקיים ואנכיים יוצרת מטריצת תאים (בדוגמה: "טבלת תאורה" ומקרא חשמל בצד הגיליון). כותרת שמכילה "מקרא" או "טבלת תאורה" מעלה את הציון. בכל שורה מפרידים בין תא הסמל (פרימיטיבים שאינם טקסט) לתאי הטקסט (תיאור, גובה התקנה, סוג גוף, כמות אם קיימת). עמודות מזוהות לפי כותרת. מבנה הטבלה ממופה ל-schema: `{symbol_primitives, description, mount_height, fixture_type, notes}`. אם המבנה לא ודאי, תמונת הטבלה החתוכה וה-OCR נשלחים ל-VLM להחזרת JSON מובנה, אבל הגאומטריה של הסמלים תמיד נלקחת מהווקטור. מקרא שזוהה בגיליון אחד ניתן לשימוש בגיליונות אחרים באותו סט (`legend_scope = set`).
- **פלט:** `legends` ו-`legend_entries` (עם `template_geometry` מנורמלת ו-hash), וגם `symbol_templates`.
- **אותות:** `legend_parse_conf`, שלמות שורה (יש סמל ויש תיאור), איכות ה-OCR של התיאור, האם התבנית ייחודית ביחס לתבניות האחרות במקרא (מרחק Chamfer מינימלי).
- **כשלים:** מקרא בלי קווי טבלה (רק רשימה), סמלים שחופפים לטקסט, מקרא בגיליון אחר, ושני סמלים כמעט זהים (שקע כפול לעומת שקע כח). מקרה אחרון מסומן כ"זוג מבלבל" ומקבל סף התאמה מחמיר.

### שלב 6 — זיהוי סמלים מבוסס מקרא
- **קלט:** `symbol_templates` (מהמקרא, מספריית הארגון ומבלוקי DXF), פרימיטיבים ואינדקס מרחבי (shapely `STRtree`).
- **אלגוריתם וקטורי (ראשי):**
  1. **יצירת מועמדים:** לכל תבנית בוחרים "פרימיטיב עוגן" ייחודי (למשל עיגול ברדיוס r, או משולש מלא) ומחפשים בגיליון כל מופע של העוגן בטולרנס רדיוס ±8% ובצבע תואם.
  2. **יישור:** סביב כל עוגן לוקחים את הפרימיטיבים בחלון של bbox התבנית ×1.5. בודקים יישור בסיבובים 0/90/180/270 ובשיקוף, ואז ICP קצר לסיבוב חופשי. ה-scale קבוע, כי מקרא ותוכנית מצוירים באותו גודל נייר. אם זה לא מתקיים, מבצעים חיפוש scale בטווח 0.5–2.
  3. **ציון:** Chamfer דו-כיווני מנורמל (כיסוי התבנית על ידי המועמד ולהפך), התאמת סוגי פרימיטיבים, התאמת צבע ועובי. מחשבים גם margin: הפער בין הציון הטוב ביותר לציון של התבנית השנייה הכי טובה.
  4. **NMS** וטיפול בחפיפות. פרימיטיב משויך לסמל אחד בלבד.
  5. **בלוקים ב-DXF:** `INSERT` עם שם בלוק שממופה לתבנית מקבל זיהוי ישיר עם ציון 0.99, בכפוף למיפוי.
- **CV fallback (רסטר ואזורים "רועשים"):** OpenCV `matchTemplate` (TM_CCOEFF_NORMED) על רינדור 300dpi בסיבובים, עם אותו NMS. בשלב ב' יתווסף גלאי מאומן few-shot (RT-DETR תחת Apache-2.0 דרך HF transformers. נמנעים מ-Ultralytics בגלל AGPL) על בסיס תיקוני המשתמשים.
- **כריית מוטיבים לא מזוהים (FR-24):** אשכולות פרימיטיבים שלא שויכו מקבלים hash גאומטרי ומקובצים. אשכול שחוזר שלוש פעמים ויותר הופך ל"סמל לא מזוהה" עם שאלה אחת למשתמש.
- **פלט:** `detections` (נקודה או פוליגון, class = `legend_entry_id`, rotation, primitive_ids, score, features).
- **אותות:** `match_score`, `margin_to_second`, `in_legend`, `is_confusable_pair`, `color_match`, `overlap_with_text`, `source` (block/vector/raster).
- **כשלים:** סמלים חופפים לקווי קיר, סמלים מקובצים (שלישיית שקעים כצורה אחת לעומת שלושה שקעים), סמלים מוקטנים, וסמל מקרא שבתוכנית מצויר אחרת.

### שלב 7 — סגמנטציית חדרים
- **קלט:** פרימיטיבים, `text_spans`, קנה מידה. בדרך כלל מגיליון האדריכלות או הבנייה של אותה קומה, עם יישור לגיליונות האחרים.
- **אלגוריתם:** מזהים קירות כזוגות קווים מקבילים במרחק 7–40 ס"מ בקנ"מ, או כפוליגונים עם hatch או מילוי. סוגרים פתחים: קשת דלת (רבע מעגל עם קו) מגדירה פתח, ומוסיפים קו "סגירה וירטואלי" על ציר הקיר. גם פתחים בלי דלת קצרים מ-1.2 מ' נסגרים. אחר כך `shapely.polygonize` על צירי הקירות וקווי הסגירה, ומסננים לפי שטח (מעל 1 מ"ר). שם החדר נלקח מ-`text_spans` שבתוך הפוליגון ומותאם למילון ("סלון", "מטבח", "חדר רחצה", "ממ"ד" וכו'). **יישור בין גיליונות:** כל הגיליונות של אותה קומה מיושרים ל"גיליון ייחוס" באמצעות RANSAC על נקודות פינה של הקירות החיצוניים (טרנספורמציית similarity), ונשמרים ב-`sheet_alignments`.
- **פלט:** `rooms` (polygon, name, floor, area_m2, perimeter_m, openings[]).
- **אותות:** `room_closed` (נסגר בלי סגירות וירטואליות ארוכות), `name_conf`, `alignment_residual`.
- **כשלים:** חדרים פתוחים (סלון-מטבח), קירות מקווקווים (קיים או להריסה), פרטי חתך. חדר שלא נסגר מסומן "חדר לא סגור", ומשתמש יכול לצייר או לתקן פוליגון.

### שלב 8 — גרף קישורים מפסק↔גוף תאורה
- **קלט:** `detections` של מפסקים וגופי תאורה, ופרימיטיבים מקווקווים.
- **אלגוריתם:** מסננים פרימיטיבים עם `dash_pattern` לא ריק (ב-PDF מ-AutoCAD המקווקוו נשמר כ-dash array, ובמקרים אחרים כקטעים קצרים קולינאריים שאותם מאחדים). משרשרים לקשתות או פוליליינים רציפים. לכל קצה מחפשים את הסמל הקרוב (מפסק או גוף) במרחק עד 4 מ"מ נייר. נבנה גרף: צמתים = סמלים, קשתות = קישורים. משתמשים גם בקישורי גוף↔גוף (שרשור). מרכיבים רכיבי קשירות, ומסווגים כל רכיב לתבנית סעיף לפי מספר המפסקים ומספר הגופים: 1/1 → "נק' מאור כוללת מפסק", 2/1 → "שני מפסקים מחליפים", 1/2 → "שתי נק' משותפות", 1/3 → "שלוש נק'". גוף "קיים" עם מפסק חדש → "הוספת מפסק מחליף לנקודה קיימת". גוף בלי קישור עם חיישן → "ללא מפסק (חיישן)". מספרי מעגל לצד הסמל (למשל "a", "b") משמשים להכרעה בין קישורים מתחרים.
- **פלט:** `links` (from_detection, to_detection, path_geometry, conf), `link_groups` (pattern, members).
- **אותות:** מרחק קצה מהסמל, קצה שאין לו סמל ("קשת יתומה"), כמה סמלים מועמדים לקצה אחד, דפוס לא מוכר.
- **כשלים:** קשתות שחוצות זו את זו, קשת שמסתיימת על קיר, גופים בלי קשת. ביטחון ברירת מחדל נמוך, ותור בדיקה ייעודי.

### שלב 9 — סיווג קיים / חדש / להריסה
- **קלט:** פרימיטיבים, `detections`, מקרא קירות (אם קיים).
- **אלגוריתם:** אשכול צבעים לכל גיליון (k-means ב-Lab על צבעי stroke ו-fill). המיפוי צבע→סטטוס נלקח מהמקרא אם יש, ואחרת מברירת מחדל ארגונית (אדום = להריסה, צהוב = חדש, שחור או אפור = קיים), כפי שמופיע בגיליונות ההריסה והבנייה בדוגמה. גם סוג הקו נלקח בחשבון (מקווקוו לעומת רציף) ו-hatch מסוים. לכל detection נקבע סטטוס לפי הצבע הדומיננטי בפרימיטיביו, ולכל קיר לפי הצבע שלו. המשתמש מאשר את מיפוי הצבעים פעם אחת לגיליון (מסך אישור אחד).
- **פלט:** `detections.lifecycle` (existing/new/demolish), `wall_segments` עם סטטוס.
- **אותות:** מרחק הצבע ממרכז האשכול, האם יש מקרא צבעים, אישור משתמש.
- **כשלים:** הדפסה ב-monochrome, צהוב חלש על לבן (מבדילים לפי RGB ולא לפי רינדור), צבעי שכבה שאינם סמנטיים.

### שלב 10 — חישוב כמויות
- **קלט:** detections, rooms, links, lifecycle, scale, הגדרות פרויקט (גובה חיפוי, פחת).
- **אלגוריתם:** ספירה לכל (class, lifecycle, room, floor). שטח רצפה נטו = שטח הפוליגון במ"ר. חיפוי = היקף × גובה (משתמש), פחות פתחים (רוחב פתח × גובה פתח מתוך הגדרות ברירת מחדל: דלת 2.1 מ', חלון לפי קלט). כמות להזמנה = נטו × (1 + פחת). אינסטלציה: קבועות → נקודות לפי `conversion_rules` (למשל כיור = נק' מים חמים, קרים וניקוז). חשמל: `link_groups` → סעיפים מורכבים. **כל כמות נשמרת כביטוי** (`qty_expr`: רשימת detection_ids או חישוב גאומטרי עם פרמטרים), כך שהיא ניתנת לשחזור (NFR עקיבות).
- **פלט:** `quantity_facts` (מפתח: class/pattern, room, floor, lifecycle; ערך; expr; evidence_ids).
- **אותות:** ירושה מהרכיבים, `scale_conflict`, `room_closed`.
- **כשלים:** ספירה כפולה בין גיליונות (שקע שמופיע גם בתוכנית החשמל וגם באדריכלות). מענה: כל class מוגדר "גיליון סמכותי" לפי תחום, ויש dedupe מרחבי אחרי היישור.

### שלב 11 — מיפוי לסעיפים
- **קלט:** `quantity_facts`, `item_library` של הארגון, `symbol_item_mappings`, תבנית כתב כמויות.
- **אלגוריתם:** לכל class (legend entry או block name) או pattern: (1) אם יש מיפוי קיים בארגון, P = (אישורים + 1) / (אישורים + דחיות + 2). (2) אחרת, אחזור מועמדים לפי דמיון embedding בין תיאור המקרא לתיאורי הסעיפים (מודל מקומי `multilingual-e5-base` שרץ ב-worker, ואחסון ב-pgvector), בתוספת חוקים לפי מילות מפתח ("כח", "כפול", "תקשורת"), ונבחרים 3 המועמדים המובילים. (3) LLM רק כמכריע בין מועמדים כשהציון קרוב, ולא כמחולל סעיפים. אחרי זה נבנות `boq_lines` לפי פרקי התבנית, עם פירוק לפי קומה וחדר.
- **פלט:** `boq_lines`, `boq_line_evidence`.
- **אותות:** `mapping_prob`, `mapping_source` (learned/embedding/llm/manual), margin בין המועמדים.
- **כשלים:** סעיף שאין לו מקבילה בספרייה. השורה נוצרת כ"סעיף חדש מוצע" ומסומנת אדום.

### שלב 12 — ביטחון וכיול
- **רמת פריט (detection/link/room):** וקטור מאפיינים: `match_score`, `margin_to_second`, `in_legend`, `is_confusable_pair`, `source_kind`, `ocr_conf` (אם רלוונטי), `room_assigned`, `lifecycle_dist`, `scale_conflict`, `link_ambiguity`, צפיפות מקומית. המודל: logistic regression לכל משפחת class (ב-MVP), ו-LightGBM בשלב ב' כשיש מעל 5,000 פריטים מתויגים. הכיול: **isotonic regression** על holdout של פרויקטים, עם חלוקה לפי פרויקט ולא לפי פריט כדי למנוע דליפה. Platt משמש רק כשיש פחות מ-200 דוגמאות בתא.
- **כלל ירוק:** מחלקים את הציון המכויל ל-bins. פריט ירוק רק אם החסם התחתון של Wilson 95% של הדיוק ב-bin שלו ב-holdout הוא לפחות סף הארגון (ברירת מחדל 0.98). במצב "כיול שמרני" (פחות מ-30 פרויקטים) הסף מוחמר ל-0.99 על הציון הגולמי. צהוב: 0.85–ירוק. אדום: מתחת ל-0.85.
- **תקרות (hard caps):** רסטר → מקסימום צהוב. `scale_conflict` → שטחים באדום. סמל שלא במקרא → מקסימום צהוב. פריט שתוקן ידנית → `manual_confirmed`, נשאר קבוע בריצות חוזרות.
- **רמת שורה:** P(שורה נכונה) ≈ ∏ p_i של הפריטים, × p_mapping, × (1 − P(החמצה)). P(החמצה) נאמד מ-recall היסטורי לכל class וממספר מועמדים שנדחו קרוב לסף. **ציון סיכון** לתור הבדיקה = השפעה כמותית (מספר יחידות × משקל מחיר מוערך של הסעיף, וב-MVP משקל אחיד) × (1 − P).
- **סיבות:** כל מאפיין שתורם לירידה מעל סף מתורגם לקוד סיבה (`NOT_IN_LEGEND`, `SCALE_CONFLICT`, `RASTER_SOURCE`, `LINK_UNCERTAIN`, `ROOM_OPEN`, `LOW_OCR`, `CONFUSABLE_SYMBOL`, `MAPPING_UNCERTAIN`) עם טקסט עברי ב-i18n. שלוש הסיבות המובילות נשמרות לפי תרומה (מקדם × סטייה).
- **מודלי הכיול** נשמרים בטבלה `calibration_models` עם גרסה. כל ריצה רושמת באיזו גרסה השתמשה.

## מודל הנתונים

כל הטבלאות כוללות `id uuid pk default gen_random_uuid()`, `org_id uuid not null` (פרט ל-`orgs` ו-`users`), `created_at` ו-`updated_at`. **גאומטריה: PostGIS** (`geometry(Geometry, 0)`, מ"מ נייר), עם אינדקס GiST. נבחר על פני JSONB כי צריך שאילתות "בתוך חדר", לאסו בשרת, dedupe מרחבי ו-ST_Area, וכל אלה בתוך ה-DB ובאינדקס.

| טבלה | עמודות מפתח |
| --- | --- |
| `orgs` | name, slug, settings jsonb (`green_threshold`, `block_export_on_red`, `llm_enabled`, `llm_provider`, `llm_monthly_budget_usd`, `training_opt_in`, `default_waste_pct`) |
| `users` | id (= `auth.users.id`), full_name, locale |
| `memberships` | user_id, org_id, role enum(`admin`,`editor`,`reviewer`,`viewer`), unique(user_id, org_id) |
| `projects` | name, address, boq_template_id, status, default_cladding_height_m |
| `sheet_sets` | project_id, name, uploaded_by, source_file_path, source_sha256, file_kind |
| `sheets` | project_id, sheet_set_id, logical_key (מספר גיליון, מאפשר רצף גרסאות), discipline[], floor, title |
| `sheet_versions` | sheet_id, version_no, source_sha256, page_index, width_mm, height_mm, scale, scale_source, scale_conflict, is_raster, tiles_manifest_path, pipeline_state jsonb (סטטוס לכל שלב + גרסת שלב), title_block jsonb |
| `scale_regions` | sheet_version_id, geom, scale, source |
| `sheet_alignments` | from_sheet_version_id, to_sheet_version_id, transform float8[6], residual_mm |
| `text_spans` | sheet_version_id, geom, text, direction, height_mm, source, conf |
| `glyph_dictionary` | org_id, glyph_hash, char, source, conf |
| `legends` | sheet_version_id, scope enum(`sheet`,`set`), kind (electrical/lighting/walls), geom, parse_conf |
| `legend_entries` | legend_id, row_index, description, mount_height, fixture_type, template_hash, template_geometry (geometry), conf, confusable_with uuid[] |
| `symbol_templates` | org_id, project_id null, source enum(`legend`,`dxf_block`,`manual`,`learned`), name, geometry, anchor jsonb, embedding vector(768) null |
| `detections` | sheet_version_id, geom (point/polygon), template_id, legend_entry_id, rotation, primitive_ids int[], lifecycle, room_id, score_raw, confidence, level enum(`green`,`yellow`,`red`), reasons text[], features jsonb, status enum(`auto`,`accepted`,`rejected`,`edited`), source enum(`auto`,`manual`), run_id, superseded_by |
| `rooms` | sheet_version_id, floor, geom (polygon), name, name_conf, area_m2, perimeter_m, closed bool, source |
| `links` | sheet_version_id, from_detection_id, to_detection_id, path_geom, conf, status, source |
| `link_groups` | sheet_version_id, pattern, member_ids uuid[], conf |
| `boq_templates` | org_id, name, chapters jsonb (סדר, כותרות, הערות פרק), columns jsonb, xlsx_template_path |
| `item_library` | org_id, code, chapter, description, unit, embedding vector(768), tags, source_file |
| `symbol_item_mappings` | org_id, key_type (`template_hash`/`block_name`/`pattern`), key, item_id, accept_count, reject_count, last_used_at |
| `conversion_rules` | org_id, fixture_class, item_id, multiplier |
| `boq_lines` | project_id, item_id null, chapter, code, description, unit, quantity, quantity_override null, qty_expr jsonb, floor, room_id null, lifecycle, confidence, level, reasons, status enum(`draft`,`reviewed`,`approved`), approved_by, approved_at, locked bool |
| `boq_line_evidence` | boq_line_id, detection_id null, room_id null, link_group_id null, weight |
| `review_items` | project_id, target_type, target_id, risk_score, reason_codes, state |
| `audit_log` | actor_id, actor_kind (user/system/share), entity, entity_id, action, before jsonb, after jsonb, at (append-only, אין UPDATE/DELETE) |
| `share_links` | project_id, token_hash, scope jsonb, expires_at, revoked_at, created_by |
| `jobs` | project_id, sheet_version_id null, type, status, progress, stage, input_hash, attempts, error jsonb, cost_usd, started_at, finished_at |
| `pipeline_runs` | project_id, trigger, stage_versions jsonb, calibration_model_id |
| `calibration_models` | scope (global/org), family, version, params jsonb, holdout_metrics jsonb |
| `llm_calls` | org_id, purpose, provider, model, input_hash, tokens_in, tokens_out, cost_usd, latency_ms, cache_hit (בלי תוכן) |
| `exports` | project_id, kind, file_path, created_by, snapshot_hash |
| `ground_truth_annotations` | project_id, sheet_version_id, geom, class, item_code (ל-benchmark בלבד, org פנימי) |

**RLS:**
- custom access token hook ב-Supabase מוסיף ל-JWT את `org_ids` ואת התפקידים. פונקציית `auth.has_org_role(org uuid, min_role text)` היא `SECURITY DEFINER STABLE` וקוראת מ-`memberships`.
- כל טבלה: `USING (auth.has_org_role(org_id,'viewer'))`. כתיבה: `editor` (בבדיקה גם `reviewer` לטבלאות `detections`, `links`, `boq_lines.status`). ניהול: `admin`.
- NestJS מריץ כל בקשה בטרנזקציה עם JWT המשתמש (`set_config('request.jwt.claims', …, true)`, `set local role authenticated`). RLS הוא קו הגנה שני מעבר להרשאות ב-Guards של NestJS.
- Workers משתמשים ב-service role (עוקף RLS) אבל תמיד מקבלים `org_id` מה-job, ויש בדיקת CI שכל query ב-workers מסנן לפי `org_id`.
- **Storage:** נתיבים `org/{org_id}/...`, ומדיניות על `storage.objects` לפי `split_part(name,'/',2)::uuid`.
- **צופה חיצוני:** טוקן השיתוף מוחלף ב-API ל-JWT קצר (15 דק', מתחדש) עם `role=share_viewer` ו-`project_id`, חתום בסוד ה-JWT של Supabase. מדיניות RLS נפרדת ל-`share_viewer` מאפשרת רק SELECT על הפרויקט הזה.
- `orgs`/`audit_log`: append-only דרך trigger.

**גרסאות:** אין מחיקה פיזית של גיליונות (FR-02). העלאה חדשה יוצרת `sheet_version`. שורות שאושרו ידנית (`locked`) לא נדרסות בהרצה חוזרת: מיזוג לפי מפתח (item, floor, room, lifecycle) ודגל "השתנה מאז האישור".

## API

REST תחת `/v1`, JSON, אימות Bearer (JWT של Supabase). חוזים מוגדרים ב-Zod ב-`packages/contracts`, ומהם נוצרים OpenAPI ולקוח TS. כל רשימה עם cursor pagination.

**ארגונים ומשתמשים**
- `GET /me` · `GET/PATCH /orgs/:orgId` (הגדרות כולל `llm_enabled`) · `GET/POST/PATCH/DELETE /orgs/:orgId/members` · `POST /orgs/:orgId/invites`

**פרויקטים, סטים וגיליונות**
- `GET/POST /projects` · `GET/PATCH /projects/:id`
- `POST /projects/:id/uploads` → מחזיר signed upload URL (resumable, TUS של Supabase) · `POST /projects/:id/sheet-sets` (אחרי העלאה, מפעיל ingest)
- `GET /projects/:id/sheets` · `PATCH /sheets/:id` (אישור תחום, קומה) · `GET /sheet-versions/:id` (manifest, scale, מצב צנרת)
- `POST /sheet-versions/:id/scale` (כיול ידני: שתי נקודות + מרחק) · `POST /sheet-versions/:id/color-mapping`
- `POST /projects/:id/process` (הרצה מלאה או `{stages:[…], sheetVersionIds:[…]}`)

**מקרא, תבניות ומיפויים**
- `GET /sheet-versions/:id/legends` · `PATCH /legend-entries/:id` (תיאור, מיפוי לסעיף) · `POST /legend-entries` (הוספה ידנית)
- `GET/POST /symbol-templates` · `GET/PUT /symbol-item-mappings`

**זיהויים ותיקונים**
- `GET /sheet-versions/:id/detections?bbox=&class=&level=` (GeoJSON, בקואורדינטות מ"מ)
- `POST /sheet-versions/:id/detections` (הוספה ידנית) · `PATCH /detections/:id` · `POST /detections/bulk` (`{ids|lasso_polygon, action: accept|reject|reclass, legend_entry_id}`)
- `POST /detections/:id/find-similar` ("למד מהתיקון", מחזיר job) · `GET /projects/:id/unknown-symbols` · `POST /unknown-symbols/:clusterId/resolve`
- `GET/POST/PATCH /rooms` · `GET/PATCH /links` · `POST /measurements` (שטח או אורך ידני שהופך לראיה)

**כתב כמויות**
- `GET /projects/:id/boq?groupBy=floor|room|none` · `PATCH /boq-lines/:id` (override, סטטוס, הערה) · `POST /boq-lines/bulk-status`
- `GET /boq-lines/:id/evidence` · `GET /projects/:id/review-queue?sort=risk`
- `GET/POST /item-library` · `POST /item-library/import` (xls/xlsx) · `GET/POST/PATCH /boq-templates`

**ייצוא ושיתוף**
- `POST /projects/:id/exports` (`{kind: xlsx|pdf_markup, breakdown}`) → job · `GET /exports/:id` (signed URL)
- `POST/GET/DELETE /projects/:id/share-links` · `POST /share/:token/session` (מחזיר JWT צופה)

**Jobs ו-audit**
- `GET /jobs/:id` · `POST /jobs/:id/cancel` · `GET /projects/:id/audit`

**אירועי זמן אמת (Supabase Realtime):**
- ערוץ Broadcast `project:{id}`: `job.progress {jobId, stage, pct, sheetVersionId}`, `job.completed`, `job.failed`, `sheet.ready`, `boq.recomputed`. ה-workers מפרסמים דרך Realtime REST API.
- Postgres Changes (מסונן RLS) על `boq_lines`, `detections` ו-`review_items` של הפרויקט, כדי ששני בודקים יראו תיקונים זה של זה.
- Presence: מי צופה בגיליון (אינדיקציה בלבד).

## עיבוד אסינכרוני ותורים

**תורים (BullMQ):** `ingest`, `render`, `analyze` (שלבים 2–9 לגיליון), `project-aggregate` (שלבים 10–12), `learn` (find-similar, retrain mappings), `export`, `llm` (קריאות VLM, עם rate limiter נפרד). ה-workers ב-Python מאזינים ל-`ingest`, `render`, `analyze`, `project-aggregate`, `learn`, `llm`. ה-worker של Node מאזין ל-`export`.

**זרימה:** העלאה → `ingest` (פיצול לגיליונות) → FlowProducer: לכל גיליון `render` ו-`analyze` במקביל → כשכל הילדים מסתיימים, `project-aggregate`. כך מתקבלת מקביליות לפי גיליון (סט של 15 גיליונות פחות מ-10 דקות, עם 4 workers במקביל).

**Retries:** 3 ניסיונות, backoff אקספוננציאלי (10s, 60s, 5m). שגיאות מסווגות: `Transient` (רשת, LLM 429/5xx) → retry. `Permanent` (קובץ פגום, המרה נכשלה) → fail מיידי עם הודעה למשתמש. timeout לכל שלב (render ב-A0: 5 דקות). jobs שנכשלו סופית עוברים ל-DLQ ומתריעים ב-Sentry.

**Idempotency:** `jobId` = `sha256(type, sheet_version_id, stage_version, input_hash, settings_hash)`. BullMQ דוחה כפילות לפי jobId. כתיבה ל-DB בטרנזקציה עם `run_id`, וזיהויים קודמים מאותו שלב שלא תוקנו ידנית מסומנים `superseded_by`. upload חוזר של אותו קובץ (אותו sha256) בפרויקט מקשר לגרסה הקיימת.

**מטמון לפי hash:** artifacts נשמרים לפי `(source_sha256, page_index, stage, stage_version)`, ולכן עיבוד מחדש של אותו קובץ בפרויקט אחר באותו ארגון לא חוזר על render ו-OCR. קריאות LLM נשמרות במטמון לפי `sha256(model, prompt_version, image_bytes)` בטבלת `llm_cache`, עם TTL של 180 יום. מילון הגליפים הוא מטמון ברמת ארגון.

**התקדמות:** כל שלב מדווח `job.updateProgress({stage, pct})`. מאזין ב-NestJS (QueueEvents) מעדכן את `jobs` ומשדר ל-Realtime. ה-workers יכולים גם לשדר ישירות לחיסכון בזמן.

**משאבים:** pool `cpu-heavy` (render, analyze): 2 vCPU / 4GB, concurrency 1 לכל container, autoscale ידני 1–4 instances. pool `cpu-light` (llm, learn, aggregate): concurrency 4.

## שכבת ה-AI

**עיקרון:** ה-AI משמש כקורא ולא כסופר. הוא קורא טקסט מתמונות חתוכות ומכריע בין מועמדים מוגדרים, אבל לא סופר סמלים ולא ממציא סעיפים. כל פלט שלו עובר validation מול JSON schema (pydantic). פלט לא תקין מקבל ניסיון תיקון אחד, ואם גם הוא נכשל השלב ממשיך בלי AI ומוסיף סיבה `LOW_OCR`.

**מתי משתמשים:**
| מטרה | קלט | מודל ברירת מחדל |
| --- | --- | --- |
| תיוג גליפים SHX לא מוכרים | אצוות תמונות גליפים ממוספרים | VLM קטן (Claude Haiku-class / Gemini Flash) |
| פענוח טבלת מקרא ותיאורים | חיתוך הטבלה + טקסט OCR | VLM בינוני (Claude Sonnet-class) |
| טבלת כותרת | חיתוך הטבלה | VLM קטן |
| OCR fallback לשורה חשובה | חיתוך שורה 400dpi | VLM קטן |
| מתן שם לסמל לא מזוהה | תמונת אשכול + הקשר המקרא | VLM בינוני |
| הכרעת מיפוי סמל→סעיף | תיאור + 3 מועמדים | LLM קטן, טקסט בלבד |

**ניתוב:** `llm_gateway.call(purpose, org_id, payload)` בוחר מודל לפי טבלת `purpose → tier` ולפי ספק הארגון. ברירת מחדל: Anthropic Claude דרך AWS Bedrock ב-eu-central-1 (ללא אימון, ללא שמירת נתונים, נתונים נשארים ב-EU). חלופה: Gemini ב-Vertex AI europe-west4. Escalation: tier קטן, ואם הביטחון נמוך או ה-schema לא תקין, tier בינוני. כל prompt מנוהל בגרסאות (`prompts/{purpose}/v{n}.yaml`), וגרסת ה-prompt נכנסת ל-hash של המטמון.

**בקרת עלויות:** רק תמונות חתוכות (לעולם לא גיליון שלם), downscale לרזולוציה המינימלית הקריאה, אצוות גליפים, מטמון. תקציב חודשי לכל ארגון (`llm_monthly_budget_usd`, ברירת מחדל 30$). ב-80% נשלחת התראה, וב-100% ה-AI נכבה אוטומטית והצנרת ממשיכה בלי AI. תקרה גלובלית למערכת (למשל 200$ בחודש) עם circuit breaker ב-Redis. העלות נרשמת ב-`llm_calls` וב-`jobs.cost_usd`.

**Kill switch לארגון:** `orgs.settings.llm_enabled=false` נבדק בכל קריאה (ונשמר במטמון 30 שניות ב-Redis). כשהמתג כבוי: OCR מקומי בלבד, מקרא מפוענח בכללים, ושורות שתלויות ב-AI מקבלות תקרת צהוב. יש גם מתג גלובלי במשתני סביבה.

**no-training ופרטיות:** חוזים וקונפיגורציה רק מול endpoints ארגוניים עם zero data retention. אין שליחת טבלת כותרת עם שם הלקוח או כתובת כשאין צורך: לפני שליחה לצורך פענוח מקרא, התאים "שם הפרויקט" ו"כתובת" מוסתרים. אנונימיזציה זו חובה גם לשימוש באימון בהסכמה (FR-33).

**מדיניות לוגים:** ב-`llm_calls` נשמרים מטא-דאטה בלבד (purpose, model, hash, tokens, עלות, latency, תוצאת validation). תוכן ה-prompt והתגובה **לא** נשמר כברירת מחדל. במצב debug לארגון פנימי (benchmark) אפשר לשמור תוכן ל-14 יום ב-Storage מוצפן. התגובה המובנית עצמה נשמרת כתוצר עסקי (למשל טקסט המקרא) בטבלאות הרגילות.

## מציג השרטוטים

**החלטה: Deck.gl** עם `OrthographicView` בקואורדינטות מ"מ נייר. נשקלו OpenSeadragon (מצוין לאריחים, אבל overlay וקטורי רב-פריטים דורש שכבה נוספת), Konva (Canvas2D, לא מחזיק עשרות אלפי פריטים ב-60fps) ו-PixiJS (גמיש, אבל בלי tiling ו-picking מוכנים). Deck.gl נותן ב-WebGL גם `TileLayer` לאריחים, גם שכבות וקטור עם GPU picking, וגם עדכון יעיל של attributes.

**שכבות (מלמטה למעלה):** `TileLayer` + `BitmapLayer` (אריחי WebP, LOD לפי zoom) → `PolygonLayer` חדרים (מילוי שקוף לפי סעיף ריצוף) → `PathLayer` קישורים → `ScatterplotLayer`/`IconLayer` זיהויים (צבע לפי סעיף, מסגרת לפי רמת ביטחון) → שכבת בחירה ועריכה (`@deck.gl-community/editable-layers` ללאסו, פוליגון ומדידה) → HTML overlay לתוויות ולתפריט הקשר.

**מערכות קואורדינטות:**
1. **Paper mm** (קנונית, ב-DB): ראשית בפינה השמאלית העליונה, y כלפי מטה.
2. **Tile px**: `px = mm × px_per_mm(z)`. ה-manifest מגדיר את היחס.
3. **World m**: `m = mm × scale / 1000`, לפי `scale_regions`. משמש למדידה ולתצוגת שטחים.
4. **Screen**: מנוהל על ידי Deck.gl.

כל ההמרות מרוכזות ב-`packages/geometry` (TS) ובמודול Python מקביל, עם בדיקות round-trip משותפות (fixtures ב-JSON).

**בחירה ו-hit-testing:** לחיצה מטופלת ב-GPU picking של Deck.gl (`pickObject` עם radius של 6px). לאסו: אינדקס `flatbush` בצד הלקוח על נקודות הזיהויים, סינון לפי bbox, ואז point-in-polygon (`robust-point-in-polygon`). פעולות גדולות (מעל 500 פריטים) נשלחות כפוליגון לשרת (`ST_Within`). חלון קישור הדדי: לחיצה על שורה ב-BOQ מבצעת zoom-to-fit על הראיות ומדגישה אותן, ולחיצה על סמל גוללת לשורה.

**ביצועים:** אריחים 512px WebP (q=80), prefetch של רמה אחת, מטמון LRU של 300 אריחים. נתוני ה-overlay נטענים לפי viewport (`bbox` query) רק כשיש מעל 20,000 פריטים, ואחרת נטען הכל לגיליון (A3 טיפוסי: 300–2,000 פריטים). עדכונים אופטימיים עם `updateTriggers`. **יעדים:** 60fps בגלילה וזום ב-A0 עם 50,000 פריטים על Chrome במחשב נייד ממוצע. זמן ממסך הפתיחה לגיליון ראשון מתחת ל-1.5 שניות. תגובה ללחיצה מתחת ל-50ms. האריחים מוגשים מ-Supabase Storage עם access token של המשתמש ו-`Cache-Control: private, max-age=31536000, immutable`, כי הנתיב כולל את ה-hash.

**RTL:** מעטפת האפליקציה RTL, ה-canvas תמיד LTR. קיצורי מקלדת: A הוספה, D מחיקה, L לאסו, M מדידה, Space+גרירה להזזה.

## ייצוא

**Excel: exceljs ב-worker של Node** (נבחר על פני openpyxl כי הלוגיקה של התבניות והפורמט העסקי יושבת ב-NestJS, ו-exceljs שומר עיצוב, merged cells, RTL וגופנים). התהליך:
1. טוענים `xlsx_template_path` של התבנית (ברירת מחדל: שחזור מבנה הדוגמה, כלומר גיליונות "כותרת", "חוזה" ו"כמויות", עמודות "סעיף | תאור העבודה | יחידה | כמות סה"כ | מחיר יח' | סה"כ ₪", פרקים עם הערות ושורת סה"כ).
2. מילוי לפי פרקים, מספור סעיפים לפי מוסכמת הארגון (`4.01`, `4.1`). עמודות המחיר נשארות ריקות, ונוסחאות `=D*E` ו-SUM לכל פרק נשמרות כנוסחאות.
3. עמודה נוספת "סטטוס ביטחון" (מאומת, סביר, לבדיקה) עם עיצוב מותנה, ועמודת "הערות ראיה" (למשל "16 גופים, 4 גיליונות"). מצב "מפורק" מוסיף גיליון לפי קומה וחדר.
4. אזהרה בראש הקובץ אם יש פריטים לא מאומתים. אם הגדרת הארגון היא `block_export_on_red` ויש שורות אדומות, הייצוא נחסם (409) עם רשימת השורות.
5. ייבוא (FR-16) משתמש באותו פרסר בכיוון ההפוך: זיהוי שורות "סעיף | תאור | יחידה" ופרקים "פרק NN – …".

**PDF מסומן: pdf-lib (Node)** על קובץ ה-PDF המקורי, כך שהשרטוט נשאר וקטורי וחד. לכל זיהוי מצויר סימון צבעוני לפי סעיף (מעגל או פוליגון שקוף), לחדרים מצוירים מילוי ותווית שטח, ולכל גיליון נוסף עמוד מקרא צבעים (סעיף → צבע → כמות). למקורות DXF ו-PNG משתמשים ב-PDF המרונדר משלב 1. גופן עברי מוטמע (Noto Sans Hebrew).

**קישורי שיתוף:** טוקן אקראי של 32 בתים (נשמר כ-hash), תוקף ברירת מחדל 14 יום, ביטול מיידי. הצופה רואה כתב כמויות ומציג עם ראיות, בלי כלי עריכה ובלי מחירים אם הוגדר. כל צפייה נרשמת ב-`audit_log` עם `actor_kind=share`.

כל ייצוא נשמר כ-`exports` עם `snapshot_hash` של מצב השורות, לשחזור עתידי ולהשוואת גרסאות בשלב ב'.

## תשתית ופריסה

**סביבות:**
| סביבה | Supabase | Railway | Vercel | נתונים |
| --- | --- | --- | --- | --- |
| dev (מקומי) | Supabase CLI (Docker) | docker-compose: api, worker, redis | `vite dev` | seed + פרויקט הדוגמה |
| staging | פרויקט Supabase נפרד (Pro, eu-central-1) | environment "staging" | Preview deployments | פרויקטי benchmark בלבד |
| prod | פרויקט Supabase (Pro, eu-central-1), PITR כשיש לקוחות משלמים | environment "production", EU West | Production | נתוני לקוחות |

Vercel משרת רק נכסים סטטיים, ואין שום נתוני לקוח שעוברים דרכו. ה-API וה-Storage נמצאים ב-EU. רוב השמירה מתבצעת ב-Supabase, ו-Redis מכיל רק מזהים ומטא-דאטה של jobs (לא תוכן שרטוטים).

**סודות:** Railway ו-Vercel environment variables לכל סביבה, ו-GitHub Actions secrets ל-deploy. מפתח service role של Supabase נמצא רק ב-workers וב-API, אף פעם לא בפרונט. מפתחות LLM נשמרים ב-AWS (Bedrock דרך IAM role עם access key מוגבל ל-`bedrock:InvokeModel` באזור אחד). רוטציה רבעונית.

**CI/CD (GitHub Actions):**
- על כל PR: lint, typecheck, unit (Vitest, pytest), בדיקת מיגרציות (`supabase db reset` + pgTAP לבדיקות RLS), build, ו-**benchmark** על פרויקט הדוגמה ועל קבוצת benchmark (job נפרד, מתחת ל-15 דקות). ירידה של מעל 0.5 נקודות אחוז ב-precision או recall לכל משפחה, או בכיול (ECE), חוסמת מיזוג. Playwright E2E על preview.
- על merge ל-`main`: מיגרציות ל-staging, deploy של API ו-workers ל-staging (Railway מ-GHCR images), ו-Vercel preview→staging.
- release tag: promote ל-prod עם אישור ידני (environment protection).
- Docker images: `apps/api` (node:20-slim), `workers/drawing` (python:3.12-slim + tesseract-ocr-heb + libredwg), שנבנים עם uv ו-layer caching.

**הערכת עלות חודשית ל-MVP (3–5 משרדים, כ-40 פרויקטים בחודש):**
| פריט | USD/חודש |
| --- | --- |
| Vercel Pro (מושב אחד) | 20 |
| Supabase Pro prod + compute small | 35 |
| Supabase staging (Pro, micro) | 25 |
| Storage (~100GB אריחים ומקורות) + egress | 10–20 |
| Railway: API (1×0.5vCPU/1GB), export worker, Redis | 25 |
| Railway: workers heavy (2–4 × 2vCPU/4GB, לפי שימוש) | 60–120 |
| LLM/VLM (עם מטמון ומילון גליפים) | 40–120 |
| Sentry Team | 26 |
| PostHog EU (free tier), Grafana Cloud (free tier) | 0 |
| **סה"כ** | **~240–390** |

## מבנה הריפו

ריפו GitHub חדש, monorepo עם **pnpm workspaces + Turborepo** ל-TS ו-**uv** ל-Python (workspace עם `pyproject.toml` לכל חבילה, ו-`uv.lock` אחד).

```
kamutan/
├─ apps/
│  ├─ web/                 # React + Vite + Tailwind + shadcn (RTL)
│  └─ api/                 # NestJS (modules: orgs, projects, sheets, detections, boq, library, exports, share, jobs)
│     └─ src/workers/export.ts   # process נפרד, אותו קוד
├─ workers/
│  └─ drawing/             # Python: ingest/, render/, ocr/, titleblock/, scale/, legend/, symbols/,
│                          #   rooms/, links/, lifecycle/, quantities/, mapping/, confidence/, llm_gateway/
├─ packages/
│  ├─ contracts/           # Zod schemas (מקור אמת ל-DTO ול-payloads של jobs) → OpenAPI + JSON Schema
│  ├─ shared-types/        # טיפוסים שנוצרים: supabase gen types + מ-contracts
│  ├─ viewer/              # רכיב Deck.gl (מבודד, עם Storybook)
│  ├─ geometry/            # המרות קואורדינטות TS + fixtures משותפים
│  └─ ui/                  # רכיבי shadcn מותאמים, טוקנים
├─ py-packages/
│  ├─ kamutan_contracts/   # pydantic שנוצר מ-JSON Schema (datamodel-code-generator)
│  └─ kamutan_geometry/    # מקבילה ל-packages/geometry
├─ supabase/
│  ├─ migrations/          # SQL (מקור אמת לסכמה), policies, functions
│  └─ tests/               # pgTAP ל-RLS
├─ benchmark/
│  ├─ datasets/            # מניפסטים (הקבצים עצמם ב-Storage פרטי, לא בגיט)
│  ├─ annotations/         # GeoJSON של אמת
│  ├─ runner/              # הרצת הצנרת והשוואה, precision/recall/ECE לכל משפחה
│  └─ reports/
├─ infra/
│  ├─ docker/              # Dockerfiles, docker-compose.dev.yml
│  ├─ railway/             # railway.json לכל שירות
│  └─ github/              # workflows
└─ docs/adr/               # Architecture Decision Records
```

**יצירת טיפוסים משותפים:** `packages/contracts` (Zod) → `zod-to-json-schema` → `datamodel-code-generator` → pydantic ב-`kamutan_contracts`. Payloads של jobs ושל אירועי realtime מוגדרים רק שם. טיפוסי ה-DB נוצרים עם `supabase gen types typescript`, וב-Python נכתבים מודלים ידניים לטבלאות הצנרת עם בדיקת CI שמשווה אותם לסכמה. `turbo run gen` רץ ב-CI, ו-diff לא ריק מכשיל את ה-build.

## תצפיות וניטור

- **Sentry:** web (כולל Session Replay עם מסכת טקסט), api ו-workers (sentry-sdk Python). release לכל deploy ו-source maps. התראות על שגיאות חדשות ועל jobs ב-DLQ.
- **OpenTelemetry:** traces מה-API (auto-instrumentation ל-HTTP, pg, BullMQ) ומה-workers. ה-`traceparent` מועבר ב-payload של ה-job, כך שיש trace אחד מהעלאה ועד כתב כמויות. span לכל שלב צנרת עם attributes (`sheet_version_id`, `stage`, `primitive_count`, `cache_hit`). יצוא ל-Grafana Cloud (Tempo, Loki ל-logs של pino ו-structlog, Prometheus למטריקות).
- **מטריקות מפתח:** משך כל שלב (p50/p95) לפי גודל גיליון, אורך תורים, שיעור כשלים לפי שלב, עלות LLM לפי ארגון ו-purpose, cache hit rate, שיעור גליפים שזוהו בלי VLM, וזמן ממסך ראשון לגיליון.
- **PostHog (EU Cloud):** אירועי מוצר: יצירת פרויקט, העלאה, אישור סיווג, תיקונים (סוג, class, לפני ואחרי), זמן בתור בדיקה, ייצוא. מדד הצלחה 1 (זמן לכתב כמויות מאומת) נגזר מכאן. **אין** שליחת תוכן שרטוטים או שמות פרויקטים.
- **דשבורד benchmark:** כל ריצת CI ו-nightly כותבת תוצאות ל-`benchmark_runs` ב-Supabase הפנימי. דשבורד Grafana מציג precision/recall לכל משפחת סמל, דיוק כמות לשורה, reliability diagram ו-ECE, ושיעור ירוקים שגויים (חייב להיות 2% ומטה), כולם לאורך זמן ולפי commit.
- **לולאת תיקונים:** כל תיקון משתמש הוא תווית. דוח שבועי של "ירוקים שתוקנו" לכל ארגון. חריגה מסף מפעילה מעבר אוטומטי למצב "כיול שמרני" עבור ה-class הזה.

## סיכונים טכניים והחלטות פתוחות

| # | סיכון / החלטה פתוחה | השפעה | מענה / המלצה | בעלים, מועד |
| --- | --- | --- | --- | --- |
| 1 | OCR עברי על SHX לא מספיק טוב | אין מקרא, שמות חדרים וטבלת כותרת | מילון גליפים + VLM על חיתוכים. ספייק בשבוע 1: יעד קריאה של 95% מהתווים במקרא של פרויקט הדוגמה | מהנדס קליטה, ספרינט 0 |
| 2 | רישוי המרת DWG (ODA מול LibreDWG) | DWG לא נקלט או לא חוקי | MVP: LibreDWG בקונטיינר מבודד + בקשת DXF/PDF כגיבוי. **פתוח:** בדיקת עלות חברות ב-ODA מול שיעור DWG בפועל אצל השותפים | ארכיטקט + משפטי, סוף ספרינט 1 |
| 3 | מעט פרויקטי אמת לכיול | ירוק לא אמין | מצב "כיול שמרני", חלוקת holdout לפי פרויקט, ותיקוני משתמשים כתוויות. 30 פרויקטים עד הבטא | מהנדס נתונים |
| 4 | סמלים "מבלבלים" (שקע כפול לעומת שקע כח) | ספירות שגויות בין סעיפים | זיהוי זוגות מבלבלים מהמקרא, ספים מחמירים ו-margin כמאפיין ביטחון | מהנדס זיהוי |
| 5 | קישור מפסק↔גוף בקשתות חוצות | סעיפים מורכבים שגויים | גרף + מספרי מעגל, ביטחון ברירת מחדל צהוב, תור ייעודי | מהנדס זיהוי |
| 6 | ספירה כפולה בין גיליונות | כמויות מנופחות | גיליון סמכותי לכל משפחה + dedupe מרחבי אחרי יישור | מהנדס כמויות |
| 7 | גיליון עם כמה קני מידה | שטחים שגויים | `scale_regions` לפי viewport, אזהרה, כיול ידני | מהנדס קליטה |
| 8 | ביצועי Deck.gl בטאבלט או Safari | חוויה איטית | הורדת LOD, הגבלת מספר הפריטים לפי viewport, בדיקות ביצועים ב-CI (Playwright trace) | פרונט מציג |
| 9 | Supabase Realtime + RLS בעומס | אירועים מאוחרים או חסרים | Broadcast לאירועי jobs (בלי RLS לכל שורה), ו-Postgres Changes רק לטבלאות קטנות. polling כגיבוי | בקאנד |
| 10 | עלות LLM חורגת | תקציב | מטמון, אצוות, תקציב לארגון, circuit breaker גלובלי | DevOps |
| 11 | Railway כ-SPOF ומגבלות משאבים ל-A0 | זמני עיבוד | images ניידים. Cloud Run Jobs (europe-west4) כנתיב ל-cpu-heavy כשצריך. **פתוח:** מעבר אם p95 של גיליון A0 עולה על 3 דקות | DevOps, ספרינט 5 |
| 12 | אי-התאמה בין השרטוט לאקסל הדוגמה (שקעים 42 מול 51) | benchmark מטעה | **פתוח:** אישור מהמשתמש שהגרסאות זהות. עד אז ה-benchmark מבוסס על סימון ידני של השרטוט ולא על האקסל | מנהל פיתוח |
| 13 | רישוי מודלים ו-OCR (Surya GPL, Ultralytics AGPL) | חשיפה משפטית | רק Apache/MIT/BSD בייצור (Tesseract, PaddleOCR, RT-DETR דרך HF) | ארכיטקט |
| 14 | עמידה בתיקון 13 לחוק הגנת הפרטיות | רגולציה | אחסון ב-EU, DPA מול Supabase, AWS ו-Sentry, רישום מאגר אם נדרש, אנונימיזציה לפני LLM, מחיקת ארגון לפי בקשה | מומחה אבטחה, ספרינט 5 |
| 15 | **פתוח:** האם לאפשר PostGIS גם ב-share_viewer או להחזיר GeoJSON מוכן מה-API | פשטות מול ביצועים | המלצה: הצופה החיצוני עובר תמיד דרך ה-API (endpoint read-only) ולא ישירות ל-DB | בקאנד |
