# Sprint 1 — security gate (ingest)

Gate from `docs/spec/06_security.md` ("שערים לפי ספרינט", row 1): *sandbox לפענוח (SEC-17) עובד ונבדק; magic bytes ו-ClamAV;
מגבלות גודל ופיקסלים; fuzzing ראשוני ל-PDF ול-DXF ב-CI; role ייעודי ל-worker* — plus the SEC-13..SEC-24 requirements touched by
ingest. Platform mapping per ADR 0008 (Firebase: Security Rules + IAM instead of RLS / Postgres roles).

Status legend: **done** = implemented and covered by a test that runs in CI; **partial** = implemented but a piece or its test
is missing; **owner action** = needs the human owner in GCP/GitHub (commands are ready); **open** = not started.

Date: 2026-10-12, branch `sprint-1/ingest` (uncommitted). Security/QA agent.

## Gate items

| # | Gate item | Status | Evidence | What is missing |
| --- | --- | --- | --- | --- |
| G1 | Parser sandbox works and is tested (SEC-17) | **done** (locally; production kernel features to verify on first deploy) | `workers/drawing/src/kamutan_drawing/sandbox/`: child `python -I` in a fresh temp dir, own session, env allow-list, `RLIMIT_AS/CPU/FSIZE/NPROC/CORE`, `unshare -n`, **Landlock** (`landlock.py`: read/exec only interpreter/venv/`sys.path`/system dirs, write only the workdir, no TCP, no signals/abstract sockets outside), as root a **per-run uid** from `UID_POOL` (NPROC per sandbox, all its processes killed on teardown), wall timeout + output cap, typed `SandboxError`. `sandbox/tasks.py` registers `probe`/`page` (used by `service/pipeline.py`, which calls parsers only via `run_task`) and `parse_pdf`/`parse_dxf`/`parse_raster`. Escape tests `workers/drawing/tests/test_sandbox.py` (14): TCP connect to a reachable local server and to 1.1.1.1 blocked; writes to a 0777 dir outside, `/tmp`, `/dev/shm`, `$HOME`, `/etc` blocked (workdir allowed); world-readable secret file outside unreadable; signal to an outside process blocked; 100 GB alloc → `parse_memory_limit`; CPU loop → `parse_cpu_limit`; hang → `parse_timeout`; abort → `parse_crashed`; fork bomb → typed error in < 20 s, peak ≤ NPROC (48) processes, none left; thread bomb → `parse_crashed`; `landlock=require` without Landlock fails closed. Fuzz suite now targets the real sandbox (`KAMUTAN_FUZZ_TARGET=sandbox`): `47 passed` (30 s budget, 88 s). Findings F-1 (0-byte DXF) and F-2/F-3 (cyclic / 10^9 fan-out blocks → `too_complex` in < 1 s, static block-graph count in `parse/dxf.py`) fixed; `tests/test_dxf_limits.py`. | CI: set `KAMUTAN_FUZZ_TARGET=sandbox` in the `fuzz` and `fuzz-long` jobs (DevOps; `auto` already resolves to the sandbox). Production image runs as uid 10001 → no per-sandbox uid (NPROC shared by the service uid); Landlock and `unshare -rn` on Cloud Run gen2 unverified — `GET /healthz` reports `sandbox.{landlockAbi, netns, dropRoot}`; set `KAMUTAN_SANDBOX_LANDLOCK=require` once confirmed. F-4 (PDF path extraction speed) open. |
| G2 | Magic bytes (SEC-14) | **done** | API: `apps/api/test/unit/magic-bytes.test.ts`, finalize returns 415 + deletes the upload (`uploads.service.ts`). Worker re-check before any parsing: `service/pipeline.py` (`unsupported_format` / `file_type_mismatch`) and again inside the `parse_*` sandbox tasks; unit test `workers/drawing/tests/test_formats.py` (40 cases: PDF/PNG/JPEG/DWG/ASCII+binary DXF incl. BOM/comments; EXE, ELF, ZIP, OLE2, HTML, SVG, GIF, TIFF, R12 DWG, NUL-prefixed / >1 KiB-offset PDF rejected; declared-vs-detected compatibility) + pipeline tests (`tests/test_pipeline.py`: PNG declared as PDF, renamed EXE). Fuzz corpus `pdf-exe-renamed-pdf` → `file_type_mismatch`. | — |
| G3 | ClamAV (SEC-15) | **open** | — | No scanner in the API or worker image. Decide: ClamAV sidecar in the worker image vs. a separate Cloud Run scanner on `quarantine` objects. |
| G4 | Size and pixel limits (SEC-14/16) | **done** (rules/API/parsers) | Storage rules: create only if `0 < size ≤ 100 MB` — `storage.rules.test.ts` "rejects bad content types, empty and > 100 MB files"; API: size re-check while streaming (413). Parsers: `MAX_PAGES=100`, `MAX_PAGE_MM=5000`, Pillow `MAX_IMAGE_PIXELS=200 MP`. Fuzz corpus: `pdf-pages-101 → too_many_pages`, `pdf-giant-page-max-spec → page_too_large`, `png-huge-dims-2^31 / dims-70000x70000 / decompression-bomb-20k → image_too_large`, `pdf-flate-bomb-512mb`, `png-ztxt-bomb-256mb` end typed within limits. | Per-project 2 GB quota (SEC-14) not enforced anywhere yet (API). |
| G5 | Initial fuzzing of PDF + DXF in CI | **done** | `.github/workflows/ci.yml` job `fuzz` (PR, path-filtered `workers/drawing/**`, 60 s Hypothesis budget + 44-case corpus, ~2 min) and `.github/workflows/nightly.yml` job `fuzz-long` (30 min default, up to 5 h via dispatch; Hypothesis DB cached and uploaded on failure). Local run: `46 passed, 1 xfailed in 121 s` (PDF 98 / DXF 49 / PNG 150 generated cases). | Atheris/coverage-guided fuzzing (06 names Atheris) — Hypothesis structure-aware fuzzing chosen for Sprint 1; revisit if nightly finds nothing new. |
| G6 | Dedicated worker identity (ADR 0008 §authz-3; was "Postgres role") | **owner action** | `infra/IAM.md` §1: `kamutan-worker@` with `roles/storage.objectAdmin` conditioned on `orgs/` **minus** `orgs/*/quarantine/`, `roles/datastore.user`, no Pub/Sub role (push), no secrets; §2 push subscription with OIDC SA (`run.invoker` on the service only), DLQ `ingest-dlq`, `--max-delivery-attempts=5`; §7 verification via Policy Troubleshooter. In code: worker validates `storagePath` prefix = job org/project (`service/contracts.py`). | Owner runs §0–§2. Firestore IAM cannot scope per path — per-org discipline stays in worker code. |

