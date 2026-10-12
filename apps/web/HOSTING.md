# apps/web on Firebase Hosting — notes for DevOps

DevOps owns `firebase.json`. The web app expects the settings below.

## Build
- `pnpm --filter @kamutan/web build` writes the output to **`apps/web/dist`**. This is the hosting `public` dir.
- Vite reads the public Firebase config from `apps/web/.env.firebase` at build time. `VITE_USE_MOCKS` must be unset or `false` for real deploys.
- Hashed assets live in `dist/assets/*`, including the self-hosted Heebo / JetBrains Mono `.woff2` files. They can be cached immutably. `index.html` must not be cached.

## Hosting block (suggested)
```jsonc
{
  "hosting": {
    "public": "apps/web/dist",
    "ignore": ["**/*.map"],
    "cleanUrls": true,
    "rewrites": [
      // Same-origin API (ADR 0008): the web client calls /api/v1/...
      { "source": "/api/**", "function": { "functionId": "api", "region": "europe-west1" } },
      // SPA fallback (client routes: /login, /auth/complete, /projects/...)
      { "source": "**", "destination": "/index.html" }
    ],
    "headers": [
      { "source": "/assets/**", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] },
      { "source": "/index.html", "headers": [{ "key": "Cache-Control", "value": "no-cache" }] },
      { "source": "**", "headers": [
        { "key": "Content-Security-Policy-Report-Only", "value": "<see CSP below>" },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy", "value": "camera=(), microphone=(), geolocation=(), payment=()" },
        { "key": "Strict-Transport-Security", "value": "max-age=31536000; includeSubDomains" },
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin-allow-popups" }
      ]}
    ]
  }
}
```
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` is needed. With a stricter COOP, `signInWithPopup` (Google) cannot talk to its popup.
- Keep `X-Frame-Options` / `frame-ancestors 'none'` for the app itself. The Firebase auth iframe is a *child* frame, so those headers don't affect it.

## CSP (SEC-40: Report-Only in Sprint 0, enforce before beta)
```
default-src 'self';
script-src 'self' https://apis.google.com;
style-src 'self';
font-src 'self';
img-src 'self' data: blob: https://firebasestorage.googleapis.com https://lh3.googleusercontent.com;
connect-src 'self'
  https://identitytoolkit.googleapis.com
  https://securetoken.googleapis.com
  https://firestore.googleapis.com
  https://firebasestorage.googleapis.com
  https://*.googleapis.com
  https://*.firebaseio.com wss://*.firebaseio.com;
frame-src https://kamutan-fba67.firebaseapp.com https://accounts.google.com https://apis.google.com;
worker-src 'self' blob:;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
```
- **Fonts:** Google Fonts is gone. Heebo and JetBrains Mono are bundled via `@fontsource/*`, so `font-src 'self'` is enough.
- **Inline code:** there are no inline scripts or styles. React `style={}` props go through CSSOM, which `style-src 'self'` allows.
- **Firestore long-polling fallback:** this also goes to `firestore.googleapis.com`, which `connect-src` already covers.
- **Google sign-in popup:** this loads `https://<authDomain>/__/auth/handler` and scripts from `apis.google.com`. If `authDomain` later moves to the custom hosting domain, the handler becomes same-origin and the `frame-src` entry for `firebaseapp.com` can be removed.
- **Analytics:** it is off by default (`VITE_ANALYTICS_CONSENT`). If it is ever enabled, add these:
  - `https://www.googletagmanager.com` to `script-src`
  - `https://*.google-analytics.com https://*.analytics.google.com` to `connect-src`

## Auth console settings (Firebase Console → Authentication)
- **Providers:** Email/Password with **Email link** enabled, and Google.
- **Authorized domains:** the hosting domain(s), the preview-channel domains (`kamutan-fba67--*.web.app`), and `localhost`.
- **Email link:** the action URL is `https://<host>/auth/complete`. The app builds it from `window.location.origin`, so every authorized domain works.
