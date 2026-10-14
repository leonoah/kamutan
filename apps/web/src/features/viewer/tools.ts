import { Eraser, Hash, Lasso, Link2, Move, MousePointer2, PlusCircle, Ruler, Scaling, SquareDashed } from "lucide-react";
import type { ViewerTool } from "@kamutan/viewer";

/* Kept out of SheetViewer.tsx so pages can map keys without pulling deck.gl into their chunk (type-only viewer import). */
/** Tool rail entries; keys by event.code (physical key → also on a Hebrew layout). */
export const TOOL_META: Record<ViewerTool, { key: string; code: string; shift?: boolean; icon: typeof Lasso; label: string }> = {
  select: { key: "V", code: "KeyV", icon: MousePointer2, label: "viewer.select" },
  pan: { key: "H", code: "KeyH", icon: MousePointer2, label: "viewer.select" },
  lasso: { key: "L", code: "KeyL", icon: Lasso, label: "viewer.lasso" },
  measure: { key: "D", code: "KeyD", icon: Ruler, label: "viewer.measure" },
  calibrate: { key: "S", code: "KeyS", icon: Scaling, label: "viewer.calibrate" },
  add: { key: "+", code: "Equal", shift: true, icon: PlusCircle, label: "viewer.add" },
  remove: { key: "Del", code: "Delete", icon: Eraser, label: "viewer.remove" },
  move: { key: "W", code: "KeyW", icon: Move, label: "viewer.move" },
  link: { key: "G", code: "KeyG", icon: Link2, label: "viewer.link" },
  count: { key: "C", code: "KeyC", icon: Hash, label: "viewer.count" },
  area: { key: "M", code: "KeyM", icon: SquareDashed, label: "viewer.area" },
  length: { key: "D", code: "KeyD", icon: Ruler, label: "viewer.length" },
};

export const toolForKey = (tools: readonly ViewerTool[], e: { code: string; shiftKey: boolean }): ViewerTool | null =>
  tools.find((k) => TOOL_META[k].code === e.code && Boolean(TOOL_META[k].shift) === e.shiftKey) ?? null;
