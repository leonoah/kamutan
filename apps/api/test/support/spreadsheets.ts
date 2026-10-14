import ExcelJS from 'exceljs';

/** A real (tiny) .xlsx produced by exceljs. */
export async function xlsxBytes(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('כמויות').getCell('A1').value = '4.10';
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** OLE CFB header + padding (what a legacy .xls starts with). */
export const XLS_BYTES = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(1024)]);
