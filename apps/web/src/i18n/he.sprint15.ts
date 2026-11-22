/**
 * Sprint 15 strings — "סעיפים שלא זוהו" (the missing-items worklist, docs/spec/11_missing_items_worklist.md).
 * Merged into `he` (src/i18n/he.ts) as `missing`. Plain words, no tool jargon.
 */
export const sprint15He = {
  missing: {
    tab: "סעיפים שלא זוהו",
    title: "סעיפים שלא זוהו",
    filtersLabel: "סינון הסעיפים",
    filter: { all: "הכל", in_project: "בפרויקט", not_relevant: "לא רלוונטי" },
    counter_other: "{{count}} סעיפים",
    counter_one: "סעיף אחד",
    counter_two: "שני סעיפים",
    summary: "{{open}} סעיפים פתוחים · {{hidden}} לא רלוונטיים",
    intro: "סעיפים מהספרייה שאין להם כמות בפרויקט. סמנו אותם בשרטוט, או קבעו שאינם רלוונטיים כאן.",
    originNoLine: "אין שורה בכתב הכמויות",
    originZero: "כמות 0",
    hiddenBy: "סומן כלא רלוונטי",
    hiddenReasonPrefix: "סיבה:",
    notBuilt: "עוד אין כתב כמויות. בנו אותו כדי לראות אילו סעיפים לא זוהו.",
    emptyAll: "כל סעיפי הספרייה מופיעים בכתב הכמויות עם כמות.",
    emptyOpen: "אין סעיפים פתוחים. כל מה שלא זוהה סומן כלא רלוונטי.",
    emptyHidden: "לא סומנו סעיפים כלא רלוונטיים.",
    loadError: "לא הצלחנו לטעון את הרשימה. נסו שוב.",
    retry: "נסו שוב",
    actions: {
      notRelevant: "לא רלוונטי בפרויקט הזה",
      restore: "החזר",
      mark: "סמן בשרטוט",
    },
    markHint: { count: "ספרו את המופעים בשרטוט", measure_area: "סמנו את השטח בשרטוט", measure_length: "סמנו את האורך בשרטוט" },
    lumpSum: "סעיף חד-פעמי: אין מה לסמן בשרטוט",
    notRelevantDone: "הסעיף {{code}} סומן כלא רלוונטי בפרויקט הזה.",
    restoredDone: "הסעיף {{code}} הוחזר לכתב הכמויות.",
    undo: "בטל",
    error: "לא הצלחנו לשמור. נסו שוב.",
    notAllowed: "אין לך הרשאה לשנות סעיפים.",
    markBanner: { count: "ספירה לסעיף", measure_area: "מדידת שטח לסעיף", measure_length: "מדידת אורך לסעיף" },
    markCancel: "ביטול הסימון",
    markNoSheet: "אין גיליון מוכן לסימון.",
    marked: "נשמרה כמות ידנית לסעיף {{code}}: {{qty}} {{unit}}.",
    markError: "לא הצלחנו לשמור את הסימון. נסו שוב.",
  },
} as const;
