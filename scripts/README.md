# a11y scripts

One-command accessibility gate (builds nothing — run after `npm run build`):

```sh
npm run build && npm run a11y
```

- `npm run a11y` → `scripts/a11y-check.mjs`: starts `vite preview` on
  `127.0.0.1:4173`, waits for `/`, runs the scan, kills the
  server, exits **non-zero on serious/critical findings only**.
- `npm run a11y:scan` → `scripts/a11y-scan.mjs`: scan only, expects the
  preview server already running. Writes `a11y/axe-results.json`
  (gitignored) with `[{ state, violations, violationsAllRules, incomplete }]`.
- `npm run csp:serve` → `scripts/csp-serve.mjs [port] [dir]`: serves `dist/`
  (defaults: port `4174`, dir `dist/`) with the header values from
  `public/_headers` (minus `upgrade-insecure-requests`, plain http), so
  CSP-governed behavior can be verified locally — `vite preview` and the
  a11y gate don't apply those headers.
- `npm run e2e:build` → `vite build --mode e2e` (mock store alias, loopback API
  base, `dist-e2e/`) then `scripts/e2e-sentinel.mjs`: fails if the mock hook is
  missing from `dist-e2e/` or present in production `dist/`.
- `npm run e2e:a11y` → Playwright state + emulation suites, then
  `scripts/e2e-merge-axe.mjs`: folds `a11y/states/*.json` (gitignored) into
  `a11y/axe-results.json` (same shape as above), prints summary counts, exits
  non-zero on any violation.
- `npm run a11y:all` → `lint:a11y` → `build` → `a11y` → `e2e:build` → `e2e:a11y`:
  single run-before-merge command.
- `npm run lint:a11y` → `eslint src --max-warnings 0` (jsx-a11y strict,
  static only — no browser).
- `npm run e2e` → `build` + `e2e:build` + all Playwright projects (full suite).
- `npm run e2e:keyboard` → Playwright `e2e/keyboard` only (dialog contracts,
  fastest signal for focus/Esc/return work).
