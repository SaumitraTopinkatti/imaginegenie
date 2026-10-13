# imaginegenie

Vite + React image generation app using Seedream 5.0 Pro via OpenRouter (`bytedance-seed/seedream-5-0-pro`).

## What it does

Single-user AI image studio: write a prompt, optionally attach reference images, generate, and keep results in a local encrypted library.

Features:

- Composer with model picker, prompt, aspect ratio, resolution, and reference image inputs
- Gallery with filters and cost tracking
- References library tab for reusable reference images
- Inpaint tab: pick a generation or reference, paint a red mask, describe the change ("replace this with a basketball") — the model edits only inside the mask and the unpainted area stays pixel-exact
- Lightbox view for generated images
- Encrypted IndexedDB store for generations and settings (key held in memory)
- API-key modal with a truthful Test (checks `GET /key`, shows the key label + remaining limit) and paste-tolerant input (`Bearer ` prefix, quotes, and stray whitespace are cleaned automatically)

## Routes

Each section has its own URL (History API, no router library): `/` Studio,
`/references`, `/inpaint` (optional `?src=gen:<id>` / `?src=ref:<id>` deep
link that restores the source image after a refresh — strokes are never
persisted). Back/forward switch sections; unknown paths land on `/`.
Deploys need the SPA fallback in `public/_redirects` (`/* /index.html 200`).

## Setup

Prerequisites: Node.js 18+.

1. Copy the example env file and add your key:

   ```sh
   copy .env.example .env
   ```

   Required variable:

   ```text
   VITE_OPENROUTER_API_KEY=your-key-here
   ```

   Optional override (defaults to `https://openrouter.ai/api/v1`):

   ```text
   VITE_OPENROUTER_BASE=https://openrouter.ai/api/v1
   ```

2. Install and run:

   ```sh
   npm install
   npm run dev
   ```

## Security

Headers + CSP ship via `public/_headers` (Netlify, copied to `dist/` on build):

- Clickjacking: `X-Frame-Options: DENY` + `frame-ancestors 'none'`.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`.
- Enforcing CSP: scripts/styles/images self-only, fonts from Google Fonts,
  API calls to `https://openrouter.ai` only. If you set a custom
  `VITE_OPENROUTER_BASE`, add its origin to `connect-src` in `public/_headers`.

Threat-model notes (honest limits):

- API key: held in tab memory (opt-in AES-GCM remembered copy in IndexedDB,
  decrypted only for viewing / Test / Generate). Any XSS that executes JS in
  the page can read it — no client-side storage survives that. A backend proxy
  holding the key is the only stronger isolation, deliberately not built.
- Local library: AES-GCM with a device-held key stored alongside the data.
  Protection against casual inspection only (e.g. glancing at DevTools), not
  against anyone with profile/filesystem access. If encryption can't start,
  the app shows a banner and refuses to save or generate — new data is never
  silently downgraded.
- Backups ("Back up library") are passphrase-protected: the device key is
  wrapped with a key derived from your passphrase (PBKDF2-SHA256, 600k
  iterations, random salt) and embedded in the file, so the backup restores on
  any browser with the passphrase. Keep the passphrase — it can't be
  recovered. Backups made before this change have no wrapped key and restore
  only on the browser that created them (the restore dialog says so).

## Scripts
- `npm run dev` — start Vite dev server
- `npm run build` — typecheck (`tsc --noEmit`) and build to `dist/`
- `npm run preview` — preview the production build
- `npm run a11y` — accessibility gate (run after `npm run build`; exits non-zero on serious/critical findings only)
- `npm run a11y:scan` — accessibility scan only, expects a preview server already running (see `scripts/README.md`)
- `npm run lint:a11y` — jsx-a11y static lint over `src/` (zero warnings)
- `npm run a11y:all` — run-before-merge: `lint:a11y` → `build` → `a11y` → `e2e:build` → `e2e:a11y`
- `npm run e2e` — full Playwright suite: prod `build` + mock `e2e:build` + all projects (zero-cost, offline — no real OpenRouter calls)
- `npm run e2e:a11y` — a11y state + emulation suites, merges into `a11y/axe-results.json`
- `npm run e2e:keyboard` — dialog/keyboard contracts only
- `npm run mock:api` — standalone loopback mock API (manual poking)
- `npm run typecheck:e2e` — `tsc` over `src/` + `e2e/` (mock drift guard)

E2E harness details (ports, mock store/API contract, adding states/scenarios): see `e2e/README.md`.

## poc.mjs usage

Standalone Node proof-of-concept for the OpenRouter Images API (no build step).

Set env first (`OPENROUTER_API_KEY` or `openrouter_api_key`):

```sh
node poc.mjs endpoints
node poc.mjs text
node poc.mjs ref --image <path-or-url>
node poc.mjs limit-test
```

- `endpoints` inspects model endpoint pricing and supported parameters.
- `text` generates from a text prompt, saves `output-text.png`.
- `ref` generates with one reference image, saves `output-ref.png`.
- `limit-test` posts 15 dummy references to confirm the API limit behavior.

Generated `output-*.png` files are git-ignored test artifacts.
