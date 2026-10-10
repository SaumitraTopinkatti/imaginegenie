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
