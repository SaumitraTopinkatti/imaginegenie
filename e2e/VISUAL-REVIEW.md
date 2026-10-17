# Visual review — screenshots + judgement loop

Model or human reviews mock-state screenshots after the gates are green.
Shots never gate: no pixel asserts, no committed images.

## When

- Visual diffs only (CSS, JSX layout, copy, icons, sheets, dialogs).
- Logic-only diffs skip this entirely.

## Commands

- Full: `npm run e2e:shots` (builds `dist-e2e`, captures desktop 1280 +
  mobile 390, writes `a11y/shots/manifest.json` + `index.html`).
- Scoped: `npm run e2e:shots -- -g inpaint` (passthrough to Playwright;
  `-g` matches as regex substring). Wipes the dir first, so a scoped run
  holds only that subset under a new run id.
- Review: open `a11y/shots/index.html` over `file://`, or read shots by
  absolute path from `manifest.json` order.

## Naming / order

`a11y/shots/<state>.<project>.png` + `<state>.<project>.meta.json`
sidecar (`runId`, viewport, path, `fontLoaded`, timestamp). Groups:

| Group | States |
|---|---|
| studio-empty | composer-empty (desktop) |
| composer-open | composer-filled (d), mobile-sheet-open (m) |
| generating | generating (d) |
| gallery | gallery-populated, toast-ok, lib-menu-open (d+m) |
| lightbox | lightbox, lightbox-with-refs (d+m) |
| viewer | viewer-over-lightbox (d+m) |
| refs | refs-empty, refs-populated, refs-edit-combobox (d+m) |
| inpaint | inpaint-empty (d), inpaint-picker-open (d+m), inpaint-sheet-open (m), inpaint-editing (d+m), inpaint-result (d+m) |
| dialogs | drawer-open, delete-confirm, clear-step1/2, key-empty/ok, backup-export/restore/legacy, refs-delete/clear-dialog (d+m) |
| errors | composer-error (d); key-err, backup-wrong-pass, degraded-banner, unreadable-bar, toast-err-sticky (d+m) |

Known gaps (no state exists, listed not fixed): mobile studio-empty,
inpaint load state (`inpaint-result` waits through the loader).

## Scope rule

Review only states your diff touches + their mobile pair. File → group map:
`ReferencesTab` → refs; `InpaintTab`/`MaskEditor`/`SourcePicker` → inpaint;
`App.tsx` areas → composer/gallery/lightbox/dialogs; global CSS or tokens →
full sweep.

## Freshness

Judge only shots whose sidecar `runId` equals `manifest.json runId`,
captured after your last edit. Else re-run. A manifest with
`playwrightExit ≠ 0` is partial — noted on the contact sheet.

## Noise (ignore, don't fix)

Clock text, hover remnants on last-clicked control, loader canvas frames,
fallback font when sidecar `fontLoaded: false` (offline runs can't reach
Google Fonts).

## Report template

One entry per shot, in manifest order:

```
- /abs/path/a11y/shots/<state>.<project>.png — <state> · <project> <w>x<h>
  expected: <1 line>
  observed: <1 line>
  verdict: ok | fix | question
  fix: <file::symbol or selector>   (fix/question only)
```

End with a verdict-count line (e.g. `12 reviewed: 10 ok, 2 fix`).
Human corrects/approves before any commit/push of a visual change.

## Cleanup

`rm -rf a11y/shots a11y/states a11y/axe-results.json e2e-results playwright-report dist-e2e`

## Non-goals

No pixel diffs, no CI gating, no committed images, no new states/flows.
