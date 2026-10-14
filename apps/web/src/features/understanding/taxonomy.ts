/**
 * Class taxonomy (benchmark/schema/classes.json → @kamutan/contracts taxonomy.ts), Hebrew names for the UI.
 * TODO(contracts): import SYMBOL_CLASS_INFO from @kamutan/contracts once web depends on the built package.
 */
export interface ClassInfo {
  domain: string;
  he: string;
}

export const CLASS_INFO: Readonly<Record<string, ClassInfo>> = Object.freeze({
  socket_single: { domain: "electrical", he: "שקע בודד" },
  socket_double: { domain: "electrical", he: "שקע כפול" },
  socket_triple: { domain: "electrical", he: "שלישיית שקעים" },
  socket_power: { domain: "electrical", he: "שקע כח" },
  socket_power_double: { domain: "electrical", he: "שקע כח כפול" },
  socket_3phase: { domain: "electrical", he: "שקע תלת פאזי" },
  socket_box_6: { domain: "electrical", he: "אביזר עדה פלאסט (פרט A)" },
  socket_prep: { domain: "electrical", he: "הכנה לשקע" },
  data_point: { domain: "electrical", he: "נק' רשת" },
  tv_point: { domain: "electrical", he: "נק' TV" },
  phone_point: { domain: "electrical", he: "נק' טלפון" },
  speaker: { domain: "electrical", he: "נק' רמקול" },
  intercom: { domain: "electrical", he: "אינטרקום" },
  doorbell: { domain: "electrical", he: "פעמון" },
  heater_feed: { domain: "electrical", he: "הזנה לתנור/דוד/ונטה" },
  panel: { domain: "electrical", he: "לוח חשמל/תקשורת" },
  breaker: { domain: "electrical", he: "מפסק (בלוח)" },
  switch_single: { domain: "lighting", he: "מפסק/מתג" },
  switch_2way: { domain: "lighting", he: "מחליף" },
  switch_fan: { domain: "lighting", he: "מפסק למאוורר" },
  luminaire_ceiling: { domain: "lighting", he: "גוף תאורה תקרתי" },
  luminaire_wall: { domain: "lighting", he: "גוף תאורה קיר" },
  luminaire_pendant: { domain: "lighting", he: "גוף תלוי" },
  luminaire_strip: { domain: "lighting", he: "פס לד" },
  luminaire_outdoor: { domain: "lighting", he: "גוף חוץ / פרוז'קטור" },
  ceiling_fan: { domain: "lighting", he: "מאוורר תקרה" },
  fixture_wc_concealed: { domain: "plumbing", he: "אסלה תלויה + מיכל סמוי" },
  fixture_wc_monoblock: { domain: "plumbing", he: "אסלה מונובלוק" },
  fixture_basin: { domain: "plumbing", he: "כיור" },
  faucet_basin: { domain: "plumbing", he: "ברז פרח" },
  faucet_wall: { domain: "plumbing", he: "ברז קיר" },
  fixture_shower: { domain: "plumbing", he: "מקלחון" },
  fixture_bath: { domain: "plumbing", he: "אמבטיה" },
  fixture_kitchen_sink: { domain: "plumbing", he: "כיור מטבח" },
  fixture_washing_machine: { domain: "plumbing", he: "מכונת כביסה" },
  garden_tap: { domain: "plumbing", he: "ברז גן" },
  ac_unit: { domain: "hvac", he: "מזגן (מיקום)" },
  room: { domain: "tiling", he: "חדר" },
  floor_tiling: { domain: "tiling", he: "ריצוף" },
  wall_cladding: { domain: "tiling", he: "חיפוי" },
  region: { domain: "other", he: "אזור סימון (context)" },
});

export const UNKNOWN_CLASS = "unknown";

/** Domains shown in pickers, in this order (tiling/other are not symbol classes). */
export const SYMBOL_DOMAINS = ["electrical", "lighting", "plumbing", "hvac"] as const;

/** Classes the user can assign to a symbol, grouped by domain (in taxonomy order). */
export const SYMBOL_CLASS_GROUPS: { domain: string; classes: string[] }[] = SYMBOL_DOMAINS.map((domain) => ({
  domain,
  classes: Object.entries(CLASS_INFO)
    .filter(([, v]) => v.domain === domain)
    .map(([k]) => k),
}));

export const isSymbolClass = (c: string | null | undefined): c is string =>
  Boolean(c) && c !== UNKNOWN_CLASS && Boolean(CLASS_INFO[c!]) && (SYMBOL_DOMAINS as readonly string[]).includes(CLASS_INFO[c!]!.domain);

/** Hebrew name of a class id; unknown ids are shown verbatim. */
export function className(c: string | null | undefined, unknownLabel = "סמל לא מוכר"): string {
  if (!c) return "—";
  if (c === UNKNOWN_CLASS) return unknownLabel;
  return CLASS_INFO[c]?.he ?? c;
}

export const domainOf = (c: string): string => (c === UNKNOWN_CLASS ? "unknown" : (CLASS_INFO[c]?.domain ?? "other"));
