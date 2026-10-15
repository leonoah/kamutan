import type { LibraryImportKind } from '@kamutan/contracts';

/** OLE2 Compound File Binary header (legacy .xls). */
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_LOCAL = 0x04034b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const MAX_ZIP_ENTRIES = 20_000;

export function isXls(b: Buffer): boolean {
  return b.length >= 512 && b.subarray(0, 8).equals(CFB_SIGNATURE);
}

/**
 * Entry names from the ZIP central directory (EOCD → central headers). null when the buffer is not a well-formed
 * ZIP (bad signatures, offsets outside the buffer, too many entries). ZIP64 is not supported (≤ 20 MB uploads).
 */
export function zipEntryNames(b: Buffer): string[] | null {
  if (b.length < 22 || b.readUInt32LE(0) !== ZIP_LOCAL) return null;
  const minEocd = Math.max(0, b.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = b.length - 22; i >= minEocd; i--) {
    if (b.readUInt32LE(i) === ZIP_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (total > MAX_ZIP_ENTRIES || cdOffset + cdSize > eocd) return null;
  const names: string[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > eocd || b.readUInt32LE(p) !== ZIP_CENTRAL) return null;
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    if (p + 46 + nameLen > eocd) return null;
    names.push(b.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** OOXML workbook: a ZIP whose central directory lists [Content_Types].xml and xl/workbook.xml. */
export function isXlsx(b: Buffer): boolean {
  const names = zipEntryNames(b);
  return names !== null && names.includes('[Content_Types].xml') && names.includes('xl/workbook.xml');
}

/** Detects the spreadsheet kind from content only (magic bytes / structure), never from the filename. */
export function detectSpreadsheetKind(b: Buffer): LibraryImportKind | null {
  if (isXls(b)) return 'xls';
  if (isXlsx(b)) return 'xlsx';
  return null;
}
