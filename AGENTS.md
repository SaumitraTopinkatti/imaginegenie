# AGENTS.md — imaginegenie

Single-user AI image studio (Vite + React 18 + TS). Prompt → Seedream 5.0 Pro via OpenRouter → encrypted local library.

## Commands

- `npm run build` — typecheck (`tsc --noEmit`) + build to `dist/`. Always run after edits.
- `npm run a11y` — accessibility gate. Run **after** `npm run build`; it starts its own `vite preview` on `127.0.0.1:4173`, scans, kills it. Exits non-zero only on serious/critical findings.
- `npm run a11y:scan` — scan only; expects a preview server already running.
- No test runner, no linter. Gates for "done": `tsc` clean + `build` ok + `a11y` 0 serious/critical.
- Node 18+.

## Gotchas

- `vite.config.ts` sets `base: "/imaginegenie/"` — always serve/verify under the `/imaginegenie/` subpath, never root.
- Never manually run preview on port **4173**; `npm run a11y` owns it. For manual screenshots use another port (e.g. 4180+) launched **detached** — a foreground `vite preview` holds the console forever.
- Kill preview servers and delete temp scripts/screenshots under `a11y/` when done. Only `a11y/axe-results.json` belongs there (gitignored).
- Loader frames must match the aspect of the card thumb they replace (grid thumbs are square). Mismatched loader/card ratios break the reveal.
- Scroll fades use CSS `mask-image`, not overlay strips/`::before` gradients — axe flags those as incomplete color-contrast.

## Architecture

- `src/App.tsx` — nearly all UI: header, drawer nav, Studio composer/gallery/lightbox, all modals. `tab` state drives `body[data-tab]`.
- `src/components/ReferencesTab.tsx` — reference library tab (own dropzone, filters, edit drafts, delete confirm).
- `src/components/DenoiseFrame.tsx` — canvas pixel-drift loader; loops until `done`, then finishes to clear and calls `onClean`.
- `src/components/icons.tsx` — all icons.
- `src/lib/openrouter.ts` — `MODEL` / `MODEL_ENDPOINT_SLUG` constants + API calls. `src/lib/images.ts` — image helpers. `src/lib/secureStore.ts` — AES-GCM IndexedDB store (generations + references); key held in memory only.
- Generation reveal rule: a pending slot reuses the **same card node** (`Slot {key, gen, revealing, epoch}`, merge after 1100ms, epoch-guarded). Never unmount/remount the card between loader and image or the reveal sequence breaks.
- Image count (1–4) is a **parallel fan-out of `n: 1` calls** (`src/lib/openrouter.ts` hardcodes `n: 1`). Never request `n > 1`.
- Clipboard paste is **tab-scoped**: Studio handler returns early unless `tab === "studio"`; ReferencesTab owns library paste. New paste targets must follow the same guard, and must never `preventDefault` text-only pastes.
- Library mutations broadcast over `BroadcastChannel` (`LIB_CHANNEL` in `secureStore.ts`) so other tabs stay in sync. Storage logic must stay correct with multiple tabs open.
- `poc.mjs` + `poc-models-parked.md` (gitignored): parked multi-model experiments. Human triage only on explicit request — never auto-pick.

## Money + secrets (hard rules)

- Real OpenRouter image calls cost money. **Ask before any real generation** during dev/verification; verify with mocks/screenshots.
- **Seedream 5.0 Pro only.** No model switches/additions without an explicit request.
- API key lives in memory + `.env` (`VITE_OPENROUTER_API_KEY`, see `.env.example`). Never commit, log, or print keys; clear test keys after use. `output-*.png`, `.env*`, `a11y/axe-results.json` are gitignored.

## Design conventions (don't regress)

- Light mode only. Teal `#0A7A6B` / `#13A08C` / `#E1F1ED` / `#F1F8F6` on `#F5F4EF` / `#FFFFFF` / `#DEDDD5`. System body font; `Instrument Serif` italic for brand/title accents only.
- Every control needs **hover AND `:active` feedback** (touch has no hover — `:active` is required, not optional). Focus-visible ring is global.
- `body { user-select: none }` with an opt-in allowlist for dynamic values (costs, prompts, times, key status, errors). Keep the allowlist updated when adding dynamic text.
- Native `<select>`s use `appearance: none` + drawn SVG chevron (`padding-right: 34px`); the open dropdown list itself stays OS-native. Seed input is `type=text inputMode=numeric`. No `<datalist>` — group suggestions are a custom `combobox` + `listbox` popover (`mousedown` beats blur).
- Desktop (≥901px): composer is sticky fixed-height with scrollable body + pinned footer; Studio tab locks the viewport (`body[data-tab="studio"]`, gallery scrolls internally). Mobile: composer is a bottom sheet + peek-bar; drawer goes full-height with its own close row.
- New UI must follow the existing design (tokens, components, patterns above). No visual drift without explicit user confirmation.

## Workflow

- Commit/push only on explicit request. Never discard uncommitted user changes.
- Default reply style: terse (fragments, no filler) unless the user asks for prose.
