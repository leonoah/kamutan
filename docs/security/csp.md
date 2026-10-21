# Content Security Policy and hosting headers (SEC-40, SEC-29, SEC-21)

Source of truth: `firebase.json` → `hosting.headers`. Checked statically on every PR
(`infra/scripts/check-hosting-headers.mjs`, CI job `node`) and in a real browser nightly
(`infra/scripts/csp-verify.mjs`, workflow `dast.yml`). Status: **enforced since Sprint 5** (was Report-Only).

## Header blocks (no header key is set by two blocks — Hosting's precedence for duplicates is undocumented)

| Block | Matches | Headers |
| --- | --- | --- |
| `**` | everything | `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`, `Cross-Origin-Opener-Policy: same-origin-allow-popups` |
| app (regex) | every path except `/s/…`, `/api/…`, `/__/…` | enforced **app CSP**, Report-Only **candidate CSP**, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` |
| no-cache (regex) | same, minus `/assets/…` | `Cache-Control: no-cache` (SPA routes and `index.html` revalidate after every deploy) |
| `/s/**` | external share viewer | enforced **share CSP**, Report-Only share candidate, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store` |
| `/api/**` | API rewrite | `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` (the API also sets its own helmet headers) |
| `/assets/**` | hashed bundles | `Cache-Control: public, max-age=31536000, immutable` |

Why `/assets/**` also gets the app CSP: an unknown `/assets/x.js` falls back to `index.html` (SPA rewrite), which would
otherwise boot the app with no policy. Why `/__/**` gets none: Firebase reserved URLs (`/__/auth/handler`,
`/__/auth/iframe`) are framed/opened by the Firebase Auth SDK and must keep their own headers. Source maps are not
deployed (`hosting.ignore: **/*.map`).

The app regex (RE2, no look-ahead; "not starting with `s/`, `api/`, `__/`"):
`^/(?:$|[^sa_]|s(?:$|[^/])|a(?:$|[^p]|p(?:$|[^i]|i(?:$|[^/])))|_(?:$|[^_]|_(?:$|[^/])))`

## Enforced app policy

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'self'` | |
| `script-src` | `'self' https://apis.google.com` | Vite bundles only; `apis.google.com` = gapi loader used by `signInWithPopup`. No inline, no eval. |
| `style-src` | `'self' 'unsafe-inline'` | Radix Dialog (`react-remove-scroll`) injects a `<style>` element while a dialog is open (found by the browser check). Style injection cannot run script; removal tracked by the candidate policy. |
| `img-src` | `'self' data: blob: https://firebasestorage.googleapis.com https://storage.googleapis.com https://*.googleusercontent.com` | tiles/crops via V4 signed URLs (path style, `storage.googleapis.com`), Google avatars |
| `font-src` | `'self'` | Heebo / JetBrains Mono self-hosted (`@fontsource`) |
| `connect-src` | `'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://firebasestorage.googleapis.com https://storage.googleapis.com` | Firebase Auth, Firestore listeners (WebChannel / long-poll), uploads, signed-URL artifact fetches. Analytics and Installations are gone (analytics is off by default). |
| `frame-src` | `'self' https://kamutan-fba67.firebaseapp.com https://accounts.google.com https://apis.google.com` | Firebase Auth iframe on the auth domain |
| `worker-src` | `'self' blob:` | viewer workers |
| `object-src` / `base-uri` / `form-action` / `frame-ancestors` | `'none'` / `'self'` / `'self'` / `'none'` | |
| `upgrade-insecure-requests` | on | |

Share viewer (`/s/**`) is stricter: `default-src 'none'`, `script-src 'self'`, `connect-src 'self'` (all data and tiles
come through the API proxy), `img-src 'self' data: blob:`, `frame-src 'none'`, `base-uri 'none'`, `form-action 'none'`.

Report-Only candidates (same, plus): `style-src 'self'` (no `'unsafe-inline'`) and `require-trusted-types-for 'script'`.
No reporting endpoint yet (request R-A6), so the candidate is evaluated by the browser check and by developers' consoles.

## Verification (Sprint 5, 2026-10-15)

`infra/scripts/csp-verify.mjs` serves a build over HTTPS with the exact `firebase.json` headers and rewrites, drives
headless Chromium (Playwright 1.56, `/opt/pw-browsers`), aborts any request that leaves localhost (after CSP has been
evaluated) and collects `securitypolicyviolation` events.

| Build | Steps | Enforced violations | Report-Only (candidate) |
| --- | --- | --- | --- |
| mock (`VITE_USE_MOCKS=true`) | login, mock sign-in → projects, Radix dialog, project page, sheets, review workspace (viewer + overlays + minimap), library, share viewer `/s/demo-noah`, expired link, unknown token, 404 | **0** | 1: `style-src-elem` inline `<style>` from `radix-*.js` when the dialog opens |
| real (Firebase config) | login (Firebase Auth initialised), share viewer, 404 | **0** | 0 |

Found and fixed on the way: (1) the mock backend serves artifacts as `data:` URLs read with `fetch()` → blocked by
`connect-src`; production uses signed Storage URLs, so the harness adds `data:` to `connect-src` for `--mock` runs only
(the deployed policy is unchanged). (2) Without a CSP on `/assets/**`, an unknown asset URL rendered the SPA with no
policy — fixed by the block layout above. (3) `upgrade-insecure-requests` removed from the Report-Only policies (ignored
there, logs a console error).

Not verifiable from the dev sandbox (Google hosts are blocked): the real Google sign-in popup, Firestore listeners and
signed tile URLs against live endpoints. Their origins are in the policy; confirm on the first staging deploy with the
browser console open (any `Refused to …` line is a bug — add the origin here and in `firebase.json` in the same PR).

```bash
pnpm --filter @kamutan/web build                       # real config
NODE_PATH=<dir with playwright> PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  node infra/scripts/csp-verify.mjs --dist apps/web/dist --report /tmp/csp.json
VITE_USE_MOCKS=true pnpm --filter @kamutan/web exec vite build --outDir /tmp/web-mock
node infra/scripts/csp-verify.mjs --dist /tmp/web-mock --mock --screenshots /tmp/shots
node infra/scripts/check-hosting-headers.mjs           # static invariants
```

## Changing the policy

1. Add the origin to the narrowest directive in `firebase.json` (both the enforced and the candidate value).
2. Run `check-hosting-headers.mjs` and `csp-verify.mjs` (both builds). Update the table above.
3. CODEOWNERS: `firebase.json` and this file need the owner's review.
4. Enabling Analytics: `script-src https://www.googletagmanager.com`, `connect-src https://*.google-analytics.com
   https://*.analytics.google.com https://firebaseinstallations.googleapis.com https://firebase.googleapis.com`.
   Sentry (EU): `connect-src https://*.ingest.de.sentry.io`.
5. Moving `authDomain` to the hosting domain makes the auth handler same-origin; drop `kamutan-fba67.firebaseapp.com`
   from `frame-src` then.
