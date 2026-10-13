# @kamutan/web — Sprint 0 notes (Firebase edition, ADR 0008)

This is the React app shell for Kamutan. It is right-to-left first and in Hebrew by default. It runs against one of two backends:
- **Real:** Firebase (Auth, Firestore listeners, Cloud Storage) plus the NestJS API, called same-origin at `/api/v1`.
- **Mock:** a fully in-memory backend, used with `VITE_USE_MOCKS=true` and in all tests.

## Stack
- Vite 5, React 18, TypeScript (strict, `noUncheckedIndexedAccess`).
- Tailwind 3, logical utilities only.
- Local shadcn-style components on Radix.
- React Router 6 (v7 future flags on), TanStack Query 5, Zustand 5.
- i18next: `he` is the default, `en` is a scaffold.
- **Firebase JS SDK 12** (modular).
- Self-hosted fonts via **@fontsource/heebo** and **@fontsource/jetbrains-mono** (Hebrew and Latin subsets). Google Fonts is no longer used.

## Run
```bash
pnpm --filter @kamutan/web dev          # mock mode if .env.local has VITE_USE_MOCKS=true
pnpm --filter @kamutan/web test         # vitest + testing-library + vitest-axe (Firebase SDK mocked)
pnpm --filter @kamutan/web typecheck
pnpm --filter @kamutan/web build        # → apps/web/dist (Firebase Hosting public dir, see HOSTING.md)
```
- **Env:** `vite.config.ts` loads `apps/web/.env.firebase` automatically through `loadEnv('firebase')` + `define`, so you don't need to copy it. Precedence is: real environment variables, then `.env.local` / `.env.[mode]`, then `.env.firebase`. See `.env.example`.
- **Mock mode:** `VITE_USE_MOCKS=true` in `.env.local` (copy it from `.env.example`). Firebase is never initialized.
  - Password login: any valid email with a password of at least 10 characters.
  - "כניסה עם Google" signs in as a demo user.
  - Magic link: after you send it, the confirmation shows an in-app link to `/auth/complete`.
  - Uploads: a file whose name contains `fail` simulates a network error halfway through.
  - Finalizing an upload starts a simulated ingest job. You can watch it progress live, the same way it would through Firestore.
- **Dev against the real API:** set `VITE_API_URL` (for example the Functions emulator `http://127.0.0.1:5001/kamutan-fba67/europe-west1`, or a local Nest instance). Vite proxies `/api` to it. In production, Firebase Hosting rewrites `/api/**` to the `api` function.

## Architecture
```
src/lib/firebase.ts          lazy initializeApp from VITE_FIREBASE_*; auth.languageCode="he";
                             Analytics only if VITE_ANALYTICS_CONSENT=true (default OFF), lazy-imported
src/features/auth/authService.ts
                             AuthService interface + Firebase impl + mock:
                             email+password, email-link (sendSignInLinkToEmail → /auth/complete,
                             email kept in localStorage for same-device completion), Google (signInWithPopup),
                             onChange = onAuthStateChanged, getIdToken() for Bearer
src/features/auth/AuthProvider.tsx   auth store driven by onChange; clears query cache + uploads when the user changes
src/features/auth/CompleteEmailLinkPage.tsx   /auth/complete (same device: auto; other device: asks email; bad link: error)
src/features/org/            GET /api/v1/me → orgs; current org persisted (localStorage) with fallback to first;
                             <RequireOrg> shows "עוד לא שויכת לארגון" for users with no membership
src/api/types.ts             DTOs mirroring @kamutan/contracts field-for-field (Project, CreateUpload*, FinalizeUpload*,
                             SheetSet/Sheet/SheetVersion, Job, MeResponse, ApiError body) + Backend interfaces:
                             ApiClient / UploadTransport / RealtimeSource
src/api/http.ts              fetch → /api/v1/... with Authorization: Bearer <Firebase ID token>; maps {error:{code,…}}
src/api/firebaseBackend.ts   Storage: uploadBytesResumable(ref(storagePath), file, {contentType}) → progress,
                             pause/resume/cancel; Firestore: onSnapshot on
                               jobs where orgId==X [and projectId==Y] orderBy createdAt desc limit 50
                               orgs/{o}/projects/{p}/sheetSets orderBy createdAt desc
                               orgs/{o}/projects/{p}/sheets + per-sheet listener on versions/{currentVersionId}
src/api/mock.ts              in-memory Backend (API + Storage + listeners), simulated ingest jobs
src/lib/useSubscription.ts   push source → TanStack Query cache (setQueryData) helper
src/features/realtime/hooks.ts   useLiveJobs / useLiveSheetSets / useLiveSheets
src/features/upload/         validation (client hints; server re-checks magic bytes), uploadStore, Dropzone
```

