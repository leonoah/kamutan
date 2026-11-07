import { FILE_INFECTED_ERROR, SHEET_LIMIT_ERROR } from '@kamutan/contracts';
import type { Doc } from './mappers';

/**
 * Sprint 7 (per-project storage quota): which sheet-set docs count toward `project.storageBytes`. Every set holds one
 * stored source file of `sizeBytes` until it is released (`storageReleasedAt`: the file is gone — today only an
 * infected upload the worker quarantined; a future delete uses the same stamp). Superseded sets keep their file and
 * stay counted. Shared by the Firestore and in-memory repositories (and the legacy recount).
 */
export const releasableBytes = (d: Doc): number => (typeof d.sizeBytes === 'number' && Number.isFinite(d.sizeBytes) && d.sizeBytes > 0 ? Math.round(d.sizeBytes) : 0);
export const countedBytes = (d: Doc): number => (d.storageReleasedAt ? 0 : releasableBytes(d));
/**
 * Sets whose bytes are released without a delete: infected uploads (Sprint 7) and Sprint 8 sets the worker refused
 * because the split would exceed 100 sheets per project (`sheet_limit`: never processed, nothing to keep).
 */
export const RELEASED_ERROR_CODES: readonly string[] = [FILE_INFECTED_ERROR, SHEET_LIMIT_ERROR];
export const isInfected = (d: Doc): boolean => !!d.error && typeof d.error === 'object' && RELEASED_ERROR_CODES.includes(String((d.error as Doc).code));
