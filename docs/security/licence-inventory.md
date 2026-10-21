# Licence inventory — shipped runtime components

Scope: what is **deployed** (Cloud Functions `api`/`apiJobs`/`reprocessDependents`, Cloud Run `kamutan-worker`, Cloud
Run job `kamutan-offboard-purge`, the web bundle). Dev/test tooling is not listed. Policy (ADR 0002, workplan v2 §2):
no AGPL; GPL only as a separate, unlinked CLI process (LibreDWG, not shipped yet); LGPL only dynamically linked and
unmodified; every new runtime dependency is reviewed in its PR (SEC-44, CODEOWNERS). Versions = lockfiles on
2026-10-21 (`pnpm-lock.yaml`, `workers/drawing/uv.lock`). Status: **ok** = permissive, nothing to do;
**ok (obligations)** = allowed, with the listed obligations; **legal review** = owner/counsel to confirm.

## Added in Sprint 5

| Component | Version | Used by | Licence | Status / obligations |
| --- | --- | --- | --- | --- |
| `sharp` | 0.34.5 | API (share tiles: watermark + title-block mask) | Apache-2.0 | ok (obligations): keep its NOTICE/licence in the deployed `node_modules` (default). |
| libvips (prebuilt `@img/sharp-libvips-linux-x64`) | 1.2.4 | API, via sharp | **LGPL-3.0-or-later** (bundles further libraries under permissive licences, see the package's `THIRD-PARTY-NOTICES`) | ok (obligations) / **legal review**: dynamically linked, unmodified, server-side only (not distributed to customers) — LGPL obligations triggered only on distribution; if images or functions are ever handed to a customer, ship the LGPL text + a way to relink. Recorded per apps/api/NOTES.md. |
| `fflate` | 0.8.3 | API (`apiJobs`: offboarding ZIP, streaming) | MIT | ok. (`fflate@0.7.5` also present transitively — MIT.) |
| `pypdf` | 6.20.1 | worker (marked PDF: page import/merge) | BSD-3-Clause | ok. |
| `reportlab` (open-source toolkit) | 5.0.1 | worker (marked PDF: overlay, legend) | BSD-3-Clause ("ReportLab Open Source License") | ok. Do not add the commercial ReportLab PLUS / rlextra packages. |
| DejaVu Sans (Hebrew subset `DejaVuSans-heb.ttf`, `DejaVuSans-Bold-heb.ttf`) | 2.37 | worker (marked PDF text) — `workers/drawing/src/kamutan_drawing/export/fonts/` | Bitstream Vera Fonts licence (+ DejaVu changes public domain, Arev glyphs © Tavmjung Bah, same terms) | ok (obligations): the licence file `LICENSE-DejaVu.txt` ships next to the fonts; a **modified** (subset) font must not be called "Bitstream"/"Vera" — DejaVu naming is fine; embedding in generated PDFs is permitted. |
| DejaVu Sans (full `DejaVuSans.ttf`) | 2.37 | API (watermark text via Pango) — `apps/api/assets/fonts/` | Bitstream Vera Fonts licence | ok (obligations): `LICENSE-DejaVuSans.txt` ships with it (not excluded by `firebase.json` functions `ignore`). Fonts are never downloaded at runtime. |

## Earlier sprints (for completeness)

| Component | Used by | Licence | Status |
| --- | --- | --- | --- |
| `pypdfium2` 5.14.0 + PDFium binary | worker (render, vector paths) | Apache-2.0 / BSD-3-Clause; PDFium BSD-3 (+ bundled third-party notices) | ok — chosen instead of PyMuPDF (AGPL), ADR 0002 |
| Pillow 12.3.0 | worker | MIT-CMU (HPND) | ok |
| ezdxf 1.4.4 | worker | MIT | ok |
| numpy 2.5.4, scipy 1.18.1, shapely 2.2.0 (GEOS LGPL-2.1, dynamically linked) | worker | BSD-3 / BSD-3 / BSD-3 (GEOS LGPL-2.1) | ok (obligations): GEOS as for libvips |
| fastapi 0.143.0, uvicorn 0.54.0, httpx 0.28.1, jsonschema 4.26.0, pydantic, msgpack, openpyxl, xlrd | worker | MIT / BSD-3 / BSD-3 / MIT / MIT / Apache-2.0 / MIT / BSD-3 | ok |
| google-cloud-firestore 2.34.1, google-cloud-storage 3.17.0 | worker | Apache-2.0 | ok |
| Tesseract OCR + `heb`/`eng` traineddata (Debian packages) | worker image | Apache-2.0 | ok |
| tini, util-linux (Debian) | worker image | MIT / GPL-2.0 (separate executables, not linked) | ok |
| NestJS 11, express 5, helmet 8.3.0, pino, zod, rxjs, reflect-metadata | API | MIT / MIT / MIT / MIT / MIT / Apache-2.0 / Apache-2.0 | ok |
| firebase-admin 13.10.0, firebase-functions, @google-cloud/pubsub | API | Apache-2.0 | ok |
| exceljs 4.4.0 | API (xlsx export, offboarding ZIP) | MIT | ok |
| React 18, react-router, Radix UI, TanStack Query, zustand, i18next, lucide-react, tailwind-merge, clsx | web | MIT (lucide: ISC) | ok |
| firebase (web SDK) 12 | web | Apache-2.0 | ok |
| Heebo, JetBrains Mono (`@fontsource`) | web | OFL-1.1 | ok (obligations): OFL text ships in the package; fonts are not sold separately |
| Base images `python:3.12-slim`, `node:22-slim` | images | Debian packages (mixed, mostly GPL/LGPL/MIT system tools, not linked into our code) | ok |

## Open / to decide

- LibreDWG (GPL-3.0) / ODA File Converter (proprietary) for DWG — not shipped; ADR 0002 decision pending legal review.
- No automated licence check in CI yet. Candidate: `pnpm licenses list --prod --json` + `uv pip licenses` (or
  `pip-licenses`) diffed against an allowlist in CI — DevOps follow-up.
- Before distributing anything to customers (on-prem, exported containers), produce a NOTICE bundle (LGPL texts for
  libvips/GEOS, Apache NOTICE files, font licences).
