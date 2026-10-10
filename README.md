# imaginegenie

Vite + React image generation app using Seedream 5.0 Pro via OpenRouter (`bytedance-seed/seedream-5-0-pro`).

## What it does

Single-user AI image studio: write a prompt, optionally attach reference images, generate, and keep results in a local encrypted library.

Features:

- Composer with model picker, prompt, aspect ratio, resolution, and reference image inputs
- Gallery with filters and cost tracking
- References library tab for reusable reference images
- Lightbox view for generated images
- Encrypted IndexedDB store for generations and settings (key held in memory)

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

Threat-model notes (honest limits, no passphrase changes planned):

- API key: held in tab memory (opt-in AES-GCM remembered copy in IndexedDB,
  decrypted only for viewing / Test / Generate). Any XSS that executes JS in
  the page can read it — no client-side storage survives that. A backend proxy
  holding the key is the only stronger isolation, deliberately not built.
- Local library: AES-GCM with a device-held key stored alongside the data.
  Protection against casual inspection only (e.g. glancing at DevTools), not
  against anyone with profile/filesystem access. Passphrase-derived encryption
  would change that at the cost of an unlock step on every visit.

## Scripts
- `npm run dev` — start Vite dev server
- `npm run build` — typecheck (`tsc --noEmit`) and build to `dist/`
- `npm run preview` — preview the production build
- `npm run a11y` — accessibility gate (run after `npm run build`; exits non-zero on serious/critical findings only)
- `npm run a11y:scan` — accessibility scan only, expects a preview server already running (see `scripts/README.md`)

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
