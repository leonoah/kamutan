import {
  ApiError,
  CORRECTION_KINDS,
  type Correction,
  type CreateCorrectionRequest,
  type CreateCorrectionsBatchRequest,
  type Detection,
  type FindSimilarRequest,
  type ReviewQueueResponse,
  type RoomSettings,
  type RoomSettingsDoc,
  type RoomSettingsResponse,
  type SheetRow,
  type SimilarCandidate,
  type SimilarSearch,
} from "./types";
import type { UnderstandingMock } from "./mockUnderstanding";
import type { BoqMock } from "./mockBoq";
import { applyCorrections, isActive, materialize, newId } from "@/features/corrections/model";
import { buildReviewQueue, type QueueSheetInput } from "@/features/review/queueModel";
import { defaultSettings, settingsDocId } from "@/features/tiling/model";
import { classFamily } from "@/features/corrections/model";
import { domainOf } from "@/features/understanding/taxonomy";
import { authoritativeRooms } from "./mockSprint4Engine";

/**
 * Mock Sprint-4 backend: corrections (CRUD + batch + revert), the ranked review queue, room settings and the
 * `symbols.find_similar` job. Every write re-derives the BOQ at once (mock Worker-BOQ), so the UI sees overlay AND
 * quantities change immediately.
 */
export interface ReviewMockDeps {
  rows(projectId: string): SheetRow[];
  understanding: UnderstandingMock;
  boq: () => BoqMock;
  emit(): void;
  /** Delay before a find-similar job completes (ms). */
  similarMs: number;
}

/** Deterministic 0..1 from a string (FNV-1a) — the "random jitter" of candidate scores is stable per item. */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

