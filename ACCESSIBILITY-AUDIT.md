# ImagineGenie — Accessibility Audit

| | |
|---|---|
| Date | 2026-10-11 |
| Standard | WCAG 2.2 Level A + AA |
| Method | `check-fix-accessibility` skill v1.8.0 (`~/.agents/all-skills/check-fix-accessibility`). Full static read of every source file + axe results already on disk + computed contrast ratios. |
| Scope | `index.html`, `src/App.tsx`, `src/components/{ReferencesTab,DenoiseFrame,icons}.tsx`, `src/index.css`, `scripts/a11y-*.mjs`, existing `a11y/axe-results.json` |
| Changes made | **None.** Audit only. No build, no scan, no browser run. |

## 1. Verdict

Strong base: semantic buttons, labelled controls, global focus ring, reduced-motion, skip link, drag alternatives, live toast region, Esc handlers. Automated gate is green.

**But the gate is blind to the riskiest UI.** The scan runs on an empty library: no gallery cards, no lightbox, no dialogs, no menu, no edit state, no key modal. Most findings below live exactly there.

**Count: 0 Critical · 13 Serious · 14 Minor/advisory.**

> Evidence labels: **[code]** read from source, logic certain · **[calc]** contrast computed from tokens · **[verify]** reasoned from CSS/DOM, confirm in a browser before fixing.
> Not tested: real screen reader (NVDA/VoiceOver/TalkBack), voice control, real touch device, 200–400 % zoom in a browser.

## 2. Automated evidence on disk

`a11y/axe-results.json` (2026-10-11 00:16): composer / references / gallery → **0 violations**, `color-contrast` incomplete ×2 each (nodes unrecorded). Lightbox **skipped** (no cards in fresh profile).

Gate limits (`scripts/a11y-scan.mjs`, `a11y-check.mjs`):
- Tags `wcag2a, wcag2aa, wcag21a, wcag21aa` — no `wcag22aa`.
- Blocks only serious/critical; moderate ignored.
- States never reached: GenCard, lightbox, reference viewer, confirm dialogs, key modal, backup dialog, library menu, edit-draft + combobox, drawer open, mobile sheet, error/progress states.
- Cannot see keyboard/focus/announcement defects at all.
- Two `color-contrast` incompletes never resolved.

## 3. Findings — Serious

### S1 · Gallery card is a button containing buttons, and hijacks their keys
- **File**: `src/App.tsx:197-209` (card), `227-274` (inner buttons)
- **Element**: `article.card[role=button][tabindex=0]` wrapping 4 `button.icon-btn`
- **Rules**: axe `nested-interactive` · 4.1.2 Name/Role/Value (A) · 2.1.1 Keyboard (A) **[code]**
- **Problem**: (a) Role `button` makes children presentational → Retry/Copy/Download/Delete are not exposed to many screen readers. (b) Card `onKeyDown` does not check `e.target === e.currentTarget`; Enter/Space on an inner button bubbles, calls `preventDefault()` and `onOpen(g)` → opens lightbox instead of acting. (c) Overrides `article` semantics.
- **Fix**: make the card a non-interactive `article`; put one real `<button>` (thumb or title) as the open trigger; keep action buttons as siblings. Or guard keydown with `e.target === e.currentTarget` as a stopgap.
- **Why scan missed**: library empty.

### S2 · Modal dialogs: no focus containment, no focus return, background not inert
- **Where**: lightbox `App.tsx:2081`, reference viewer `2252`, delete confirm `2290`, clear-all `2327`, key modal `2414`, backup `2490`; References tab `ReferencesTab.tsx:662` and `696`.
- **Rules**: 2.4.3 Focus Order (A) · 2.1.2 · APG dialog **[code]**
- **Problem**: all declare `aria-modal="true"`, but Tab walks into the page behind. Only some move focus in (key modal, delete confirm, clear-all, backup); lightbox, viewer and both References dialogs do **not** move focus at all. None return focus to the opener on close.
- **Fix**: one shared `Dialog` wrapper (native `<dialog>.showModal()` or focus-trap) handling focus-in, trap, Esc, focus-return, `inert` on the rest.

