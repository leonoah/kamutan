# Sprint 1 — Ingest & viewer: brief for all agents

Read first: AGENTS.md, docs/agents/SPRINT0_BRIEF.md (rules still apply: own dirs only, flock for installs, no git commits, NOTES.md, tests must pass), docs/adr/0008-firebase-platform.md (platform = Firebase; Supabase is gone), docs/sprints/sprint-0-report.md, workers/drawing/spikes/SHX_SPIKE_REPORT.md and SHEET_CLASSIFICATION.md.
Sprint 1 goal (docs/spec/08_workplan_v2.md §4): "upload a set → split into sheets → classify discipline/floor → scale → tiled viewer".
Security gate for this sprint: parser sandbox (SEC-17), magic bytes, size/pixel limits, initial fuzzing of PDF and DXF parsers in CI, worker identity scoped to its org path.

## Shared interfaces (all agents must follow exactly)

Pub/Sub topic `ingest`, message data = JSON of `IngestSheetVersionJob` (packages/contracts/src/jobs.ts, json-schema/IngestSheetVersionJob.json).
One uploaded file = one sheetSet. The worker splits pages: page i → sheet doc `sheets/{sheetId}` (sheetId = `${sheetSetId}-p${i}`) with a version doc.

Firestore (under orgs/{orgId}/projects/{projectId}):
- `sheets/{sheetId}`: { sheetSetId, pageIndex, title, discipline, floors: string[], scaleDenominator, classification: {discipline, floors, sheetTitle, scaleText, confidence (0..1), level: 'green'|'yellow'|'red', reasons: string[]}, confirmed: boolean, confirmedBy?, confirmedAt?, currentVersionId, updatedAt }
- `sheets/{sheetId}/versions/{versionId}`: { status: 'queued'|'processing'|'ready'|'failed', progress: {stage: 'ingest'|'render'|'ocr'|'classify'|'scale'|'done', pct: 0..100}, error?: {code, message}, page: {widthMm, heightMm, rotation}, artifacts: { tiles: {prefix, format:'webp', tileSize:256, dpi, levels, widthPx, heightPx}, primitives: path, text: path, thumbnail: path }, regions: [{id, floor, polygonMm: [[x,y],...], scaleDenominator}], stats: {paths, segments, textLines, glyphs}, workerVersion, updatedAt }
- `jobs/{jobId}` (top level): { orgId, projectId, sheetSetId, type:'ingest.sheet_version', status: 'queued'|'running'|'succeeded'|'failed', progress, attempts, error?, updatedAt }
Coordinates: paper millimetres, origin top-left, y down. Item codes are TEXT.

Storage (bucket kamutan-fba67.firebasestorage.app):
- uploads: `orgs/{orgId}/projects/{projectId}/uploads/{sheetSetId}/{filename}` (already produced by the API)
- artifacts: `orgs/{orgId}/projects/{projectId}/sheets/{sheetId}/versions/{versionId}/`
  - `tiles/{z}/{x}_{y}.webp` (z = 0 is the most zoomed-out level that fits in one 256 tile; max level renders at `dpi`, default 300; A0 must be tiled, never one full image)
  - `thumbnail.webp` (max 512px), `primitives.msgpack.gz`, `text.json.gz` (OCR lines: {text, bboxMm, angle, confidence})
Tile URLs to the browser: short signed URLs (15 min) issued by the API endpoint `GET /v1/projects/:pid/sheets/:sid/versions/:vid/tiles-manifest` returning {tiles meta, urlTemplate or batched signed URLs}. In local/mock mode the web uses static files.

Local sample data: /home/claude/kamutan-data/sample-noah/ (never commit). A local artifacts output dir for dev: /home/claude/kamutan-data/artifacts/ (never commit).
