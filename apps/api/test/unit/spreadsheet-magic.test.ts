import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectSpreadsheetKind, isXls, isXlsx, zipEntryNames } from '../../src/library/spreadsheet-magic';
import { SAMPLE } from '../support/helpers';
import { XLS_BYTES, xlsxBytes } from '../support/spreadsheets';

/** A ZIP with one stored entry (not a workbook). */
function zipOf(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const n of names) {
    const name = Buffer.from(n);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('spreadsheet magic bytes (library import)', () => {
  it('xlsx: ZIP with [Content_Types].xml + xl/workbook.xml', async () => {
    const b = await xlsxBytes();
    expect(zipEntryNames(b)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml']));
    expect(isXlsx(b)).toBe(true);
    expect(detectSpreadsheetKind(b)).toBe('xlsx');
  });
  it('xls: OLE CFB header', () => {
    expect(isXls(XLS_BYTES)).toBe(true);
    expect(detectSpreadsheetKind(XLS_BYTES)).toBe('xls');
  });
  it('the real sample BOQ (.xls) is detected when available', () => {
    const p = '/home/claude/kamutan-data/sample-noah/boq_sample.xls';
    let buf: Buffer | null = null;
    try {
      buf = existsSync(p) ? readFileSync(p) : null;
    } catch {
      buf = null; // not readable in this environment
    }
    if (buf) expect(detectSpreadsheetKind(buf)).toBe('xls');
  });
  it('rejects other ZIPs (docx-like), truncated / corrupt ZIPs, PDFs, PNGs, empty and short CFB', async () => {
    expect(detectSpreadsheetKind(zipOf(['[Content_Types].xml', 'word/document.xml']))).toBeNull();
    expect(detectSpreadsheetKind(zipOf(['xl/workbook.xml']))).toBeNull();
    expect(detectSpreadsheetKind(zipOf(['[Content_Types].xml', 'xl/workbook.xml']))).toBe('xlsx');
    const good = await xlsxBytes();
    expect(detectSpreadsheetKind(good.subarray(0, good.length - 30))).toBeNull();
    const corrupt = Buffer.from(good);
    corrupt.writeUInt32LE(0xffffffff, corrupt.length - 6); // central directory offset out of range
    expect(detectSpreadsheetKind(corrupt)).toBeNull();
    expect(detectSpreadsheetKind(SAMPLE.pdf)).toBeNull();
    expect(detectSpreadsheetKind(SAMPLE.png)).toBeNull();
    expect(detectSpreadsheetKind(Buffer.alloc(0))).toBeNull();
    expect(detectSpreadsheetKind(XLS_BYTES.subarray(0, 100))).toBeNull();
  });
});
