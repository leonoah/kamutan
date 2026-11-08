import {
  INPUT_QUALITY_ISSUE_KINDS,
  isQualityRejected,
  QUALITY_ISSUE_HE,
  QUALITY_REASON_PREFIX_HE,
  QUALITY_REJECT_BANNER_HE,
  QUALITY_STATUS_HE,
  QUALITY_WARN_BANNER_HE,
  qualityIssueTitleHe,
  qualityReasonHe,
  UPLOAD_ERROR_MESSAGES_HE,
} from "@kamutan/contracts";
import i18n from "@/i18n";
import he from "@/i18n/he";
import { displayIssues, isQualityReason, isRejected, issueAction, issueTitle, QUALITY_ISSUE_KINDS, QUALITY_REASON_PREFIX, qualityFlag, qualityOf, roundDpi } from "./model";

const t = i18n.t.bind(i18n);

describe("Sprint 9 quality model — copy pinned to the contracts", () => {
  it("issue titles / actions, statuses, banners, reason prefix, error text equal the contracts", () => {
    expect([...QUALITY_ISSUE_KINDS]).toEqual([...INPUT_QUALITY_ISSUE_KINDS]);
    for (const k of INPUT_QUALITY_ISSUE_KINDS) {
      expect(he.quality.issue[k]).toBe(QUALITY_ISSUE_HE[k].title);
      expect(he.quality.action[k]).toBe(QUALITY_ISSUE_HE[k].action);
      expect(issueAction(t, { kind: k })).toMatch(/^העלה /);
    }
    for (const s of ["ok", "warn", "reject"] as const) expect(he.quality.status[s]).toBe(QUALITY_STATUS_HE[s]);
    expect(he.quality.warnBanner).toBe(QUALITY_WARN_BANNER_HE);
    expect(he.quality.rejectBanner).toBe(QUALITY_REJECT_BANNER_HE);
    expect(QUALITY_REASON_PREFIX).toBe(QUALITY_REASON_PREFIX_HE);
    expect(he.quality.reasonChip).toBe(QUALITY_REASON_PREFIX_HE);
    expect(he.project.errors.input_quality_rejected).toBe(UPLOAD_ERROR_MESSAGES_HE.input_quality_rejected);
  });

  it("titles with dpi round like the contracts (worker reason chips read the same)", () => {
    for (const dpi of [12.4, 30, 30.6, 72, 99.4, 99.6, 104, 254, 1200]) {
      expect(issueTitle(t, { kind: "low_resolution" }, dpi)).toBe(qualityIssueTitleHe({ kind: "low_resolution" }, dpi));
      expect(roundDpi(dpi)).toBeGreaterThan(0);
    }
    expect(issueTitle(t, { kind: "low_resolution" }, 30)).toBe("רזולוציה נמוכה מדי (כ-30 dpi)");
    expect(issueTitle(t, { kind: "mirrored" }, 30)).toBe("הקובץ הפוך (מראה)");
    expect(issueTitle(t, { kind: "nope" as never })).toBe("בעיה באיכות הקובץ");
  });

  it("qualityOf / flags / rejected agree with contracts isQualityRejected", () => {
    const cases = [
      null,
      {},
      { quality: null },
      { quality: { status: "ok", issues: [] } },
      { quality: { status: "warn", issues: [{ kind: "blurred" }] } },
      { quality: { status: "reject", issues: [] } },
      { error: { code: "input_quality_rejected", message: "x" } },
      { quality: { status: "warn", issues: [] }, error: { code: "input_quality_rejected", message: "x" } },
      { error: { code: "render_failed", message: "x" } },
    ] as const;
    for (const c of cases) expect(isRejected(c as never)).toBe(isQualityRejected(c as never));
    expect(qualityFlag({ quality: { status: "ok", issues: [] } })).toBeNull();
    expect(qualityFlag({ quality: { status: "warn", issues: [] } })).toBe("warn");
    expect(qualityOf({ error: { code: "input_quality_rejected", message: "" } })).toEqual({ status: "reject", issues: [] });
  });

  it("displayIssues dedupes and never returns an empty list; reason chip detection", () => {
    expect(displayIssues({ status: "reject", issues: [] }).map((i) => i.kind)).toEqual(["unknown"]);
    expect(displayIssues({ status: "warn", issues: [{ kind: "blurred" }, { kind: "blurred" }, { kind: "mirrored" }] }).map((i) => i.kind)).toEqual(["blurred", "mirrored"]);
    expect(isQualityReason(qualityReasonHe({ effectiveDpi: 30, issues: [{ kind: "low_resolution" }] }))).toBe(true);
    expect(isQualityReason(qualityReasonHe({ issues: [] }))).toBe(true);
    expect(isQualityReason("סמלים חופפים")).toBe(false);
  });
});
