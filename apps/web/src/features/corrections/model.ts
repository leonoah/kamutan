import type { Correction, CorrectionUnit, CreateCorrectionRequest, Detection, LinkGroup, LinksArtifact, PointMm } from "@/api/types";
import { domainOf } from "@/features/understanding/taxonomy";

/**
 * Pure model of Sprint-4 human corrections (brief §Corrections): corrections are applied AFTER automatic detection
 * and re-matched to newer versions by `anchorMm` within `radiusMm` (+ class family). The web uses this for the
 * optimistic overlay; the mock backend uses the same functions as its stand-in for Worker-BOQ.
 */

export const DEFAULT_RADIUS_MM = 3;
export const MANUAL_REASON = "אושר ידנית";
export const ADDED_REASON = "נוסף ידנית";
export const LEARNED_REASON = "תוקן בלמידה";

let seq = 0;
/** Client-generated ids (corrections are idempotent by id: an optimistic write and its retry share one id). */
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const isActive = (c: Pick<Correction, "revertedAt">) => !c.revertedAt;

const d2 = (a: PointMm, b: PointMm) => Math.hypot(a.x - b.x, a.y - b.y);

/** Class family for anchor re-matching (sockets ≈ sockets, luminaires ≈ luminaires…). */
export function classFamily(cls: string | null | undefined): string {
  if (!cls) return "";
  const m = /^(socket|switch|luminaire|fixture|faucet)_/.exec(cls);
  return m ? m[1]! : domainOf(cls);
}

/** Base for a correction request with the brief's defaults. */
export function baseCorrection(
  kind: Correction["kind"],
  at: { sheetId: string; versionId: string; anchorMm: PointMm },
  extra: Partial<CreateCorrectionRequest> = {},
): CreateCorrectionRequest {
  return {
    id: newId("corr"),
    kind,
    sheetId: at.sheetId,
    versionId: at.versionId,
    anchorMm: { x: round(at.anchorMm.x), y: round(at.anchorMm.y) },
    radiusMm: DEFAULT_RADIUS_MM,
    detectionId: null,
    signature: null,
    class: null,
    itemCode: null,
    linkGroupId: null,
    geometry: null,
    quantity: null,
    unit: null,
    roomId: null,
    floor: null,
    reason: null,
    batchId: null,
    ...extra,
  };
}
const round = (n: number) => Math.round(n * 100) / 100;

/** Server-shaped correction from a request (mock backend + optimistic cache). */
export function materialize(req: CreateCorrectionRequest, by: string, at = new Date().toISOString()): Correction {
  return { ...req, id: req.id ?? newId("corr"), batchId: req.batchId ?? null, by, at, revertedAt: null };
}

export interface AppliedCorrections {
  /** Effective detections: corrected, added; rejected ones flagged (not removed) so a "נדחו" layer can show them. */
  detections: Detection[];
  /** Corrections of this sheet that could not be re-matched to the current version. */
  unmatched: Correction[];
}

/**
 * Apply active corrections of one sheet (oldest first) to its detections. Re-match: same detection id (same version
 * or stable id), else the nearest detection of the same class family within `radiusMm` of `anchorMm`.
 */
