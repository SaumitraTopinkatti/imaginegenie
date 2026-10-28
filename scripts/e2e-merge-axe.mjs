// Merge per-test axe files (a11y/states/<state>.<project>.json, written by
// scanState) into two outputs:
//  - a11y/axe-results.json: light only (desktop/mobile/reduced-motion/forced-colors),
//    one entry per state (desktop preferred, else first seen), existing shape
//    [{state, violations, violationsAllRules, incomplete}].
//  - a11y/axe-results-dark.json: every dark / dark-mobile file, one entry per
//    (state, project). Never picked against light, never dropped.
// Prints summary lines per group; exits non-zero on any unallowlisted violation
// in either group (dark has no color-contrast allowlist: contrast is enforced).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = join(ROOT, "a11y/states");

let files = [];
try {
  files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
} catch {
  console.error("merge-axe: no a11y/states/ files — run the e2e state suite first");
  process.exit(1);
}

const isDark = (project) => project.startsWith("dark");
const byState = new Map(); // light: state -> file (desktop preferred)
const darkEntries = []; // dark: one per file, no picking
const byFile = new Map();
for (const f of files) {
  const dot = f.lastIndexOf(".json");
  const base = f.slice(0, dot);
  const sep = base.lastIndexOf(".");
  const state = base.slice(0, sep);
  const project = base.slice(sep + 1);
  const parsed = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  byFile.set(f, { state, project, parsed });
  if (isDark(project)) {
    darkEntries.push({ state, project, parsed });
    continue;
  }
  const cur = byState.get(state);
  if (!cur || project === "desktop") byState.set(state, f);
}

const allowlist = JSON.parse(readFileSync(join(ROOT, "e2e/a11y/allowlist.json"), "utf8"));
const applicableFor = (state, project) =>
  new Set(
    allowlist
      .filter(
        (a) =>
          (!a.states || a.states.includes(state) || a.states.includes(`${state}.${project}`)) &&
          !(a.excludeProjects ?? []).includes(project)
      )
      .map((a) => a.id)
  );

// Count + print one group. Returns { states, viol, allowed, incompletes }.
function summarise(entries, tag) {
  let viol = 0;
  let allowed = 0;
  const incompletes = [];
  for (const s of entries) {
    const allow = applicableFor(s.state, s.project);
    const prefix = tag ? `[${tag}] ` : "";
    for (const v of [...s.violations, ...s.violationsAllRules]) {
      if (allow.has(v.id)) {
        allowed += 1;
        console.log(`${prefix}${s.state}: allowlisted ${v.id} x${v.nodesCount}`);
      } else {
        viol += 1;
        console.log(`${prefix}${s.state}: UNALLOWLISTED ${v.id} (${v.impact}) x${v.nodesCount} — ${v.help}`);
      }
    }
    for (const i of s.incomplete) incompletes.push(`${s.state}:${i.id}x${i.nodesCount}`);
  }
  return { states: entries.length, viol, allowed, incompletes };
}

// Light
const light = [...byState.entries()].map(([state, f]) => {
  const { project, parsed: r } = byFile.get(f);
  return {
    state,
    project,
    violations: r.violations ?? [],
    violationsAllRules: r.violationsAllRules ?? [],
    incomplete: r.incomplete ?? [],
  };
});
mkdirSync(join(ROOT, "a11y"), { recursive: true });
writeFileSync(
  join(ROOT, "a11y/axe-results.json"),
  JSON.stringify(light.map(({ state, violations, violationsAllRules, incomplete }) => ({ state, violations, violationsAllRules, incomplete })), null, 2)
);
const L = summarise(light, "");
console.log(
  `merge-axe: ${light.length} states, ${L.viol} unallowlisted violations (${L.allowed} allowlisted), incompletes: ${L.incompletes.join(", ") || "none"}`
);
console.log("Wrote a11y/axe-results.json");

// Dark (per project: dark, dark-mobile)
const dark = darkEntries.map(({ state, project, parsed: r }) => ({
  state,
  project,
  violations: r.violations ?? [],
  violationsAllRules: r.violationsAllRules ?? [],
  incomplete: r.incomplete ?? [],
}));
writeFileSync(
  join(ROOT, "a11y/axe-results-dark.json"),
  JSON.stringify(dark.map(({ state, project, violations, violationsAllRules, incomplete }) => ({ state, project, violations, violationsAllRules, incomplete })), null, 2)
);
let darkViol = 0;
if (dark.length === 0) {
  console.error("merge-axe: no dark states found (dark / dark-mobile projects did not run)");
  darkViol = 1;
}
for (const proj of ["dark", "dark-mobile"]) {
  const entries = dark.filter((d) => d.project === proj);
  if (entries.length === 0) continue;
  const D = summarise(entries, proj);
  darkViol += D.viol;
  console.log(
    `${proj}: ${D.states} states, ${D.viol} violations (${D.allowed} allowlisted), incompletes: ${D.incompletes.join(", ") || "none"}`
  );
}
console.log("Wrote a11y/axe-results-dark.json");

process.exit(L.viol > 0 || darkViol > 0 ? 1 : 0);
