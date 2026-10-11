# Sprint 0 — brief for all agents

Repo: /home/claude/kamutan (pnpm workspaces + turbo for TS; uv for Python). Specs (Hebrew) in docs/spec/:
01_PRD.md, 08_workplan_v2.md (authoritative plan + decisions table §2), 04_architecture.md, 05_ux.md, 06_security.md, 07_test_plan.md, review_consistency.md.
**Where specs conflict, 08_workplan_v2.md §2 decisions win** (e.g. pypdfium2 not PyMuPDF; worker uses a dedicated limited DB role, not service_role; share links via API only; item codes are TEXT like "4.10"; row confidence = min of item levels; coordinates = paper millimetres, y down).

Sample project data (NEVER copy into the repo, never commit PDFs): /home/claude/kamutan-data/sample-noah/ — 15 A3 PDFs (AutoCAD 2017, 1:50, no text layer; Hebrew text is vectorized SHX strokes), matching PNG renders, and boq_sample.xls. Code reads it via env var KAMUTAN_DATA_DIR.

Environment limits:
- No Docker Hub access, no cloud Supabase yet. For Postgres use @electric-sql/pglite (+ @electric-sql/pglite-postgis if needed) in tests. Tesseract 5 with `heb` and `eng` is installed system-wide.
- npm registry and PyPI are reachable. Most other hosts are blocked.
- Shared lockfile: wrap EVERY `pnpm install/add` as `flock /tmp/kamutan-pnpm.lock pnpm ...` and every `uv sync/add` as `flock /tmp/kamutan-uv.lock uv ...`.
- Stay inside YOUR assigned directories. Do not edit root files except as stated. Do NOT run git commit/branch/checkout — the orchestrator commits.
- Languages: code/identifiers English; user-facing UI strings Hebrew.
- Every deliverable needs tests that pass locally; report the exact commands you ran and their results.
- Write a short `NOTES.md` in your directory: what you built, how to run it, known gaps.