export function applyCorrections(dets: readonly Detection[], corrections: readonly Correction[], sheetId: string): AppliedCorrections {
  const list = corrections.filter((c) => c.sheetId === sheetId && isActive(c)).sort((a, b) => a.at.localeCompare(b.at));
  if (!list.length) return { detections: dets as Detection[], unmatched: [] };
  const out = dets.map((d) => ({ ...d }));
  const byId = new Map(out.map((d) => [d.id, d]));
  const unmatched: Correction[] = [];
  const find = (c: Correction): Detection | null => {
    if (c.detectionId) {
      const hit = byId.get(c.detectionId);
      if (hit) return hit;
    }
    if (!c.detectionId && c.kind !== "move") return null;
    const fam = classFamily(c.signature ?? c.class);
    let best: Detection | null = null;
    let bestD = Infinity;
    for (const d of out) {
      const dist = d2(d.centerMm, c.anchorMm);
      if (dist <= c.radiusMm && dist < bestD && (!fam || classFamily(d.class) === fam || d.manual === "added")) {
        best = d;
        bestD = dist;
      }
    }
    return best;
  };
  for (const c of list) {
    if (c.kind === "add") {
      const geom = c.geometry?.mm[0] ?? c.anchorMm;
      const r = Math.max(1.5, c.radiusMm);
      const d: Detection = {
        id: `m_${c.id}`,
        class: c.class ?? "unknown",
        legendEntryId: null,
        centerMm: { x: geom.x, y: geom.y },
        bboxMm: { x: geom.x - r, y: geom.y - r, w: 2 * r, h: 2 * r },
        angleDeg: 0,
        score: 1,
        level: "green",
        reasons: [ADDED_REASON],
        roomId: c.roomId,
        floor: c.floor,
        lifecycle: "new",
        supply: null,
        annotations: [],
        clusterId: null,
        manual: "added",
        correctionId: c.id,
      };
      out.push(d);
      byId.set(d.id, d);
      continue;
    }
    if (!["accept", "reject", "remove", "reclassify", "move"].includes(c.kind)) continue;
    const d = find(c);
    if (!d) {
      unmatched.push(c);
      continue;
    }
    d.correctionId = c.id;
    switch (c.kind) {
      case "accept":
        d.level = "green";
        d.rejected = false;
        d.manual = d.manual === "added" ? "added" : d.manual === "reclassified" || d.manual === "learned" ? d.manual : "accepted";
        d.reasons = [MANUAL_REASON];
        break;
      case "reject":
      case "remove":
        d.rejected = true;
        break;
      case "reclassify":
        if (c.class) d.class = c.class;
        d.level = "green";
        d.rejected = false;
        d.clusterId = null;
        d.manual = d.manual === "added" ? "added" : c.reason === "learned" ? "learned" : "reclassified";
        d.reasons = [c.reason === "learned" ? LEARNED_REASON : MANUAL_REASON];
        break;
      case "move": {
        const to = c.geometry?.mm[0];
        if (to) {
          const dx = to.x - d.centerMm.x;
          const dy = to.y - d.centerMm.y;
          d.centerMm = { x: to.x, y: to.y };
          d.bboxMm = { ...d.bboxMm, x: d.bboxMm.x + dx, y: d.bboxMm.y + dy };
          if (!d.manual) d.manual = "moved";
        }
        break;
      }
    }
  }
  return { detections: out, unmatched };
}

/** Only items that count (rejected ones never do). */
export const counted = (dets: readonly Detection[]) => dets.filter((d) => !d.rejected);

/**
 * Switch↔point links edited by hand: `link` attaches the point (luminaire) to the switch's group (or makes a new
 * group); `unlink` detaches it. Returns a new artifact (input untouched).
 */