### Upload flow (closes the "no resumable upload" gap)
For each file, up to 3 at a time:
1. Client checks: extension, size up to 100MB, magic bytes, duplicate.
2. `POST /api/v1/projects/:id/uploads` returns `{storagePath: orgs/{orgId}/uploads/{uid}/{fileId}, uploadToken, contentType}`.
3. `uploadBytesResumable` sends the file to that path with that `contentType`, as `storage.rules` require. Progress is real, and each file can be paused, resumed or cancelled.
4. `POST /api/v1/projects/:id/sheet-sets {uploadToken, name}` finalizes the upload. The response carries `jobId` and `deduplicated`.
5. A toast confirms. The `ProcessingPanel` then shows the job stage and % live, plus the sheet-set status, from the Firestore listeners.

The upload store is global (Zustand), so uploads keep going if you navigate away. Retry gets a fresh upload slot and token.

### Projects
- The list comes from `GET /api/v1/projects?orgId=` (first page, limit 100).
- The API has no workflow status, so `projectPhase()` derives the phase shown in the list from `stats` plus the live org jobs:
  - draft
  - processing (shows a live %)
  - review
  - ready
  - archived
- % verified = green / (green + yellow + red) BOQ rows.

## Design decisions (unchanged from v1)
- **Tokens and confidence badges:**
  - Spec tokens are CSS variables, light and dark.
  - Confidence is always shown as colour + SVG shape + word: ● ▲ ◆ ◇ ✎.
  - `--conf-mid` is only 4.2:1 on white, so the badge text uses `--foreground` and the level colour stays on the shape. This is enforced by `tokens.test.ts`.
- **RTL:** codes and units go in `<bdi dir="ltr">`. Item codes are text. The drawing subtree is the only LTR area, enforced by `logical-props.test.ts`.
- **tailwind-merge** is extended with the custom font-size scale.

## Screens
- **Login (`/login`):**
  - Password / email-link segmented control, then an "או" divider, then the **"כניסה עם Google"** button.
  - Firebase errors are mapped to Hebrew: wrong credentials (without revealing whether the account exists), too many attempts, disabled account, popup closed.
- **Email-link completion (`/auth/complete`):** a spinner while signing in. If the link was opened on another device, it asks for the email again (Firebase requirement). An invalid or expired link shows a message and a link back to login.
- **No organisation:** a calm empty state asking the user to get an invitation, plus a logout button.
- **Projects (`/projects`):** the table from v1. The status column is now live ("בעיבוד · 42%"). The user menu shows the display name, email and org, and an org switcher when the user belongs to more than one org.
- **Project (`/projects/:id`):**
  - The dropzone now has per-file pause ⏸ / resume ▶ / cancel ⦸ / retry ↻ / remove ✕ buttons.
  - Each row shows status: מתכונן → מעלה n% / מושהה → מאמת את הקובץ → הועלה. A file that already exists in the project is noted as such.
  - The live "סטים שהועלו" card shows:
    - running jobs, with the file name, the spec micro-copy for the current stage ("קורא טבלאות כותרת וקנה מידה…") and a progress bar
    - failed jobs
    - each sheet set with its status and date
    - a ready-sheets counter
- **Review workspace (`/projects/:id/review`):** the static 3-pane skeleton from v1, unchanged.

## Tests (89, 13 files): the Firebase SDK is mocked with `vi.mock`
- **`authService.firebase.test.ts`:**
  - password sign-in
  - error-code mapping
  - `sendSignInLinkToEmail` called with url `/auth/complete` and `handleCodeInApp`; the email is stored
  - `signInWithEmailLink` with the stored email, then the email is cleared
  - refusal without an email or with a non-link URL
  - Google popup with `select_account`
  - `onAuthStateChanged` feeding the session
  - ID token
- **`firebaseBackend.test.ts`:**
  - `uploadBytesResumable` path and contentType; progress and paused states; pause/resume
  - cancel maps to `UploadCanceledError`; other errors pass through
  - jobs query shape (`orgId ==`, `projectId ==`, orderBy) with Timestamp → ISO conversion
  - sheetSets path; sheets joined with current-version listeners, and cleanup
