import type { TFunction } from "i18next";
import type { InputQuality, InputQualityIssue, InputQualityIssueKind, SheetVersion } from "@/api/types";

/**
 * Sprint 9 — input-quality gate (contracts `quality.ts`, "Sprint 9 published").
 * Pure helpers (no runtime import of @kamutan/contracts in app code — the copy lives in i18n `quality.*` and a unit test
 * pins it to the contracts' `QUALITY_ISSUE_HE`).
 */
export const QUALITY_ISSUE_KINDS: readonly InputQualityIssueKind[] = ["low_resolution", "mirrored", "dark_background", "screenshot", "partial_crop", "blurred"];
/** Contracts `INPUT_QUALITY_REJECTED`. */
export const INPUT_QUALITY_REJECTED = "input_quality_rejected";
/** Prefix of the worker's reason chip on items of a `warn` sheet (contracts `QUALITY_REASON_PREFIX_HE`). */
export const QUALITY_REASON_PREFIX = "איכות קובץ ירודה";

/**
 * The version's effective quality: `quality` when present; a version that only carries the error code
 * `input_quality_rejected` counts as rejected (no issues known); otherwise null (= ok / not checked).
 */
export function qualityOf(v: Pick<SheetVersion, "quality" | "error"> | null | undefined): InputQuality | null {
  if (!v) return null;
  if (v.quality) return v.quality;
  if (v.error?.code === INPUT_QUALITY_REJECTED) return { status: "reject", issues: [] };
  return null;
}

export type QualityFlag = "warn" | "reject";
/** "warn" / "reject" when the sheet needs a quality notice, else null. */
export function qualityFlag(v: Pick<SheetVersion, "quality" | "error"> | null | undefined): QualityFlag | null {
  const q = qualityOf(v);
  return q && q.status !== "ok" ? q.status : null;
}

export const isRejected = (v: Pick<SheetVersion, "quality" | "error"> | null | undefined) => qualityFlag(v) === "reject";

/** Same rounding as contracts `qualityIssueTitleHe`: integer below 100 dpi, tens from 100. */
export const roundDpi = (dpi: number) => (dpi >= 100 ? Math.round(dpi / 10) * 10 : Math.round(dpi));

const known = (k: string): k is InputQualityIssueKind => (QUALITY_ISSUE_KINDS as readonly string[]).includes(k);

/** "רזולוציה נמוכה מדי (כ-30 dpi)" / "הקובץ הפוך (מראה)". */
export function issueTitle(t: TFunction, issue: Pick<InputQualityIssue, "kind">, effectiveDpi?: number | null): string {
  if (issue.kind === "low_resolution" && typeof effectiveDpi === "number" && effectiveDpi > 0) return t("quality.issue.low_resolutionDpi", { dpi: roundDpi(effectiveDpi) });
  return t(`quality.issue.${known(issue.kind) ? issue.kind : "unknown"}`);
}

/** What to do about it ("העלה את קובץ ה-PDF המקורי מתוכנת השרטוט…"). */
export function issueAction(t: TFunction, issue: Pick<InputQualityIssue, "kind">): string {
  return t(`quality.action.${known(issue.kind) ? issue.kind : "unknown"}`);
}

/** Issues to list; a rejected / warn version without issues gets one generic line so there is always an action. */
export function displayIssues(q: InputQuality): Array<Pick<InputQualityIssue, "kind"> & { detail?: string }> {
  const seen = new Set<string>();
  const out = q.issues.filter((i) => (seen.has(i.kind) ? false : (seen.add(i.kind), true)));
  return out.length ? out : [{ kind: "unknown" as InputQualityIssueKind }];
}

/** True for the worker's quality reason chip ("איכות קובץ ירודה: …"). */
export const isQualityReason = (r: string) => r === QUALITY_REASON_PREFIX || r.startsWith(`${QUALITY_REASON_PREFIX}:`);