export function createReviewMock(deps: ReviewMockDeps) {
  const corrections = new Map<string, Correction[]>(); // projectId → all (incl. reverted)
  const settings = new Map<string, Map<string, RoomSettingsDoc>>(); // projectId → docId → doc
  const searches = new Map<string, SimilarSearch & { readyAt: number; projectId: string }>();

  const list = (projectId: string) => {
    let l = corrections.get(projectId);
    if (!l) corrections.set(projectId, (l = []));
    return l;
  };
  const ready = (projectId: string) => deps.rows(projectId).filter((r) => r.version?.status === "ready");
  const validate = (req: CreateCorrectionRequest) => {
    if (!CORRECTION_KINDS.includes(req.kind)) throw new ApiError(400, "validation_failed", `unknown kind ${String(req.kind)}`);
    if (!req.sheetId || !req.versionId) throw new ApiError(400, "validation_failed", "sheetId and versionId are required");
    if (!Number.isFinite(req.anchorMm?.x) || !Number.isFinite(req.anchorMm?.y)) throw new ApiError(400, "validation_failed", "anchorMm");
    if ((req.kind === "add" || req.kind === "reclassify") && !req.class) throw new ApiError(400, "validation_failed", "class is required");
    if ((req.kind === "count" || req.kind === "measure") && !(req.quantity !== null && req.quantity >= 0))
      throw new ApiError(400, "validation_failed", "quantity");
    // Same per-kind rules as contracts CreateCorrectionRequestSchema (so the mock catches what the API would 400).
    if (req.kind === "measure" && req.unit !== (req.geometry?.type === "polygon" ? "m2" : "m"))
      throw new ApiError(400, "validation_failed", "measure unit");
    if (req.kind === "count" && req.geometry && req.quantity !== req.geometry.mm.length)
      throw new ApiError(400, "validation_failed", "count quantity");
    if (req.kind === "add" && req.detectionId) throw new ApiError(400, "validation_failed", "add has no detectionId");
    if (req.kind === "unlink" && !req.linkGroupId) throw new ApiError(400, "validation_failed", "unlink needs a linkGroupId");
    if (req.kind !== "measure" && req.kind !== "count" && req.unit !== null) throw new ApiError(400, "validation_failed", "unit");
    if (req.signature !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(req.signature)) throw new ApiError(400, "validation_failed", "signature");
  };
  const write = (projectId: string, reqs: CreateCorrectionRequest[]) => {
    const l = list(projectId);
    const out: Correction[] = [];
    for (const r of reqs) {
      validate(r);
      // Idempotent by id (an optimistic write retried).
      const existing = r.id ? l.find((c) => c.id === r.id) : undefined;
      if (existing) {
        out.push(existing);
        continue;
      }
      const c = materialize(r, "mock-user");
      l.push(c);
      out.push(c);
    }
    return out;
  };

  async function sheetInputs(projectId: string): Promise<{ inputs: QueueSheetInput[]; unmatched: Correction[] }> {
    const all = list(projectId);
    const inputs: QueueSheetInput[] = [];
    const unmatched: Correction[] = [];
    const rows = ready(projectId);
    const arts = await Promise.all(rows.map((r) => deps.understanding.artifacts(r)));
    // Rooms are reviewed where the tiling quantities come from (one authoritative sheet per floor), not on every sheet.
    const auth = authoritativeRooms(rows.map((row, i) => ({ row, detections: [], rooms: arts[i]!.rooms?.rooms ?? [] })));
    const authIds = new Set(auth.map((x) => `${x.row.sheet.id}/${x.room.id}`));
    for (const [i, row] of rows.entries()) {
      const a = arts[i]!;
      const applied = applyCorrections(a.detections?.detections ?? [], all, row.sheet.id);
      unmatched.push(...applied.unmatched);
      const links = deps.boq().links(projectId, row.sheet.id);
      inputs.push({
        sheetId: row.sheet.id,
        versionId: row.version!.id,
        detections: applied.detections,
        unknownClusters: a.detections?.unknownClusters ?? [],
        linkGroups: links?.groups ?? [],
        rooms: (a.rooms?.rooms ?? []).filter((r) => authIds.has(`${row.sheet.id}/${r.id}`)),
        thumbs: a.thumbs,
      });
    }
    return { inputs, unmatched };
  }

  const settingsMap = (projectId: string): Map<string, RoomSettings> => new Map([...(settings.get(projectId)?.values() ?? [])].map((d) => [d.id, d]));

  return {
    /** Active corrections (deps of the BOQ mock). */
    active: (projectId: string): Correction[] => list(projectId).filter(isActive),
    roomSettingsMap: settingsMap,

    async listCorrections(projectId: string, sheetId?: string) {
      return {
        items: list(projectId)
          .filter((c) => !sheetId || c.sheetId === sheetId)
          .map((c) => ({ ...c })),
      };
    },
    async create(projectId: string, req: CreateCorrectionRequest) {
      const [c] = write(projectId, [req]);
      await deps.boq().recompute(projectId);
      deps.emit();
      return { ...c! };
    },
    async createBatch(projectId: string, req: CreateCorrectionsBatchRequest) {
      if (!req.batchId) throw new ApiError(400, "validation_failed", "batchId");
      if (req.corrections.length > 500) throw new ApiError(400, "validation_failed", "max 500 corrections per batch");
      const items = write(
        projectId,
        req.corrections.map((c) => ({ ...c, batchId: req.batchId })),
      );
      await deps.boq().recompute(projectId);
      deps.emit();
      return { items: items.map((c) => ({ ...c })), batchId: req.batchId };
    },
    async revert(projectId: string, id: string) {
      const c = list(projectId).find((x) => x.id === id);
      if (!c) throw new ApiError(404, "not_found", "Correction not found");
      c.revertedAt ??= new Date().toISOString();
      await deps.boq().recompute(projectId);
      deps.emit();
      return { ...c };
    },
    async revertBatch(projectId: string, batchId: string) {
      const items = list(projectId).filter((x) => x.batchId === batchId);
      if (!items.length) throw new ApiError(404, "not_found", "Batch not found");
      const at = new Date().toISOString();
      let reverted = 0;
      for (const c of items)
        if (!c.revertedAt) {
          c.revertedAt = at;
          reverted++;
        }
      await deps.boq().recompute(projectId);
      deps.emit();
      return { reverted };
    },

    async reviewQueue(projectId: string, filter?: string): Promise<ReviewQueueResponse> {
      const { inputs, unmatched } = await sheetInputs(projectId);
      const boq = deps.boq();
      const lines = boq.state(projectId) ? boq.listLines(projectId).items : [];
      const lineOf = new Map<string, string[]>();
      for (const s of inputs) {
        const ev = boq.sheetEvidence(projectId, s.sheetId, s.versionId);
        for (const [det, ids] of Object.entries(ev.detections)) lineOf.set(`${s.sheetId}/${det}`, ids);
      }
      let items = buildReviewQueue({ sheets: inputs, lines, roomSettings: settingsMap(projectId), unmatched, lineOf });
      if (filter) items = items.filter((i) => i.kind === filter || i.sheetId === filter);
      return { items, total: items.length };
    },

    async getRoomSettings(projectId: string, sheetId: string, roomId: string): Promise<RoomSettingsResponse> {
      const id = settingsDocId(sheetId, roomId);
      const doc = settings.get(projectId)?.get(id);
      if (doc) return { settings: structuredClone(doc), isDefault: false };
      const row = ready(projectId).find((r) => r.sheet.id === sheetId);
      const room = row ? (await deps.understanding.artifacts(row)).rooms?.rooms.find((r) => r.id === roomId) : undefined;
      if (!room) throw new ApiError(404, "not_found", "Room not found");
      return { settings: { ...defaultSettings(room), id, sheetId, roomId, by: null, at: null }, isDefault: true };
    },
    async putRoomSettings(projectId: string, sheetId: string, roomId: string, req: RoomSettings): Promise<RoomSettingsResponse> {
      if (!(req.claddingHeightM >= 0 && req.claddingHeightM <= 6)) throw new ApiError(400, "validation_failed", "claddingHeightM 0..6");
      if (!(req.wasteFactor >= 0 && req.wasteFactor <= 0.5)) throw new ApiError(400, "validation_failed", "wasteFactor 0..0.5");
      for (const p of req.partialCladding)
        if (!(p.toM > p.fromM && p.fromM >= 0 && p.heightM > 0)) throw new ApiError(400, "validation_failed", "partialCladding");
      const id = settingsDocId(sheetId, roomId);
      const doc: RoomSettingsDoc = { ...structuredClone(req), id, sheetId, roomId, by: "mock-user", at: new Date().toISOString() };
      let m = settings.get(projectId);
      if (!m) settings.set(projectId, (m = new Map()));
      m.set(id, doc);
      await deps.boq().recompute(projectId);
      deps.emit();
      return { settings: structuredClone(doc), isDefault: false };
    },

    /**
     * Mock `symbols.find_similar`: candidates are the REAL detections (overlay artifacts) whose original class matches
     * the exemplar's original class (the same drawn symbol), with a stable jitter on the score; other classes of the
     * same family come in lower, so the slider has something to cut.
     */
    async findSimilar(projectId: string, req: FindSimilarRequest): Promise<SimilarSearch> {
      const id = newId("sim");
      const rows = ready(projectId).filter((r) => req.scope === "project" || r.sheet.id === req.exemplar.sheetId);
      const exRow = ready(projectId).find((r) => r.sheet.id === req.exemplar.sheetId);
      const exRaw = exRow ? ((await deps.understanding.detections(exRow))?.detections ?? []) : [];
      const exDet: Detection | undefined =
        exRaw.find((d) => d.id === req.exemplar.detectionId) ??
        exRaw.find((d) => Math.abs(d.bboxMm.x - req.exemplar.bboxMm.x) < 1 && Math.abs(d.bboxMm.y - req.exemplar.bboxMm.y) < 1);
      const symbol = exDet?.class ?? req.exemplar.class ?? "unknown";
      const candidates: SimilarCandidate[] = [];
      const all = list(projectId);
      for (const row of rows) {
        const raw = (await deps.understanding.detections(row))?.detections ?? [];
        const eff = new Map(applyCorrections(raw, all, row.sheet.id).detections.map((d) => [d.id, d]));
        for (const d of raw) {
          if (d.id === exDet?.id && row.sheet.id === req.exemplar.sheetId) continue;
          const cur = eff.get(d.id);
          if (!cur || cur.rejected) continue;
          const j = hash01(`${row.sheet.id}/${d.id}/${symbol}`);
          let score: number;
          if (d.class === symbol) score = 0.7 + 0.29 * j;
          else if (classFamily(d.class) === classFamily(symbol)) score = 0.42 + 0.3 * j;
          else if (domainOf(d.class) === domainOf(symbol)) score = 0.2 + 0.25 * j;
          else continue;
          candidates.push({
            id: `c_${row.sheet.id.replace(/[^A-Za-z0-9_-]/g, "")}_${d.id}`.slice(0, 66),
            sheetId: row.sheet.id,
            versionId: row.version!.id,
            centerMm: { ...d.centerMm },
            bboxMm: { ...d.bboxMm },
            score: Math.round(score * 1000) / 1000,
            alreadyDetected: d.id,
            currentClass: cur.class,
          });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      const s: SimilarSearch & { readyAt: number; projectId: string } = {
        id,
        status: "running",
        exemplar: req.exemplar,
        candidates: candidates.slice(0, 120),
        thumbs: {},
        error: null,
        readyAt: Date.now() + deps.similarMs,
        projectId,
      };
      searches.set(id, s);
      const { readyAt: _r, projectId: _p, ...pub } = s;
      return { ...pub, status: deps.similarMs > 0 ? "running" : "succeeded", candidates: deps.similarMs > 0 ? [] : pub.candidates };
    },
    async getSimilar(projectId: string, searchId: string): Promise<SimilarSearch> {
      const s = searches.get(searchId);
      if (!s || s.projectId !== projectId) throw new ApiError(404, "not_found", "Search not found");
      const { readyAt, projectId: _p, ...pub } = s;
      return Date.now() >= readyAt ? { ...pub, status: "succeeded" } : { ...pub, status: "running", candidates: [] };
    },
  };
}

export type ReviewMock = ReturnType<typeof createReviewMock>;
