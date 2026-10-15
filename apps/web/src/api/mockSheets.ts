import type { SheetClassification, SheetRegion, SheetRow, SheetSet, TilesMeta } from "./types";

/**
 * Demo sheets of the sample project (sample-noah), as classified by the Sprint 0 spike
 * (docs: SHEET_CLASSIFICATION.md). Tiles for these are rendered locally by
 * `apps/web/scripts/make_dev_tiles.py` into /home/claude/kamutan-data/artifacts and served in
 * `vite dev` at /dev-artifacts/ (never committed, never bundled). In tests the URLs simply 404.
 */
export const DEV_ARTIFACTS_BASE = "/dev-artifacts";

const PROJECT = "p-noah";
const ORG = "org-demo";
const DPI = 300;
const MM = 25.4;

const LANDSCAPE = { widthPx: 4963, heightPx: 3509 };
const PORTRAIT = { widthPx: 3509, heightPx: 4963 };

interface Seed {
  fileId: string;
  file: string;
  title: string;
  discipline: string;
  floors: string[];
  scaleText: string;
  confidence: number;
  level: SheetClassification["level"];
  reasons: string[];
  portrait: boolean;
  /** Seeded regions for two-floor sheets (paper mm). */
  regions?: { floor: string; polygonMm: [number, number][] }[];
  confirmed?: boolean;
}

/** Pick an existing sample to stand in for an uploaded file (mock only). */
export const SAMPLE_FOR_UPLOAD = "eb8be8a3";

const SEEDS: Seed[] = [
  {
    fileId: "eb8be8a3",
    file: "ת.חשמל קומת קרקע.pdf",
    title: "ת. חשמל / קומת קרקע",
    discipline: "electrical",
    floors: ["ground"],
    scaleText: "1:50",
    confidence: 0.94,
    level: "green",
    reasons: ["SCALE_FROM_TITLE", "SCALE_MATCHES_DIMS"],
    portrait: false,
  },
  {
    fileId: "c054fd3a",
    file: "ת.חשמל מרתף+קרקע.pdf",
    title: "ת. חשמל / קומת מרתף+ / קומת קרקע",
    discipline: "electrical",
    floors: ["basement", "ground"],
    scaleText: "1:50",
    confidence: 0.92,
    level: "yellow",
    reasons: ["MULTI_FLOOR", "SCALE_MATCHES_DIMS"],
    portrait: true,
  },
  {
    fileId: "b2046277",
    file: "ת.תאורה קומת קרקע.pdf",
    title: "ת. תאורה / קומת קרקע",
    discipline: "lighting",
    floors: ["ground"],
    scaleText: "1:50",
    confidence: 0.94,
    level: "green",
    reasons: ["SCALE_FROM_TITLE", "SCALE_MATCHES_DIMS"],
    portrait: false,
    confirmed: true,
  },
  {
    fileId: "1bbe4113",
    file: "ת.תאורה מרתף+קרקע.pdf",
    title: "ת.תאורה / קומת מרתף+ / קומת קרקע",
    discipline: "lighting",
    floors: ["basement", "ground"],
    scaleText: "1:50",
    confidence: 0.92,
    level: "yellow",
    reasons: ["MULTI_FLOOR", "SCALE_MATCHES_DIMS"],
    portrait: true,
    regions: [
      { floor: "basement", polygonMm: [[12, 14], [285, 14], [285, 196], [12, 196]] },
      { floor: "first", polygonMm: [[12, 200], [285, 200], [285, 352], [12, 352]] },
    ],
  },
  {
    fileId: "24ab0ea0",
    file: "ת.אינסטלציה קומת מרתף.pdf",
    title: "ת. אינסטלציה / קומת מרתף",
    discipline: "plumbing",
    floors: ["basement"],
    scaleText: "1:50",
    confidence: 0.92,
    level: "yellow",
    reasons: ["SCALE_FROM_TITLE", "NO_DIM_CHECK"],
    portrait: false,
  },
  {
    fileId: "70a5c3e0",
    file: "ת.הריסה קומת קרקע.pdf",
    title: "ת. הריסה / קומת קרקע",
    discipline: "demolition",
    floors: ["ground"],
    scaleText: "1:50",
    confidence: 0.77,
    level: "red",
    reasons: ["LOW_OCR", "NO_DIM_CHECK"],
    portrait: false,
  },
];

export const tilesPrefix = (sheetId: string, versionId: string) =>
  `orgs/${ORG}/projects/${PROJECT}/sheets/${sheetId}/versions/${versionId}/tiles`;

export function sampleTiles(fileId: string, portrait: boolean): TilesMeta {
  const size = portrait ? PORTRAIT : LANDSCAPE;
  return { prefix: tilesPrefix(`noah-${fileId}-p0`, "v1"), format: "webp", tileSize: 256, dpi: DPI, levels: 6, ...size };
}

export const pageOf = (t: Pick<TilesMeta, "widthPx" | "heightPx" | "dpi">, rotation = 0) => ({
  widthMm: Math.round(((t.widthPx / t.dpi) * MM) * 1000) / 1000,
  heightMm: Math.round(((t.heightPx / t.dpi) * MM) * 1000) / 1000,
  rotation,
});