export function applyLinkCorrections(links: LinksArtifact | null, corrections: readonly Correction[], sheetId: string): LinksArtifact | null {
  const list = corrections
    .filter(
      (c) =>
        c.sheetId === sheetId &&
        isActive(c) &&
        (c.kind === "link" || c.kind === "unlink" || ((c.kind === "accept" || c.kind === "reject") && c.linkGroupId)),
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  if (!list.length) return links;
  const groups: LinkGroup[] = (links?.groups ?? []).map((g) => ({
    ...g,
    switchIds: [...g.switchIds],
    luminaireIds: [...g.luminaireIds],
    pointIds: [...g.pointIds],
  }));
  for (const c of list) {
    if (c.kind === "accept" || c.kind === "reject") {
      const g = groups.find((x) => x.id === c.linkGroupId);
      if (g && c.kind === "accept") Object.assign(g, { level: "green", confidence: 1, reasons: [MANUAL_REASON] });
      if (g && c.kind === "reject") g.luminaireIds = [];
      continue;
    }
    const sw = c.switchIds?.[0];
    const pts = c.pointIds ?? [];
    if (!sw || !pts.length) continue;
    if (c.kind === "link") {
      // The point leaves its old group; joins the switch's group (or the point's group gets this switch: two-way).
      const pGroup = groups.find((g) => pts.some((p) => g.luminaireIds.includes(p)));
      const sGroup = groups.find((g) => g.switchIds.includes(sw));
      if (pGroup && !pGroup.switchIds.includes(sw) && pGroup !== sGroup) {
        pGroup.switchIds.push(sw);
        pGroup.kind = pGroup.switchIds.length >= 2 ? "two_way" : pGroup.kind;
        Object.assign(pGroup, { level: "green", confidence: 1, reasons: [MANUAL_REASON] });
      } else if (sGroup) {
        for (const p of pts) if (!sGroup.luminaireIds.includes(p)) sGroup.luminaireIds.push(p);
        sGroup.kind = sGroup.luminaireIds.length >= 3 ? "shared" : sGroup.luminaireIds.length === 2 ? "shared" : "single";
        Object.assign(sGroup, { level: "green", confidence: 1, reasons: [MANUAL_REASON] });
      } else {
        groups.push({
          id: c.linkGroupId ?? `lk_m${groups.length + 1}`,
          switchIds: [sw],
          pointIds: pts.map((_, i) => `${c.id}_p${i}`),
          luminaireIds: [...pts],
          kind: pts.length > 1 ? "shared" : "single",
          confidence: 1,
          level: "green",
          reasons: [MANUAL_REASON],
        });
      }
    } else {
      for (const g of groups)
        if (g.switchIds.includes(sw)) {
          g.luminaireIds = g.luminaireIds.filter((p) => !pts.includes(p));
          Object.assign(g, { level: "green", confidence: 1, reasons: [MANUAL_REASON] });
        }
    }
  }
  return { schema: "kamutan.links/1", ...(links ?? {}), groups: groups.filter((g) => g.luminaireIds.length > 0) };
}

/* ---------------- manual items (count / measure) ---------------- */

/** Contract unit → Hebrew display unit. */
export const unitLabel = (u: CorrectionUnit | null): string => (u === "m2" ? 'מ"ר' : u === "m" ? 'מ"א' : "יחידה");

export interface ManualItem {
  id: string;
  kind: "count" | "area" | "length";
  sheetId: string;
  itemCode: string | null;
  quantity: number;
  unit: string;
  points: PointMm[];
  correction: Correction;
}
export function manualItems(corrections: readonly Correction[], sheetId?: string): ManualItem[] {
  return corrections
    .filter((c) => isActive(c) && (c.kind === "count" || c.kind === "measure") && (!sheetId || c.sheetId === sheetId))
    .map((c) => ({
      id: c.id,
      kind: c.kind === "count" ? "count" : c.geometry?.type === "polygon" ? "area" : "length",
      sheetId: c.sheetId,
      itemCode: c.itemCode,
      quantity: c.quantity ?? c.geometry?.mm.length ?? 0,
      unit: unitLabel(c.unit ?? (c.kind === "count" ? "unit" : c.geometry?.type === "polygon" ? "m2" : "m")),
      points: c.geometry?.mm ?? [c.anchorMm],
      correction: c,
    }));
}

/* ---------------- undo stack ---------------- */

/** One step in the session history (a group action is one step). */
export interface HistoryStep {
  label: string;
  /** Correction ids written by this step (all reverted together). */
  ids: string[];
  /** Requests to re-send on redo (new ids). */
  redo: CreateCorrectionRequest[];
  batchId: string | null;
  /** UI bookkeeping (e.g. the queue item to restore on undo). */
  meta?: Record<string, unknown>;
}
export interface History {
  past: HistoryStep[];
  future: HistoryStep[];
}
export const HISTORY_LIMIT = 100;
export const pushStep = (h: History, s: HistoryStep): History => ({ past: [...h.past, s].slice(-HISTORY_LIMIT), future: [] });
export function popUndo(h: History): { step: HistoryStep | null; next: History } {
  const step = h.past[h.past.length - 1] ?? null;
  return step ? { step, next: { past: h.past.slice(0, -1), future: [step, ...h.future] } } : { step: null, next: h };
}
export function popRedo(h: History): { step: HistoryStep | null; next: History } {
  const step = h.future[0] ?? null;
  return step ? { step, next: { past: [...h.past, step], future: h.future.slice(1) } } : { step: null, next: h };
}
/** Fresh ids for a redo (the reverted originals stay in the audit trail). */
export const reissue = (reqs: readonly CreateCorrectionRequest[], batchId: string | null): CreateCorrectionRequest[] =>
  reqs.map((r) => ({ ...r, id: newId("corr"), batchId }));
