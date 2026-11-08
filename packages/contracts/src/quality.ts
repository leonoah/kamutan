import { z } from 'zod';

/**
 * Sprint 9 — input-quality gate (Worker-Legend writes `SheetVersion.quality`; API surfaces it; Web shows it).
 *
 * Raster input (PNG/JPG and image-only PDF pages) is checked before symbol detection:
 * - `ok`     → processed as usual (raster cap at "סביר" still applies).
 * - `warn`   → processed; every item of the sheet is capped at yellow/red and carries `qualityReasonHe(quality)`.
 * - `reject` → NO symbol counts (no detections / BOQ contribution); the tiles are still rendered so the drawing can be
 *              viewed. The version stays `ready`; the worker may also set `error {code: 'input_quality_rejected'}` on
 *              the version / job (informational — the UI keys off `quality.status`).
 * Vector PDF / DXF pages may omit `quality` (absent ≡ not checked ≡ ok).
 */
export const INPUT_QUALITY_STATUSES = ['ok', 'warn', 'reject'] as const;
export const InputQualityStatusSchema = z.enum(INPUT_QUALITY_STATUSES);
export type InputQualityStatus = z.infer<typeof InputQualityStatusSchema>;

export const INPUT_QUALITY_ISSUE_KINDS = ['low_resolution', 'mirrored', 'dark_background', 'screenshot', 'partial_crop', 'blurred'] as const;
export const InputQualityIssueKindSchema = z.enum(INPUT_QUALITY_ISSUE_KINDS);
export type InputQualityIssueKind = z.infer<typeof InputQualityIssueKindSchema>;

/** Error code on the version / job of a rejected sheet (also in `API_ERROR_CODES`). */
export const INPUT_QUALITY_REJECTED = 'input_quality_rejected' as const;
/** Upper bound of a plausible effective resolution (dpi). */
export const EFFECTIVE_DPI_MAX = 4800;
export const INPUT_QUALITY_ISSUES_MAX = 16;

export const InputQualityIssueSchema = z.object({
  kind: InputQualityIssueKindSchema,
  /** Worker diagnostic (English or Hebrew, short). Not shown as the main message — the UI maps `kind` to Hebrew. */
  detail: z.string().max(300).optional(),
  /** Optional: which status this issue alone would cause. */
  severity: z.enum(['warn', 'reject']).optional(),
});
export type InputQualityIssue = z.infer<typeof InputQualityIssueSchema>;

/** `SheetVersion.quality` (worker-written, read-only for clients). */
export const InputQualitySchema = z.object({
  status: InputQualityStatusSchema,
  /** Estimated effective resolution of the sheet at its paper size (from sheet size / text height). */
  effectiveDpi: z.number().positive().max(EFFECTIVE_DPI_MAX).nullable().optional(),
  issues: z.array(InputQualityIssueSchema).max(INPUT_QUALITY_ISSUES_MAX),
  /** Optional worker metrics used for tuning (≤ 32 numbers, e.g. `{blurVar: 41.2, darkRatio: 0.83}`). */
  metrics: z
    .record(z.string().min(1).max(64), z.number().finite())
    .refine((r) => Object.keys(r).length <= 32, { message: 'too many metrics' })
    .optional(),
});
export type InputQuality = z.infer<typeof InputQualitySchema>;

// ---------------------------------------------------------------------------
// Hebrew copy (shared by web + worker reasons). Singular imperative, as in the Sprint 9 brief ("העלה PDF מקורי").
// ---------------------------------------------------------------------------

/** The common remedy: the original vector PDF exported by the CAD program. */
export const QUALITY_UPLOAD_ORIGINAL_HE = 'העלה את קובץ ה-PDF המקורי מתוכנת השרטוט';

