import type { BoqChapter, BoqRule, BoqTemplate, LibraryItem } from "@/api/types";

/**
 * Sprint 3 mock seeds: the org item library (chapter 04 + the lighting install line, as in the client's sample
 * BOQ format), the default template and the default rule set (brief "Domain rules"). Synthetic — only the item
 * wording follows the sample's style; codes are TEXT.
 */

export const CH04_NOTES = [
  "כל העבודות יבוצעו בהתאם למפרט הסטנדרטי הבין משרדי לעבודות חשמל ע\"י חשמלאי מוסמך.",
  "תמחור כלל עבודות יתבצע על בסיס תכניות החשמל.",
  "לכמויות ופרוט ראה תכניות חשמל מצורפות.",
  "יש לקרוא פירוט זה בקפידה וביחד עם תכנית חשמל ותאורה.",
];

export const DEFAULT_CHAPTERS: BoqChapter[] = [
  { code: "01", title: "פרק 01 - עבודות הריסה ופינוי", notes: ["כלל הפינויים יהיו לשפך העירייה."] },
  { code: "02", title: "פרק 02 - עבודות בנייה", notes: [] },
  { code: "03", title: "פרק 03 – עבודות אינסטלציה", notes: [] },
  { code: "04", title: "פרק 04 – עבודות חשמל", notes: CH04_NOTES },
  { code: "05", title: "פרק 05 - עבודות ריצוף, חיפוי ואיטום", notes: [] },
  { code: "06", title: "פרק 06 - עבודות גבס", notes: [] },
  { code: "07", title: "פרק 07 - עבודות שפכטל, טיח וצבע", notes: [] },
  { code: "08", title: "פרק 08 - שונות", notes: [] },
];

export const DEFAULT_TEMPLATE: BoqTemplate = {
  id: "tpl-default",
  name: "תבנית ברירת מחדל (לפי כתב הכמויות לדוגמה)",
  chapters: DEFAULT_CHAPTERS,
  columns: ["סעיף", "תאור העבודה", "יחידה", "כמות סה\"כ", "מחיר יח'", "סה\"כ ₪"],
  titleRows: ["כתב כמויות", "{{projectName}}"],
  default: true,
  updatedAt: "2026-10-11T10:00:00.000Z",
};

export const SECOND_TEMPLATE: BoqTemplate = {
  id: "tpl-compact",
  name: "תבנית מקוצרת (חשמל ותאורה בלבד)",
  chapters: DEFAULT_CHAPTERS.filter((c) => c.code === "04" || c.code === "08"),
  columns: ["סעיף", "תאור העבודה", "יחידה", "כמות"],
  titleRows: ["כתב כמויות — חשמל"],
  default: false,
  updatedAt: "2026-10-12T09:00:00.000Z",
};

/** [code, chapter, description, unit, tags] */
const ITEMS: [string, string, string, string, string[]][] = [
  ["4.00", "04", "שקע בודד", "יחידה", ["socket_single"]],
  ["4.01", "04", "שקע כפול", "יחידה", ["socket_double"]],
  ["4.02", "04", "אביזר שלישיית שקעים", "יחידה", ["socket_triple"]],
  ["4.03", "04", "שקע כח", "יחידה", ["socket_power"]],
  ["4.04", "04", "שקע כח כפול", "יחידה", ["socket_power_double"]],
  ["4.05", "04", "נק' תקשורת (כבלים/ טלפון/ רשת) הכנה עם חוט משיכה", "יחידה", ["data_point", "tv_point", "phone_point"]],
  ["4.06", "04", "אביזר עדה פלאסט הכולל 6 שקעים, נק' כבלים, נק' טלפון ונק' רשת", "יחידה", ["socket_box_6"]],
  ["4.07", "04", "נק' קצה לרמקול", "יחידה", ["speaker"]],
  ["4.09", "04", "נק' מאור כוללת מפסק", "יחידה", ["lighting", "single"]],
  ["4.10", "04", "נק' מאור בעלת שני מפסקים מחליפים", "יחידה", ["lighting", "two_way"]],
  ["4.11", "04", "שתי נק' מאור משותפות בעלות מפסק בודד", "יחידה", ["lighting", "shared"]],
  ["4.12", "04", "הוספת מפסק מחליף לנקודת מאור קיימת", "יחידה", ["lighting", "add_to_existing"]],
  ["4.14", "04", "הוספת מפסק למאוורר עבור נק' מאור קיימת", "יחידה", ["lighting", "fan"]],
  ["4.15", "04", "נק' מאור ללא מפסק (חיישן תנועה)", "יחידה", ["lighting", "sensor"]],
  ["4.16", "04", "שלוש נקודות מאור בעלות מפסק בודד", "יחידה", ["lighting", "shared3"]],
  ["4.17", "04", "הזנה לתנור חימום + מפסק", "יחידה", ["heater_feed"]],
  ["4.18", "04", "נק' אינטרקום", "יחידה", ["intercom"]],
  ["4.21", "04", "שקע תלת פאזי", "יחידה", ["socket_3phase"]],
  ["4.22", "04", "הזנה למפסק ופעמון", "יחידה", ["doorbell"]],
  ["4.23", "04", "הזנה לדוד חשמל יחידת דיור כולל התקנת מפסק טיימר", "יחידה", ["water_heater_feed"]],
  ["4.24", "04", "אספקה והתקנת לוח חשמל 14 מקום כולל מונה משני", "יחידה", ["panel"]],
  ["9.01", "08", "התקנת גופי התאורה בבית", "יחידה", ["install_count"]],
  ["1.01", "01", "פירוק ופינוי מחיצות פנים וחוץ בהתאם לתכנית הריסה", "קומפלט", []],
  ["1.05", "01", "פירוק ופינוי מזגנים", "קומפלט", []],
  ["3.02", "03", "נקודת מים חמים/קרים לכיור", "נק'", []],
  ["5.01", "05", "ריצוף באריחי פורצלן", "מ\"ר", []],
];

