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

---

# Sprint 3 — BOQ (web + viewer)

Shapes: `docs/agents/SPRINT3_BRIEF.md` + contracts `boq.ts`, mirrored by hand in `src/api/types.ts` (`BoqLine` +
`byFloor/evidenceCount/ruleId/sourceVersions/computedAt`, `ProjectBoqState`, `BoqBuild`, `BoqLineEvidence`,
`LinksArtifact/LinkGroup`, `ExportBoqRequest/Response`, `LibraryItem`, `BoqTemplate`, `BoqRule`, `LibraryImport*`).

## API (reconciled with the API agent's contracts `boq.ts` / `library.ts` at the end of the sprint)
`src/api/http.ts` adapts the contract DTOs to the app DTOs in `types.ts`:
| call | route | adaptation |
| --- | --- | --- |
| build | `POST /projects/:p/boq/build` → `{build, deduplicated, jobId}` | → `{buildId, jobId}` |
| build progress | Firestore `boqBuilds/{b}` listener | (no GET route; `getBoqBuild` reads `summary.build`) |
| BOQ state / stale | Firestore project doc `boq` listener | + `summary` of GET …/boq |
| lines | `GET /projects/:p/boq?limit=500[&cursor]` → `{summary, items, nextCursor}` | cursors followed; `summary.blockExportOnRed` → export dialog; missing worker fields defaulted |
| patch line | `PATCH …/boq/lines/:id {status? \| qtyOverride + reason \| qtyOverride: null}` → `{line}` | override reason = `qtyOverrideReason` |
| evidence | `GET …/boq/lines/:id/evidence` | as is |
| export | `POST …/boq/export {templateId?, split, markDraft}` → `{url, fileName, …}`; 409 `export_blocked` | `draftNote` → `markDraft`, `fileName` → `filename` |
| library items | `GET /library/items?orgId=&q&chapter&limit`, `PATCH /library/items/:id?orgId=` (`unit`, `tags`, `active`, `chapterTitle` — code+description are the identity) | |
| import | `POST /library/imports {orgId, filename, sizeBytes}` → `{import, storagePath, contentType}` → Storage upload → `POST …/imports/:id/finalize {orgId}` → poll `GET …/imports/:id?orgId=` | `stats {created, updated, templates}` → summary; `ambiguousCodes` shown only if the API adds it to `stats` |
| templates | `GET /boq-templates?orgId=`, `PATCH /boq-templates/:id?orgId= {default: true}` | columns `{key, title}` rendered by title |
| rules | `GET /boq-rules?orgId=`, `PATCH /boq-rules/:id?orgId= {enabled}` | condition text derived in Hebrew from `match` |
| links | `links: {url}\|null` in `GET …/overlay` (kamutan.links/1 incl. top-level `arcs`, groups `arcIds`) | traced arcs drawn as is (inferred/ambiguous → dotted) |
| marker → line | `GET /projects/:p/boq/evidence?sheetId=&versionId=` → `{detections, linkGroups}` (per sheet, per build) | replaces the per-line fan-out; inverted for the row-hover preview |

Role policy (web): viewers change nothing; editors move draft ↔ נבדק and override quantities; reviewer/admin get all
contract transitions (approve / un-approve). Rules toggle + default template: admin only.

## Screens
- **BOQ panel** (right pane of S10, `features/boq/BoqPanel.tsx`): tabs "כתב כמויות" | "ספירה לפי סוג" (Sprint-2 counts;
  `?panel=counts`). Chapters = one table, sticky column header + sticky chapter header (title from the default template,
  "% מאומת" by lines, ●▲◆ split bar, collapsible numbered notes). Row: level (stripe + shape), code `<bdi dir=ltr>`, description
  + first reason chip "+N", unit, [per-floor columns when "לפי קומה"], qty, status pill (טיוטה/נבדק/אושר; icon-only in
  split mode). **Receipt** on hover/focus of the qty (Radix Tooltip): "16 = 14 שזוהו + 2 ידני", items + sheets, per floor,
  override reason, reasons. Overridden qty shows the computed number struck through + "✎ ידני".
- **Row → drawing**: evidence (`useLineEvidence`) → if none on the current sheet, jump to the sheet holding most of it +
  toast "עברת לגיליון …"; focus (dim others 30% + blue halo) and zoom to their bounds; `[` `]` step through them; sheet
  picker badges "N פריטים של השורה". Hover on a row = preview focus without zoom (from the all-evidence index).
- **Drawing → row**: a marker click selects its line (all-lines evidence index `useAllEvidence`, per-line fan-out, 4
  concurrent; a second click on an item shared by 2 lines cycles), scrolls the row in and flashes it 1.2 s.
- **Link groups**: for the selected line (or the selected item's group) the overlay draws switch→luminaire arcs (dashed,
  2 px, level colour; worker-traced arcs `arcs[].completed` = dotted), an 8% hull and a chip "ק-n" + `4.11` + "· 2 גופים /
  מפסק אחד". Viewer: `PathFeature.dash: "dashed" | "dotted"` (PathStyleExtension) — the only viewer change.
- **Keyboard** (event.code): `A` status one step forward (role-checked, toast "השורה 4.10 סומנה 'נבדק' · who, when"), `E`
  override dialog (number + mandatory reason), `N` next draft non-green line (wraps). Footer buttons mirror them.
- **Build**: empty state + "בנה כתב כמויות", progress (build doc), "בנו מחדש" in the panel header, failure alert, stale
  banner "השרטוטים או המיפויים השתנו — בנו מחדש". Build success refreshes lines, links (overlay) and evidence.
- **Export dialog** (header "ייצוא"): template (default preselected), מסוכם / מפורק לפי קומה, the spec's warning copy with
  live counts + the draft-note checkbox, [חזרה לבדיקה (מומלץ)] primary / [ייצא בכל זאת]; blocked state ("לא ניתן לייצא עדיין…
  נותרו N" + [עבור לפריטים] → ◆ filter + first red line). Real mode downloads the signed URL; mock mode shows a toast.
- **Library** `/library` (top-nav "ספרייה"): items (search, chapter filter, TEXT-sorted codes, edit dialog: description
  required / unit / active), "ייבוא אקסל" (xls/xlsx ≤ 20 MB → upload % → processing % → summary: added / updated / template
  created / ambiguous codes), templates (read-only cards, admin "קבע כברירת מחדל"), rules (Hebrew kind + condition, item, priority,
  admin-only switch; toggling marks BOQs stale).

## Mock mode
- `src/api/mockBoq.ts` + `mockBoqEngine.ts` (stand-in for Worker-BOQ): authority per discipline, one sheet per
  (discipline, floor), socket lines by class, composite lighting lines from the link graph (Worker-A's links when present,
  else a synthetic graph: 2-way pairs ≤ 140 mm same floor, nearest lights ≤ 150 mm, leftovers join a point ≤ 60 mm or
  become a sensor point), 9.01 install count, per-floor, level = min, reasons = union. Overrides / statuses survive rebuilds.
  First build seeds one override on 4.01 so the "+2 ידני" receipt is visible.
- Dev artifacts: the dev index is polled every 15 s (after the understanding artifacts are wired): Worker-BOQ's
  `boqLines` / `boqEvidence` pointers (`kamutan.boq-lines-dev/1` + `kamutan.boq-evidence/1`) replace the engine;
  Worker-A's `links` (top-level or `artifacts.links`) replace the synthetic graph. While Worker-A's links are missing,
  the mock synthesizes links for the sheets Worker-BOQ's composite lines point at and tags that evidence with the group
  ids (**mock-only**, so the arcs can be demoed).
- URL flags (first load): `?mockBoq=built` (build at start), `?mockBoq=engine` (ignore Worker-BOQ lines),
  `?mockBlockExport=1`, `?mockRole=editor|reviewer|viewer`. Import: a file named `*corrupt*` fails in the parser step.

## Tests (Sprint 3 additions; web 169 total, viewer 52)
`features/boq/model.test.ts` (TEXT code order, receipts, chapters + % by lines, role transitions, N, shared filters,
evidence indexes, link-group geometry, mock engine aggregation/authority, Worker-BOQ line normaliser),
`features/boq/boq.test.tsx` (empty → build → chapters/notes/LTR codes/statuses, receipt "+2 ידני", composite line → sheet
jump + focus + arcs + hull chip + footer + picker badge, marker → line, per-floor + filters + status filter, A/E/N, editor
can't approve, stale banner + rebuild keeps override, export warning copy + mock toast + axe, blocked export → ◆ filter,
axe), `features/library/library.test.tsx` (list/search/chapter + axe, edit, import ok/failed + axe, templates default,
rules admin/editor), `api/http.test.ts` + `firebaseBackend.test.ts` (new endpoints / listeners), viewer dash paths.
Sprint-2 review tests now open `?panel=counts` (counts is the secondary tab).

## Known gaps
- Needs the API: optional `stats.ambiguousCodes` / template name on library imports.
- `api/types.ts` is still a hand mirror; switch to `import type` from `@kamutan/contracts` (now has all Sprint-3 shapes).
- Not yet: row expansion "▸ פירוק קבוצות" (floor → room → groups), group editing (`G`), `R` on lines, undo/history,
  "+ סעיף ידני", TanStack Virtual (plain table), room filter on lines (lines carry no room), S12 summary page.
- Arc geometry: without `arcs` in the link group the UI draws a schematic Bézier switch→luminaire, not the traced arc.

### Sprint 3 follow-up
- Composite lines count distinct link groups (qty = groups): receipt "N = N קבוצות מפסק↔גוף" + the "ק-n" groups per sheet
  (fetched when the receipt opens), sheet-switcher badges "N קבוצות של השורה", footer group count. "ק-n" = the group id's number.
- Mock: Worker-A's real `links.json.gz` (dev-index `links`) is re-read every poll and replaces the synthetic graph (lines'
  evidence re-attached); the synthetic fallback only runs for sheets without real links.
