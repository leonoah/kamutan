import { describe, expect, it } from 'vitest';
import { DISCIPLINE_CODES, SheetSchema } from '../src/index.js';

const sheet = {
  id: 'set1-p0',
  sheetSetId: 'set1',
  pageIndex: 0,
  title: 'תאורה',
  discipline: 'lighting',
  floors: ['basement', 'ground', 'first'],
  scaleDenominator: 50,
  classification: null,
  confirmed: false,
  currentVersionId: 'v1',
  updatedAt: null,
};

describe('Sprint 10 — Worker-Classify sheet fields', () => {
  it('discipline codes for the designer\'s pool / after-form-4 sheets', () => {
    expect(DISCIPLINE_CODES).toContain('pool');
    expect(DISCIPLINE_CODES).toContain('post_permit');
  });
  it('coverage (overview sheet) and floorCheck are additive and nullable', () => {
    expect(SheetSchema.safeParse(sheet).success).toBe(true);
    const ov = {
      status: 'overview',
      coveredBy: ['a-p0', 'b-p0', 'c-p0'],
      floors: ['basement', 'ground', 'first'],
      contentShare: 0.99,
      reason: 'גיליון מרוכז: התוכן מופיע בגיליונות … — לא נספר בכתב הכמויות',
    };
    expect(SheetSchema.parse({ ...sheet, coverage: ov }).coverage?.status).toBe('overview');
    expect(SheetSchema.safeParse({ ...sheet, coverage: null }).success).toBe(true);
    expect(SheetSchema.safeParse({ ...sheet, coverage: { ...ov, status: 'primary' } }).success).toBe(false);
    expect(SheetSchema.safeParse({ ...sheet, coverage: { ...ov, contentShare: 1.5 } }).success).toBe(false);
    const fc = { titleFloors: ['ground'], floors: ['first'], support: 0.35, reason: 'קומה לפי השוואה לגיליונות אחרים בפרויקט (בכותרת: קרקע)' };
    expect(SheetSchema.parse({ ...sheet, floorCheck: fc }).floorCheck?.floors).toEqual(['first']);
    expect(SheetSchema.safeParse({ ...sheet, floorCheck: null }).success).toBe(true);
  });
});
