# e2e harness — zero-cost, offline, repeatable

App under test: `dist-e2e/` (mock secureStore alias + `VITE_OPENROUTER_BASE`
pointing at the loopback mock API). No real OpenRouter call can happen: every
test installs a `**://openrouter.ai/**` route guard that records + aborts, and
the fixture fails the test if the guard ever fires.

## Commands

- `npm run e2e:build` — `vite build --mode e2e` + sentinel (mock present in
  `dist-e2e/`, absent from `dist/`).
- `npm run e2e` — `build` + `e2e:build` + all Playwright projects.
- `npm run e2e:a11y` — state + emulation suites (desktop, mobile,
  reduced-motion, forced-colors) + dark + dark-mobile (states only), then merge:
  light → `a11y/axe-results.json`, dark → `a11y/axe-results-dark.json`
  (one summary line per dark project; exits non-zero on any unallowlisted
  violation in either group).
- `npm run e2e:keyboard` — dialog contracts + keyboard specs.
- `npm run e2e:shots` — viewport PNGs per state (desktop, mobile, dark,
  dark-mobile; dark shots named `<state>.dark.png` / `<state>.dark-mobile.png`)
  in `a11y/shots/` (gitignored) + ordered manifest + contact sheet; review per
  `VISUAL-REVIEW.md`, never gates.
- `npm run a11y:all` — `lint:a11y` → `build` → `a11y` → `e2e:build` → `e2e:a11y`.
- `npm run mock:api` — mock server standalone (manual poking).
- `npm run typecheck:e2e` — `tsc` over `src/` + `e2e/` (drift guard included).

Ports (env-overridable): app 4190 (`E2E_APP_PORT`), mock API 4191
(`E2E_MOCK_PORT`), prod preview 4192, CSP preview 4193. Port 4173 untouched.

## Layout