- `boq.test.tsx` hardened: lazy route chunks preloaded in `beforeAll`, `userEvent` without delays, waits (not test timeouts)
  raised to 25 s, axe scoped to the panel / dialog. Passes in `pnpm turbo run test --concurrency=2`.

---

# Sprint 4 — Review queue, correction tools, learn from correction, rooms, plumbing + tiling (web + viewer)

Shapes: `docs/agents/SPRINT4_BRIEF.md` + the API agent's `packages/contracts/src/corrections.ts`, mirrored by hand in
`src/api/types.ts` (`Correction`, `CreateCorrectionRequest`, `CorrectionUnit` = `m2|m|unit`, `ReviewQueueItem`,
`RoomSettings` (+ `keepOpenings`, `type`), `RoomSettingsResponse`, `SimilarSearch`/`SimilarCandidate`, `Room` + `type/wet/
walls/openings/externalCorners`, `BoqLine` + `orderQty/wasteFactor/manualCount/breakdown`). Taxonomy + 5 plumbing
fixtures and `ac_unit` (domain `hvac`).

## API (contracts corrections.ts → app DTOs, `src/api/http.ts`)
| call | route | adaptation |
| --- | --- | --- |
| list corrections | `GET /projects/:p/corrections?limit=500[&sheetId][&cursor]` → `{items, nextCursor}` | pages followed |
| create | `POST /projects/:p/corrections` → `{correction, rebuild}` | strict body: client-only `id` / `batchId` stripped |
| batch | `POST /projects/:p/corrections/batch {items, source, similarSearchId}` → `{batch, items, rebuild}` | → `{items, batchId: batch.id}`; source `cluster` / `lasso` / `similar` / `selection` |
| undo | `POST …/corrections/:id/revert`, `POST …/correction-batches/:batchId/revert` | |
| queue | `GET /projects/:p/review-queue?limit=200[&kind][&cursor]` | ≤ 5 pages; `ref.*` → `clusterId/linkGroupId/roomId/correctionId/lineId`, `memberBboxesMm` → `members`, unknown clusters → level `unknown`, `suggestedAction` mapped |
| room settings | `GET|PUT /projects/:p/rooms/:sheetId/:roomId/settings` → `{settings, isDefault, room}` | strict PUT body (`toRoomSettingsBody`) |
| find similar | `POST /projects/:p/similar-searches {exemplar:{sheetId, versionId, bboxMm, class}, scope, correctionId}` → `{search, jobId}`; `GET …/:id` → `{search, thumbUrls}` | polled every 300 ms until done (`useSimilarSearch`) |

Optimistic writes (`features/corrections/queries.ts` `useCorrectionActions`): the correction enters the cache at once
(overlay re-derived synchronously by `applyCorrections`), the call runs in the background, an error rolls back + toast
"לא הצלחנו לשמור את התיקון". The server's ids / batch id replace the provisional ones by position and re-key the undo
step; an undo of a step still in flight waits for its ids. Session history: ≤ 100 steps, a group action = 1 step,
redo re-sends with fresh ids (the reverted originals stay for the audit).

## Model (pure, shared with the mock)
- `features/corrections/model.ts`: `applyCorrections` (accept → green "אושר ידנית", reject/remove → flagged, never
  counted, reclassify (learned → ✦ "תוקן בלמידה"), move, add → `m_<corrId>` ◈; re-match by `detectionId`, else
  `anchorMm` within `radiusMm` + class family; unmatched reported), `applyLinkCorrections` (link / unlink / accept /
  reject a group), `manualItems` (count / measure), history helpers.
- `features/tiling/model.ts`: room type from the worker or the name, wet = bathroom / wc (contracts), defaults by type,
  walls from the polygon (`w_…` ids, collinear merged), openings (door 2.1 m, window 1.2 m over a 1.0 m sill),
  `tilingQuantities` (floor, perimeter × height − openings, partial, corners × height, waterproofing, order m²),
  contributions → 5.01 / 5.02 / 5.03 / 5.05 / 5.06 / 5.07.
- `features/review/queueModel.ts`: ranked queue (risk = impact × (1 − score) × level weight); clusters = ≥ 3 items with
  the same sheet + class + level + first reason; unknown clusters, link groups, rooms (unnamed / not closed / wet or
  courtyard without settings), unmatched corrections, lines without items; time estimate 3 s / item, 5 s / card.

## Screens
- **Review queue** (left pane, `ReviewQueuePanel`): all kinds, risk order, "נותרו N · כ-X דק'" + progress bar. Cluster
  cards: 64 px crops cut from the sheet's own tiles (`TileCrop`, signed tile URLs, cached) — hover flashes the item on
  the drawing, click = "חריג" (red ✕, stays for review), "פתח ופצל" shows up to 60. "מה זה?" cards keep the Sprint-2
  flow. Selecting an item switches sheet (opens at the item via the initial view) / zooms; after A/R/E the next item
  on the SAME sheet loads (no sheet reload between items), then the global next. Entry: the top item of the opened
  sheet is active. Clicking a marker activates its queue card.
- **Tool rail** (viewer, physical keys): V select · L lasso · + add · Del remove · W move · G link · M area · D length ·
  C count · S calibrate; undo/redo buttons; "נדחו" layer (rejected as grey ✕).
