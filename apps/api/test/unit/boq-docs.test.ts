import { describe, expect, it } from 'vitest';
import { applyRebuild, BOQ_LINE_STATUSES, BOQ_LINE_TRANSITIONS, type BoqLine, type BoqLineStatus } from '@kamutan/contracts';
import { countLines, planLinePatch, toBoqLine } from '../../src/db/boq-docs';
import { RepoConflictError } from '../../src/db/repository';
import { groupEvidence } from '../../src/boq/boq.service';

const NOW = new Date('2026-10-14T12:00:00Z');
const line = (status: BoqLineStatus, extra: Partial<BoqLine> = {}): BoqLine =>
  toBoqLine('l1', { chapter: '04', code: '4.10', description: 'x', qty: 2, unit: 'יחידה', level: 'yellow', status, ...extra });

describe('planLinePatch — status transition matrix (BOQ_LINE_TRANSITIONS)', () => {
  for (const from of BOQ_LINE_STATUSES) {
    for (const to of BOQ_LINE_STATUSES) {
      if (from === to) continue;
      const allowed = BOQ_LINE_TRANSITIONS[from].includes(to);
      it(`${from} → ${to}: ${allowed ? 'allowed' : '409'}`, () => {
        const run = () => planLinePatch('p', line(from, from === 'approved' ? { approvedBy: 'u0' } : {}), { status: to }, 'u1', NOW);
        if (!allowed) {
          expect(run).toThrow(RepoConflictError);
          return;
        }
        const { patch, audit } = run();
        expect(patch.status).toBe(to);
        expect(audit).toMatchObject({ from, to, lineId: 'l1', code: '4.10' });
        if (from === 'draft' && to === 'reviewed') expect(patch).toMatchObject({ reviewedBy: 'u1', reviewedAt: NOW });
        if (to === 'approved') expect(patch).toMatchObject({ approvedBy: 'u1', approvedAt: NOW });
        if (from === 'reviewed' && to === 'draft') expect(patch).toMatchObject({ reviewedBy: null, reviewedAt: null });
        if (from === 'approved' && to === 'reviewed') expect(patch).toMatchObject({ approvedBy: null, approvedAt: null });
      });
    }
  }

  it('same status is a no-op for the status fields', () => {
    const { patch } = planLinePatch('p', line('reviewed'), { status: 'reviewed', note: 'x' }, 'u1', NOW);
    expect(patch.status).toBeUndefined();
    expect(patch.note).toBe('x');
  });

  it('approved lines: note alone locked; un-approve allowed; an override sends the line back to reviewed', () => {
    const approved = line('approved', { approvedBy: 'u0' });
    expect(() => planLinePatch('p', approved, { note: 'x' }, 'u1', NOW)).toThrow(/approved_locked/);
    expect(() => planLinePatch('p', approved, { status: 'draft' }, 'u1', NOW)).toThrow(/approved_locked/);
    expect(() => planLinePatch('p', approved, { status: 'approved', qtyOverride: 3, reason: 'r' }, 'u1', NOW)).toThrow(/approved_locked/);
    const ov = planLinePatch('p', approved, { qtyOverride: 3, reason: 'r' }, 'u1', NOW);
    expect(ov.patch).toMatchObject({ status: 'reviewed', approvedBy: null, approvedAt: null, qtyOverride: 3, reasons: ['כמות שונתה ידנית'] });
    expect(ov.audit).toMatchObject({ from: 'approved', to: 'reviewed' });
    expect(planLinePatch('p', approved, { status: 'reviewed', qtyOverride: 3, reason: 'r' }, 'u1', NOW).patch.status).toBe('reviewed');
    expect(planLinePatch('p', approved, { status: 'reviewed', note: 'לבדוק שוב' }, 'u1', NOW).patch).toMatchObject({ status: 'reviewed', note: 'לבדוק שוב', approvedBy: null });
  });

  it('override keeps draft/reviewed status and adds / removes the "כמות שונתה ידנית" reason', () => {
    const rv = planLinePatch('p', line('reviewed', { reasons: ['ביטחון נמוך'] }), { qtyOverride: 4, reason: 'r' }, 'u1', NOW);
    expect(rv.patch.status).toBeUndefined();
    expect(rv.patch.reasons).toEqual(['ביטחון נמוך', 'כמות שונתה ידנית']);
    const cleared = planLinePatch('p', line('reviewed', { reasons: ['ביטחון נמוך', 'כמות שונתה ידנית'], qtyOverride: 4 }), { qtyOverride: null }, 'u1', NOW);
    expect(cleared.patch.reasons).toEqual(['ביטחון נמוך']);
    // derived on read, so a worker rebuild that rewrites reasons cannot drop it
    expect(toBoqLine('x', { code: '4.1', qty: 1, level: 'green', status: 'draft', qtyOverride: 2, reasons: ['a'] }).reasons).toEqual(['a', 'כמות שונתה ידנית']);
  });

  it('qtyOverride sets reason/by/at; null clears; audit has numbers but never the note text', () => {
    const set = planLinePatch('p', line('draft'), { qtyOverride: 5, reason: 'ספירה ידנית', note: 'סוד' }, 'u1', NOW);
    expect(set.patch).toMatchObject({ qtyOverride: 5, qtyOverrideReason: 'ספירה ידנית', qtyOverrideBy: 'u1', qtyOverrideAt: NOW, note: 'סוד' });
    expect(set.audit).toMatchObject({ qty: 2, prevQtyOverride: null, qtyOverride: 5, noteChanged: true });
    expect(JSON.stringify(set.audit)).not.toContain('סוד');
    const clear = planLinePatch('p', line('draft', { qtyOverride: 5 }), { qtyOverride: null }, 'u1', NOW);
    expect(clear.patch).toMatchObject({ qtyOverride: null, qtyOverrideReason: null, qtyOverrideBy: null, qtyOverrideAt: null });
    expect(clear.audit).toMatchObject({ prevQtyOverride: 5, qtyOverride: null });
  });
});

