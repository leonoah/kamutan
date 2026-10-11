import { EXTENSION_TO_KIND, type FileKind } from '@kamutan/contracts';

const MAX_NAME = 200;

/** Lower-cased extension → expected kind, or null when not allowed. */
export function kindFromFilename(filename: string): FileKind | null {
  const m = /\.([A-Za-z0-9]+)\s*$/.exec(filename);
  const ext = m?.[1]?.toLowerCase();
  return ext && ext in EXTENSION_TO_KIND ? EXTENSION_TO_KIND[ext as keyof typeof EXTENSION_TO_KIND] : null;
}

/**
 * Sanitizes a client-supplied filename for display/metadata (SEC-13). Keeps
 * Hebrew and other letters; drops directories, control and bidi/format
 * characters (e.g. U+202E RTL override used to spoof extensions), reserved
 * path characters and leading dots. The result is never used in a storage path.
 */
export function sanitizeFilename(input: string, fallbackExt = 'bin'): string {
  let name = input.normalize('NFC');
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
  name = name.replace(/[<>:"|?*]/g, '_');
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = name.slice(0, MAX_NAME - ext.length).trimEnd() + ext;
  }
  return name || `upload.${fallbackExt}`;
}
