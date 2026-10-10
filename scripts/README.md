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