- `fixtures.ts` — `app` page (fresh context, guard, store reset), `mockApi`
  client, `seedLibrary`, `gotoTab` (studio/refs/inpaint; closes an open
  Inpaint sheet first), `fillKey` (same), `paintStroke` (mouse drag; touch
  taps on coarse pointers, sheet closed + taps kept clear of the peek bar),
  `ensureInpaintControlsOpen` / `closeInpaintControls` (mobile peek-bar
  open / Esc close; no-ops on desktop), `openSourcePicker` /
  `pickFirstGeneration` (always through the sheet's Choose/Change button),
  `assertDialogContract`, `assertLayeredEsc`, `scanState` (axe tags +
  allowlist + per-test JSON).
- `mocks/secureStore.mock.ts` — every real export, in-memory + localStorage
  mirror (cross-tab sync works), `_apiCheck: typeof Real` fails `tsc` on drift.
  `window.__e2e__`: `seed` (returns ids) / `reset` / `setDegraded` / `markUnreadable` / `failNext`.
- `mock-api/server.mjs` — node:http, 127.0.0.1 only, CORS incl. preflight.
  Auth enforced like the real provider: `/images` and `/key` 401
  (`Missing Authentication header`) when the bearer value is empty or not
  `sk-or-`-prefixed — checked before any scenario, so no directive bypasses
  it. `GET /api/v1/key` → `{data:{label, limit_remaining}}` for good keys.
  Scenario priority: prompt `[[mock:name,k=v]]` > key `sk-or-test-*` >
  `POST /__mock/scenario`. `GET /__mock/requests` log (auth redacted) —
  **filter by unique prompt marker** (`marker()`), never by global counts:
  the server is shared across parallel workers. Per-prompt counters keep
  `fail-nth` parallel-safe.
- `mock-api/png.mjs` — deterministic PNG fixtures (zlib encoder, no binaries).
- `a11y/states.spec.ts` — 36 states × projects; emulation runs a subset;
  ARIA snapshots (`__aria__/`) assert on desktop only (`inpaint-empty` skips
  mobile — its heading lives in the closed sheet; `inpaint-sheet-open` covers
  the mobile sheet instead). `dark` / `dark-mobile` (`colorScheme: "dark"`)
  run the same states, no snapshots; `mobile` checks use `isMobileProj()`
  so `dark-mobile` gets the same layout skips.
- `a11y/dark-project.spec.ts` — guard: dark projects really render dark
  (`html[data-theme=dark]`, `colorScheme` dark, body bg `rgb(15, 22, 20)`).
  Dark projects only (testMatch).
- `a11y/allowlist.json` — known incompletes with justification (`color-contrast`
  + one scoped `aria-valid-attr-value` on `lib-menu-open`: `true` is spec-valid,
  popup is `role=group`, axe cannot verify popup type). `color-contrast` is
  `excludeProjects: ["dark", "dark-mobile"]`: contrast is enforced in dark
  (no allowlist there). Axe `incomplete` results (not violations) are listed
  in the merge output, not gated.
- `keyboard/dialogs.spec.ts` — contract × 10 dialogs + menu/combobox/edit/skip/Ctrl+Enter.
- `emulation/matrix.spec.ts` — viewport reflow, 1.4.12 spacing, target-size sweep
  (opacity-0 and closed-`<details>` controls excluded; see limits).
- `behavior/` — generate fan-out/errors/cancel/reveal, key flows, backup round
  trip, cross-tab sync, degraded pre-POST block.
- `behavior/api-key.spec.ts` — `Bearer `/quote/whitespace normalisation in
  the field, warn-without-block on non-`sk-or-` shape, truthful Test via
  `GET /key` (label + limit), mangled-key Studio + Inpaint generates with a
  clean header, garbage-key 401 copy. Verified to fail with normalisation
  reverted.
- `behavior/inpaint.spec.ts` — inpaint wrap + ref order (2 default, 1 with knob),
  extra refs (upload + library multi-select, order `[base…, extras…]`, prompt,
  cost, 12-slot cap, over-cap knob toggle sends zero requests, tab-switch
  survival), guards (zero requests), cancel, mid-flight tab switch, overlay tint
  uniformity, pixel-exact composite pixels, entry points, undo/redo gating,
  backup survival.
- `behavior/routing.spec.ts` — deep-link landing (title, skip link,
  `aria-current`, real `href`), back/forward, unknown-path normalisation,
  `/inpaint?src=` resolution for generations + references, missing-id toast +
  URL cleanup.
- `behavior/inpaint-fixes.spec.ts` — picker surface (opaque, ≥600px, internal
  scroll, captions), 200-char source label containment, brush-ring/pointer
  alignment (±1px, incl. after page scroll), wheel sizing without page scroll,
  size-preview visibility/fade/diameter, dab diameter. Cursor/wheel specs skip
  on coarse pointers. The picker + cursor specs were verified to fail with
  their fixes reverted.
- `behavior/inpaint-layout.spec.ts` — tall-source sizing (N20): loader box ≈
  measured canvas box, ≤70dvh and on-screen, page `scrollHeight` doesn't grow
  during load; result lands at the painted canvas size.
- `unit/inpaint-prompt.spec.ts` — pure prompt/aspect/cost contract, no `app`
  fixture, desktop only.
- `real-store.spec.ts` — prod `dist/` smoke (no hook, boots, XOR-row decrypt).
- `behavior/theme.spec.ts` — System/Light/Dark toggle + persistence (header at
  >460px, drawer foot at ≤460px; one control per viewport), live OS follow,
  invalid/blocked storage fallback, `data-theme` set before the app
  bundle runs (bundle route-held; fails if `theme-init.js` is dropped).
- `csp.spec.ts` — header parity on `dist-e2e` under production headers;
  `theme-init.js` runs with zero CSP violations.

## Add a state

1. New `test("<name>", ...)` in `a11y/states.spec.ts` driving only by role/name.
2. End with `await scanState(app, "<name>")` (same name → one JSON file).
3. If risky on emulation, keep it out of `EMU_SUBSET`; snapshots: desktop only.
4. Run `npm run e2e:a11y` (merge prints states/violations/incompletes).

## Add a scenario

1. Case in `server.mjs` POST handler + document here.
2. Reach it via `[[mock:name]]` in the test prompt (unique marker first).
3. Assert via marker-filtered `loggedWithPrompt()` + UI text. Never `n > 1`.

## Read the request log

`GET http://127.0.0.1:4191/__mock/requests` → `[{method, path, headers
(authorization stripped), body, scenario, via, keyKind, ts, aborted?}]`.
`keyKind` proves auth presence without logging the value.

## Known limits

- Mock crypto is base64 tagging, not AES-GCM; backup wrap is self-consistent,
  not portable to production. Real-crypto paths rely on `real-store.spec.ts` +
  the `_apiCheck` type guard.
- `ok-webp`/`ok-jpeg` serve PNG bytes with a webp/jpeg label (decoders sniff;
  only the tag text is asserted).
- Hover-only card controls (M1, opacity 0) are excluded from the target-size
  sweep, as is content inside closed `<details>` (keeps layout boxes in some
  engines while hidden and non-interactive).
- Aria snapshots pin wall-clock text (`Oct \d+, \d+:\d+`): the meridiem is
  matched as `(AM|PM)` so states stay green morning and afternoon.
- Menu-launched dialogs (backup/restore/clear) return focus to the Library
  menu trigger via `Dialog returnFocusRef`; the restore picker-cancel path
  pre-focuses the trigger (no dialog opens). Success landings: clear →
  gallery (explicit), backup export/restore → Library trigger (dialog return),
  key Test result announced via role=status/alert (asserted in api-key.spec).
- `toast-ok`/`toast-err-sticky` wait out the staggered reveal
  (`awaitRevealSettled`: `.reveal` count 0 and no `.gen-caption.fading`) before
  scanning — mid-fade text scans below AA but no user rests on it; the settled
  card is the truthful state. `.reveal` alone reads 0 before the solo hero's
  reveal starts, so the fading loader caption was caught mid-fade (dark
  desktop, 1.05:1 on an opacity-transitioning caption). Animation untouched.
- Mobile sheet dialog semantics live on a `display:contents` wrapper div
  inside the composer `aside` (desktop stays a plain complementary region);
  role/name verified via `getByRole("dialog", { name: "Image composer" })`.
  The Inpaint sheet works the same way (`dialog "Inpaint controls"`, closed
  by X / backdrop / Esc / grab swipe; closes on success, on tab switch, and
  above 900px; errors while closed also toast).
- `aria-valid-attr-value` incomplete on `button[aria-haspopup="true"]`
  (lib-menu-open): reviewed, kept scoped — `true` is spec-valid, popup is
  role=group so no narrower token applies; axe cannot verify popup type.
- No screen-reader automation, no visual-regression assertions (manual review
  via `VISUAL-REVIEW.md`), no CI provider config.
- eslint 9.39.5 prints a deprecation notice (pinned; jsx-a11y 6.10.2 needs the
  9.x line). Node 18.18+ required by eslint 9.
