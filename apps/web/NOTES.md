# @kamutan/web — Sprint 0 notes

The React app shell for Kamutan, built RTL-first (Hebrew by default). It runs on its own against an in-memory mock API (`VITE_USE_MOCKS=true`), so it doesn't need apps/api or Supabase to be up.

## Stack
Vite 5, React 18, TypeScript (strict, `noUncheckedIndexedAccess`), Tailwind 3 (logical utilities only), local shadcn-style components on Radix, React Router 6 (v7 future flags on), TanStack Query 5, Zustand 5, i18next (`he` default, `en` scaffold), and @supabase/supabase-js 2.

## Run
```bash
cp apps/web/.env.example apps/web/.env.local      # VITE_USE_MOCKS=true by default
pnpm --filter @kamutan/web dev                    # http://localhost:5173
pnpm --filter @kamutan/web test                   # vitest + testing-library + vitest-axe
pnpm --filter @kamutan/web typecheck
pnpm --filter @kamutan/web build
```
- **Mock login:** any valid email plus a password of at least 10 characters (this mirrors SEC-01). Shorter passwords show the "wrong credentials" error.
- **Mock upload:** a file whose name contains `fail` simulates a network error halfway through, so the retry path can be exercised.

## Layout
```
src/
  api/          types.ts (DTOs mirroring planned packages/contracts), http.ts (REST /v1 + XHR upload), mock.ts, client.ts (adapter pick + ApiContext)
  components/   ui/ (button, input, label/Field, card, dialog, dropdown-menu, toast, badge, table, progress)
                ConfidenceBadge, SectionProgress, ReasonChip, Kbd, Ltr, Logo, EmptyState, AppShell
  features/     auth/ (authService: Supabase + mock, AuthProvider/RequireAuth, LoginPage)
                projects/ (ProjectsPage, ProjectPage, CreateProjectDialog, queries)
                upload/ (validation, uploadStore, Dropzone)
                review/ (ReviewPage 3-pane skeleton, DrawingPlaceholder, sampleData)
  i18n/         he.ts (all UI strings), en.ts (partial), index.ts (keeps <html dir/lang> in sync)
  styles/       tokens.css (spec tokens, light + dark), index.css
  test/         setup, utils (renderApp with memory router + mock adapters), axe config, RTL and lint-style guards
```

## Design decisions
- **Tokens:** `--*` CSS variables hold RGB channels, so Tailwind opacity modifiers work (`bg-conf-low/10`). There are two dark-mode blocks: `prefers-color-scheme` (unless `data-theme="light"` is set) and `[data-theme="dark"]`. A test checks the two blocks are identical. `--canvas-bg` stays white in dark mode.
- **Confidence language:** every level is shown as colour + SVG shape + word: ● מאומת, ▲ סביר, ◆ לבדיקה, ◇ לא מוכר, ✎ אושר ידנית. **Finding for UX:** `--conf-mid` `#B26B00` has only 4.2:1 contrast on white, which is below 4.5:1 for small text. So the badge word uses `--foreground` and the level colour goes only on the shape (graphics need 3:1). `tokens.test.ts` encodes these ratios.
- **RTL:**
  - `<html dir="rtl" lang="he">` is set in index.html and kept in sync by i18n.
  - Codes and units such as "4.10", "16A", "H=65" and "1:50" are wrapped in `<bdi dir="ltr">` (`<Ltr>`, `MixedText`), or in FSI/PDI inside translated strings.
  - Item codes are always strings.
  - The drawing subtree is `dir="ltr"` and is the only place physical `left-`/`right-` classes are allowed. `logical-props.test.ts` enforces this until ESLint lands.
  - "Next" chevrons point left and "back" chevrons point right.
  - Progress bars fill from inline-start, so they fill right to left.
- **tailwind-merge** is extended with the custom font-size scale (`text-meta`, `text-dense`, …). Without that it dropped `text-foreground` and `text-primary-foreground` (a real bug that tests caught).
- **Upload validation (client hints only; the server re-validates per SEC-14):**
  - Extension allow-list (pdf/dwg/dxf/png), with 0 bytes rejected and a 100MB limit.
  - The magic-byte sniff (`%PDF-`, `AC10xx`, PNG signature, ASCII/binary DXF) must match the extension.
  - Duplicates (same name + size) are flagged.
  - PNG gets the "רסטר — ביטחון מרבי 'סביר'" badge.
  - At most 3 uploads run at once. The upload store is global (Zustand), so uploads continue when the user navigates away.
- **Auth:**
  - Supabase uses PKCE and `persistSession`.
  - Magic link uses `shouldCreateUser: false`, because organisations are invite-only.
  - The access token goes to the API as a Bearer header (no cookies, per SEC-41).
  - With no `VITE_SUPABASE_URL`, the app falls back to mock auth.

## Screens
- **Login (`/login`)**
  - Split layout: the form sits on the right (start side). The other side is a decorative engineering-grid panel showing a sample BOQ excerpt with confidence shapes and a "receipt" line.
  - A segmented control switches between סיסמה and קישור למייל.
  - Inline Hebrew validation and an `role=alert` error for bad credentials. Magic-link mode shows a confirmation (`role=status`).
  - Redirects back to the page the user originally asked for.
