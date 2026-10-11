import { describe, expect, it } from 'vitest';
import { detectFileKind, isDwg, isPdf, isPng, isTextDxf } from '../../src/uploads/magic-bytes';
import { SAMPLE } from '../support/helpers';

const b = (s: string) => Buffer.from(s, 'latin1');

describe('magic bytes', () => {
  it('detects PDF by %PDF- + version at offset 0 only', () => {
    expect(detectFileKind(SAMPLE.pdf)).toBe('pdf');
    expect(isPdf(b('%PDF-2.0\n...'))).toBe(true);
    expect(isPdf(b(' %PDF-1.7\n....'))).toBe(false);
    expect(isPdf(b('%PDF-x.y\n....'))).toBe(false);
    expect(isPdf(b('%PDF'))).toBe(false);
  });

  it('detects PNG by signature followed by IHDR', () => {
    expect(detectFileKind(SAMPLE.png)).toBe('png');
    const noIhdr = Buffer.from(SAMPLE.png);
    noIhdr.write('IDAT', 12, 'latin1');
    expect(isPng(noIhdr)).toBe(false);
    expect(isPng(SAMPLE.png.subarray(0, 8))).toBe(false);
  });

  it('detects DWG by AC10xx version prefix', () => {
    expect(detectFileKind(SAMPLE.dwg)).toBe('dwg');
    for (const v of ['AC1012', 'AC1015', 'AC1018', 'AC1024', 'AC1027', 'AC1032']) expect(isDwg(b(`${v}\0\0\0\0`))).toBe(true);
    expect(isDwg(b('AC2.10\0\0'))).toBe(false);
    expect(isDwg(b('AC10'))).toBe(false);
    expect(isDwg(b('AC10xx\0\0'))).toBe(false);
  });

  it('detects text DXF with comments, CRLF/LF, padded group codes, BOM', () => {
    expect(detectFileKind(SAMPLE.dxf)).toBe('dxf');
    expect(isTextDxf(b('0\nSECTION\n2\nENTITIES\n0\nLINE\n0\nENDSEC\n'))).toBe(true);
    expect(isTextDxf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b('  0\nSECTION\n  2\nHEADER\n')]))).toBe(true);
    expect(isTextDxf(b('\n\n  0\r\nSECTION\r\n  2\r\nTABLES\r\n  0\r\nENDSEC\r\n'))).toBe(true);
  });

  it('rejects DXF look-alikes', () => {
    expect(isTextDxf(b('0\nSECTION\n2\nNOT_A_SECTION\n0\nENDSEC\n'))).toBe(false);
    expect(isTextDxf(b('hello world\n0\nSECTION\n2\nHEADER\n'))).toBe(false);
    expect(isTextDxf(b('0\nSECTION\n2\nHEADER\n\0\0\0\0\0\0\0\0'))).toBe(false);
  });

  it('detects binary DXF sentinel', () => {
    expect(detectFileKind(b('AutoCAD Binary DXF\r\n\x1a\x00\x00\x00rest'))).toBe('dxf');
  });

  it('rejects everything else', () => {
    for (const s of [
      'MZ\x90\x00\x03\x00\x00\x00', // PE executable
      'PK\x03\x04\x14\x00\x00\x00', // zip / docx
      '\xff\xd8\xff\xe0\x00\x10JFIF', // jpeg
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      '<html><body>%PDF-1.7</body></html>',
      '',
    ]) {
      expect(detectFileKind(b(s))).toBeNull();
    }
  });
});