### S3 · Reference viewer ignores Escape; Escape closes the wrong layer
- **File**: `App.tsx:865-878` (global Esc), `2252-2287`
- **Rules**: 2.1.1 (A) · APG dialog **[code]**
- **Problem**: no handler ever calls `setViewRef(null)` on Esc. With viewer open over lightbox, Esc closes the lightbox beneath and leaves the viewer orphaned. Also: Esc with key modal open (`412-420`, no `stopPropagation`) additionally closes lightbox/drawer behind it.
- **Fix**: layered Esc: topmost dialog only, with `stopPropagation`.

### S4 · Skip link targets are wrong/non-focusable
- **File**: `App.tsx:1321-1323`, `1840`, `2049`
- **Rules**: 2.4.1 Bypass Blocks (A) **[code]** · focus part **[verify]**
- **Problem**: References tab: "Skip to references" → `#ref-library`, which is a `<span>` **inside the footer** at the bottom, not the panel. Studio: `#gallery` is a `<section>` with no `tabindex="-1"`, so focus may not move in some browsers.
- **Fix**: target `<main id="main" tabIndex={-1}>` (or the panel) and focus it.

### S5 · Dropzones: `div role=button` with accessible name that doesn't match visible text
- **File**: `App.tsx:1655-1685`, `ReferencesTab.tsx:333-362`
- **Rules**: 2.5.3 Label in Name (A) · 4.1.2 **[code]**
- **Problem**: visible "Drop, browse or paste images" / "Drop images here, click to browse…"; `aria-label` "Upload reference images" / "…to the library". Voice-control users saying the visible words fail to target it. Custom role where a native button + hidden file input fits.
- **Fix**: native `<button>`; drop the `aria-label` or make it start with the visible text.

### S6 · Text-field boundaries and placeholders fail contrast
- **File**: `index.css:5, 57, 215-221, 220`
- **Rules**: 1.4.11 Non-text Contrast (AA) · 1.4.3 Contrast (AA) **[calc]**
- **Numbers**: input/select/textarea border `#DEDDD5` on white **1.36:1**; composer fields fill `#F5F4EF` inside white panel ≈1.1:1; dashed dropzone border `#C9C8BF` on `#F5F4EF` **1.53:1**; placeholder `#7F8986` on `#F5F4EF` **3.27:1** (need 3:1 / 4.5:1).
- **Fix**: field border ≥3:1 (e.g. `#8E9895`-class darker neutral → ≥3:1 on white); placeholder ≥4.5:1 (`--muted` `#5D6966` passes 5.18).

### S7 · Auto-dismissing toasts carry errors and one-time warnings
- **File**: `App.tsx:450-454` (4200 ms), `1145`, `837`, `2655-2670`
- **Rules**: 2.2.1 Timing Adjustable (A) · 4.1.3 Status Messages (AA) **[code]**
- **Problem**: partial-failure message ("Generated 2 of 4 · saved 1 … : <error>") and "Keep the passphrase — it can't be recovered" vanish in 4.2 s; no pause on hover/focus, no dismiss, no history. Error toasts are `role=status`, not `alert`.
- **Fix**: persist error/warning toasts until dismissed (or ≥10 s with pause on hover/focus); use `role="alert"` for errors; add a close button.

### S8 · API-key Test result is not announced
- **File**: `App.tsx:2453-2455`
- **Rules**: 4.1.3 Status Messages (AA) **[code]**
- **Problem**: `div.key-status` has no `role`/`aria-live`. "Works — your key is valid." / failure text appears silently after pressing Test.
- **Fix**: `role="status"` (ok) / `role="alert"` (err), element always in DOM.

### S9 · Library menu declares `role=menu` without menu behaviour
- **File**: `App.tsx:1868-1916`, `434-448`
- **Rules**: 4.1.2 (A) · 2.1.1 (A) · APG menu button **[code]**
- **Problem**: no arrow-key navigation, focus not moved into menu on open, Esc closes but focus is not returned to "Library" (menu unmounts → focus lost to `body`), no `aria-haspopup="menu"`/`aria-controls`.
- **Fix**: implement APG menu-button keys + focus return, or drop `role=menu/menuitem` and use a plain disclosure list of buttons.

