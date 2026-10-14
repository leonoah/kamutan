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
