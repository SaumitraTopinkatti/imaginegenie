# AGENTS.md — imaginegenie

Single-user AI image studio (Vite + React 18 + TS). Prompt → OpenRouter (`POST /images`) → encrypted local library. Studio offers Seedream 5.0 Pro (default) + Qwen Image 3 Pro; Inpaint stays Seedream-only.

## Commands

- `npm run build` — typecheck (`tsc --noEmit`) + build to `dist/`. Always run after edits.
- `npm run a11y` — accessibility gate. Run **after** `npm run build`; it starts its own `vite preview` on `127.0.0.1:4173`, scans, kills it. Exits non-zero only on serious/critical findings.
- `npm run a11y:scan` — scan only; expects a preview server already running.
- `npm run a11y:all` — run-before-merge: `lint:a11y` → `build` → `a11y` → `e2e:build` → `e2e:a11y`. Zero-cost offline harness (in-memory mock store + loopback mock API on 4190/4191). `npm run e2e` = everything; `e2e:keyboard` = dialog contracts only. Never touch port 4173.
- Runners: Playwright e2e (`npm run e2e`) + `eslint` jsx-a11y (`npm run lint:a11y`). Gates for "done": `lint:a11y` clean + `tsc` clean + `build` ok + `a11y` 0 serious/critical + `e2e:a11y` green (or full `npm run a11y:all`).
- Node ≥18.18 (eslint 9 floor).

## Gotchas

- App is served from root (`/`). Verify previews/screenshots at root, never a subpath.
- Never manually run preview on port **4173**; `npm run a11y` owns it. For manual screenshots use another port (e.g. 4180+) launched **detached** — a foreground `vite preview` holds the console forever.
- Kill preview servers and delete temp scripts/screenshots when done. Under `a11y/`: `axe-results.json` + `states/*.json` are gitignored per-run output; `e2e/__aria__/` snapshots are committed. Also clear `e2e-results/`, `playwright-report/`, `dist-e2e/` (all gitignored).
- Studio loaders are always 1:1 (grid pending cards + solo hero share one square frame) so mid-run shape changes never resize or restart the animation; the hero reveal sits in the same square stage (`contain`). Grid thumbs are square. Inpaint loader + result keep the measured canvas box (`--loader-w` pinned at run start, `max-height: 70dvh` like `.mask-base`) so paint → load → After never jumps or grows the page.
- Scroll fades use CSS `mask-image`, not overlay strips/`::before` gradients — axe flags those as incomplete color-contrast.
- Security headers + enforcing CSP ship via `public/_headers` (Netlify, copied to `dist/`). New external host (API base, fonts, images) → update the matching CSP directive there and re-validate (see README `## Security`). `frame-ancestors 'none'` + `X-Frame-Options: DENY` must stay — app is never embedded.
- `dist-e2e/` is a mock-instrumented build (mock store + loopback API). Never ship it — `e2e-sentinel.mjs` fails if the mock hook is missing from `dist-e2e/` or present in production `dist/`.

## Architecture

- `src/App.tsx` — nearly all UI: header, drawer nav, Studio composer/gallery/lightbox, all modals. `tab` state drives `body[data-tab]`.
- `src/components/ReferencesTab.tsx` — reference library tab (own dropzone, filters, edit drafts, delete confirm).
- `src/components/InpaintTab.tsx` + `MaskEditor.tsx` + `SourcePicker.tsx`, `src/lib/inpaint.ts` (prompt contract, aspect, cost, composite) + `src/lib/types.ts` (`Generation`, `InpaintMeta`) + `src/lib/library.ts` (`saveGeneration`, reference thumb/pick loaders) — Inpaint section. App.tsx holds tab wiring + entry points only.
- Inpaint records are ordinary generations with optional `inpaint` meta (`instruction` shown/searched, `prompt` = exact wrapped prompt sent). Gallery search matches `inpaint?.instruction ?? prompt` plus the model's short label.
- InpaintTab mounts on first visit then stays mounted (`hidden` when inactive + `[hidden]{display:none!important}` guard); tab switches never wipe strokes or orphan a run. The inpaint form must never take the `.composer` class (scoped Ctrl+Enter lives on its own panel).
- Routing: `/` Studio, `/references`, `/inpaint[?src=gen:<id>|ref:<id>]` via History API (`src/lib/route.ts`, no router dep). **All tab switches go through `goTo(tab)` — never `setTab` directly** — or the URL drifts. Drawer items are real `<a href>` (plain click intercepted; modified/middle clicks fall through). Deploy fallback: `public/_redirects` (`/* /index.html 200`); `scripts/csp-serve.mjs` mirrors it for extensionless paths.
- Back-to-close history (`src/lib/historyLayers.ts`): modal entries are same-URL `pushState` tags (`{igBase, igLayer}`) — no query/hash/path changes. **No raw `history.pushState/replaceState` outside that module** (`goTo` → `navigate`, `?src=` writes → `replaceUrl`, route pops → `onRoutePop`). Every `Dialog` registers a layer by default (`history={false}` opts out); sheets + nav drawer join via `useHistoryLayer`. Back closes the topmost layer; any close path consumes its entry. `src/lib/useSwipeDismiss.ts` — touch-only swipe-down dismiss (no `preventDefault`, 70px threshold); lightbox/viewer wire it on mobile.
- Mask geometry always derives from the overlay canvas rect (paint mapping + brush ring share one frame). `containerRef` is keyboard-shortcut scope only.
- `e2e` alias note: vite `mode=e2e` aliases every `secureStore` specifier to the mock — new specifier spellings (`./secureStore` from `lib/`) need their own alias entry.
- `src/components/DenoiseFrame.tsx` — canvas pixel-drift loader; loops until `done`, then finishes to clear and calls `onClean`.
- `src/lib/useBottomSheet.ts` — shared mobile-sheet behaviour (`SHEET_MQ`, scroll lock, focus trap, Esc, grab swipe, guarded peek focus-return). Studio's drawer and Inpaint's controls both run on it; sheet CSS is shared via `.composer, .inpaint-sheet` selector lists (never put `.composer` on Inpaint).
- `src/components/icons.tsx` — all icons.
- `src/lib/openrouter.ts` — `MODEL` / `MODEL_ENDPOINT_SLUG` constants + API calls. `src/lib/models.ts` — per-model caps table (`MODELS`, `DEFAULT_MODEL = "seedream"`, `modelFor()`): aspects, ref caps, prices, request ids. All model knowledge lives here; no scattered `if (qwen)`. Records carry `model?` (absent = Seedream). `src/lib/images.ts` — image helpers. `src/lib/secureStore.ts` — AES-GCM IndexedDB store (generations + references); key held in memory only.
- Generation reveal rule: a pending slot reuses the **same card node** (`Slot {key, gen, revealing, epoch}`, merge after 1100ms, epoch-guarded). Never unmount/remount the card between loader and image or the reveal sequence breaks.
- Image count (1–4) is a **parallel fan-out of `n: 1` calls** (`src/lib/openrouter.ts` hardcodes `n: 1`). Never request `n > 1`.
- Clipboard paste is **tab-scoped**: Studio handler returns early unless `tab === "studio"`; ReferencesTab owns library paste. New paste targets must follow the same guard, and must never `preventDefault` text-only pastes.
- Library mutations broadcast over `BroadcastChannel` (`LIB_CHANNEL` in `secureStore.ts`) so other tabs stay in sync. Storage logic must stay correct with multiple tabs open.
- `poc.mjs` + `poc-models-parked.md` (gitignored): parked multi-model experiments. Human triage only on explicit request — never auto-pick.

