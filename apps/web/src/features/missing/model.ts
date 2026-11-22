import type { MissingItem, MissingItemCounts, MissingItemFilter } from "@/api/types";

/** "סעיפים שלא זוהו" — pure helpers over the server's view (the server owns the list, the sort and the counts). */

export interface MissingChapterGroup {
  /** Chapter key as the server sent it ("04"). */
  chapter: string;
  title: string;
  items: MissingItem[];
}

/**
 * Groups the (already chapter-then-code sorted) items by chapter, keeping the server's order: a chapter is a run of
 * items with the same chapter key, in first-seen order. Deterministic: the same input always gives the same groups.
 */
export function groupMissingByChapter(items: readonly MissingItem[]): MissingChapterGroup[] {
  const out: MissingChapterGroup[] = [];
  const byKey = new Map<string, MissingChapterGroup>();
  for (const it of items) {
    let g = byKey.get(it.chapter);
    if (!g) {
      g = { chapter: it.chapter, title: it.chapterTitle, items: [] };
      byKey.set(it.chapter, g);
      out.push(g);
    }
    g.items.push(it);
  }
  return out;
}

/** The filter chips, in display order, with their counter. */
export function filterCounter(filter: MissingItemFilter, counts: MissingItemCounts): number {
  return filter === "all" ? counts.all : filter === "in_project" ? counts.inProject : counts.notRelevant;
}

/** "סמן בשרטוט" needs a drawing tool: lump-sum items (no count / m² / m) have none. */
export const canMarkItem = (it: MissingItem): boolean => it.state === "open" && it.markKind !== null;

/** "למד" after one marked instance: only for symbol-based items (a rule maps symbol classes to the item) and only after a count. */
export const canLearnAfterMark = (it: Pick<MissingItem, "markKind" | "classes">): boolean => it.markKind === "count" && it.classes.length > 0;

/** Correction unit for the manual quantity the mark saves. */
export const MARK_UNIT = { count: "unit", measure_area: "m2", measure_length: "m" } as const;
