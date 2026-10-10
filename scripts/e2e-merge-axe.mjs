// Merge per-test axe files (a11y/states/<state>.<project>.json, written by
// scanState) into a11y/axe-results.json in the existing shape:
// [{state, violations, violationsAllRules, incomplete}].
// One entry per state (desktop preferred, else first seen). Prints summary
// counts; exits non-zero on any recorded violation.
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

const byState = new Map();
const byFile = new Map();
for (const f of files) {
  const dot = f.lastIndexOf(".json");
  const base = f.slice(0, dot);
  const sep = base.lastIndexOf(".");
  const state = base.slice(0, sep);
  const project = base.slice(sep + 1);
  const cur = byState.get(state);
  const parsed = JSON.parse(readFileSync(join(DIR, f), "utf8"));
  byFile.set(f, { state, project, parsed });
  if (!cur || project === "desktop") byState.set(state, f);
}

const allowlist = JSON.parse(readFileSync(join(ROOT, "e2e/a11y/allowlist.json"), "utf8"));
const applicableFor = (state, project) =>
  new Set(
    allowlist
      .filter((a) => !a.states || a.states.includes(state) || a.states.includes(`${state}.${project}`))
      .map((a) => a.id)
  );

const out = [...byState.entries()].map(([state, f]) => {
  const { project, parsed: r } = byFile.get(f);
  return {
    state,
    violations: r.violations ?? [],
    violationsAllRules: r.violationsAllRules ?? [],
    incomplete: r.incomplete ?? [],
    _project: project,
  };
});
mkdirSync(join(ROOT, "a11y"), { recursive: true });
writeFileSync(join(ROOT, "a11y/axe-results.json"), JSON.stringify(out, null, 2));

let viol = 0;
let allowed = 0;
let incompletes = [];
for (const s of out) {
  const allow = applicableFor(s.state, s._project);
  for (const v of [...s.violations, ...s.violationsAllRules]) {
    if (allow.has(v.id)) {
      allowed += 1;
      console.log(`${s.state}: allowlisted ${v.id} x${v.nodesCount}`);
    } else {
      viol += 1;
      console.log(`${s.state}: UNALLOWLISTED ${v.id} (${v.impact}) x${v.nodesCount} — ${v.help}`);
    }
  }
  delete s._project;
  for (const i of s.incomplete ?? []) incompletes.push(`${s.state}:${i.id}x${i.nodesCount}`);
}
console.log(`merge-axe: ${out.length} states, ${viol} unallowlisted violations (${allowed} allowlisted), incompletes: ${incompletes.join(", ") || "none"}`);
console.log("Wrote a11y/axe-results.json");
process.exit(viol > 0 ? 1 : 0);