export function libraryItems(): LibraryItem[] {
  const title = new Map(DEFAULT_CHAPTERS.map((c) => [c.code, c.title]));
  return ITEMS.map(([code, chapter, description, unit, tags]) => ({
    id: `it_${code.replace(".", "_")}`,
    code,
    chapter,
    chapterTitle: title.get(chapter) ?? null,
    description,
    unit,
    tags,
    source: "import",
    sourceRef: "boq_sample.xls",
    active: true,
    updatedAt: "2026-10-11T10:00:00.000Z",
  }));
}

/** Socket/comms/feed classes → item code (class_to_item rules). */
export const CLASS_TO_CODE: Record<string, string> = {
  socket_single: "4.00",
  socket_double: "4.01",
  socket_triple: "4.02",
  socket_power: "4.03",
  socket_power_double: "4.04",
  data_point: "4.05",
  tv_point: "4.05",
  phone_point: "4.05",
  socket_box_6: "4.06",
  speaker: "4.07",
  heater_feed: "4.17",
  intercom: "4.18",
  socket_3phase: "4.21",
  doorbell: "4.22",
  panel: "4.24",
};

/** Link-group kind (+ point count) → composite lighting item code. */
export const COMPOSITE_CODES = { single1: "4.09", two_way: "4.10", shared2: "4.11", shared3: "4.16", sensor: "4.15", add_to_existing: "4.12" } as const;

export function defaultRules(): BoqRule[] {
  const at = "2026-10-11T10:00:00.000Z";
  const rules: BoqRule[] = Object.entries(CLASS_TO_CODE).map(([cls, code], i) => ({
    id: `r_class_${cls}`,
    kind: "class_to_item",
    match: { class: cls },
    itemCode: code,
    priority: 100 + i,
    enabled: true,
    description: null,
    updatedAt: at,
  }));
  rules.push(
    { id: "r_comp_single", kind: "composite_lighting", match: { switches: 1, points: 1 }, itemCode: "4.09", priority: 10, enabled: true, description: "מפסק אחד ← נקודה אחת", updatedAt: at },
    { id: "r_comp_two_way", kind: "composite_lighting", match: { switches: 2, kind: "two_way", points: 1 }, itemCode: "4.10", priority: 11, enabled: true, description: "שני מחליפים ← נקודה אחת", updatedAt: at },
    { id: "r_comp_shared2", kind: "composite_lighting", match: { switches: 1, points: 2 }, itemCode: "4.11", priority: 12, enabled: true, description: "מפסק אחד ← שתי נקודות", updatedAt: at },
    { id: "r_comp_shared3", kind: "composite_lighting", match: { switches: 1, points: 3 }, itemCode: "4.16", priority: 13, enabled: true, description: "מפסק אחד ← שלוש נקודות", updatedAt: at },
    { id: "r_comp_sensor", kind: "composite_lighting", match: { switches: 0, kind: "sensor" }, itemCode: "4.15", priority: 14, enabled: true, description: "נקודה ללא מפסק (חיישן)", updatedAt: at },
    { id: "r_comp_point_cluster", kind: "composite_lighting", match: { pointClusterMm: 600, wire: ["solid", "dashed"] }, itemCode: null, priority: 5, enabled: true, description: "גופים במרחק עד 600 מ\"מ המחוברים בקו = נקודה אחת", updatedAt: at },
    { id: "r_install_count", kind: "install_count", match: { exclude: ["ceiling_fan"], excludeSupply: ["client", "existing"] }, itemCode: "9.01", priority: 20, enabled: true, description: "התקנת גופי תאורה — ללא מאווררים, ללא אספקת לקוח/קיים", updatedAt: at },
    { id: "r_auth_sockets", kind: "authority", match: { families: ["sockets", "comms", "feeds"], discipline: "electrical" }, itemCode: null, priority: 1, enabled: true, description: "שקעים, תקשורת והזנות — לפי תכנית החשמל", updatedAt: at },
    { id: "r_auth_lighting", kind: "authority", match: { families: ["switches", "luminaires"], discipline: "lighting" }, itemCode: null, priority: 2, enabled: true, description: "מפסקים וגופי תאורה — לפי תכנית התאורה", updatedAt: at },
  );
  return rules;
}