### S10 · Group combobox: suggestions are mouse-only
- **File**: `ReferencesTab.tsx:501-559`
- **Rules**: 4.1.2 (A) · 2.1.1 (A) **[code]**
- **Problem**: `role=combobox` + listbox, but no ArrowUp/Down, no `aria-activedescendant`; options are `<button role=option>` created on focus and destroyed on blur (`onBlur → setGroupSuggestOpen(false)`) so Tab cannot reach them; Enter saves the draft instead of choosing. Typing the group still works, picking an existing one does not.
- **Fix**: APG combobox-listbox: active-descendant, arrows, Enter selects, Esc closes list first.

### S11 · Focus is dropped on section switch and on removal/edit
- **File**: `App.tsx:366-369, 1415-1430, 1243-1246`; `ReferencesTab.tsx:480-572, 248-259, 662-694`
- **Rules**: 2.4.3 Focus Order (A) · 4.1.3 (AA) · 2.4.2 Page Titled **[code]**
- **Problem**: choosing Studio/References closes the drawer (the focused item becomes hidden) → focus lost to `body`; no focus to `<main>`/heading, no announcement, `document.title` never changes. Edit → inputs appear but focus not moved; Save/Cancel/Delete remove focused node → focus lost. Drawer close also never returns focus to the hamburger.
- **Fix**: on tab change focus a `tabIndex=-1` main/heading and update `document.title`; focus first field on Edit and the Edit button on Save/Cancel; focus next card/list on Delete; return focus to toggle on drawer close.

### S12 · Desktop "locked viewport" layout collapses at short heights / zoom
- **File**: `index.css:740-765`
- **Rules**: 1.4.4 Resize Text (AA) · 1.4.10 Reflow (AA) **[verify]**
- **Problem**: ≥901 px: `body[data-tab=studio]{height:100dvh;overflow:hidden}`, `.main-col{height:calc(100dvh-112px);overflow:hidden}`, metrics/footer `flex:none`, composer `overflow:hidden`. At 200 % zoom on 1920×1080 (≈960×540 CSS px) estimate: metrics wrap to ~250 px, leaving the gallery ≈100 px; composer footer (estimate + Generate + progress + Cancel + error + hint) can exceed the composer and clip. Hard to scroll away because the page itself is locked.
- **Fix**: raise the locked-layout breakpoint with a `min-height` media query, or let `.shell` scroll when height is short; keep Generate reachable.

### S13 · Mobile composer sheet is a modal in behaviour only
- **File**: `App.tsx:1436-1468, 890-923`; `index.css:679-724`
- **Rules**: 4.1.2 (A) · 2.4.3 (A) **[code]**
- **Problem**: ≤900 px the composer acts as a bottom-sheet modal (scroll lock, backdrop, hand-rolled Tab trap) but has no `role=dialog`/`aria-modal`/name binding when open and header/main stay in the a11y tree (virtual cursor leaves it). Custom trap selector omits `a[href]`, `[contenteditable]`, etc.
- **Fix**: same shared Dialog wrapper as S2, or `inert` the rest of the page while open.

## 4. Findings — Minor / advisory