describe('groupEvidence — composite lines count link groups, not items', () => {
  const it_ = (sheetId: string, detectionId: string, linkGroupId: string | null, floor: string | null) => ({ sheetId, versionId: 'v1', detectionId, linkGroupId, floor });
  it('one unit per distinct (sheet, version, linkGroupId); plain items one each; group floor = first item', () => {
    const g = groupEvidence([
      it_('s1', 'd_1', 'lk_1', 'ground'), it_('s1', 'd_2', 'lk_1', 'ground'), it_('s1', 'd_3', 'lk_1', 'basement'), // switch on another floor: still lk_1@ground
      it_('s1', 'd_4', 'lk_2', 'ground'), it_('s1', 'd_5', 'lk_2', 'ground'),
      it_('s2', 'd_1', 'lk_1', 'ground'), it_('s2', 'd_2', 'lk_1', 'ground'), // same id on another sheet = another group
      it_('s1', 'd_9', null, 'basement'),
    ]);
    expect(g.map(({ sheetId, floor, count, linkGroupIds }) => ({ sheetId, floor, count, linkGroupIds }))).toEqual([
      { sheetId: 's1', floor: 'ground', count: 2, linkGroupIds: ['lk_1', 'lk_2'] },
      { sheetId: 's2', floor: 'ground', count: 1, linkGroupIds: ['lk_1'] },
      { sheetId: 's1', floor: 'basement', count: 1, linkGroupIds: [] },
    ]);
    expect(g.reduce((a, x) => a + x.count, 0)).toBe(4);
    expect(g[0]?.detectionIds).toEqual(['d_1', 'd_2', 'd_3', 'd_4', 'd_5']);
  });
});

describe('rebuild semantics (API side)', () => {
  it('a rebuilt doc keeps override / status / note; the API reads the effective quantity from it', () => {
    const before = { chapter: '04', code: '4.01', description: 'שקע כפול', qty: 15, unit: 'יחידה', level: 'yellow', status: 'approved', approvedBy: 'u', qtyOverride: 14, qtyOverrideReason: 'r', note: 'n' };
    const rebuilt = applyRebuild(before, { chapter: '04', code: '4.01', description: 'שקע כפול', qty: 16, unit: 'יחידה', level: 'green', byFloor: { a: 16 } });
    const l = toBoqLine('l', rebuilt);
    expect(l).toMatchObject({ qty: 16, qtyOverride: 14, status: 'approved', note: 'n', level: 'green' });
    expect(countLines([l])).toMatchObject({ overridden: 1, approved: 1, green: 1 });
  });

  it('toBoqLine tolerates worker docs with odd fields', () => {
    const l = toBoqLine('x', { code: '4.10', qty: 'NaN', level: 'purple', status: 'weird', byFloor: { '': 3, a: 'x', b: 2 }, sourceVersions: [{ sheetId: 's' }], reasons: [1, 'ok'] });
    expect(l).toMatchObject({ qty: 0, level: 'red', status: 'draft', byFloor: { b: 2 }, sourceVersions: [], reasons: ['ok'] });
  });
});
