# ADR-0007: מדיניות LLM gateway

- **סטטוס:** התקבל
- **תאריך:** 2026-10-11
- **מקורות:** 04_architecture ("שכבת ה-AI"), 06_security (SEC-30–34), 08_workplan_v2 §2 (הכרעות 4, 5), review_consistency (סתירות 3, 4, 16)

## הקשר

ה-LLM/VLM משמש כ"קורא" של אזורי טקסט חתוכים (גליפים, מקרא, תוויות). שליחת קטעי שרטוט לספק חיצוני היא העברת מידע C3 לצד שלישי ולעתים מחוץ לישראל, עם סיכוני אימון, retention, prompt injection ודליפה ללוגים.

## החלטה

1. **נקודה אחת:** כל קריאת LLM/VLM עוברת ב-`workers/drawing/**/llm_gateway/` (`llm_gateway.call(purpose, org_id, payload)`). ייבוא SDK של ספק מחוץ ל-gateway חסום ב-Semgrep (`kamutan-llm-sdk-outside-gateway`, ובקוד TS בכלל). השינויים ב-gateway דורשים CODEOWNERS.
2. **ספקים:** רק API ארגוני עם התחייבות חוזית ל-**no-training** ו-retention מינימלי/zero-data-retention, **אזור EU**: ברירת מחדל Claude דרך AWS Bedrock eu-central-1; חלופה Gemini ב-Vertex europe-west4. **DPA חתום** לפני ספרינט 2. אין ממשקי צרכן.
3. **מזעור:** רק חיתוכים (לעולם לא גיליון מלא), downscale מינימלי קריא, הסרת metadata.
4. **טבלת הכותרת לא נשלחת לעולם.** סיווג גיליון נעשה מקומית (מילון גליפים + OCR). מותר לשלוח רק תאים ללא מידע אישי (תחום, שם גיליון, קנ"מ); שם לקוח וכתובת מוסתרים תמיד (שני שלבים: חיתוך + בדיקת PII בצד ה-gateway).
5. **Kill switch:** `orgs.settings.llm_enabled` נבדק **בכל קריאה** (cache של 30 שניות), ומתג גלובלי במשתנה סביבה. כשכבוי — הצנרת ממשיכה ב-OCR מקומי וכללים, וביטחון יורד בהתאם. שינוי המתג נרשם ב-audit. תקציב חודשי לארגון (80% התראה, 100% כיבוי אוטומטי) ו-circuit breaker גלובלי.
6. **Prompt injection:** טקסט מהשרטוט מועבר כנתון תחום (delimited), למודל אין כלים ואין רשת, הפלט חייב לעבור JSON schema (pydantic); ניסיון תיקון אחד ואז fallback ללא AI. ה-LLM לא קובע הרשאות, סטטוס "אושר" או ירוק (ADR-0004).
7. **לוגים:** נשמרים רק purpose, model, hash, tokens, עלות, latency ותוצאת validation. **אין prompts, תמונות או תשובות** בלוגים, Sentry או OTel.
8. **מטמון:** מפתח `sha256(org_id, model, prompt_version, image_bytes)` — לא משותף בין ארגונים; נמחק עם הפרויקט.

## השלכות

- (+) מקום אחד לאכיפת פרטיות, עלות ומדיניות; המערכת עובדת גם כשה-AI כבוי.
- (−) תלות בחוזה DPA לפני שימוש אמיתי; עד אז רק נתונים סינתטיים/מאושרים.
- (−) בדיקות חובה ב-CI לכל שינוי ב-gateway: סט prompt injection (עברית ואנגלית), בדיקת חסימת טבלת כותרת, בדיקת kill switch.
