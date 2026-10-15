import type { ViewerLabels } from "./types";

const nf = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const nf1 = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 1 });

/** FSI … PDI: isolate LTR numbers/scales inside Hebrew text (spec §כללי RTL). */
export const isolate = (s: string): string => `⁨${s}⁩`;

/** Hebrew defaults (docs/spec/05_ux.md §כלי תיקון). Units use the Hebrew gershayim ״. */
export const defaultLabels: ViewerLabels = {
  minimap: "מיני-מפה",
  minimapToggle: "הצג/הסתר מיני-מפה",
  measureHint: "לחצו על שתי נקודות למדידת אורך · Esc לביטול",
  calibrateHint: "כיול קנה מידה: לחצו על שני קצות קו מידה ידוע",
  lassoHint: "גררו לציור לאסו, או לחצו לקודקודים ו-Enter לסגירה",
  realLength: "אורך אמיתי:",
  unitCm: "ס״מ",
  apply: "החל",
  cancel: "ביטול",
  scaleSuggestion: (measured, nearest) => `${isolate(measured)} — קרוב ל-${isolate(nearest)}. להשתמש ב-${isolate(nearest)}?`,
  scaleResult: (measured) => `קנה מידה מחושב: ${isolate(measured)}`,
  formatLength: (realMm, paperMm) =>
    realMm == null
      ? `${isolate(nf1.format(paperMm))} מ״מ על הנייר · קנה מידה לא ידוע`
      : `${isolate(nf.format(realMm / 1000))} מ״א`,
  addHint: "לחצו על השרטוט להוספת פריט ידני · נצמד לסמל קרוב",
  removeHint: "לחצו על פריט כדי להסיר אותו מהספירה",
  moveHint: "גררו פריט למקומו הנכון",
  linkHint: "גררו ממפסק אל נקודת המאור כדי לקשר (או לנתק קישור קיים)",
  countHint: "לחצו על כל מופע · Backspace מבטל את האחרון · Enter לשמירה",
  areaHint: "לחצו לקודקודים (נצמד לפינות) · לחיצה כפולה או Enter לסגירה",
  lengthHint: "לחצו לנקודות הקו · Enter או לחיצה כפולה לסיום",
  formatArea: (areaM2, perimeterM, paperMm2) =>
    areaM2 == null
      ? `${isolate(nf1.format(paperMm2))} מ״מ² על הנייר · קנה מידה לא ידוע`
      : `${isolate(nf1.format(areaM2))} מ״ר · היקף ${isolate(nf1.format(perimeterM ?? 0))} מ״א`,
  formatCount: (n) => `${isolate(String(n))} נספרו · Enter לשמירה`,
};
