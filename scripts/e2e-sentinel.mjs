// Sentinel: mock code + __e2e__ hook must be PRESENT in dist-e2e/ and
// ABSENT from the production dist/. Fails loudly either way.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PRESENT = ["__e2e__", "IMAGINEGENIE_E2E_MOCK"];

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...jsFiles(p));
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

function hits(dir) {
  const found = new Set();
  for (const f of jsFiles(dir)) {
    const src = readFileSync(f, "utf8");
    for (const s of PRESENT) if (src.includes(s)) found.add(s);
  }
  return found;
}

let failed = false;
for (const [dir, want] of [[join(ROOT, "dist-e2e"), true], [join(ROOT, "dist"), false]]) {
  let found;
  try {
    found = hits(dir);
  } catch {
    console.error(`sentinel: ${dir} missing — run the corresponding build first`);
    failed = true;
    continue;
  }
  for (const s of PRESENT) {
    const has = found.has(s);
    console.log(`sentinel: ${dir} ${has ? "contains" : "clean"} ${s}`);
    if (has !== want) {
      console.error(
        want
          ? `FAIL: e2e wiring missing in dist-e2e (${s} not found)`
          : `FAIL: mock/hook leaked into production dist/ (${s} found)`
      );
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
