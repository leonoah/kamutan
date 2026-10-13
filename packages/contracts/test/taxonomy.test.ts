import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DetectionClassSchema,
  SYMBOL_CLASS_INFO,
  SYMBOL_CLASSES,
  SymbolClassSchema,
  TAXONOMY_SCHEMA_VERSION,
} from '../src/index.js';

const classesJson = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'benchmark', 'schema', 'classes.json'), 'utf8')) as {
  schema_version: string;
  classes: Record<string, { domain: string; core: boolean; he: string }>;
};

describe('taxonomy (generated from benchmark/schema/classes.json)', () => {
  it('stays in sync with classes.json — run `pnpm --filter @kamutan/contracts gen:taxonomy` if this fails', () => {
    expect(TAXONOMY_SCHEMA_VERSION).toBe(classesJson.schema_version);
    const ids = Object.keys(classesJson.classes).filter((id) => id !== 'unknown'); // reserved, see gen-taxonomy.cjs
    expect([...SYMBOL_CLASSES]).toEqual(ids);
    for (const [id, c] of Object.entries(classesJson.classes).filter(([k]) => k !== 'unknown')) {
      expect(SYMBOL_CLASS_INFO[id as keyof typeof SYMBOL_CLASS_INFO], id).toEqual({ domain: c.domain, core: Boolean(c.core), he: c.he });
    }
  });

  it('assignable classes exclude "unknown"; detections allow it', () => {
    expect(SymbolClassSchema.safeParse('socket_double').success).toBe(true);
    expect(SymbolClassSchema.safeParse('unknown').success).toBe(false);
    expect(SymbolClassSchema.safeParse('socket_quadruple').success).toBe(false);
    expect(DetectionClassSchema.safeParse('unknown').success).toBe(true);
    expect(DetectionClassSchema.safeParse('nope').success).toBe(false);
  });
});
