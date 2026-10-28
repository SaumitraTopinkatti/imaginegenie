// Screenshot run orchestrator: wipe a11y/shots/, run the state suite with
// E2E_SHOTS_RUN set (capture hook in e2e/fixtures.ts), then write an ordered
// manifest.json + contact sheet. Never gates: exits with Playwright's code.
// Usage: node scripts/e2e-shots.mjs [-- <playwright args, e.g. -g inpaint>]
import { spawnSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "a11y/shots");

// Review order: [group, state, scenario]. Unknown states append as unordered.
const ORDER = [
  ["studio-empty", "composer-empty", "empty library, desktop composer visible"],
  ["composer-open", "composer-filled", "prompt + seed 42 + count 2 set"],
  ["composer-open", "mobile-sheet-open", "mobile composer sheet open"],
  ["generating", "generating", "mid-flight loader with Cancel"],
  ["gallery", "gallery-populated", "4 seeded cards, mixed aspects"],
  ["gallery", "toast-ok", "settled success toast + new card"],
  ["gallery", "lib-menu-open", "Library menu open"],
  ["lightbox", "lightbox", "Generation details dialog"],
  ["lightbox", "lightbox-with-refs", "details with 2 reference thumbs"],
  ["viewer", "viewer-over-lightbox", "fullscreen reference viewer"],
  ["refs", "refs-empty", "No references yet empty state"],
  ["refs", "refs-populated", "3 seeded reference cards"],
  ["refs", "refs-edit-combobox", "edit draft with group listbox open"],
  ["inpaint", "inpaint-empty", "desktop inpaint landing, no source"],
  ["inpaint", "inpaint-picker-open", "Choose image picker open"],
  ["inpaint", "inpaint-sheet-open", "mobile inpaint controls sheet open"],
  ["inpaint", "inpaint-editing", "source loaded, one stroke painted"],
  ["inpaint", "inpaint-result", "After result rendered"],
  ["dialogs", "drawer-open", "Sections nav drawer open"],
  ["dialogs", "delete-confirm", "delete generation alertdialog"],
  ["dialogs", "clear-step1", "clear library step 1"],
  ["dialogs", "clear-step2", "clear library DELETE typed step"],
  ["dialogs", "key-empty", "empty API key dialog"],
  ["dialogs", "key-ok", "key Test accepted status"],
  ["dialogs", "backup-export", "backup export with passphrases"],
  ["dialogs", "backup-restore", "restore backup passphrase prompt"],
  ["dialogs", "backup-legacy", "old backup restore prompt"],
  ["dialogs", "refs-delete-dialog", "delete reference alertdialog"],
  ["dialogs", "refs-clear-dialog", "clear references alertdialog"],
  ["errors", "composer-error", "Generate without key error"],
  ["errors", "key-err", "key Test rejected alert"],
  ["errors", "backup-wrong-pass", "wrong passphrase alert"],
  ["errors", "degraded-banner", "encryption unavailable banner"],
  ["errors", "unreadable-bar", "undecryptable row bar"],
  ["errors", "toast-err-sticky", "settled partial-failure sticky toast"],
];
const orderIndex = new Map(ORDER.map(([g, s], i) => [s, i]));
const scenarioOf = new Map(ORDER.map(([g, s, sc]) => [s, sc]));
const groupOf = new Map(ORDER.map(([g, s]) => [s, g]));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(36).slice(2, 7);
const startedAt = new Date().toISOString();
let head = "";
let dirty = null;
try {
  head = execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim();
  dirty = execSync("git status --porcelain", { cwd: ROOT, encoding: "utf8" }).trim() !== "";
} catch { /* read-only git info, allowed to fail */ }

const passthrough = process.argv.slice(2);
const args = ["e2e/a11y/states.spec.ts", "--project=desktop", "--project=mobile", "--project=dark", "--project=dark-mobile", ...passthrough];
console.log(`e2e-shots: run ${runId} — playwright test ${args.join(" ")}`);
const pw = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", ...args], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, E2E_SHOTS_RUN: runId },
});
const playwrightExit = pw.status ?? 1;

