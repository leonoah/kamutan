import type { ConfidenceLevel } from "@/components/ConfidenceBadge";

/** Static illustrative data for the Sprint-0 workspace skeleton. Not real output. */
export interface SampleRow {
  code: string; // TEXT, e.g. "4.10" — never a number
  desc: string;
  meta?: string;
  unit: string;
  qty: number;
  level: ConfidenceLevel;
  expandable?: boolean;
}

export const sampleChapter = {
  title: "פרק 04 – עבודות חשמל",
  verifiedPct: 91,
  split: { high: 18, mid: 3, low: 2 },
};

export const sampleRows: SampleRow[] = [
  { code: "4.01", desc: "שקע כפול", meta: "קרקע 9 · א' 6", unit: "יח'", qty: 15, level: "low" },
  { code: "4.03", desc: "שקע כח 16A", meta: "קרקע 4", unit: "יח'", qty: 4, level: "high" },
  { code: "4.09", desc: "נק' מאור", unit: "יח'", qty: 16, level: "high" },
  { code: "4.10", desc: "נק' מאור בעלת שני מפסקים מחליפים", unit: "יח'", qty: 2, level: "mid", expandable: true },
  { code: "4.11", desc: "שתי נק' מאור משותפות", unit: "יח'", qty: 5, level: "low", expandable: true },
  { code: "4.12", desc: "הוספת מפסק מחליף לנקודת מאור קיימת", unit: "יח'", qty: 3, level: "high" },
  { code: "4.20", desc: "הזנה למזגן עם מפסק דו-קוטבי", meta: "H=180", unit: "יח'", qty: 3, level: "manual" },
  { code: "4.31", desc: "צינור שרשורי 25 מ\"מ", unit: "מ\"א", qty: 42.5, level: "mid" },
];

export interface SampleQueueItem {
  kind: "item" | "cluster";
  level: ConfidenceLevel;
  code?: string;
  title: string;
  reasonCode: string;
  impact?: "high" | "mid";
  count?: number;
}

export const sampleQueue: SampleQueueItem[] = [
  { kind: "item", level: "low", code: "4.10", title: "מחליף 2", reasonCode: "SWITCH_LINK", impact: "high" },
  { kind: "cluster", level: "unknown", title: "סמל לא מוכר", reasonCode: "NOT_IN_LEGEND", count: 7 },
  { kind: "item", level: "low", code: "4.01", title: "שקע כפול · סלון", reasonCode: "OVERLAP", impact: "mid" },
  { kind: "item", level: "mid", code: "4.03", title: "שקע כח 16A · מטבח", reasonCode: "SIMILAR_SYMBOLS", impact: "mid" },
];