/** Per-kind title (what is wrong) and action (what to do). `{dpi}` is replaced by `effectiveDpi` when known. */
export const QUALITY_ISSUE_HE: Readonly<Record<InputQualityIssueKind, { title: string; action: string }>> = Object.freeze({
  low_resolution: { title: 'רזולוציה נמוכה מדי', action: `${QUALITY_UPLOAD_ORIGINAL_HE}, או סריקה ברזולוציה של 200 dpi לפחות.` },
  mirrored: { title: 'הקובץ הפוך (מראה)', action: `${QUALITY_UPLOAD_ORIGINAL_HE}, או הפוך את התמונה בחזרה לפני ההעלאה.` },
  dark_background: { title: 'רקע כהה (צילום ממסך תוכנת CAD)', action: `${QUALITY_UPLOAD_ORIGINAL_HE}, או ייצא את השרטוט על רקע לבן.` },
  screenshot: { title: 'צילום מסך ולא קובץ שרטוט', action: `${QUALITY_UPLOAD_ORIGINAL_HE} במקום צילום מסך.` },
  partial_crop: { title: 'חלק מהגיליון חסר (אין מסגרת או טבלת כותרת)', action: 'העלה את הגיליון המלא, כולל המסגרת וטבלת הכותרת.' },
  blurred: { title: 'התמונה מטושטשת', action: `${QUALITY_UPLOAD_ORIGINAL_HE}, או סריקה חדה יותר.` },
});

export const QUALITY_STATUS_HE: Readonly<Record<InputQualityStatus, string>> = Object.freeze({
  ok: 'איכות הקובץ תקינה',
  warn: 'איכות הקובץ ירודה',
  reject: 'איכות הקובץ נמוכה מדי לספירה',
});

/** Banner text of a rejected sheet (no counts, drawing still shown). */
export const QUALITY_REJECT_BANNER_HE = 'לא ספרנו פריטים בגיליון הזה, כי איכות הקובץ נמוכה מדי. השרטוט מוצג לעיון בלבד.';
/** Banner text of a warn sheet. */
export const QUALITY_WARN_BANNER_HE = 'איכות הקובץ ירודה. ספרנו את הפריטים, אבל כולם מסומנים לבדיקה ולא יסומנו "מאומת".';
/** Reason chip prefix the worker puts on every detection / room of a `warn` sheet. */
export const QUALITY_REASON_PREFIX_HE = 'איכות קובץ ירודה';

const roundDpi = (dpi: number): number => (dpi >= 100 ? Math.round(dpi / 10) * 10 : Math.round(dpi));

/** "רזולוציה נמוכה מדי (כ-30 dpi)" — the issue title, with the dpi for `low_resolution` when known. */
export function qualityIssueTitleHe(issue: Pick<InputQualityIssue, 'kind'>, effectiveDpi?: number | null): string {
  const base = QUALITY_ISSUE_HE[issue.kind]?.title ?? 'בעיה באיכות הקובץ';
  if (issue.kind === 'low_resolution' && typeof effectiveDpi === 'number' && effectiveDpi > 0) return `${base} (כ-${roundDpi(effectiveDpi)} dpi)`;
  return base;
}

/** "רזולוציה נמוכה מדי (כ-30 dpi). העלה את קובץ ה-PDF המקורי …" — title + action in one sentence pair. */
export function qualityIssueMessageHe(issue: Pick<InputQualityIssue, 'kind'>, effectiveDpi?: number | null): string {
  const action = QUALITY_ISSUE_HE[issue.kind]?.action ?? `${QUALITY_UPLOAD_ORIGINAL_HE}.`;
  return `${qualityIssueTitleHe(issue, effectiveDpi)}. ${action}`;
}

/**
 * Reason chip for items of a `warn` sheet: "איכות קובץ ירודה: רזולוציה נמוכה מדי (כ-30 dpi)" (first issue; ≤ 200 chars
 * so it fits `Detection.reasons`). Without issues: just the prefix. The worker (Python) mirrors this exactly.
 */
export function qualityReasonHe(quality: Pick<InputQuality, 'issues' | 'effectiveDpi'>): string {
  const first = quality.issues[0];
  const text = first ? `${QUALITY_REASON_PREFIX_HE}: ${qualityIssueTitleHe(first, quality.effectiveDpi)}` : QUALITY_REASON_PREFIX_HE;
  return text.slice(0, 200);
}

/** True when the version must show no counts (status `reject`, or the rejected error code without a quality block). */
export function isQualityRejected(v: { quality?: InputQuality | null; error?: { code: string } | null } | null | undefined): boolean {
  if (!v) return false;
  if (v.quality) return v.quality.status === 'reject';
  return v.error?.code === INPUT_QUALITY_REJECTED;
}