// Finish step: always runs. Keep only current-run metas with a PNG present.
const metas = [];
const unordered = [];
try {
  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".meta.json"))) {
    let m;
    try {
      m = JSON.parse(readFileSync(join(DIR, f), "utf8"));
    } catch {
      console.warn(`e2e-shots: unreadable sidecar ${f}`);
      continue;
    }
    if (m.runId !== runId) {
      console.warn(`e2e-shots: orphan sidecar ${f} (run ${m.runId ?? "?"})`);
      continue;
    }
    const png = `${m.state}.${m.project}.png`;
    if (!existsSync(join(DIR, png))) {
      console.warn(`e2e-shots: missing PNG for ${f}`);
      continue;
    }
    metas.push(m);
  }
} catch { /* empty dir */ }

const PROJECT_RANK = { desktop: 0, mobile: 1, dark: 2, "dark-mobile": 3 };
metas.sort((a, b) => {
  const ia = orderIndex.has(a.state) ? orderIndex.get(a.state) : 1e9;
  const ib = orderIndex.has(b.state) ? orderIndex.get(b.state) : 1e9;
  if (ia !== ib) return ia - ib;
  const pa = PROJECT_RANK[a.project] ?? 9;
  const pb = PROJECT_RANK[b.project] ?? 9;
  if (pa !== pb) return pa - pb;
  return 0;
});
for (const m of metas) {
  if (!orderIndex.has(m.state)) unordered.push(`${m.state}.${m.project}`);
}
if (unordered.length) console.warn(`e2e-shots: unordered states: ${unordered.join(", ")}`);

const shots = metas.map((m, i) => ({
  order: i + 1,
  group: groupOf.get(m.state) ?? "unordered",
  state: m.state,
  project: m.project,
  viewport: m.viewport,
  scenario: scenarioOf.get(m.state) ?? "",
  fontLoaded: m.fontLoaded,
  file: join(DIR, `${m.state}.${m.project}.png`),
}));
const manifest = {
  runId, startedAt, finishedAt: new Date().toISOString(),
  head, dirty, playwrightExit, shots,
};
writeFileSync(join(DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

// Contact sheet: groups in ORDER; per state: desktop, mobile, dark, dark-mobile.
let lastGroup = "";
let cards = "";
for (const s of shots) {
  if (s.group !== lastGroup) {
    cards += `<h2>${esc(s.group)}</h2>\n`;
    lastGroup = s.group;
  }
  const rel = `${s.state}.${s.project}.png`;
  const vp = s.viewport ? `${s.viewport.width}x${s.viewport.height}` : s.project;
  cards += `<figure><img src="${esc(rel)}" alt="${esc(s.state + " " + s.project)}" loading="lazy">`
    + `<figcaption>${esc(s.state)} · ${esc(s.project)} ${esc(vp)}${s.fontLoaded === false ? " · fallback font" : ""}<br>${esc(s.scenario)}<br><code>${esc(s.file)}</code></figcaption></figure>\n`;
}
if (unordered.length) cards += `<p class="warn">Unordered: ${esc(unordered.join(", "))}</p>\n`;
writeFileSync(join(DIR, "index.html"), `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>shots ${esc(runId)}</title>
<style>body{background:#F5F4EF;font-family:system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:24px}h1,h2{color:#0A7A6B}figure{background:#fff;border:1px solid #DEDDD5;border-radius:12px;padding:12px;margin:0 0 16px}img{max-width:100%;border:1px solid #DEDDD5;border-radius:8px}figcaption{font-size:13px;margin-top:8px}code{font-size:11px;user-select:text}.warn{color:#9a3412}header{border-bottom:2px solid #0A7A6B;margin-bottom:16px}</style>
</head><body><header><h1>Visual review — ${esc(runId)}</h1>
<p>HEAD ${esc(head)}${dirty === true ? " (dirty)" : dirty === false ? " (clean)" : ""} · ${esc(startedAt)} · ${shots.length} shots${playwrightExit !== 0 ? ' · <span class="warn">PARTIAL RUN (playwright exit ' + playwrightExit + ")</span>" : ""}</p></header>
${cards}</body></html>\n`);

const byGroup = {};
const byProject = {};
for (const s of shots) {
  byGroup[s.group] = (byGroup[s.group] ?? 0) + 1;
  byProject[s.project] = (byProject[s.project] ?? 0) + 1;
}
console.log(`e2e-shots: ${shots.length} shots (${Object.entries(byProject).map(([k, v]) => `${k} ${v}`).join(", ")})`);
for (const [g, n] of Object.entries(byGroup)) console.log(`  ${g}: ${n}`);
for (const s of shots) console.log(`  ${s.file}`);
console.log("Wrote a11y/shots/manifest.json + index.html");
process.exit(playwrightExit);