- **`http.test.ts`:** same-origin `/api/v1`, Bearer header, contract endpoints, error-body mapping.
- **`firebase.test.ts`:** analytics stays off without consent; init refuses when unconfigured.
- **UI (mock backend):**
  - login: password, Google, email link (same device, other device, invalid), the in-app mock link, no-org screen, logout
  - projects: list, empty state, create dialog, live processing status
  - uploads: multi-file → finalize → live sets reach "מוכן"; pause/resume/cancel; rejections with no API calls; raster flag and duplicates; retry; drag highlight
  - review skeleton
- **axe** on the login, projects, empty state, dialog, project + processing, and review screens.
- **RTL / tokens / logical-props guards.** The RTL test now also asserts that there are no Google Fonts and that fonts are self-hosted.

## Known gaps / next
- **Contracts:** the DTOs in `api/types.ts` are a hand-kept mirror of `@kamutan/contracts`. We should switch to `import type` from the package once turbo builds contracts before web typecheck.
- **Email-link sign-in:** this must be enabled in the Firebase Console, and the hosting and preview domains added to Authorized domains (see HOSTING.md).
- **Firebase chunk:** it is about 716 kB (177 kB gzip) and is loaded even in mock mode. Next step is to dynamic-import the Firebase backend when `VITE_USE_MOCKS` is false, and lazy-load Firestore after first paint.
- **Not yet:** org creation/onboarding UI, resuming an upload across a page reload (the SDK's resumable session lives in memory), a full S09 processing screen, and auto-advance to S07.
- **Not runnable here:** emulator-based end-to-end tests (Auth/Firestore/Storage emulators) and Playwright, because the sandbox blocks the downloads. They belong in GitHub Actions.
- **Review workspace:** still static (no deck.gl, no keyboard shortcuts). Its tool labels and the decorative login sample are not in i18n yet.

---

# Sprint 2 — Understanding (web + viewer)

Shapes: `docs/agents/SPRINT2_BRIEF.md` + `packages/contracts/src/understanding.ts`, mirrored by hand in `src/api/types.ts`
(`LegendArtifact`, `DetectionsArtifact`, `RoomsArtifact`, `OverlayManifest`, `LegendEntry(+thumbUrl)`,
`PatchLegendEntryRequest`, `ResolveUnknownClusterRequest/Response`). Endpoints in `src/api/http.ts`:
`GET /projects/:p/sheets/:s/versions/:v/overlay`, `GET|PATCH /projects/:p/legend-entries[/:id]`,
`POST /projects/:p/unknown-clusters/:id/resolve`.

## Viewer (`packages/viewer`)
- New feature kind `marker` (`MarkerFeature`): GPU `IconLayer` with a canvas-drawn MASK atlas (`src/markers.ts`, 16 icons:
  ● circle / ▲ triangle / ◆ diamond / ◇ hollow diamond × dashed × strike). Tinted by the level colour, sized in paper mm
  (`sizeUnits: "common"`, scales with zoom) with a 13 px minimum. Frame + faint tint (symbol stays readable) + solid corner badge.
- `focusIds` dims every other marker to 30% and draws a blue halo (ScatterplotLayer) — row → drawing highlight.
  `dimmed` (lifecycle layer off) → 35%. Selection/focus only re-run `getColor` via `updateTriggers`; geometry never rebuilds.
- Polygons: `dashed` via `@deck.gl/extensions` PathStyleExtension (added dep, 9.3.11), `dimmed`, label = RTL chip with
  `labelLtr` in `<bdi dir="ltr">` + `labelSuffix` ("26.0" + " מ״ר"), `labelMinPx` hides labels of tiny rooms.
- `popover` (RTL card anchored to a paper-mm point, follows pan/zoom) and `renderTooltip(id)` (hover card).
- Picking is switched off while panning/zooming (`onInteractionStateChange`) — avoids a synchronous GPU readback per frame.
- Minimap dots memoised (no per-frame re-diff); lasso picks markers.

## Mock mode with real data
- `build/devArtifacts.ts` serves `*.json.gz` as `application/json` + `Content-Encoding: gzip` (browser inflates). The
  client (`features/understanding/artifacts.ts`) also gunzips raw bodies (magic `1f 8b`, `DecompressionStream`), so signed
  GCS URLs work with or without contentEncoding metadata.
- `src/api/mockUnderstanding.ts`: in `vite dev` the mock reads `/dev-artifacts/dev-index.json`; entries with
  `legend|detections|rooms` (top-level or under `artifacts`) switch the mock to the worker's REAL artifacts (and add missing
  sheets). Otherwise (and always in tests) a deterministic synthetic fixture (`src/test/fixtures/understanding.ts`) is attached
  to `noah-eb8be8a3-p0` (electrical, 150 detections, 2 unknown clusters, 9 rooms, legend 8 rows) and `noah-b2046277-p0`.
  The mock keeps the user's answers (legend class, "מה זה?") and serves the patched docs as `data:` URLs.
