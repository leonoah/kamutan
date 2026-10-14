import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  defaultRoomSettings,
  DocIdSchema,
  RoomIdSchema,
  RoomTypeSchema,
  type PutRoomSettingsRequest,
  type RoomSettings,
  type RoomSettingsResponse,
} from '@kamutan/contracts';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../auth/auth-context';
import { ApiException, notFound, type ApiIssue } from '../common/api-exception';
import { REPOSITORY, type Repository } from '../db/repository';
import { REVIEW_REPOSITORY, type ReviewRepository } from '../db/review-repository';
import { ReviewArtifacts, type RoomView } from './artifact-views';
import { RebuildService } from './rebuild.service';

const WET_FIXTURES = new Set(['fixture_shower', 'fixture_bath']);
/** Tolerance when comparing partial-cladding spans with the wall length (drawing rounding). */
const WALL_LENGTH_TOLERANCE_M = 0.05;

/**
 * Sprint 4: tiling inputs per room (`roomSettings/{sheetId}__{roomId}`). GET = stored settings or the room-type
 * defaults (`isDefault: true`) + the room facts of the sheet's CURRENT version; PUT (editor+) validates against those
 * facts (wall ids / lengths, opening ids), audits, marks the BOQ stale (`room`) and schedules a debounced rebuild.
 */
@Injectable()
export class RoomSettingsService {
  constructor(
    private readonly access: AccessService,
    @Inject(REPOSITORY) private readonly repo: Repository,
    @Inject(REVIEW_REPOSITORY) private readonly review: ReviewRepository,
    private readonly artifacts: ReviewArtifacts,
    private readonly rebuild: RebuildService,
  ) {}

  private async roomOf(orgId: string, projectId: string, sheetId: string, roomId: string): Promise<{ versionId: string; room: RoomView | null; hasShowerOrBath: boolean | null }> {
    if (!DocIdSchema.safeParse(sheetId).success || !RoomIdSchema.safeParse(roomId).success) throw notFound('room');
    const sheet = await this.repo.getSheet(orgId, projectId, sheetId);
    if (!sheet || !sheet.currentVersionId) throw notFound('sheet');
    const a = await this.artifacts.of(orgId, projectId, sheetId, sheet.currentVersionId);
    // Shower / bath inside the room (rules v4: waterproofing defaults only for those rooms); unknown without detections.
    const hasShowerOrBath = a.detections.length ? a.detections.some((d) => d.roomId === roomId && WET_FIXTURES.has(d.class)) : null;
    return { versionId: sheet.currentVersionId, room: a.rooms.find((r) => r.id === roomId) ?? null, hasShowerOrBath };
  }

  private roomFacts(versionId: string, r: RoomView | null, hasShowerOrBath: boolean | null): RoomSettingsResponse['room'] {
    if (!r) return null;
    const type = RoomTypeSchema.safeParse(r.type);
    return {
      versionId,
      name: r.name,
      type: type.success ? type.data : null,
      wet: r.wet,
      areaM2: r.areaM2,
      perimeterM: r.perimeterM,
      walls: r.walls,
      openings: r.openings,
      externalCorners: r.externalCorners,
      ceilingHeightM: r.ceilingHeightM,
      niche: r.niche,
      hasShowerOrBath,
    };
  }

  async get(user: AuthContext, projectId: string, sheetId: string, roomId: string): Promise<RoomSettingsResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'viewer');
    const { versionId, room, hasShowerOrBath } = await this.roomOf(orgId, projectId, sheetId, roomId);
    const stored = await this.review.getRoomSettings(orgId, projectId, sheetId, roomId);
    if (!stored && !room) throw notFound('room');
    const settings: RoomSettings = stored ?? {
      ...defaultRoomSettings(room?.type, room?.wet, { ceilingHeightM: room?.ceilingHeightM ?? null, niche: room?.niche ?? false, hasShowerOrBath }),
      sheetId,
      roomId,
      by: null,
      at: null,
    };
    return { settings, isDefault: !stored, room: this.roomFacts(versionId, room, hasShowerOrBath) };
  }

  async put(user: AuthContext, projectId: string, sheetId: string, roomId: string, req: PutRoomSettingsRequest, traceparent: string): Promise<RoomSettingsResponse> {
    const { orgId } = await this.access.requireProjectRole(user, projectId, 'editor');
    const { versionId, room, hasShowerOrBath } = await this.roomOf(orgId, projectId, sheetId, roomId);
    if (!room) throw notFound('room');
    const issues = validateAgainstRoom(req, room);
    if (issues.length) throw new ApiException(HttpStatus.BAD_REQUEST, 'bad_request', 'room settings do not match the room', issues.slice(0, 20));
    const settings = await this.review.putRoomSettings(orgId, projectId, { ...req, sheetId, roomId }, user.uid);
    const rebuild = await this.rebuild.afterChange(orgId, projectId, 'room', user.uid, traceparent);
    return { settings, isDefault: false, room: this.roomFacts(versionId, room, hasShowerOrBath), rebuild };
  }
}

/** Wall ids must belong to the room, spans must fit the wall, kept openings must exist, no overlapping spans per wall. */
export function validateAgainstRoom(req: PutRoomSettingsRequest, room: RoomView): ApiIssue[] {
  const issues: ApiIssue[] = [];
  const ceiling = req.ceilingHeightM ?? room.ceilingHeightM;
  if (ceiling && req.claddingHeightM > ceiling + 0.01) issues.push({ path: 'claddingHeightM', message: `above the ceiling height (${ceiling.toFixed(2)} m)` });
  const walls = new Map(room.walls.map((w) => [w.id, w]));
  const spans = new Map<string, Array<[number, number]>>();
  req.partialCladding.forEach((p, i) => {
    const w = walls.get(p.wallId);
    if (!w) {
      issues.push({ path: `partialCladding.${i}.wallId`, message: 'not a wall of this room' });
      return;
    }
    if (p.toM > w.lengthM + WALL_LENGTH_TOLERANCE_M) issues.push({ path: `partialCladding.${i}.toM`, message: `beyond the wall length (${w.lengthM.toFixed(2)} m)` });
    if ((p.bottomM ?? 0) + p.heightM > 6) issues.push({ path: `partialCladding.${i}.heightM`, message: 'cladding above 6 m' });
    const list = spans.get(p.wallId) ?? [];
    if (list.some(([a, b]) => p.fromM < b && a < p.toM)) issues.push({ path: `partialCladding.${i}`, message: 'overlaps another span on the same wall' });
    list.push([p.fromM, p.toM]);
    spans.set(p.wallId, list);
  });
  const openings = new Set(room.openings.map((o) => o.id));
  (req.keepOpenings ?? []).forEach((id, i) => {
    if (!openings.has(id)) issues.push({ path: `keepOpenings.${i}`, message: 'not an opening of this room' });
  });
  if (new Set(req.keepOpenings ?? []).size !== (req.keepOpenings ?? []).length) issues.push({ path: 'keepOpenings', message: 'duplicate opening id' });
  return issues;
}