- **Projects (`/projects`)**
  - Sticky top bar with the logo, a "demo mode" tag when mocks are on, and a user menu (theme: system/light/dark, and logout).
  - Table columns: project + address, status dot + word, % verified (number, "◆ N לבדיקה", and a green progress bar), sheets, last updated (dd.mm.yyyy), and a next-action link.
  - Empty state uses the spec copy "עוד אין פרויקטים. גררו לכאן סט שרטוטים ונתחיל." on a dashed grid drop area. Dropping files there opens the create dialog, and the files upload as soon as the project is created.
  - Create dialog fields: name (required), address, and BOQ template (org default). On success it shows a toast and navigates to the new project.
- **Project (`/projects/:id`)**
  - Back link, title, address and status, plus a button to the review workspace.
  - The "גררו לכאן את קובצי השרטוטים" dropzone supports drag & drop and a file picker, with multiple files at once.
  - Each file row shows: icon, name (bidi-isolated), size, raster badge, status with %, a progress bar, a Hebrew error message, and retry/remove buttons.
  - A live summary line reads "X מתוך Y הועלו · ההעלאה ממשיכה ברקע".
  - "שמירת הסט והתחלת עיבוד" registers the sheet set.
  - Below that is a card listing the uploaded sets.
- **Review workspace (`/projects/:id/review`), static skeleton of S10**
  - Header: breadcrumbs, ⌘K search stub, "87% מאומת" bar + "◆ 23 לבדיקה", שתף/ייצוא, and the user menu.
  - Filter toolbar: domain/floor/room/status dropdown stubs and ●▲◆ toggle chips.
  - Three panes, in RTL order:
    - **BOQ (right, ~38%):** sticky chapter header with "91% מאומת" and the split ●▲◆ bar. Rows have an indicator column, a 3px level stripe at row start, the code as LTR text, a description with mixed-text isolation, the unit, and the quantity left-aligned with tabular digits. A selected row is highlighted.
    - **Drawing (centre, ~47%, `dir="ltr"`):** sheet and layers pickers, a schematic SVG sample of a lighting plan (walls, symbols, red dashed switch arcs, confidence frames in the spec's line weights and dashes, and a blue selection glow). Also a vertical tool rail on the left (V A L # M D S + undo), a 180×130 minimap at bottom-left, a scale/zoom strip, and the חדש/קיים/להריסה toggle.
    - **Queue (left, ~15%):** risk cards (item, unknown-symbol cluster with thumbnails, reason chips, impact) and a "23 נותרו · כ-2 דק'" footer.
  - Bottom selection bar with A/R/E/N/? keyboard hints.
  - Skip links to each pane.
  - Buttons only show a "תצוגה סטטית" toast for now.

## Tests (62, 9 files)
- `ConfidenceBadge`: word + shape for every level, three distinct shapes, score only in the tooltip, DB enum mapping, axe.
- Upload validation: extension, size boundary at 100MB / +1 byte, empty file, magic bytes, mismatch.
- Upload UI: multi-file progress → done → save set; Hebrew errors for unsupported/oversize/mismatch; PNG raster badge and duplicates; network failure + retry; drag highlight; axe.
- Login in mock mode: redirect, validation, bad credentials, success + redirect back, magic link, logout, axe.
- Projects: empty state copy, table contents, create dialog (validation → navigate), axe for list, dialog and empty state.
- Review skeleton: pane order, LTR drawing, "4.10" kept as text, axe.
- RTL: index.html root attributes, i18n dir switching he↔en, `<bdi>` isolation of 16A / H=65 / 1:50, number and date formats.
- Tokens: WCAG ratios in light and dark, and the two dark blocks are identical.
- Logical-properties guard.

axe runs with `color-contrast` disabled, because jsdom has no layout or canvas. Contrast is covered by `tokens.test.ts` here, and real-browser axe belongs in Playwright (07_test_plan).

## Known gaps / next
- Uploads use a single XHR PUT to the signed URL. **TUS resumable uploads** (Supabase Storage) are a TODO for Sprint 1, and `http.ts` endpoint shapes must be reconciled with `packages/contracts` once it is published. The DTOs in `api/types.ts` are placeholders.
- After the sheet set is saved, the app does not yet auto-advance to S07 "אישור גיליונות"; that screen doesn't exist yet.
- **Google Fonts and CSP:** Google Fonts (Heebo) conflicts with the planned strict CSP (SEC-40). The CSP would need `style-src`/`font-src` exceptions, or we self-host via `@fontsource/heebo`. I recommend self-hosting before CSP enforce. The sandbox blocks fonts.googleapis.com, so local screenshots render with the fallback stack.
- No ESLint config yet, so `lint` = `tsc`. A test stands in for the physical-class rule.
- The review workspace is static: no deck.gl, virtualization, resizable panes, keyboard shortcuts or tablet layout yet. Its tool labels and the decorative login sample are not in i18n yet.
- The Playwright E2E / visual RTL screenshots (07_test_plan) are not set up in this package.
