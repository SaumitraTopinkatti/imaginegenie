import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import waitOn from "wait-on";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 4173;
const URL = `http://127.0.0.1:${PORT}/`;

const preview = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  { cwd: ROOT, stdio: "ignore", windowsHide: true }
);

let exitCode = 0;
try {
  await waitOn({ resources: [URL], timeout: 30000 });
  console.log(`preview up at ${URL}`);
  await new Promise((resolve, reject) => {
    const scan = spawn(process.execPath, ["scripts/a11y-scan.mjs"], { cwd: ROOT, stdio: "inherit" });
    scan.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`a11y-scan exited ${code}`))
    );
  });
  const results = JSON.parse(readFileSync(join(ROOT, "a11y/axe-results.json"), "utf8"));
  let blocking = 0;
  for (const s of results) {
    for (const v of [...(s.violations ?? []), ...(s.violationsAllRules ?? [])]) {
      if (v.impact === "serious" || v.impact === "critical") blocking += 1;
    }
  }
  console.log(`blocking (serious+critical) findings: ${blocking}`);
  exitCode = blocking > 0 ? 1 : 0;
} catch (e) {
  console.error(`a11y-check failed: ${e.message}`);
  exitCode = 1;
} finally {
  preview.kill();
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(preview.pid), "/T", "/F"], { stdio: "ignore" });
    await new Promise((r) => killer.on("close", r));
  }
}
process.exit(exitCode);
