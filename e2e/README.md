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
  reduced-motion, forced-colors) + merge into `a11y/axe-results.json`.
- `npm run e2e:keyboard` — dialog contracts + keyboard specs.
- `npm run a11y:all` — `lint:a11y` → `build` → `a11y` → `e2e:build` → `e2e:a11y`.
- `npm run mock:api` — mock server standalone (manual poking).
- `npm run typecheck:e2e` — `tsc` over `src/` + `e2e/` (drift guard included).

Ports (env-overridable): app 4190 (`E2E_APP_PORT`), mock API 4191
(`E2E_MOCK_PORT`), prod preview 4192, CSP preview 4193. Port 4173 untouched.

## Layout

- `fixtures.ts` — `app` page (fresh context, guard, store reset), `mockApi`
  client, `seedLibrary`, `gotoTab`, `fillKey`, `assertDialogContract`,
  `assertLayeredEsc`, `scanState` (axe tags + allowlist + per-test JSON).
- `mocks/secureStore.mock.ts` — every real export, in-memory + localStorage
  mirror (cross-tab sync works), `_apiCheck: typeof Real` fails `tsc` on drift.
  `window.__e2e__`: `seed` (returns ids) / `reset` / `setDegraded` / `markUnreadable` / `failNext`.
- `mock-api/server.mjs` — node:http, 127.0.0.1 only, CORS incl. preflight.
  Scenario priority: prompt `[[mock:name,k=v]]` > key `sk-or-test-*` >
  `POST /__mock/scenario`. `GET /__mock/requests` log (auth redacted) —
  **filter by unique prompt marker** (`marker()`), never by global counts:
  the server is shared across parallel workers. Per-prompt counters keep
  `fail-nth` parallel-safe.
- `mock-api/png.mjs` — deterministic PNG fixtures (zlib encoder, no binaries).
- `a11y/states.spec.ts` — ~30 states × projects; emulation runs a subset;
  ARIA snapshots (`__aria__/`) assert on desktop only.
- `a11y/allowlist.json` — known incompletes with justification (`color-contrast`
  + one scoped `aria-valid-attr-value` on `lib-menu-open`: `true` is spec-valid,
  popup is `role=group`, axe cannot verify popup type).
- `keyboard/dialogs.spec.ts` — contract × 8 dialogs + menu/combobox/edit/skip/Ctrl+Enter.
- `emulation/matrix.spec.ts` — viewport reflow, 1.4.12 spacing, target-size sweep
  (opacity-0 controls excluded; see limits).
- `behavior/` — generate fan-out/errors/cancel/reveal, key flows, backup round
  trip, cross-tab sync, degraded pre-POST block.
- `real-store.spec.ts` — prod `dist/` smoke (no hook, boots, XOR-row decrypt).
- `csp.spec.ts` — header parity on `dist-e2e` under production headers.

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
  sweep.
- Menu-launched dialogs (backup/restore/clear) return focus to the Library
  menu trigger via `Dialog returnFocusRef`; the restore picker-cancel path
  pre-focuses the trigger (no dialog opens). Success landings: clear →
  gallery (explicit), backup export/restore → Library trigger (dialog return),
  key Test result announced via role=status/alert (asserted in api-key.spec).
- `toast-ok`/`toast-err-sticky` wait out the staggered reveal
  (`awaitRevealSettled`: `.reveal` count 0) before scanning — mid-fade text
  scans below AA but no user rests on it; the settled card is the truthful
  state. Animation untouched.
- Mobile sheet dialog semantics live on a `display:contents` wrapper div
  inside the composer `aside` (desktop stays a plain complementary region);
  role/name verified via `getByRole("dialog", { name: "Image composer" })`.
- `aria-valid-attr-value` incomplete on `button[aria-haspopup="true"]`
  (lib-menu-open): reviewed, kept scoped — `true` is spec-valid, popup is
  role=group so no narrower token applies; axe cannot verify popup type.
- No screen-reader automation, no visual regression, no CI provider config.
- eslint 9.39.5 prints a deprecation notice (pinned; jsx-a11y 6.10.2 needs the
  9.x line). Node 18.18+ required by eslint 9.
