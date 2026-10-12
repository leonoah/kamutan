/**
 * Best-effort static parser for Firebase security rules files. It is NOT a full
 * grammar: it strips comments, tracks `match` / `function` / brace nesting and
 * extracts every `allow` statement with the match path it lives under. Good enough
 * to enforce structural invariants in CI without the emulator.
 */

export interface AllowStmt {
  /** Full match path, e.g. "/databases/{database}/documents/orgs/{orgId}/projects/{projectId}/boqLines/{lineId}". */
  path: string;
  methods: string[];
  condition: string;
  line: number;
}

export interface ParsedRules {
  version: string | null;
  service: string | null;
  allows: AllowStmt[];
  matchPaths: string[];
  functions: string[];
  balanced: boolean;
}

export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function parseRules(src: string): ParsedRules {
  const s = stripComments(src);
  const version = /rules_version\s*=\s*['"](\d+)['"]/.exec(s)?.[1] ?? null;
  const service = /service\s+([\w.]+)\s*\{/.exec(s)?.[1] ?? null;
  const stack: Array<{ kind: 'match' | 'block'; path?: string }> = [];
  const allows: AllowStmt[] = [];
  const matchPaths: string[] = [];
  const functions: string[] = [];
  let balanced = true;

  const reMatch = /match\s+(\S+)\s*\{/y;
  const reFunc = /function\s+(\w+)\s*\([^)]*\)\s*\{/y;
  const reAllow = /allow\s+([\w\s,]+?)\s*:\s*if\s+([^;]*);/y;
  const lineAt = (idx: number) => s.slice(0, idx).split('\n').length;
  const currentPath = () => stack.filter((f) => f.kind === 'match').map((f) => f.path).join('');

  let i = 0;
  while (i < s.length) {
    for (const re of [reMatch, reFunc, reAllow]) re.lastIndex = i;
    let m: RegExpExecArray | null;
    if ((m = reMatch.exec(s))) {
      stack.push({ kind: 'match', path: m[1] });
      matchPaths.push(currentPath());
      i = reMatch.lastIndex;
    } else if ((m = reFunc.exec(s))) {
      functions.push(m[1]);
      stack.push({ kind: 'block' });
      i = reFunc.lastIndex;
    } else if ((m = reAllow.exec(s))) {
      allows.push({
        path: currentPath(),
        methods: m[1].split(',').map((x) => x.trim()).filter(Boolean),
        condition: m[2].replace(/\s+/g, ' ').trim(),
        line: lineAt(i),
      });
      i = reAllow.lastIndex;
    } else if (s[i] === '{') {
      stack.push({ kind: 'block' });
      i++;
    } else if (s[i] === '}') {
      if (!stack.pop()) balanced = false;
      i++;
    } else {
      i++;
    }
  }
  if (stack.length !== 0) balanced = false;
  return { version, service, allows, matchPaths, functions, balanced };
}

export const WRITE_METHODS = new Set(['write', 'create', 'update', 'delete']);

export function isDenyAll(cond: string): boolean {
  return cond === 'false';
}