- `?mockDetections=2000` on the first page load: fixture with N detections (performance demo; ignores real artifacts).

## Screens
- **Legend confirmation** `/projects/:projectId/legend` (`features/legend/LegendPage.tsx`): a section per sheet; rows = crop,
  editable OCR label (dashed border when OCR < 0.85), Hebrew class `<select>` grouped by domain (`ClassSelect`), confidence badge
  (thresholds 0.85 / 0.5; no suggestion → ◆), אשר / התעלם; decided rows show status + ערוך. "אשר את כל הירוקים", progress
  "X מתוך Y אושרו". Optimistic PATCH with rollback + toast. Linked from the sheets page, the processing panel (CTA when a
  version has a legend) and the review header.
- **Review workspace** (`features/review/*`): overlay of the selected sheet (ready sheets with detections first).
  - Right: "ספירה לפי סוג" (`CountsPanel`) — class (Hebrew) + legend label/crop, counts ● ▲ ◆ ◇, total; a row toggles focus
    (zoom to the class bounds, others dimmed); clicking a marker selects its row (bidirectional) and opens the details popover.
  - Filters (`FilterBar`): תחום / קומה / חדר / ביטחון chips with counts, state in the URL (`dom`, `floor`, `room`, `lvl`);
    applied to counts, overlay and queue. Room filter dims the other rooms.
  - Center: layer toggles (סמלים / חדרים / מקרא), קיים / חדש / להריסה wired (off = dimmed 35%; existing = dashed grey,
    demolish = dashed red + strike). Popover: class, legend row + crop, ●▲◆ + word + "ביטחון 0.83", reason chips, room,
    floor, lifecycle, annotations (`<bdi>`). `[` / `]` step through the selected class, Esc closes.
  - Left: "מה זה?" cluster cards (crop, count, locations → jump + select), class picker or "לא רלוונטי", "זכור לפרויקטים
    הבאים", "החל על N מופעים" → optimistic overlay update (`applyClusterResolution`), toast, rollback on error. Then the
    non-green items, lowest score first.
  - Header: real "% מאומת" + "N לבדיקה" (click → filters red/unknown).

## Tests (Sprint 2 additions)
`features/understanding/model.test.ts` (markers, lifecycle styles, rooms/legend features, filters + URL, counts, cluster
resolution, taxonomy, gzip artifact loading), `features/legend/legend.test.tsx` (rows, confirm, reassign + label, ignore,
confirm greens, rollback, links, empty state, axe), `features/review/review.test.tsx` (overlay shapes/colours, lifecycle
toggles, counts ↔ drawing, popover, filters + URL, room filter, "מה זה?" resolve + ignore + rollback, queue, axe),
`api/http.test.ts` (new endpoints), viewer `DrawingViewer.test.tsx` (marker layer, 2,000 markers geometry reuse, focus/dim,
room labels + bdi, dashed, tooltip/popover, lasso on markers, picking off during interaction).

## Known gaps
- API contract asks (sent to the orchestrator): `ignore: true` on unknown-cluster resolve ("לא רלוונטי") and `label` on
  PATCH confirm/reassign. Web already sends both; the current strict schemas would 400 them.
- `LegendEntry.classConfidence` is not in the Firestore DTO; the UI falls back to `labelConfidence`.
- No un-confirm action in the API: "ערוך" on a decided row re-opens it locally and re-sends confirm/reassign.
- Keyboard navigation between markers inside the canvas (spec a11y #3) is not done; the counts table + queue are the
  accessible alternative. Marker clustering at < 25% zoom is not done (markers keep a 13 px minimum instead).
- Performance: measured only on SwiftShader (software GL, 2 shared cores): 2,000 markers 10–20 fps vs 30 fps without
  markers; the profile is dominated by `readPixels` (hover picking), JS per frame is negligible. Needs a real-GPU check.
- The A/R/E bar and the BOQ table are still placeholders (Sprint 3).