## SEC-13 … SEC-24

| SEC | Requirement (short) | Status | Evidence / note |
| --- | --- | --- | --- |
| 13 | Direct upload to quarantine, fixed path, no user filename, 10 min TTL | **partial** | Client → `orgs/{orgId}/quarantine/{uuid}` via Firebase SDK; rules allow **create only**, editor/admin, lowercase UUID name, never readable/overwritable/deletable (`storage.rules.test.ts` › quarantine: 5 tests; lint "only `create` on the quarantine slot is client-writable"). Signed upload token binds uid+path (`apps/api/test/unit/filename-token.test.ts`). Legacy Sprint-0 slot `orgs/*/uploads/**` closed (test "legacy … is closed"). **Missing:** TTL/expiry of abandoned quarantine objects (see firebase/NOTES.md). |
| 14 | Magic bytes; ≤100 MB, ≤100 sheets, ≤2 GB/project | **partial** | See G2/G4. 2 GB/project open. |
| 15 | ClamAV before leaving quarantine | **open** | See G3. |
| 16 | Decompression bombs, pixel/page/object caps | **done** (parsers) | See G4; DXF block expansion: `MAX_ENTITIES=2M` exists but see finding F-3. |
| 17 | Parser sandbox | **partial** | See G1. Network namespace: `unshare -n` available here; on Cloud Run gen2 `unshare` needs user namespaces — verify on the first deploy (`net="require"` would fail closed). |
| 18 | Pinned parser libs, CVE SLA 7 days | **partial** | `workers/drawing/uv.lock` pins pypdfium2/Pillow/ezdxf; osv-scanner + Dependabot in CI. The 7-day SLA is a process (owner). |
| 19 | All buckets private; org-prefixed access; CI check for public bucket | **partial** | storage.rules: **nothing client-readable** (lint "nothing in the bucket is client-readable"; `storage.rules.test.ts` artifacts block ×4 roles + cross-org + anon). `infra/IAM.md` §0: `--uniform-bucket-level-access --public-access-prevention` (owner action). CI public-bucket check needs GCP read creds in CI — not added. |
| 20 | Short signed URLs, authorization first | **partial** | Decision: artifacts deny + V4 signed URLs from the API (`firebase/NOTES.md` §Sprint 1). API `sheets/url-signer.ts` + tiles-manifest (API agent). IAM: `kamutan-api@` has `serviceAccountTokenCreator` on itself only (`infra/IAM.md` §3). TTL: brief says 15 min, SEC-20 says 5 min — owner to reconcile. |
| 21 | TLS everywhere, HSTS | **done** (platform) | Google front ends; `firebase.json` HSTS preload header. |
| 22 | Encryption at rest | **done** (platform) | Google-managed AES-256 for Firestore/Storage. CMEK not planned. |
| 23 | VLM cache per org | n/a | Sprint 2. |
| 24 | Secrets in a secret store; worker without broad role; jobs carry ids only | **partial** | Worker sandbox child gets an allow-listed env (no `GOOGLE_*`); worker has no secrets (IAM.md §1); API reads only `UPLOAD_TOKEN_SECRET` (§3); jobs = ids + storagePath + sha256 (contracts). gitleaks in CI. **Owner:** delete the service-account key file kept at `kamutan-data/secrets/firebase-sa.json` once WIF/ADC are set (SEC-49). |

