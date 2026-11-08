import { qualityReasonHe, type InputQuality } from "@kamutan/contracts";
import type { UnderstandingFixture } from "@/test/fixtures/understanding";
import { ELECTRICAL_SPEC, makeUnderstandingFixture } from "@/test/fixtures/understanding";

/**
 * Sprint 9 mock: what the worker writes for a `warn` sheet — every detection / room capped at "סביר" or lower and
 * carrying the contracts' reason chip `qualityReasonHe(quality)` first ("איכות קובץ ירודה: צילום מסך ולא קובץ שרטוט").
 * (Mock-only module: it is part of the lazy mock chunk, so the contracts runtime never reaches real-mode bundles.)
 */
export function qualityCappedFixture(sheetId: string, quality: Pick<InputQuality, "issues" | "effectiveDpi">): UnderstandingFixture {
  const reason = qualityReasonHe(quality);
  const f = makeUnderstandingFixture({ ...ELECTRICAL_SPEC, sheetId, detections: 36, unknownClusters: [3], seed: 23 });
  const cap = <T extends { level: "green" | "yellow" | "red"; reasons: string[] }>(x: T): T => ({
    ...x,
    level: x.level === "green" ? "yellow" : x.level,
    reasons: [reason, ...x.reasons.filter((r) => r !== reason)].slice(0, 16),
  });
  return {
    ...f,
    detections: { ...f.detections, detections: f.detections.detections.map(cap) },
    rooms: { ...f.rooms, rooms: f.rooms.rooms.map(cap) },
  };
}
