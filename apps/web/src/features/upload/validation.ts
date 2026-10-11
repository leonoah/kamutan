import type { FileKind } from "@/api/types";

/** Client-side pre-checks only. The API/worker re-validates by magic bytes (SEC-14) — never trust this. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB (spec 05_ux flow 2, SEC-14)
export const ACCEPTED_EXTENSIONS: readonly FileKind[] = ["pdf", "dwg", "dxf", "png"] as const;
export const ACCEPT_ATTR = ".pdf,.dwg,.dxf,.png,application/pdf,image/png";

export type FileErrorCode = "unsupported" | "too_large" | "empty" | "mismatch" | "duplicate";

export type ValidationResult = { ok: true; kind: FileKind } | { ok: false; code: FileErrorCode };

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** Synchronous checks: extension allow-list, empty, size. */
export function validateFile(file: Pick<File, "name" | "size">): ValidationResult {
  const ext = extensionOf(file.name);
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) return { ok: false, code: "unsupported" };
  if (file.size === 0) return { ok: false, code: "empty" };
  if (file.size > MAX_FILE_BYTES) return { ok: false, code: "too_large" };
  return { ok: true, kind: ext as FileKind };
}

async function readHead(file: Blob, n: number): Promise<Uint8Array> {
  const slice = file.slice(0, n);
  if (typeof slice.arrayBuffer === "function") return new Uint8Array(await slice.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(slice);
  });
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** Detects the real type from the first bytes (same signatures as SEC-14). null = unknown. */
export function sniffKind(head: Uint8Array): FileKind | null {
  const s = ascii(head);
  if (s.startsWith("%PDF-")) return "pdf";
  if (/^AC10\d\d/.test(s)) return "dwg";
  if (head.length >= 8 && head[0] === 0x89 && s.slice(1, 4) === "PNG" && head[4] === 0x0d && head[5] === 0x0a) return "png";
  if (s.startsWith("AutoCAD Binary DXF")) return "dxf";
  // ASCII DXF: group code 0 then SECTION, allowing leading whitespace / CRLF / optional 999 comment.
  if (/^\s*(999\r?\n[^\n]*\r?\n\s*)?0\r?\nSECTION/.test(s)) return "dxf";
  return null;
}

/** Full client check: sync rules + magic-byte sniff matches the extension. */
export async function validateFileDeep(file: File): Promise<ValidationResult> {
  const basic = validateFile(file);
  if (!basic.ok) return basic;
  try {
    const sniffed = sniffKind(await readHead(file, 64));
    if (sniffed !== basic.kind) return { ok: false, code: "mismatch" };
  } catch {
    return { ok: false, code: "mismatch" };
  }
  return basic;
}