## Firestore / Storage rules for Sprint-1 paths

| Path | Test file › tests | Result here |
| --- | --- | --- |
| `sheets/{id}` | `ingest.rules.test.ts` › reads (4 roles get+list), B ×4 roles denied, outsider/anon, collection group denied, two-org user; writes: confirm/edit/set/delete/create ×4 roles, other-org/anon | skipped locally (emulator download blocked) — enforced in CI `db` job |
| `sheets/{id}/versions/{v}` | same file (regions/status/artifacts/delete/create ×4 roles) | idem |
| `jobs/{id}` | same file: orgId-filtered list ok; unfiltered / `in` / projectId-only / other-org denied; job without string orgId unreadable; create/update/delete ×4 roles | idem |
| Storage quarantine / sources / project uploads / artifacts / derived | `storage.rules.test.ts` (quarantine, legacy-closed ×4 roles, artifacts ×4 roles, cross-org, catch-all) | idem |
| Static invariants | `rules.lint.test.ts` (24 tests): single client write surface in storage, nothing client-readable, explicit deny blocks, id patterns = contracts, model paths covered by a match, sheets/versions/jobs never client-writable, no collection-group exposure | **24 passed** locally |

CI `db` job now also parses the vitest JSON report and fails if `firestore.rules.test.ts`, `storage.rules.test.ts` or
`ingest.rules.test.ts` has zero tests or any non-passed test — the suites cannot "pass" by skipping.

## Fuzzing findings (production parsers, reference sandbox)

| ID | Input | Observed | Severity | Owner |
| --- | --- | --- | --- | --- |
| F-1 | 0-byte `.dxf` | `parse.dxf.load_doc` returns an empty document → success | Low (magic bytes reject it first) | worker — corpus case `dxf-empty-file` is a non-strict xfail until fixed |
| F-2 | DXF with a self-referencing / cyclic block | ends via Python `RecursionError` (→ `parse_crashed` in the real child) instead of a cycle check with a clear code | Low | worker: detect cycles / cap depth → `too_complex` |
| F-3 | DXF block fan-out 10^9 (9 levels × 10 INSERTs) | `extract_page` runs until the wall timeout (20 s in fuzz; prod: 120 s CPU per upload) | Medium (cheap CPU DoS: 1 KB file = 2 CPU-min) | worker: count virtual entities during explode with an early cap; consider a per-org ingest rate limit |
| F-4 | PDF with 200k path objects | 15 s in `PdfPageSource.vectors()` (~13k paths/s) | Info | A0 sheets with >1.5 M paths would hit the 120 s CPU cap |

No crash or hang of the parent process in any run.

## Commands run (local, 2026-10-12)

```bash
pnpm --filter @kamutan/firebase-tests test        # 24 passed | 116 skipped (emulator suites skip locally)
pnpm --filter @kamutan/firebase-tests typecheck   # ok
cd workers/drawing && KAMUTAN_FUZZ=1 KAMUTAN_FUZZ_BUDGET_S=60 \
  uv run --frozen --with hypothesis==6.168.5 pytest -m fuzz tests/fuzz -q -s   # 46 passed, 1 xfailed (121 s)
cd workers/drawing && uv run --frozen pytest -q --co                           # fuzz folder ignored without KAMUTAN_FUZZ
cd benchmark && uv run --frozen pytest -q                                      # 82 passed, 15 skipped (golden real-sheet: no ingest output yet)
python3 benchmark/tests/golden/make_noah_expected.py                           # 15 expectations -> kamutan-data/gt/noah/golden (outside git)
uvx --from actionlint-py actionlint -shellcheck <shellcheck> .github/workflows/*.yml   # clean
```

## Owner actions (in order)

1. `infra/IAM.md` §0–§3 (service accounts, bucket hardening, Pub/Sub with DLQ, API SA incl. `serviceAccount:` in `function.ts`), §5 budget alert.
2. `infra/IAM.md` §4 WIF for deploys; set `GCP_WORKLOAD_IDENTITY_PROVIDER` / `GCP_DEPLOY_SERVICE_ACCOUNT` Environment variables.
3. Decide ClamAV placement (G3) and the signed-URL TTL (5 vs 15 min).
4. Delete the local service-account key after 1–2 (SEC-24/49).
5. Optional: `KAMUTAN_DATA_URL`/`KAMUTAN_DATA_KEY` to enable nightly kbench + golden.