## Money + secrets (hard rules)

- Real OpenRouter image calls cost money. **Ask before any real generation** during dev/verification; verify with mocks/screenshots.
- **Seedream 5.0 Pro + Qwen Image 3 Pro only.** No further model switches/additions without an explicit request.
- API key lives in tab memory + `.env` (`VITE_OPENROUTER_API_KEY`, see `.env.example`). Opt-in "remember" keeps an AES-GCM copy in IndexedDB (`openrouter-key` in `secureStore.ts`), decrypted only for viewing / Test / Generate via `resolveKey`, working copy dropped on modal close. Pasted keys auto-clean (`normalizeApiKey`: trim, strip `Bearer `/quotes/whitespace) at input/load/resolve/persist — stored value is always clean; odd shape warns, never blocks. Test is truthful: `GET /key` (label + `limit_remaining`), never the models endpoint. Never `sessionStorage`/plaintext at rest, never commit/log/print keys; clear test keys after use. `output-*.png`, `.env*`, `a11y/axe-results.json` are gitignored.

## Design conventions (don't regress)

- Light mode only. Teal `#0A7A6B` / `#13A08C` / `#E1F1ED` / `#F1F8F6` on `#F5F4EF` / `#FFFFFF` / `#DEDDD5`. System body font; `Instrument Serif` italic for brand/title accents only.
- Every control needs **hover AND `:active` feedback** (touch has no hover — `:active` is required, not optional). Focus-visible ring is global.
- `body { user-select: none }` with an opt-in allowlist for dynamic values (costs, prompts, times, key status, errors). Keep the allowlist updated when adding dynamic text.
- Native `<select>`s use `appearance: none` + drawn SVG chevron (`padding-right: 34px`); the open dropdown list itself stays OS-native. Seed input is `type=text inputMode=numeric`. No `<datalist>` — group suggestions are a custom `combobox` + `listbox` popover (`mousedown` beats blur).
- Desktop (≥901px): composer is sticky fixed-height with scrollable body + pinned footer; Studio tab locks the viewport (`body[data-tab="studio"]`, gallery scrolls internally). Mobile: composer is a bottom sheet + peek-bar; drawer goes full-height with its own close row. Inpaint controls use the same sheet (`useBottomSheet` + `.inpaint-sheet`, peek "Describe the edit · tap to expand") — canvas/result stay in the main view. The panel must still never take `.composer` (that triggers Studio's paid Ctrl+Enter).
- Mobile dialogs are thumb-first: lightbox is a bottom sheet (grab header + scroll body + pinned `lb-dock` with Close right-most, body Close hidden); viewer is fullscreen with a pinned 4-up `ref-view-bar` (Close right-most, swipe-down dismisses). Desktop wrappers vanish (`display: contents`/`none`) so ≥901px is pixel-identical. Input-free confirms use `overlay-thumb` (bottom-anchored, 48px equal buttons); typed dialogs stay centered. Stacked icon buttons wrap their label in `<span>` (N12 truncation rule); short/long label swaps keep the `aria-label` as the stable name. Coarse pointers get 44px dialog buttons / 32px ref-cell icons via `@media (pointer: coarse)`.
- New UI must follow the existing design (tokens, components, patterns above). No visual drift without explicit user confirmation.

## Workflow

- Commit/push only on explicit request. Never discard uncommitted user changes.
- Default reply style: terse (fragments, no filler) unless the user asks for prose.