- **Lasso** → card "נבחרו 14 פריטים (9 שקע כפול, 5 שקע בודד)" + אשר הכל / דחה הכל / שייך לסוג… / ספור ידנית כאן (one batch).
- **E / add** → ⌘K-style picker (search, recent first, sheet's domain first; "+" again changes the add class).
- **Learn from correction**: after a reclassify / add a banner "רוצה שאחפש סמלים דומים בכל הפרויקט?" (⇧L) → preview
  panel: "נמצאו N דומים ב-M גיליונות", similarity slider updating grid + drawing preview (dashed blue boxes) live,
  counts (above threshold · will change · already that class · excluded), click a crop to exclude, "זכור לארגון",
  "החל על N" → one batch (source `similar`), toast with "בטל".
- **Manual count / area / length** → "לאיזה סעיף לשייך את הכמות?" (library items, same unit first) → `count` /
  `measure` correction; numbered points / labelled polygon on the drawing. Calibration (S): the viewer's 2-click dialog
  → `confirmSheet` with the new 1:n + toast.
- **Room panel** (click a room in select mode, or E on a room item): type (→ defaults), wet (derived), area / perimeter,
  openings (each can be kept), cladding height + the formula "9.64 מ״א × 2.4 מ׳ − 0 מ״ר פתחים = 23.14 מ״ר", floor
  tiling, waterproofing, partial cladding per wall (pick on the drawing — nearest wall within 4 mm, no GPU picking
  needed), waste % → preview by line (5.01/5.02/…; order qty) → PUT settings; room item leaves the queue.
- **BOQ**: chapters 03 / 05 (plumbing / tiling domains in the shared filter), "כמות להזמנה" toggle column, receipts:
  manual part ("4 = 2 שזוהו + 2 ידני", from `manualCount` / manual breakdown rows + overrides), per-room breakdown with
  the formula, "להזמנה (פחת 7%)".

## Keyboard (event.code → works on a Hebrew layout; off in inputs and while a dialog is open)
A accept (lasso > selected BOQ row > active queue item > clicked item) · R reject · E reclassify / room panel / qty
override · N/J next · P/K previous · ⇧N skip · F focus · ⇧L find similar · [ ] step · Z / ⌘Z undo · ⇧Z / ⌘⇧Z redo ·
? shortcut map · Esc tool → select · V L + Del W G M D C S tools.

## Mock mode
`src/api/mockReview.ts` (corrections store, ranked queue, room settings, find-similar) + `mockSprint4Engine.ts`
(stand-in Worker-BOQ): every correction / room setting re-derives the BOQ at once — plumbing / tiling are computed
only when the base lines have no chapter 03 / 05 (Worker-BOQ's real lines in dev already have both: then saved room
settings are layered on as deltas), then corrections (reject −1, add +1 manual, reclassify moves, count / measure).
Find-similar: candidates from the REAL detections artifacts — same original class 0.70–0.99, same family 0.42–0.72,
same domain 0.20–0.45 (stable jitter), done after 600 ms (0 in tests). Rooms are queued only on the authoritative
sheet per floor. Mock validation mirrors the contract's per-kind rules.

## Speed protocol (`scripts/queue-speed.mjs`)
100 keyboard actions (A A N R A P A A R N …) on the real worker data in mock mode, UI latency = keydown → next painted
frame after the commit (`window.__kamutanQueue`, mock/dev builds only):
- production build (`--start --prod`): **median 27.8 ms, p95 57.5 ms, max 95.3 ms** (PASS < 100 ms); 123 → 64 items;
- dev server (React dev build): median 60.3 ms, p95 95.7 ms, max 148.5 ms.
Measured on SwiftShader (software WebGL, shared CPU). Memoised panes (`useLatestFns`, memo'd BOQ panel / drawing /
queue cards) took the dev median from 110 ms to 60 ms.

## Tests (Sprint 4 additions; web 197 total, viewer 59)
`features/corrections/model.test.ts`, `features/tiling/model.test.ts`, `features/review/queueModel.test.ts`,
`api/mockSprint4Engine.test.ts`, `api/http.test.ts` (contract routes / strict bodies / adapters),
`features/review/corrections.test.tsx` (cluster A in one batch with a Hebrew-layout key + undo/redo, N/P, R, E picker →
learn panel → slider → batch, tools add/remove/move/count/area/lasso, link, room panel → PUT + axe, BOQ 05 chapter +
order column + manual receipt, shortcut map + axe), viewer `DrawingViewer.test.tsx` (add snap 8 px, remove, move, link,
count, area snapping + m², length, ⇧= not zoom, background click, point labels). Viewer mocks in tests keep the last
real props (React dev calls components without props to print warning stacks).

## Known gaps
- Real API: the review queue is per build (`stale` / `buildId` not shown yet); room-settings "accept defaults" (A on a
  room) is a PUT, not in the undo history; unmatched corrections: R reverts, A only hides locally (no "redo on the new
  version" action yet).
- Link edits re-derive the composite lighting lines only in the real worker (the mock keeps 4.09–4.16 as built).
- "זכור לארגון" in the learn panel is UI-only (no contract field yet); `similarSearches` crops (`thumbUrls`) are used
  when present, else crops are cut from tiles.
- Move tool keeps the class; no multi-select drag. Lifecycle keys 1/2/3 and "\\" (hide queue) are not wired.
- Speed measured on software GL; a real-GPU run should be faster.

### Sprint 4 follow-up (after the integration round)
- Detection markers stay sized in paper mm, but their screen size is clamped to 12–28 px (`MARKER_MIN_PX` / `MARKER_MAX_PX`, deck.gl `sizeMinPixels` / `sizeMaxPixels`). The selection / focus halo is clamped to 8–18 px so its ring still surrounds a clamped icon. Before this, zooming to 199% blew markers up over the drawing.
- Mock `authoritativeRooms`: the duplicate-room check now only compares rooms across sheets. Two similar rooms on one sheet (first-floor bathrooms r_5 5.04 m² and r_10 4.86 m²) are separate rooms.

---

# Sprint 5: confidence and readiness (web + viewer)

Shapes come from `docs/agents/SPRINT5_BRIEF.md` §1–§5. They were aligned at the end of the sprint with the API agent's contracts (`packages/contracts/src/{share,audit,exports,offboarding,org,sheets}.ts`) and `apps/api/NOTES.md`. They are still mirrored by hand in `src/api/types.ts`. `src/api/http.ts` adapts the contract DTOs to the app DTOs.

## Screens
- **Calibration badge "כיול שמרני"** (`features/calibration/CalibrationBadge.tsx`):
  - Persistent in the review header and in the BOQ panel header.
  - Opens a popover in plain Hebrew: what it means, the "200 items with no error" rule, the ceilings (raster / scale conflict), "what this means for you", the number of capped lines, the org green threshold and the calibration table version.
  - Calibration source: the build summary, falling back to `stats.calibration` on the version. When unknown, it shows conservative (the honest default). Nothing is shown in `full` mode.
  - The worker reason "כיול שמרני: אין מספיק נתוני אמת לסוג זה" renders as the chip "כיול שמרני" (dashed), with the rest of the reason as its hint.
  - Item cards show "ביטחון מכויל 0.83 · לפני כיול 0.91" (`score` / `scoreRaw`).
- **Line history** (`features/history/LineHistoryDialog.tsx`):
  - Opened from the ⟲ icon on a BOQ row (on hover or when selected) or from "היסטוריה" in the footer.
  - Newest first. Each entry shows the Hebrew action label (שינוי סטטוס / שינוי כמות ידני / הערה / חישוב מהשרטוטים / תיקון על השרטוט), before (struck through) → after, who and when, and the reason.
  - When an override reopens an approved line it is noted ("חזרה ל'נבדק'"). This is the Sprint-3 decision; E2E-11's "טיוטה" wording is the QA agent's to fix.
  - Accepts both the contract's primitive before/after values and the mock's objects.
- **Audit log** `/settings/audit` (admin, `features/settings/AuditLogPage.tsx`):
  - Entity and action filters use the API vocabulary (entity + verb, e.g. `shareLinks · view`), with cursor paging ("טען עוד").
  - Chain indicator from `GET …/audit/verify`: OK with a count, or "שבר בשרשרת" with the id. `actorKind = share_link` is shown as "צופה חיצוני".
- **Export dialog** (`features/boq/ExportDialog.tsx`):
  - New format toggle: אקסל | PDF מסומן. The Excel path is unchanged and stays the default.
  - PDF options: one page per floor, hide title block, all sheets or a subset (with a validation message).
  - Flow: `POST …/boq/export/marked-pdf {sheetIds, options}`, then poll `GET …/exports/:id` (`ready` is mapped to `succeeded`), then a "הורד PDF" link (signed URL, `rel=noreferrer`, "בתוקף 15 דקות").
  - Editor and admin only. The org's red-line block applies here too.
- **Share dialog** (`features/share/ShareDialog.tsx`, header "שתף"):
  - Defaults: days 1–90 (default 14, quick buttons 7/14/30/90, expiry date preview), label (required, ≤ 100), optional recipient (used in the watermark), hide title block ON, allow PDF OFF.
  - The created URL is shown once in a read-only LTR field with a copy button and a "זו הפעם היחידה" warning. It is dropped when the dialog closes or on "צור קישור נוסף".
  - List: label, state chip (פעיל / פג תוקף / בוטל), recipient, expiry or revoke date, views and last view.
  - Revoke goes through the spec's AlertDialog copy. Reviewer and viewer roles see the list only.
- **External viewer `/s/:token`** (`features/share/SharedViewerPage.tsx` + `SharedDrawing.tsx`, lazy):
  - Sits outside `AuthProvider`. In real mode it gets `createPublicOnlyBackend()`, which contains only the GET-only public client. Every member API, upload or realtime call throws, and Firebase is never initialised.
  - Header: org · project, label, version date, "בתוקף עד", "לקריאה בלבד", and "הורד PDF מסומן" when the per-link PDF is ready.
  - BOQ table, read-only: chapters, LTR codes, ●▲◆ indicator, no reasons or scores. Selecting a row focuses its evidence and switches to the sheet that holds it ("עברת לגיליון …"). Clicking a marker selects its row.
  - The drawing is select-only: no tool rail and no correction callbacks. It uses API-proxied tiles and has the watermark overlay.
  - `<meta robots noindex,nofollow>` and `<meta referrer no-referrer>`. Requests use `credentials: omit` and `referrerPolicy: no-referrer`.
  - Error screens: 410 with `x-share-state: expired` → "הקישור פג תוקף"; 410 with `x-share-state: revoked` → "הקישור בוטל"; 404 → "הקישור לא נמצא"; 429 → "יותר מדי ניסיונות".
- **Org settings** `/settings` (admin; the "הגדרות" nav link is shown only to admins):
  - Green threshold slider 0.9–0.995.
  - Switches: block export on red, external LLM, training opt-in.
  - Saving sends a PATCH with only the changed fields ("נרשם ביומן"). Reset and an unsaved-changes notice are available.
- **Offboarding** `/settings/offboarding` (admin):
  1. Full ZIP export with progress and a 24 h download link.
  2. Four Hebrew warnings, a "you have not downloaded the export" nudge, the typed confirmation and an "I understand" checkbox.
  - If `auth_time` is older than 10 min (`hasRecentLogin`), or the API answers `recent_auth_required`, the page asks for re-authentication: a Google popup (`reauthenticateWithPopup`), a password (`reauthenticateWithCredential`), or "sign in again" for email-link users. After re-authenticating it retries automatically.
  - `mfa_required` shows a separate explanation.
  - An org in `offboarding` (from `/me`, or any `403 org_offboarding` through the global QueryCache handler) is blocked by `<RequireOrg>`. Only the admin's export page stays reachable.
  - **The confirmation is the org name**, as in contracts `OffboardOrgRequest` and the API NOTES ("`confirm` = org name"). The brief and a coordinator message said "slug"; the shipped API wins.
- **Viewer package:** new `watermark` prop on `DrawingViewer` (exported `Watermark`). It draws diagonal tiled text with a corner chip carrying the text once, pointer-events off, and also renders over the no-WebGL fallback.
- `apps/web/public/.well-known/security.txt` (R-WEB2): RFC 9116, placeholder `Contact`, `Expires` 2027-10-01. **The owner must fill in the Contact line.**

## Mock (`src/api/mockSprint5.ts`, wired in `mock.ts`)
- **Audit:** append-only, hash-chained (FNV stand-in for SHA-256), seeded with 42 events so two pages exist; verify detects tampering (`auditBroken` option). Uses API vocabulary and `actorKind`.
- **Line history:** built from the audit, corrections on the line's evidence, and the `computedAt` rebuild.
- **Marked PDF:** queued → running → succeeded after about 6 ticks; resolves to a real, small, multi-page PDF blob URL.
- **Share links:**
  - 256-bit base64url token, returned only in the create response.
  - Demo links on `p-noah`: `/s/demo-noah` (active, PDF allowed, 3 views), `/s/demo-expired`, `/s/demo-revoked`.
  - The public API returns 404 / 410 with the same message. Each view is counted and audited `shareLinks · view` with an IP prefix. No address and no reasons are exposed.
- **Org settings:** validated, only the 4 fields, each change audited, and fed back into `/me`. `blockExportOnRed` now comes from the settings.
- **Offboarding:** ZIP (empty valid zip blob). Confirming with the org name moves the org to `offboarding` + `deleteAfter` +30 d and revokes all its links; later writes get 403 `org_offboarding`.
- **Calibration:** `calibration: {mode: conservative}` on lines and builds. Yellow lines carry the conservative reason.
- **BOQ override:** an override on an approved line reopens it as `reviewed`.
- **Dev URL flags:** `?mockAuthAge=3600` (session an hour old, to show the re-authentication flow). `/s/…` in mock mode prebuilds the BOQ.

## CSP check (enforced policy in firebase.json, docs/security/csp.md)
- `dist/index.html` has exactly one `<script type="module" src="/assets/…">`: no inline script and no inline style attribute.
- In `dist/assets/*.js` the only `eval(` match is Firebase's internal `.eval()` method (Firestore matcher), not global eval. There is no `new Function` anywhere.
- Styles: Radix injects a `<style>` while a dialog or popover is open. This is covered by `style-src 'unsafe-inline'`. The new Popover uses the same Radix portal.
- The share viewer under the stricter `/s/**` policy (`default-src 'none'`, `connect-src 'self'`, `img-src 'self' data: blob:`):
  - All data and tiles go through same-origin `/api/v1/public/share/…`.
  - The watermark is DOM text, not an image.
  - The PDF link is a top-level navigation (302 → signed URL), which `connect-src` does not govern.
- DevOps' `csp-verify.mjs` reported 0 enforced violations on both builds, including `/s/demo-noah`, the expired link and the unknown token.

## Requests to DevOps
- **`hosting.ignore` contains `"**/.*"`.** This drops `apps/web/dist/.well-known/security.txt` from the deploy. Add `"!.well-known/**"` (or an explicit allow), and check that the SPA rewrite does not shadow it.
- **Hosts the app needs, already in the enforced policy:**
  - `connect-src`: `'self'` (API incl. `/api/v1/public/share/**`), identitytoolkit, securetoken, firestore, firebasestorage and storage.googleapis.com (signed artifact fetches).
  - `img-src`: `'self' data: blob:` plus storage.googleapis.com and firebasestorage.googleapis.com (signed tiles and crops) and `*.googleusercontent.com`.
  - `frame-src`: the auth domain plus accounts.google.com and apis.google.com (popup sign-in and `reauthenticateWithPopup`).
  - `/s/**`: `'self'` only. Nothing new was added.
- Please keep `blob:` in `img-src` / `worker-src`.
- **Download links** of the marked PDF and offboarding ZIP are mock `blob:` URLs. Production uses signed URLs as top-level navigations, so no CSP change is needed.

## Contract / API notes
- `PublicShareMeta.pdf.status` drives the viewer's PDF button: it appears only when `ready`.
- Public rooms come with `bboxMm` only; the viewer draws boxes. A polygon would be nicer and is optional.
- The org slug is not in `MyOrg`. The UI uses `org.name` for the confirmation, per the API.

## Tests (Sprint 5 additions; web 247 total (was 201), viewer 62 (+2 watermark))
- `api/mockSprint5.test.ts` (12): calibration, history/audit/E2E-11, paging/filter/verify/broken chain/roles, marked PDF job + PDF bytes, share create/list/public meta/boq/overlay/404/410, settings, offboarding.
- `api/http.sprint5.test.ts` (10): routes and bodies, the public client (GET only, no Authorization or cookies or referrer, no write methods), 410 state header, contract adapters (meta / overlay / audit / export `ready` / history primitives), and the share-viewer backend refusing every member call.
- `features/share/share.test.tsx` (10): dialog defaults and validation, create → URL once → copy → list → revoke with confirm (then 410), roles, axe. Viewer:
  - no sign-in, and a spy on every member API method shows 0 calls
  - no edit affordances; viewer callbacks undefined
  - watermark; noindex/no-referrer meta
  - row ↔ drawing highlighting
  - expired / revoked / not-found screens + axe
- `features/settings/settings.test.tsx` (8): role gating, settings save diff + audit, audit paging/filters/verify/broken + axe, offboarding happy path, re-authentication (wrong then right password), blocked app for admin and editor.
- `features/history/sprint5-ui.test.tsx` (6): badge + popover + axe + full mode hidden, reason chip / score text, history dialog E2E-11 + axe, `describeChange`, marked-PDF export options → download + axe, validation, roles and org block.
- `authService.firebase.test.ts` (+4): `auth_time`, Google / password re-authentication, email-link users.
- `sheets.test.tsx` was hardened: the lazy viewer chunk is preloaded in `beforeAll` and waits were raised. It was flaky under the bigger parallel run.

Command: `pnpm turbo run lint typecheck test build --filter=@kamutan/web --filter=@kamutan/viewer --concurrency=2`, which is 8/8 green (ran twice with `--force`).

Screenshots (mock dev with the real Noah artifacts, Chromium 1194, 1440×900): `/home/claude/kamutan-data/debug/s5/` 01–16 (badge, history, export options and ready, share dialog / created / revoke, external viewer + line focus, expired / revoked / not found, settings, audit, offboarding, re-authentication).

## Security-gate follow-up (docs/sprints/sprint-5-security-gate.md, F-3 / F-4 / F-7)

**Share dialog (F-3)**
- When "הסתר את טבלת הכותרת" is on, a new opt-in appears: "כלול גם גיליונות שלא זוהתה בהם טבלת כותרת". It is off by default. Its hint spells out the risk: the recipient will see the address, the client name and the office details.
- `includeUnmaskedSheets: true` is sent only when the editor ticks that box.
- After creation the dialog shows:
  - the API's Hebrew `warnings` (`title_block_not_detected` / `…_included`, role=alert), each with its sheet names;
  - a per-sheet list from `link.sheets[]`: טבלת הכותרת מוסתרת / נכלל בלי הסתרה (shown in red) / לא נכלל / נכלל.
  - Sheet names come from the review page.

**External viewer (F-3 / F-4)**
- Renders whatever `meta` returns. With hideTitleBlock that means the link label as the title and "גיליון N" sheet names, so no code in the viewer uses the project name.
- Shows "נכון ל-{snapshotAt}" next to the BOQ.
- `reasons` / `overridden` are no longer read or stripped.
- PDF button: shown only when `pdf.status === ready`. Otherwise a note is shown: the Hebrew message for `errorCode` (e.g. `title_block_not_found`, taken from `EXPORT_ERROR_MESSAGES_HE`), or "בהכנה" / "לא זמין".

**Marked-PDF dialog (F-3)**
- When sheets were left out (`titleBlockBySheet[sid] === false`), a warning lists them by name, using the API `message` or `EXPORT_SHEETS_OMITTED_HE`.
- A failed export shows `message` or the Hebrew text for its error code.

**Offboarding download (F-7)**
- The reauthentication flow now has two purposes: `export` and `offboard`.
- Starting the export first checks `auth_time`.
- A ready export whose GET answers `recent_auth_required` stops polling and shows the box: "גם הורדת הייצוא המלא מחייבת…". After a successful reauth it refetches, and the signed URL appears.
- `mfa_required` shows the MFA message.

**Mock**
- Title-block detection per sheet (`titleBlockDetected` option). By default `noah-c…` and `noah-7…` have no title block.
- Link `sheets[]` plus warnings.
- `meta`: label as the project name, "גיליון N" sheet names, and `pdf` = failed `title_block_not_found` when nothing can be masked.
- Excluded sheets: their overlay answers 404.
- The BOQ snapshot is frozen at creation. Seeded links freeze on their first read, dated at their creation.
- Marked PDF: `titleBlockBySheet`, `titleBlockMasked`, `message`, and a failed state when nothing can be masked.
- Offboarding ZIP URL: signed only with a recent sign-in (`recentAuth` reads the mock session's `auth_time`).

**Tests:** web 256 (+9)
- mock: F-3 exclusion and opt-in, no-mask PDF, F-4 frozen BOQ, omitted / failed marked PDF
- adapters: snapshot, `pdf.errorCode`, export fields
- UI: share opt-in, warnings and per-sheet states; viewer with no PDF; F-7 reauth before the export and on a 403 download; marked-PDF omitted / failed

## Known gaps
- Mock tiles in the viewer are not title-block-masked or watermarked. The server burns both in, and the client overlay watermark is always on.
- The mock does not model MFA: `mfa_required` is only exercised through the HTTP error mapping.
- The share viewer has no floor / room filter or receipt tooltips yet (spec S15 "זמין"). It has row ↔ drawing highlighting and a per-floor breakdown on the selected row.
- The audit "details" column shows raw `after` JSON (admin evidence view). There is no per-action Hebrew rendering yet.
- The real Google re-authentication popup and MFA are not testable in the sandbox. Firebase calls are covered by unit tests with mocks.

# Stage 10 fix round (web + viewer)

Brief: `docs/agents/STAGE10_FIX_BRIEF.md`. Defects: `/home/claude/kamutan-data/acceptance/{ui,live}/defects.md`.
The viewer package (`packages/viewer`) needed no change.

## Defects → fix → test
| defect | fix | test |
| --- | --- | --- |
| A-UI-01 landing x-scroll at 390 | `overflow-x-clip` on the landing root; sample row `min-w-0` | e2e `ia-navigation` "A-UI-01" (was fixme) |
| A-UI-02 app shell x-scroll at 390 | `TopBar`: icon-only logo below `sm`, tighter gaps / nav padding, `whitespace-nowrap` nav | e2e "A-UI-02" (was fixme; also hub + library, user menu fully in view), `stage10` members @mobile |
| A-UI-03 label-content-name-mismatch | every aria-label starts with the visible text: hub thumbnail (`{state} · סנן…`), sheet confirm when confirmed (`אושר · name`), share revoke (`בטל קישור label`), sheet picker (`גיליון: name · בחירת גיליון`); queue card and share-viewer row buttons drop aria-label (visible text + sr-only prefix/suffix) | e2e `a11y-rtl` "A-UI-03 strict" (was fixme; hub, sheets, sheet analysis, share viewer); `KNOWN_A11Y` is now empty, so every axe call in the suite fails on any serious/critical finding |
| A-UI-04 contrast | amber chips use `text-foreground` on the amber tint (hub phase chip, gallery "ממתין לאישור") | e2e "A-UI-04 strict" (was fixme) |
| A-UI-05 no "העלה מחדש" | `ReuploadButton` on a failed job row (`העלה מחדש את <file>`): uploads the picked file with `replacesSheetSetId` = the failed set; the failed set shows "הוחלף בגרסה חדשה", its failed job leaves the list | e2e `upload` "A-UI-05" (was fixme), unit `stage10` |
| A-UI-07 correction → line > 1 s | `bumpLinesOptimistic`: an add / remove on the drawing moves its counted line at once (qty, manual part), rolled back on error, replaced by the server's re-derive / rebuild | e2e `e2e02` "A-UI-07" (was fixme, asserts < 1 s) |
| A-UI-08 (API-owned) | mock side only: the mock line history also joins manual items (`m_<correctionId>` evidence). The real API builder stays with the API agent | e2e `e2e02` "A-UI-08 / A-UI-12" (was fixme; passes on the mock) |
| A-UI-06 (API-owned) | mock side only: history tie-break (override before the status reopen it caused) | e2e11 (existing) |
| A-UI-09 locked queue not filtered | locked sheet: queue keeps items on the sheet + line cards of lines this sheet feeds | e2e `e2e06` "A-UI-09" (was fixme) |
| A-UI-10 share viewer header at 390 | title block takes the first line (`basis-[calc(100%-4rem)]`), h1 wraps below `sm`, chips wrap below | e2e `e2e09` "A-UI-10" (was fixme) |
| A-UI-11 two "% מאומת" | hub header uses the live BOQ lines once built (same as the BOQ card); mock project stats are derived from the lines after a build (card = hub) | e2e `ia-navigation` "A-UI-11" (was fixme) |
| A-UI-12 mock actor always "דנה כהן" | mock audit / history / corrections / approvals use the signed-in user (`actor()`) | e2e `e2e02` "A-UI-08 / A-UI-12", unit `stage10` |
| A-UI-13 (API-owned) | UI renders `AuditEvent.summary` (requested) and, until it ships, a Hebrew line for known shapes (corrections, statuses, quantities, roles, settings, replaced sets); raw before → after as tooltip | unit `stage10` |
| A-UI-14 sheet header vs chips | locked sheet header counts this sheet's items (same unit as the level chips) | e2e `ia-navigation` "A-UI-14 / A-UI-15" |
| A-UI-15 / A-LIVE-04 stale copy | "כתב הכמויות המלא יגיע בהמשך" replaced | same e2e |
| A-UI-16 landmarks / h1 | review workspace: `<main>` + sr-only `<h1>` (+ sr-only `<h2>` per pane, heading order); share viewer: `<main>` | e2e `a11y-rtl` "A-UI-16" ×3 |
| A-UI-17 truncated hub lines | 2-line clamp + `title` | e2e `ia-navigation` "hub BOQ card" |
| A-UI-18 "פרק 03 · פרק 03 – …" | `chapterLabel(code, title)`: no duplicate code, en dash | same e2e + unit |
| A-UI-19 floors vs title (worker flag) | reason `FLOOR_TITLE_MISMATCH` (any `FLOOR_*`) marks floors unsure: ◆ + hint in the hub gallery and the dashed field on the confirm card. **Worker-Accuracy: please emit `FLOOR_TITLE_MISMATCH` in `classification.reasons`** | unit `stage10` |
| A-UI-20 PDF dialog | hide title block defaults ON (like share); unticking "כל הגיליונות" starts an empty subset | e2e `e2e13` (updated), unit `sprint5-ui` |
| A-UI-21 phone row → drawing | stacked layout (< lg): a row tap scrolls the drawing into view; "חזרה לטבלה" scrolls back to the row | e2e `e2e09` "A-UI-21" |
| A-UI-22 landing vs login copy | one sample (i18n `landing.visual.rows`) for both | — (copy) |
| A-UI-23 Esc with a toast | the toast forwards Escape to the top-most open dialog (`forwardEscapeToDialog`, `data-dialog-close`) | e2e `upload` "A-UI-23", unit |

## New flows (shapes mirrored in `src/api/types.ts` + `mock.ts`; see "Contract requests")
- **Library state (A-LIVE-01):** `LibraryNotice` in the hub BOQ card and the BOQ panel: "נבנה מספריית ברירת המחדל" (all items `source: "default"`) or "אין ספריית סעיפים" (empty), with "ייבוא כתב כמויות קודם" → `/library?import=1` (opens the import dialog). Derived from the items' `source` (contracts `ITEM_SOURCES` has `default`), no new endpoint. Mock: `libraryMode` / `?mockLibrary=default|none`. Library table shows "ברירת מחדל" as the source.
- **Revised upload (A-API-05):** the hub upload dialog asks "מה הקבצים האלה?": "סט חדש בפרויקט" (default) or "מחליף את סט X" (ready / failed sets not yet replaced); one file; `finalizeUpload({…, replacesSheetSetId})`. The set list shows "מחליף את X" / "הוחלף בגרסה חדשה". Firestore sheets with `supersededBy` are hidden. Mock: drops the old set's sheets, marks the set `superseded` + `supersededBySetId`, cancels its failed job, audit `sheetSets · supersede`, BOQ stale.
- **Members (A-API-01):** `/settings/members` (tab "חברי צוות"): list (active + pending with expiry), invite by email + role (link shown once, copy; `/invite/:inviteId` accepts when signed in, else explains and sends to sign in), change role (own role locked), remove / revoke invitation behind an AlertDialog. Hebrew errors for `last_admin`, `already_member`, validation.
- **MFA / reauth (A-API-02):** `features/auth/reauth.tsx` — `useReauthGate()` (+ `ReauthBox`, the offboarding box made reusable). Pre-checks `auth_time` and maps `recent_auth_required` / `mfa_required` answers; retries the action after a successful re-authentication. Used by org settings save, template "קבע כברירת מחדל", rule toggles and every member change. Offboarding keeps its own flow (same strings). Mock: those endpoints answer 403 `recent_auth_required` for a sign-in older than 10 min (`?mockAuthAge=3600`).
- **Approval invalidated by a qty change (A-API-06 / A-pipeline-08):** mirrors contracts `QTY_CHANGED_REASON`, `qtyChangedReason`, `needsReapproval`, `approvedQty`. Chip "הכמות השתנתה מאז האישור (X → Y)" (amber, the change is an LTR island), status filter "הכמות השתנתה מאז האישור (n)", export gate counts `needsReapproval` lines like red ones. Mock rebuild implements contracts `applyRebuild` (approved + qty ≠ baseline → `reviewed`, chip, audit `boqLines · approval_invalidated`); approve stamps `approvedQty`.

## Contracts (Stage 10) — aligned with the API agent's published shapes
The API agent published `packages/contracts/src/members.ts`, `uploads.ts` (`replacesSheetSetId`), `sheets.ts`
(`supersededBySetId`, `Sheet.supersededBy`), `boq.ts` (`approvedQty`, `qtyChangedReason`, `needsReapproval`) and
`audit.ts` (`summary`). `src/api/http.ts` adapts them:
- **Members:** `GET /orgs/:o/members {items: MemberView[]}` + `GET /orgs/:o/invites {items: Invite[]}` are merged into
  one `OrgMember[]` (pending invites get the id `inv:<inviteId>`); `POST /orgs/:o/invites → {invite, url}`;
  `PATCH /orgs/:o/members/:uid → {member}`; `DELETE /orgs/:o/members/:uid` or `DELETE /orgs/:o/invites/:id` (by the
  `inv:` prefix); `POST /invites/:id/accept` from `/invite/:inviteId` when signed in. 409 `conflict` "…at least one
  admin" is mapped to `last_admin`.
- **Revised upload:** `finalize {replacesSheetSetId}`; a replaced set is recognised by `supersededBySetId` (or the mock's
  `status: superseded`), `isSupersededSet()`; sheets with `supersededBy` are hidden by the Firestore listener.
- **Audit:** `summary` is shown when present (A-UI-13); new actions `invite`, `update_role`, `remove`, `accept`,
  `supersede`, `approval_invalidated` and entity `invites` have Hebrew labels.
- **Still to confirm with the API:** "העלה מחדש" sends `replacesSheetSetId` = the FAILED set (nothing to match); the API
  must accept it (409 only when already superseded). If it refuses failed sets, `ReuploadButton` should send a plain
  upload. Org settings / templates / rules answer 403 `recent_auth_required` / `mfa_required` like offboarding.

## Known gaps / not fixed
- A-UI-08 / A-UI-06 / A-UI-13 are API-owned: only the mock and the UI side are done here.
- A-UI-19 needs the worker flag; the UI shows any `FLOOR_*` reason.
- A-UI-07 is optimistic for counted lines (one item = ±1). Composite (switch-group) and area / length lines still wait for the server.
- Real MFA / Google reauth popups are not testable here (unit-tested through the mocked Firebase SDK, as before).
- The share viewer on a phone is a scroll-to-drawing, not tabs; good enough for E2E-09, tabs would be nicer.

# Sprint 6 (web + viewer): every BOQ line present, suggested lines + quick actions; owner feedback (bulk approve, toast flood)

Brief: `docs/agents/SPRINT6_BRIEF.md` (row "Web", "Shared interfaces") + the owner's feedback relayed by the coordinator.
`packages/viewer` needed no change (polygon / path features + labels already cover the new evidence kinds).

## Contracts (mirrored in `src/api/types.ts` until the API agent publishes "Sprint 6 published")
- `BoqLine` additive: `origin?: detected|text|geometry|suggested|manual`, `needsInput?: boolean`,
  `quickAction?: {kind: measure_area|measure_length|count|confirm, sheetId|null} | null`. The contract's `qty: null`
  ("להשלמה ידנית") is mapped by `normalizeLineDto` to `qty: 0` + `needsInput: true`. Older lines carry no origin →
  `originOf()` infers it (`r_manual` → manual, room breakdown → geometry, else detected). The suggested line's reason is
  read from `reasons[0]` (assumption: Worker-BOQ writes `suggested_item.reason` there).
- `BoqEvidenceItem` additive: `kind?: detection|room|text|geometry|stair`, `text`, `bboxMm` (text), `geometry`
  `{type: polygon|polyline, mm}`, `treads: PointMm[][]` (stair).
- `POST /projects/:pid/boq/lines/:lineId/quick-measure` `{kind, quantity, unit, sheetId, versionId, geometry, floor}`
  → `{line, correction|null}` (`quickMeasureBoqLine`).
- `POST /projects/:pid/boq/lines/batch-status` `{lineIds, to, includeRed}` → `{updated[], skipped[{lineId, reason}]}`
  (`batchBoqLineStatus`; `updated` may be lines or ids — ids trigger a refetch). **Requested semantics for the API:**
  walk the legal path of `BOQ_LINE_TRANSITIONS` (draft → reviewed → approved, and back for undo), role-check every
  step; skip reasons `red` (forward moves, unless `includeRed`), `already`, `needs_input` (a line still waiting for a
  quantity is never marked), `forbidden`, `not_found`.
- `BoqBuild.stats.coverage?` `{libraryCodes, produced, suggested, missing[]}` is typed; the UI computes the per-chapter
  coverage from the lines themselves (no dependency on the build stats).

## Screens
- **BOQ panel** (`BoqPanel.tsx`, `Sprint6Parts.tsx`, `sprint6.ts`):
  - every row shows an origin badge (icon + word, never colour alone; text always `--foreground`): סמלים / כיתוב / מדידה /
    מוצע / ידני, hover tooltip with the full sentence; the receipt repeats it ("מקור: …") for keyboard users.
  - a line that needs input: "להשלמה ידנית" chip (hand icon, dashed), the reason (wrapping), the unit, "—" + "חסרה כמות"
    in the qty cell (the estimate when there is one) and the quick-action button: מדידת שטח / מדידת אורך / ספירה / אישור
    כמות (name = visible text + "לסעיף X").
  - chapter header: "x מתוך y סעיפים חושבו מהשרטוט · z להשלמה" (origins detected / text / geometry, not waiting).
  - filter: chip "להשלמה ידנית (n)" in the toolbar + the same option in the status select (`StatusFilter` `needsInput`).
- **Quick action** (`ReviewPage`): measure / count → selects the line, switches to its sheet (`quickAction.sheetId`, else
  the current / first ready sheet), arms the area / length / count tool and shows a banner "מדידת שטח לסעיף 7.01 · ביטול
  המדידה" (Esc or switching tool cancels). The tool's result goes straight to `quick-measure` (no item picker); the line
  updates optimistically (`applyQuickMeasure`: waiting line takes the measure, `needsInput: false`, origin manual) and is
  replaced by the server's line; one toast "נשמרה כמות X לסעיף Y." with undo (reverts the stored correction). `confirm`
  opens `QuickConfirmDialog` (estimate or 1 prefilled). Hub deep link: `/review?line=<id>&quick=1`.
- **Evidence on the drawing**: `evidenceShapeFeatures` — `text` → the bbox outlined + soft fill + the matched text as a
  chip; `geometry` → the polygon (with code + qty chip) or a 4 px polyline; `stair` → each tread outlined, alternating
  fill, numbered when zoomed in. All passive (markers stay clickable). Row → drawing zooms to them (`shapeBoxesOn`), the
  sheet switch counts them, the footer's "N על הגיליון הזה" includes them.
- **Hub card** (`ProjectBoqSummary.tsx`): coverage line per chapter, the "להשלמה ידנית" chip + reason + quick-action link
  per waiting line, "—" quantity, and a "להשלמה ידנית (n)" filter toggle. The table got an explicit `<colgroup>`
  (table-fixed took widths from the sr-only header row → equal columns, the description squeezed on a phone).

## Owner feedback (high priority)
- **Bulk approve:** checkbox per row (editors / reviewers / admins; none for viewers), shift-click range
  (`rangeIds`), "בחר הכל" (= the lines in the current filter) and a tri-state chapter checkbox. `BulkBar`: "N שורות
  נבחרו · סמן כנבדק (n) · אשר (n) · כולל N שורות אדומות · נקה בחירה"; buttons are role-aware (`roleCanReach`: editors
  never see "אשר"), counts from `bulkPlan` (red out unless opted in, waiting lines never, state machine walked per role).
  The red opt-in shows a warning; `BulkConfirmDialog` states the count, what is left out, and the red lines included
  (Enter confirms). One request, optimistic; ONE summary toast "אושרו 23 שורות · 4 דולגו (2 אדומות, 2 כבר אושרו)" with
  "בטל" → the same endpoint per previous status (`undoGroups`), then "השינוי בוטל (n שורות)". **Shift+A** approves the
  selection (also with focus on a checkbox: checkboxes no longer swallow the shortcuts).
- **Toast flood:** `A` / "סמן כ…" no longer toast on success: the status pill re-mounts with a pop-in and the polite live
  region (`data-testid=live-msg`) announces "השורה 4.01 סומנה 'אושר'.". Toaster: at most 3 visible, newest on top, older
  ones collapse into "+N הודעות" (expand / "הסתר הודעות קודמות"), identical messages merge ("×2"), errors 5 s, summaries
  with undo 8 s, the rest 6 s; collapsed toasts expire without being mounted; the store keeps ≤ 20.
- **Wrong message:** `forwardOrReason()` — approved → "השורה X כבר מאושרת." (neutral), waiting line → "קודם צריך להשלים
  את הכמות של X.", no role yet (org loading) → "טוען את ההרשאות שלך…", only a real role limit → "אין לך הרשאה…". Admin
  role logic checked: admins get every transition; the message the owner saw was the approved-line case.
  **Open:** the API lets `editor` change status (contracts: "status (reviewer+)" by `ROLE_RANK`, editor 30 > reviewer
  20); the web keeps editors to draft ↔ reviewed (Sprint-3 policy). One of the two should change — decision for the
  owner / API agent.

## Mock (`src/api/mockSprint6.ts`, wired in `mockBoq.derive` + `mock.ts`)
- Stand-in for Worker-Text / Worker-Geometry / Worker-BOQ, both data modes: for catalogued codes the base lacks, adds text
  lines (4.17, 4.18, 4.23, 4.24, 9.03: text bboxes anchored next to the electrical sheet's own detections), geometry lines
  (5.04 stair: 11 treads in the stairs room / smallest room; 7.05 valance m'; 7.06 partition m²: a wall-run polyline) and
  suggested lines (2.01–2.03, 5.06–5.08, 7.01–7.04, 7.07, 8.01–8.04) with reason + quick action (red without an estimate,
  yellow קומפלט estimate 1). Codes the Worker-BOQ lines already carry are never touched (Noah: 4.17–4.24, 5.04, 5.06,
  5.07 stay theirs). `finalizeSprint6`: a measured / confirmed waiting line → manual, yellow, "הושלם ידנית".
- `quickMeasureBoqLine`: measure / count → a `measure` / `count` correction with the line's item code (re-derived,
  undo = revert), confirm → `confirmLine`; audit via `recordLinePatch`. `batchBoqLineStatus`: `boq.batchStatus` as above.
- Library fixture: generic default items for 2.xx, 5.04, 5.08, 7.01–7.07, 8.01–8.04, 9.03 (4.25 left out: the import demo
  adds it).

## Tests
- Unit (web 311, was 284; viewer 62 unchanged): `features/boq/sprint6.test.ts` (origin / needs input / quick action /
  coverage / filter / adapter null qty / optimistic measure / evidence features + zoom boxes / `forwardOrReason` /
  `bulkPlan` / range / undo groups / mock layer + finalize), `features/boq/sprint6.ui.test.tsx` (suggested row + axe,
  filter, measure via the bound area tool, confirm dialog, text + stair highlight, A inline + "כבר מאושרת" merged toast,
  bulk range → dialog → one summary → undo, red opt-in + Shift+A, editor / viewer gating, Toaster cap / collapse / merge
  / durations), `api/http.test.ts` (+1: both routes, null qty, ids in `updated`). Updated: `boq.test.tsx` (status change
  announced instead of toasted), `library.test.tsx` (chapter 08 has 9.03), `hub.test.tsx` (preloads the lazy chunks).
- Playwright `e2e/sprint6.e2e.ts` (both modes, no `needsNoah`): suggested lines / badges / tooltip / coverage / filter +
  axe; measure quick action on the canvas (polygon + Enter → line completes); confirm dialog + axe; text / stair /
  geometry highlight (screenshots); hub card + filter + axe + deep link into the bound tool; hub on a phone (390) with no
  horizontal scroll; A over lines (no per-line toast, ≤ 3 toasts, "כבר מאושרת"); bulk range + Shift+A → confirm + axe →
  one summary → undo; red opt-in warning + dialog count.
- Screenshots (checked by hand): `/home/claude/kamutan-data/acceptance/ui/screens/{desktop,mobile}/s6-*.png`.

## Known gaps
- Quick measure on a line with a server `quickAction.sheetId` the user has not got ready falls back to the current sheet.
- Only the selected line's shape evidence is drawn (hovering a row previews markers only, as before).
- The hub card shows no origin badges (kept compact: only the "להשלמה ידנית" state and its action).

# Sprint 7 (web + viewer): BOQ preview, rename a line, storage quota, `file_infected`

Brief: `docs/agents/SPRINT7_BRIEF.md` (owner requests 1–2, row "Web", "Shared interfaces"). `packages/viewer` needed no
change. Reconciled with the API agent's "Sprint 7 published" (`packages/contracts/NOTES.md`, `boq-document.ts`) at the
end of the sprint; app DTOs stay hand-kept in `src/api/types.ts`.

## Contracts (aligned with "Sprint 7 published")
- `BoqLine` additive: `descriptionOverride`, `descriptionOverrideBy`, `descriptionOverrideAt`, `descriptionOverrideReason`.
  `description` stays the original; display = `lineDescription(l)` (override ?? original, `features/boq/sprint7.ts`).
- `PATCH /projects/:pid/boq/lines/:id` `{description: string|null, reason?, alsoUpdateLibrary?: boolean}` (null = restore).
- `GET /projects/:pid/boq/document?split=floor|none&confidence=1|0&chapters=04,05` → `BoqDocumentModel`
  (`kamutan.boq-document/1`; `getBoqDocument`; `confidence` always sent, the API defaults it to 1). `normalizeDocument`
  only adapts shapes: title rows `{kind: warning|title|draft, text}` (plain strings tolerated), columns `{key,title}`,
  `code`/`unit` null → "", `cellNote`, `totals.vatRate` → `vatRate`, `exportBlocked` → `blocked`. Row order is the API's:
  `note` rows ("הערות:" + notes) → `line` rows → one `subtotal` row; `chapter.notes` is only rendered when a chapter has
  no note rows. Warning kinds `red | reapproval | unapproved | needsInput`.
- `POST …/boq/export` now also takes `includeConfidence` + `chapters`: the preview's "ייצוא לאקסל" sends them
  (`ExportDialog previewOptions`).
- `PublicBoqLine.descriptionManual?: boolean` — **web request, not in the contract**: the public DTO deliberately carries
  no override marker (Sprint 5 security gate), so the API's share snapshot shows the renamed wording WITHOUT "✎ ידני";
  the viewer shows the marker when the field arrives (the mock sends it). Decision for the owner / API agent.
- `Project.storageBytes` + `storageQuotaBytes` (read-only), `OrgSettings.projectQuotaBytes` (default 2 GB,
  `DEFAULT_PROJECT_QUOTA_BYTES`). Errors `quota_exceeded` (413) and `file_infected` mapped in the upload store.
- History action `description` (before → after: strings, or `{description, override, library?}` objects — both read).

## Screens
- **BOQ preview** `/projects/:id/boq/preview` (`features/boq/BoqPreviewPage.tsx`, lazy route inside AppShell). Linked
  from the hub BOQ card ("תצוגה מקדימה"), the BOQ panel toolbar and the Excel export dialog (keeps the split). Renders
  ONLY the API's model: warning banner (red / not approved / needs input, as the export gate), title rows, the column
  set (+ "רמת ביטחון"/"סטטוס"), chapter header + "הערות:" numbered notes, line rows, "סה"כ" per chapter, totals before
  VAT / VAT / after VAT, "הופק … · N שורות". The xlsx warning title row is rendered (and printed) in the document; the
  gate banner above it is screen-only. Lines waiting for input: empty qty + "להשלמה ידנית". Renamed lines: "✎ ידני"
  (screen only, tooltip = original wording). Options in the URL (`split`, `confidence`, `chapters`); row / description
  link → `/review?line=<id>`. "ייצוא לאקסל" opens `ExportDialog` (`initialSplit`, no preview link); "הדפסה" =
  `window.print()`. **Print CSS** (`styles/index.css`, `tokens.css`): `@page A4 portrait`, light palette whatever the
  theme, thead = table-header-group (repeats; verified in Chromium's PDF), rows never split, app header / toolbar /
  toasts / phone list `print:hidden`, compact print column widths. **Phones** (< md): stacked list per chapter (cards:
  code + description, qty + unit, total, confidence, status), totals at the end.
- **Rename a line** (`features/boq/LineDescription.tsx`, used by the BOQ panel and the hub card; editor+ only =
  `canRenameLine`): double-click the text, Enter on the panel's text button, or the ✎ button (hover / focus; always on
  touch). The editor is one card (over the row on md+, in the flow on phones): textarea (≤ 500, counter, Enter saves,
  Shift+Enter newline is collapsed, Esc cancels), optional reason, "עדכן גם בספריית הסעיפים" (+ hint), "שחזר לנוסח המקורי"
  when renamed (+ the original wording). `useRenameLine`: optimistic, refetches the document + history (+ library). One
  toast with "בטל". `recent_auth_required` / `mfa_required` (library option) → the shared `useReauthGate` box inside the
  editor, then the same PATCH is retried. Typing the original wording back = restore. Workspace shortcuts are off inside
  the editor (`[data-rename-editor]`). Marker "✎ ידני" (`ManualNameMarker`) in the panel, hub, preview and share viewer;
  history entry "שינוי שם השורה" before → after (+ reason, "עודכן גם בספריית הסעיפים", "חזרה לנוסח המקורי").
- **Storage quota**: hub header "אחסון: x מתוך y" + meter (amber "כמעט מלא" ≥ 80%, red "המכסה מלאה"); upload row on 413
  `quota_exceeded`: the API's Hebrew message, else ours with the numbers.
- **`file_infected`** (owner shelved the virus scan: error mapping ONLY, no other UI / copy): the upload row of that file
  shows "הקובץ נחסם: זוהה תוכן זדוני" (sync API error or the ingest job's `error.code`), and the processing panel maps
  `project.errors.file_infected` to the same sentence. Nothing advertises scanning.

## Mock (`src/api/mockSprint7.ts`, wired in `mockBoq.ts` / `mock.ts` / `mockSprint5.ts`)
- `buildBoqDocument` follows the API's `excel.ts` rules (template title rows + address + date, columns, chapters in
  template order, by-floor rows "<desc> – <floor>", overridden qty one row, empty prices → totals 0, VAT from org
  settings, warnings, `blocked`). Rename: validation (≤ 500 after whitespace clean-up), editor+, kept across rebuilds
  (`installDerived`), audit/history, share snapshot, library upsert (`source` → manual); the library option needs a
  recent sign-in (`?mockAuthAge=3600` to see the box). Quota: p-noah stores 48.6 MB; `?mockQuotaMb=50` shrinks the
  quota; finalize adds the size. A file named `eicar…`/`…infected…` fails its job with `file_infected`.

## Open contract points
- Share snapshot marker (`descriptionManual`), see above.
- `PatchBoqLineResponse.library` (item id / created) is not shown; the toast says "גם בספריית הסעיפים" on success.

## Tests
- Unit: web 344 (was 311): `features/boq/sprint7.test.ts` (wording / validation / optimistic / URL ↔ query / columns /
  normalisation / money / mock document incl. split + prices + warnings / library upsert / storage / error mapping /
  history), `features/boq/sprint7.ui.test.tsx` (preview + axe, options in URL, row → review, export split, links from
  hub / panel / dialog, rename Esc / Enter / counter / reason / marker / toast / history + axe, restore + undo, survives a
  rebuild, library + re-auth, hub pencil + storage, reviewer has no pencil, preview + share snapshot marker, 413, file
  infected + axe), `api/http.test.ts` (+1 routes / bodies). Viewer 62 unchanged.
- Playwright `e2e/sprint7.e2e.ts` (both modes): preview from the hub + axe + options; print media (chrome hidden,
  table-header-group, white page) + screenshot + axe + Chromium PDF (> 1 page, header row on every page via pdftotext
  when installed); row → review + export keeps split; links from panel / dialog; iPad grid; phone list; rename flow +
  history + preview marker + restore; library + re-auth; hub rename + reviewer; quota + `file_infected` in the dialog.
- Screenshots (checked by hand): `/home/claude/kamutan-data/acceptance/ui/screens/{desktop,ipad,mobile}/s7-*.png`
  (+ `s7-03-print.pdf`).

## Known gaps
- Prices do not exist yet: unit price is empty and totals are ₪ 0 (exactly as the Excel's formulas show it).
- The "✎ ידני" marker is hidden in print (client-facing paper); say if the owner wants it printed.
- The hub card's header wraps to two rows on narrow desktop columns (preview + review buttons).
