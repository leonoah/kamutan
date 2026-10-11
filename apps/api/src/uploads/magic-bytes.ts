import type { FileKind } from '@kamutan/contracts';

/** How many leading bytes the detector needs. */
export const SNIFF_BYTES = 4096;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BINARY_DXF_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\x00';
const DXF_SECTIONS = new Set(['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS', 'THUMBNAILIMAGE', 'ACDSDATA']);

const ascii = (b: Uint8Array, start: number, len: number) =>
  String.fromCharCode(...b.subarray(start, Math.min(b.length, start + len)));

export function isPdf(b: Uint8Array): boolean {
  // "%PDF-" followed by a version digit, at offset 0 (no leading junk accepted).
  return b.length >= 8 && ascii(b, 0, 5) === '%PDF-' && /^[0-9]$/.test(ascii(b, 5, 1));
}

export function isPng(b: Uint8Array): boolean {
  if (b.length < 16) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (b[i] !== PNG_SIGNATURE[i]) return false;
  // First chunk must be IHDR.
  return ascii(b, 12, 4) === 'IHDR';
}

/** DWG: version string "AC10xx" (R13 = AC1012 … R2018+ = AC1032) at offset 0. */
export function isDwg(b: Uint8Array): boolean {
  return b.length >= 6 && /^AC10[0-9]{2}$/.test(ascii(b, 0, 6));
}

export function isBinaryDxf(b: Uint8Array): boolean {
  return b.length >= BINARY_DXF_SENTINEL.length && ascii(b, 0, BINARY_DXF_SENTINEL.length) === BINARY_DXF_SENTINEL;
}

/**
 * ASCII DXF heuristic: group-code/value line pairs. After optional 999 comment
 * pairs (and an optional UTF-8 BOM / leading blank lines) the file must start
 * with `0 / SECTION / 2 / <known section name>`. Binary junk (NUL) is rejected.
 */
export function isTextDxf(b: Uint8Array): boolean {
  if (b.length < 16) return false;
  let start = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) start = 3;
  const head = b.subarray(start, Math.min(b.length, SNIFF_BYTES));
  if (head.includes(0)) return false;
  const text = Buffer.from(head).toString('latin1');
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let i = 0;
  while (i < lines.length && lines[i] === '') i++;
  // Skip comment pairs: "999" + comment line.
  while (i + 1 < lines.length && lines[i] === '999') i += 2;
  return (
    i + 3 < lines.length &&
    /^0+$/.test(lines[i] ?? '') &&
    lines[i + 1] === 'SECTION' &&
    /^0*2$/.test(lines[i + 2] ?? '') &&
    DXF_SECTIONS.has(lines[i + 3] ?? '')
  );
}

/** Detects the file kind from leading bytes only (SEC-14). Returns null for anything not allowed. */
export function detectFileKind(head: Uint8Array): FileKind | null {
  if (isPdf(head)) return 'pdf';
  if (isPng(head)) return 'png';
  if (isDwg(head)) return 'dwg';
  if (isBinaryDxf(head) || isTextDxf(head)) return 'dxf';
  return null;
}