/** Seeded sheet sets + sheets (ready, classified) of the demo project. */
export function seedNoah(createdAt: string): { sets: SheetSet[]; rows: SheetRow[] } {
  const sets: SheetSet[] = [];
  const rows: SheetRow[] = [];
  SEEDS.forEach((s, i) => {
    const setId = `noah-${s.fileId}`;
    const sheetId = `${setId}-p0`;
    sets.push({
      id: setId,
      orgId: ORG,
      projectId: PROJECT,
      fileKind: "pdf",
      sha256: s.fileId.padEnd(64, "0"),
      storagePath: `orgs/${ORG}/projects/${PROJECT}/uploads/${setId}/${s.file}`,
      status: "ready",
      name: s.file,
      uploadedBy: "mock-user",
      createdAt,
    });
    const tiles = sampleTiles(s.fileId, s.portrait);
    rows.push({
      sheet: {
        id: sheetId,
        sheetSetId: setId,
        pageIndex: 0,
        title: s.title,
        discipline: s.discipline,
        floors: [...s.floors],
        scaleDenominator: 50,
        classification: {
          discipline: s.discipline,
          floors: [...s.floors],
          sheetTitle: s.title,
          scaleText: s.scaleText,
          confidence: s.confidence,
          level: s.level,
          reasons: [...s.reasons],
        },
        confirmed: Boolean(s.confirmed),
        ...(s.confirmed ? { confirmedBy: "mock-user", confirmedAt: createdAt } : {}),
        currentVersionId: "v1",
        updatedAt: createdAt,
      },
      version: {
        id: "v1",
        sheetId,
        versionNo: 1,
        status: "ready",
        createdAt,
        progress: { stage: "done", pct: 100 },
        page: pageOf(tiles, s.portrait ? 270 : 0),
        artifacts: {
          tiles,
          thumbnail: tiles.prefix.replace(/\/tiles$/, "/thumbnail.webp"),
          primitives: tiles.prefix.replace(/\/tiles$/, "/primitives.msgpack.gz"),
          text: tiles.prefix.replace(/\/tiles$/, "/text.json.gz"),
        },
        regions: (s.regions ?? []).map((r, j) => ({
          id: `r${j + 1}`,
          floor: r.floor,
          polygonMm: r.polygonMm.map(([x, y]) => ({ x, y })),
          scaleDenominator: 50,
        })),
        stats: { paths: 41000 + i * 1300, segments: 180000 + i * 5100, textLines: 0, glyphs: 2200 + i * 90 },
        workerVersion: "mock",
        updatedAt: createdAt,
      },
    });
  });
  return { sets, rows };
}

/** Very small filename heuristic for simulated uploads (mock only). */
export function guessClassification(filename: string): SheetClassification {
  const n = filename.toLowerCase();
  const discipline = /חשמל|elec/.test(n)
    ? "electrical"
    : /תאורה|light/.test(n)
      ? "lighting"
      : /אינסטל|plumb/.test(n)
        ? "plumbing"
        : /הריסה|demo/.test(n)
          ? "demolition"
          : null;
  const floors = /מרתף|basement/.test(n) ? ["basement"] : /קרקע|ground/.test(n) ? ["ground"] : [];
  const level: SheetClassification["level"] = discipline && floors.length ? "green" : discipline ? "yellow" : "red";
  const reasons = [
    ...(discipline ? [] : ["NO_DISCIPLINE"]),
    ...(floors.length ? [] : ["NO_FLOOR"]),
    "SCALE_FROM_TITLE",
  ];
  return {
    discipline,
    floors,
    sheetTitle: filename.replace(/\.[^.]+$/, ""),
    scaleText: "1:50",
    confidence: level === "green" ? 0.93 : level === "yellow" ? 0.7 : 0.4,
    level,
    reasons,
  };
}

/** One entry of /dev-artifacts/dev-index.json (written by workers/drawing/scripts/ingest_local.py). */
export interface DevIndexEntry {
  sheetId: string;
  versionId: string;
  fileId: string;
  sheetSetId: string;
  page?: { widthMm: number; heightMm: number; rotation: number };
  tiles?: TilesMeta;
  thumbnail?: string;
  primitives?: string;
  text?: string;
  status?: string;
  title?: string;
  discipline?: string | null;
  floors?: string[];
  scaleDenominator?: number | null;
  classification?: SheetClassification;
  regions?: SheetRegion[];
  stats?: Record<string, unknown>;
  /** Sprint 2 (top-level like primitives/text, or under artifacts). */
  legend?: string;
  detections?: string;
  rooms?: string;
  artifacts?: { legend?: string; detections?: string; rooms?: string };
}

/** A ready sheet row (+ its set) built from a dev-index entry (dev mock only). */
export function rowFromDevIndex(e: DevIndexEntry, createdAt: string): { row: SheetRow; set: SheetSet } | null {
  if (!e.tiles) return null;
  const set: SheetSet = {
    id: e.sheetSetId,
    orgId: ORG,
    projectId: PROJECT,
    fileKind: "pdf",
    sha256: e.fileId.padEnd(64, "0"),
    storagePath: `orgs/${ORG}/projects/${PROJECT}/uploads/${e.sheetSetId}/source.pdf`,
    status: "ready",
    name: `${e.title ?? e.fileId}.pdf`,
    uploadedBy: "mock-user",
    createdAt,
  };
  const row: SheetRow = {
    sheet: {
      id: e.sheetId,
      sheetSetId: e.sheetSetId,
      pageIndex: 0,
      title: e.title ?? null,
      discipline: e.discipline ?? null,
      floors: e.floors ?? [],
      scaleDenominator: e.scaleDenominator ?? null,
      ...(e.classification ? { classification: e.classification } : {}),
      confirmed: false,
      currentVersionId: e.versionId,
      updatedAt: createdAt,
    },
    version: {
      id: e.versionId,
      sheetId: e.sheetId,
      versionNo: 1,
      status: "ready",
      createdAt,
      progress: { stage: "done", pct: 100 },
      ...(e.page ? { page: e.page } : {}),
      artifacts: { tiles: e.tiles, ...(e.thumbnail ? { thumbnail: e.thumbnail } : {}) },
      regions: e.regions ?? [],
      workerVersion: "dev-index",
      updatedAt: createdAt,
    },
  };
  return { row, set };
}
