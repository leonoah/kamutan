/**
 * Sprint 9 strings — input-quality gate (raster input: low resolution, mirrored, dark CAD screenshot …).
 * Merged into `he` (src/i18n/he.ts). The issue titles / actions equal the contracts' `QUALITY_ISSUE_HE`
 * (packages/contracts/src/quality.ts) — `features/quality/quality.test.ts` pins that, so the worker's reason chip and the
 * UI read the same. Singular imperative ("העלה …") as in the Sprint 9 brief.
 */
export const sprint9He = {
  quality: {
    issue: {
      low_resolution: "רזולוציה נמוכה מדי",
      low_resolutionDpi: "רזולוציה נמוכה מדי (כ-{{dpi}} dpi)",
      mirrored: "הקובץ הפוך (מראה)",
      dark_background: "רקע כהה (צילום ממסך תוכנת CAD)",
      screenshot: "צילום מסך ולא קובץ שרטוט",
      partial_crop: "חלק מהגיליון חסר (אין מסגרת או טבלת כותרת)",
      blurred: "התמונה מטושטשת",
      unknown: "בעיה באיכות הקובץ",
    },
    action: {
      low_resolution: "העלה את קובץ ה-PDF המקורי מתוכנת השרטוט, או סריקה ברזולוציה של 200 dpi לפחות.",
      mirrored: "העלה את קובץ ה-PDF המקורי מתוכנת השרטוט, או הפוך את התמונה בחזרה לפני ההעלאה.",
      dark_background: "העלה את קובץ ה-PDF המקורי מתוכנת השרטוט, או ייצא את השרטוט על רקע לבן.",
      screenshot: "העלה את קובץ ה-PDF המקורי מתוכנת השרטוט במקום צילום מסך.",
      partial_crop: "העלה את הגיליון המלא, כולל המסגרת וטבלת הכותרת.",
      blurred: "העלה את קובץ ה-PDF המקורי מתוכנת השרטוט, או סריקה חדה יותר.",
      unknown: "העלה את קובץ ה-PDF המקורי מתוכנת השרטוט.",
    },
    status: {
      ok: "איכות הקובץ תקינה",
      warn: "איכות הקובץ ירודה",
      reject: "איכות הקובץ נמוכה מדי לספירה",
    },
    /** Short chips (gallery tile, sheet card, processing list). */
    badge: {
      warn: "איכות ירודה",
      reject: "לא נספר",
    },
    badgeHint: {
      warn: "איכות הקובץ ירודה: כל הפריטים בגיליון מסומנים לבדיקה",
      reject: "איכות הקובץ נמוכה מדי: לא ספרנו פריטים בגיליון הזה",
    },
    warnBanner: 'איכות הקובץ ירודה. ספרנו את הפריטים, אבל כולם מסומנים לבדיקה ולא יסומנו "מאומת".',
    rejectBanner: "לא ספרנו פריטים בגיליון הזה, כי איכות הקובץ נמוכה מדי. השרטוט מוצג לעיון בלבד.",
    whatToDo: "מה לעשות",
    issuesLabel: "בעיות שנמצאו בקובץ",
    reuploadOriginal: "העלה קובץ מקורי",
    reuploadOriginalFor: "העלה קובץ מקורי במקום {{name}}",
    showDetails: "פרטים",
    /** Counts tab of a rejected sheet. */
    countsRejectedTitle: "לא נספרו פריטים",
    countsRejected: "איכות הקובץ נמוכה מדי, ולכן לא ספרנו את הסמלים בגיליון הזה. אפשר לעיין בשרטוט; לספירה העלה קובץ מקורי.",
    /** Processing panel section. */
    panelTitle: "איכות קבצים",
    panelSummary_one: "גיליון אחד עם בעיית איכות",
    panelSummary_two: "2 גיליונות עם בעיית איכות",
    panelSummary_other: "{{count}} גיליונות עם בעיית איכות",
    open: "פתיחת הגיליון",
    /** Reason chip on items of a warn sheet (the worker writes "איכות קובץ ירודה: …"). */
    reasonChip: "איכות קובץ ירודה",
    reasonHint: "הגיליון הוא תמונה באיכות ירודה, ולכן הפריט לא יסומן \"מאומת\" עד שתבדוק אותו.",
    tileNotCounted: "לא נספרו פריטים",
  },
  projectErrors: {
    input_quality_rejected: "איכות הקובץ נמוכה מדי לספירה. העלה את קובץ ה-PDF המקורי מתוכנת השרטוט.",
  },
} as const;