| # | Finding | File | Rule | Note |
|---|---|---|---|---|
| M1 | Move/remove overlay buttons 20×20 and 22×22 on hover-capable pointers (coarse pointers get 28) | `index.css:315-326` | 2.5.8 AA [code] | gap 2 px → fails spacing exception |
| M2 | Sections nav is `<aside>`; composer sits outside `<main>` | `App.tsx:1390, 1436` | Landmarks | use `<nav aria-label>`; composer region reads as complementary |
| M3 | Triple brand announcement: logo `alt`, hidden `h1`, visible brand text | `App.tsx:1326, 1346-1355` | Duplicate announcements | logo `alt=""` |
| M4 | Card actions repeat identical names ("Delete image" ×N) | `App.tsx:227-274` | 2.5.3 / voice control | include prompt or index (References tab already does) |
| M5 | Card exposes prompt 3× (img `alt`, `aria-label`, snippet) | `App.tsx:195-215` | Duplicate announcements | alt `""` when text adjacent |
| M6 | Resolution toggle group unnamed; name reads "1K$0.045 / image" | `App.tsx:1568-1585` | 1.3.1 / 4.1.2 | `role=group aria-labelledby`, space before price |
| M7 | Header key button name = "•••••• Connected" (no purpose) | `App.tsx:1358-1370` | 2.4.6 | add visually-hidden "OpenRouter API key" |
| M8 | No `aria-busy`/status for skeleton or generation start; N identical `role=img "Image generating"` | `App.tsx:1946, 1299`; `DenoiseFrame.tsx:157-163` | 4.1.3 / best practice | one polite status "Generating N images" |
| M9 | Seed validation not tied to field; required Prompt not marked | `App.tsx:675-683, 1497` | 3.3.1 / 3.3.2 | `aria-invalid`, `aria-describedby`, `aria-required` |
| M10 | Ctrl/Cmd+Enter fires paid generation from anywhere (hint says "from the prompt") | `App.tsx:865-878, 1801` | 3.2.2 spirit | scope to composer |
| M11 | Bottom 30 px of composer scroller masked — focused control can sit in the fade | `index.css:761-762` | 2.4.11 AA [verify] | add scroll-padding-bottom |
| M12 | Toasts (z 200) cover the mobile peek bar | `index.css:519, 712-721` | 2.4.11 [verify] | offset toasts above peek bar |
| M13 | Text-input focus: `outline:none` wins by cascade over the global ring; indicator is a 1 px border colour change | `index.css:53-56 vs 211, 218, 550-554` | 2.4.7 AA [verify] | passes weakly; contradicts AGENTS.md "ring is global"; use `box-shadow` ring |
| M14 | Current section shown by subtle tint + colour only (AT gets `aria-current`) | `index.css:167-169` | 1.4.1 advisory | add bar/check |
| M15 | Disabled Generate shows live "Working… N %" at 3.68:1 | `index.css:386` | 1.4.3 exempt (inactive) [calc] | readability advisory |
| M16 | Alert dialogs lack `aria-describedby`; `body{user-select:none}` hampers copy/translate/magnifier tools; 10–11 px type; fixed control heights vs 1.4.12 text spacing | `App.tsx:2290-2411`; `index.css:39, 514, 450` | advisory | none are hard failures |

## 5. Verified-good (keep)

- `lang="en"`, descriptive `<title>`, viewport without `user-scalable=no` (1.4.4).
- One `<main>`, hidden `<h1>`, labelled regions; icons `aria-hidden` + `focusable=false`.
- Global `:focus-visible` ring on buttons/selects/checkbox; native UA ring on `[tabindex]` cards.
- `aria-pressed` toggles, `aria-expanded` on nav/menu, `aria-current`, labelled stepper/group, `role=alert` on errors, always-mounted polite toast region.
- Drag-and-drop has click/keyboard/paste alternative; reorder via buttons (2.5.7). Hover-only controls revealed on `:focus-within` and always visible on touch.
- Esc handling on confirm/backup/key dialogs; destructive actions default focus on Cancel.
- `prefers-reduced-motion` honoured in CSS and canvas loader.
- Palette: body/muted text 4.9–5.7:1, white-on-teal 5.24:1, danger-on-tint 5.91:1.
- Touch targets ≥28 px (desktop) / 34–44 px (mobile) for primary controls.
- Passphrase fields use `new-password`; paste not blocked (3.3.8).

## 6. Recommended order (when fixing is authorised)

1. **S1** GenCard structure + keydown guard. 2. **S2/S3/S13** shared Dialog primitive (trap, Esc layering, focus return, inert). 3. **S4/S11** skip target + route-change focus/title. 4. **S5, S8, S9, S10** semantics/live regions/menu/combobox. 5. **S6** token tweaks (borders, placeholder). 6. **S7** toast persistence. 7. **S12** short-height layout. 8. Minor table.

**Then fix the gate** (so regressions are caught): seed a test library or mock IndexedDB/fixtures; scan lightbox, viewer, each confirm dialog, key modal, backup dialog, open library menu, edit draft + combobox, open drawer, mobile sheet; add `wcag22aa` + `best-practice` tags; record `color-contrast` incomplete targets; add scripted keyboard checks (Tab trap, Esc, focus return). Re-run `npm run build` then `npm run a11y`, then manual NVDA + VoiceOver pass on: generate → open card → lightbox actions → delete.

## 7. Not verified

Everything tagged **[verify]**; all screen-reader/voice-control behaviour; real zoom/reflow; contrast of the two unresolved axe `color-contrast` incompletes; behaviour with a populated library. No code was changed and no commands that write files were run.
