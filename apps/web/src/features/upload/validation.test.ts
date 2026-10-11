import { MAX_FILE_BYTES, sniffKind, validateFile, validateFileDeep } from "./validation";
import { DWG_BYTES, DXF_BYTES, PDF_BYTES, PNG_BYTES, makeFile } from "@/test/utils";

const enc = (s: string) => new TextEncoder().encode(s);

describe("validateFile (sync)", () => {
  it.each(["plan.pdf", "PLAN.PDF", "a.dwg", "b.dxf", "c.png", "שרטוט חשמל.pdf"])("accepts %s", (name) => {
    expect(validateFile({ name, size: 10 })).toMatchObject({ ok: true });
  });

  it.each(["plan.rvt", "plan.jpg", "plan", "plan.pdf.exe", "notes.xlsx"])("rejects %s as unsupported", (name) => {
    expect(validateFile({ name, size: 10 })).toEqual({ ok: false, code: "unsupported" });
  });

  it("enforces the 100MB limit exactly", () => {
    expect(validateFile({ name: "a.pdf", size: MAX_FILE_BYTES })).toMatchObject({ ok: true });
    expect(validateFile({ name: "a.pdf", size: MAX_FILE_BYTES + 1 })).toEqual({ ok: false, code: "too_large" });
    expect(MAX_FILE_BYTES).toBe(100 * 1024 * 1024);
  });

  it("rejects empty files", () => {
    expect(validateFile({ name: "a.pdf", size: 0 })).toEqual({ ok: false, code: "empty" });
  });
});

describe("sniffKind (magic bytes, mirrors SEC-14)", () => {
  it("detects each allowed signature", () => {
    expect(sniffKind(enc(PDF_BYTES))).toBe("pdf");
    expect(sniffKind(PNG_BYTES)).toBe("png");
    expect(sniffKind(enc(DWG_BYTES))).toBe("dwg");
    expect(sniffKind(enc(DXF_BYTES))).toBe("dxf");
    expect(sniffKind(enc("0\r\nSECTION\r\n"))).toBe("dxf");
    expect(sniffKind(enc("AutoCAD Binary DXF\r\n\x1a\0"))).toBe("dxf");
  });
  it("returns null for anything else", () => {
    expect(sniffKind(enc("PK\x03\x04"))).toBeNull();
    expect(sniffKind(enc("<html>"))).toBeNull();
  });
});

describe("validateFileDeep", () => {
  it("accepts a real PDF", async () => {
    expect(await validateFileDeep(makeFile("a.pdf", PDF_BYTES))).toEqual({ ok: true, kind: "pdf" });
  });
  it("rejects a file whose bytes don't match its extension", async () => {
    expect(await validateFileDeep(makeFile("evil.pdf", "PK\x03\x04zip"))).toEqual({ ok: false, code: "mismatch" });
    expect(await validateFileDeep(makeFile("img.png", PDF_BYTES))).toEqual({ ok: false, code: "mismatch" });
  });
});
