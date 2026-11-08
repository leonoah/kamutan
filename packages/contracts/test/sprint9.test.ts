import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  INPUT_QUALITY_ISSUE_KINDS,
  InputQualitySchema,
  isQualityRejected,
  jsonSchemaRegistry,
  QUALITY_ISSUE_HE,
  qualityIssueMessageHe,
  qualityIssueTitleHe,
  qualityReasonHe,
  SheetSummarySchema,
  SheetVersionSchema,
  UPLOAD_ERROR_MESSAGES_HE,
} from '../src/index.js';

const baseVersion = {
  id: 'v1',
  sheetId: 's1',
  status: 'ready',
  progress: { stage: 'done', pct: 100 },
  page: { widthMm: 420, heightMm: 297, rotation: 0 },
  artifacts: {},
  regions: [],
  stats: null,
  workerVersion: 'w',
  updatedAt: null,
};

describe('Sprint 9 — input quality', () => {
  it('parses ok / warn / reject and stays optional on the version', () => {
    expect(SheetVersionSchema.safeParse(baseVersion).success).toBe(true);
    expect(SheetVersionSchema.safeParse({ ...baseVersion, quality: null }).success).toBe(true);
    const warn = { status: 'warn', effectiveDpi: 31, issues: [{ kind: 'low_resolution', detail: 'text x-height 2.1px' }] };
    expect(SheetVersionSchema.parse({ ...baseVersion, quality: warn }).quality).toEqual(warn);
    const reject = { status: 'reject', issues: [{ kind: 'mirrored', severity: 'reject' }, { kind: 'dark_background' }], metrics: { darkRatio: 0.9 } };
    expect(InputQualitySchema.safeParse(reject).success).toBe(true);
  });

  it('rejects unknown kinds / statuses and absurd dpi', () => {
    expect(InputQualitySchema.safeParse({ status: 'bad', issues: [] }).success).toBe(false);
    expect(InputQualitySchema.safeParse({ status: 'warn', issues: [{ kind: 'noise' }] }).success).toBe(false);
    expect(InputQualitySchema.safeParse({ status: 'warn', effectiveDpi: 0, issues: [] }).success).toBe(false);
    expect(InputQualitySchema.safeParse({ status: 'warn', effectiveDpi: 99999, issues: [] }).success).toBe(false);
    expect(InputQualitySchema.safeParse({ status: 'warn' }).success).toBe(false);
  });

  it('sheet summary carries quality on currentVersion', () => {
    const s = SheetSummarySchema.shape.currentVersion.unwrap().safeParse({
      id: 'v1',
      status: 'ready',
      progress: { stage: 'done', pct: 100 },
      quality: { status: 'reject', issues: [{ kind: 'screenshot' }] },
    });
    expect(s.success).toBe(true);
  });

  it('error code + Hebrew message', () => {
    expect(API_ERROR_CODES).toContain('input_quality_rejected');
    expect(UPLOAD_ERROR_MESSAGES_HE.input_quality_rejected).toMatch(/PDF/);
  });

  it('Hebrew copy: every kind has a title and an action that says what to do', () => {
    for (const k of INPUT_QUALITY_ISSUE_KINDS) {
      expect(QUALITY_ISSUE_HE[k].title.length).toBeGreaterThan(3);
      expect(QUALITY_ISSUE_HE[k].action).toMatch(/^העלה /);
    }
    expect(qualityIssueTitleHe({ kind: 'low_resolution' }, 30.4)).toBe('רזולוציה נמוכה מדי (כ-30 dpi)');
    expect(qualityIssueTitleHe({ kind: 'low_resolution' }, 254)).toBe('רזולוציה נמוכה מדי (כ-250 dpi)');
    expect(qualityIssueTitleHe({ kind: 'low_resolution' }, null)).toBe('רזולוציה נמוכה מדי');
    expect(qualityIssueTitleHe({ kind: 'mirrored' })).toBe('הקובץ הפוך (מראה)');
    expect(qualityIssueMessageHe({ kind: 'screenshot' })).toContain('העלה את קובץ ה-PDF המקורי מתוכנת השרטוט');
  });

  it('reason chip (worker mirrors these vectors) and isQualityRejected', () => {
    expect(qualityReasonHe({ effectiveDpi: 31, issues: [{ kind: 'low_resolution' }] })).toBe('איכות קובץ ירודה: רזולוציה נמוכה מדי (כ-31 dpi)');
    expect(qualityReasonHe({ issues: [] })).toBe('איכות קובץ ירודה');
    const vectors = JSON.parse(readFileSync(join(__dirname, '..', 'json-schema', 'defaults', 'quality-messages.json'), 'utf8')) as {
      examples: Array<{ quality: { effectiveDpi?: number; issues: Array<{ kind: (typeof INPUT_QUALITY_ISSUE_KINDS)[number] }> }; reason: string }>;
    };
    for (const e of vectors.examples) expect(qualityReasonHe(e.quality)).toBe(e.reason);
    expect(isQualityRejected({ quality: { status: 'reject', issues: [] } })).toBe(true);
    expect(isQualityRejected({ quality: { status: 'warn', issues: [] }, error: { code: 'input_quality_rejected' } })).toBe(false);
    expect(isQualityRejected({ quality: null, error: { code: 'input_quality_rejected' } })).toBe(true);
    expect(isQualityRejected(null)).toBe(false);
  });

  it('registry exports the JSON schemas', () => {
    expect(jsonSchemaRegistry).toHaveProperty('InputQuality');
    expect(jsonSchemaRegistry).toHaveProperty('InputQualityIssue');
  });
});
