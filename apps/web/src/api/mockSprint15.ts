import { auditSummaryHe, computeMissingItems, exclusionIdFor, filterMissing, missingCounts } from "@kamutan/contracts";
import {
  ApiError,
  type BoqChapter,
  type BoqExclusion,
  type BoqLine,
  type BoqRule,
  type LibraryItem,
  type MissingItemFilter,
  type MissingItemsView,
  type Role,
  type SetBoqExclusionRequest,
  type SetBoqExclusionResponse,
} from "./types";

/**
 * Sprint 15 mock — stand-in for the API's "סעיפים שלא זוהו" (GET …/boq/missing-items, POST …/boq/exclusions). The list is
 * the contracts' own `computeMissingItems` (the API runs the same function), the decisions live per project apart from
 * the BOQ lines, so a rebuild (which rewrites the mock's lines) keeps them — like the real `boqExclusions` collection.
 */
export interface MissingMockDeps {
  /** ALL lines of the project (before the exclusions are applied). */
  lines(projectId: string): readonly BoqLine[];
  built(projectId: string): boolean;
  library(): readonly LibraryItem[];
  rules(): readonly BoqRule[];
  chapters(): readonly BoqChapter[];
  role(): Role;
  actorUid(): string;
  /** Audit of the org hash chain (`boqExclusions/exclude|restore`, code + unit only). */
  audit(projectId: string, action: "exclude" | "restore", entityId: string, after: { code: string; unit: string }, summary: string): void;
  emit(): void;
}

const now = () => new Date().toISOString();

export function createMissingMock(deps: MissingMockDeps) {
  const store = new Map<string, Map<string, BoqExclusion>>();
  const of = (projectId: string) => {
    let m = store.get(projectId);
    if (!m) store.set(projectId, (m = new Map()));
    return m;
  };

  return {
    /** Every exclusion doc of the project (active and restored). */
    exclusions(projectId: string): BoqExclusion[] {
      return [...(store.get(projectId)?.values() ?? [])].map((e) => ({ ...e }));
    },
    dropProject(projectId: string) {
      store.delete(projectId);
    },
    view(projectId: string, filter: MissingItemFilter = "all"): MissingItemsView {
      if (!deps.built(projectId)) return { built: false, filter, counts: { all: 0, inProject: 0, notRelevant: 0 }, items: [] };
      const all = computeMissingItems({
        library: deps.library().filter((i) => i.active).map((i) => ({ ...i, chapterTitle: i.chapterTitle ?? undefined })),
        lines: deps.lines(projectId),
        exclusions: this.exclusions(projectId),
        templateChapters: deps.chapters(),
        // the mock's fixture rules say `match.class`; the real contract (and worker) say `match.classes[]`
        rules: deps.rules().map((r) => {
          const m = r.match as { class?: unknown; classes?: unknown } | null;
          return r.kind === "class_to_item" && m && !Array.isArray(m.classes) && typeof m.class === "string" ? { ...r, match: { ...m, classes: [m.class] } } : r;
        }),
      });
      return { built: true, filter, counts: missingCounts(all), items: filterMissing(all, filter) as MissingItemsView["items"] };
    },
    set(projectId: string, req: SetBoqExclusionRequest): SetBoqExclusionResponse {
      const role = deps.role();
      if (role !== "admin" && role !== "editor") throw new ApiError(403, "forbidden", "editors only");
      const code = req.code.trim();
      const m = of(projectId);
      const cur = m.get(code) ?? null;
      const id = exclusionIdFor(code);
      if (req.excluded) {
        if (cur?.active) return { exclusion: { ...cur }, changed: false };
        const item = deps.library().find((i) => i.active && i.code === code) ?? null;
        const line = deps.lines(projectId).find((l) => l.code === code) ?? null;
        if (!item && !line) throw new ApiError(404, "not_found", "Item not found");
        const next: BoqExclusion = {
          id,
          code,
          description: item?.description ?? line?.description ?? "",
          unit: item?.unit ?? line?.unit ?? "",
          chapter: item?.chapter ?? line?.chapter ?? "",
          active: true,
          excludedBy: deps.actorUid(),
          excludedAt: now(),
          reason: req.reason?.trim() || null,
          restoredBy: null,
          restoredAt: null,
        };
        m.set(code, next);
        deps.audit(projectId, "exclude", id, { code, unit: next.unit }, auditSummaryHe({ entity: "boqExclusions", action: "exclude", entityId: id, after: { code } }));
        deps.emit();
        return { exclusion: { ...next }, changed: true };
      }
      if (!cur) throw new ApiError(404, "not_found", "Exclusion not found");
      if (!cur.active) return { exclusion: { ...cur }, changed: false };
      const next: BoqExclusion = { ...cur, active: false, restoredBy: deps.actorUid(), restoredAt: now() };
      m.set(code, next);
      deps.audit(projectId, "restore", id, { code, unit: cur.unit }, auditSummaryHe({ entity: "boqExclusions", action: "restore", entityId: id, after: { code } }));
      deps.emit();
      return { exclusion: { ...next }, changed: true };
    },
  };
}

export type MissingMock = ReturnType<typeof createMissingMock>;
