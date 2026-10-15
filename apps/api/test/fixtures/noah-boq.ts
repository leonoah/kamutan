import type { BoqLine } from '@kamutan/contracts';

/**
 * Lines matching the sample BOQ (בית משפחת נח, sheet "כמויות") chapter 04 + the lighting install line 9.01 —
 * codes, descriptions, units and quantities as in /home/claude/kamutan-data/gt/noah/boq_truth.json. Per-floor
 * splits, levels and statuses are illustrative (they sum to the sample quantities).
 */
type Seed = [code: string, description: string, qty: number, byFloor: Record<string, number>, level?: BoqLine['level'], status?: BoqLine['status']];

const B = 'מרתף';
const G = 'קומת קרקע';
const F = "קומה א'";

const CH04: Seed[] = [
  ['4.00', 'שקע בודד', 23, { [B]: 7, [G]: 9, [F]: 7 }],
  ['4.01', 'שקע כפול', 15, { [B]: 4, [G]: 6, [F]: 5 }],
  ['4.02', 'אביזר שלישיית שקעים', 5, { [G]: 3, [F]: 2 }],
  ['4.03', 'שקע כח', 8, { [B]: 2, [G]: 4, [F]: 2 }],
  ['4.04', 'שקע כח כפול', 1, { [G]: 1 }],
  ['4.05', "נק' תקשורת (כבלים/ טלפון/ רשת) הכנה עם חוט משיכה", 11, { [B]: 3, [G]: 3, [F]: 5 }, 'yellow'],
  ['4.06', "אביזר עדה פלאסט הכולל 6 שקעים, נק' כבלים, נק' טלפון ונק' רשת", 4, { [G]: 2, [F]: 2 }],
  ['4.07', "נק' קצה לרמקול", 3, { [G]: 3 }],
  ['4.08', 'צינור חופשי מהריצפה כהכנה לשקעי שירות בתוך האי)', 1, { [G]: 1 }, 'yellow'],
  ['4.09', "נק' מאור כוללת מפסק", 16, { [B]: 5, [G]: 5, [F]: 6 }, 'green', 'reviewed'],
  ['4.10', "נק' מאור בעלת שני מפסקים מחליפים", 2, { [G]: 1, [F]: 1 }, 'yellow'],
  ['4.11', "שתי נק' מאור משותפות בעלות מפסק בודד", 5, { [B]: 1, [G]: 2, [F]: 2 }, 'yellow'],
  ['4.12', 'הוספת מפסק מחליף לנקודת מאור קיימת', 3, { [G]: 2, [F]: 1 }, 'red'],
  ['4.14', "הוספת מפסק למאוורר עבור נק' מאור קייימת", 1, { [F]: 1 }, 'yellow'],
  ['4.15', "נק' מאור ללא מפסק (חיישן תנועה)", 1, { [G]: 1 }],
  ['4.16', 'שלוש נקודות מאור בעלות מפסק בודד', 2, { [G]: 1, [F]: 1 }, 'yellow'],
  ['4.17', 'הזנה לתנור חימום+  מפסק', 3, { [B]: 1, [F]: 2 }],
  ['4.18', "נק' אינטרקום", 1, { [G]: 1 }, 'green', 'approved'],
  ['4.19', 'הזנה לונטה+ מפסק', 1, { [B]: 1 }],
  ['4.20', 'צינור קוברה 50 מ"מ באורך 1.5 מ\'', 5, { [G]: 5 }, 'yellow'],
  ['4.21', 'שקע תלת פאזי', 3, { [B]: 1, [G]: 2 }],
  ['4.22', 'הזנה למפסק ופעמון', 1, { [G]: 1 }],
  ['4.23', 'הזנה לדוד חשמל יחידת דיור כולל התקנת מפסק טיימר של גוויס', 1, { [B]: 1 }],
  ['4.24', 'אספקה והתקנת לוח חשמל 14 מקום כולל מונה משני ביחידת דיור', 1, { [B]: 1 }, 'yellow'],
  ['4.25', 'אספקה והתקנת לוח תקשורת ביחידת דיור', 1, { [B]: 1 }, 'yellow'],
  ['4.26', 'החלפת מפסק דוד קיים למפסק טיימר של גוויס', 1, { [F]: 1 }, 'yellow'],
  ['4.27', 'צינור קוברה 50 מ"מ באורך 3.5 מ\' למקרן תקרה', 1, { [G]: 1 }, 'yellow'],
  ['4.28', 'אספקה והתקרת לוח חשמל 36 מקום', 1, { [G]: 1 }, 'yellow'],
];

export const NOAH_FLOORS = [B, G, F];

export function noahLines(opts: { allGreen?: boolean } = {}): Array<Partial<BoqLine> & { id: string; code: string }> {
  const mk = ([code, description, qty, byFloor, level = 'green', status = 'draft']: Seed, chapter: string) => ({
    id: `bl_${code.replace('.', '_')}`,
    chapter,
    code,
    description,
    qty,
    unit: 'יחידה',
    byFloor,
    level: opts.allGreen ? 'green' : level,
    reasons: level === 'green' || opts.allGreen ? [] : level === 'red' ? ['קישור מפסק לא ודאי'] : ['שיוך לפריט לפי כלל ברירת מחדל'],
    status,
    evidenceCount: Math.max(1, qty),
    ruleId: null,
    sourceVersions: [],
  });
  return [
    ...CH04.map((s) => mk(s, '04')),
    mk(['9.01', 'התקנת גופי התאורה בבית', 43, { [B]: 12, [G]: 16, [F]: 15 }, 'yellow'], '08'),
  ];
}
