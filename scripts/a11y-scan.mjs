import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const URL = "http://127.0.0.1:4173/";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

function slim(violations) {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodesCount: v.nodes.length,
    help: v.help,
    helpUrl: v.helpUrl,
    sampleTargets: v.nodes.slice(0, 3).map((n) => n.target),
  }));
}

async function scanState(page, state) {
  const tagged = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const full = await new AxeBuilder({ page }).analyze();
  console.log(
    `[${state}] tagged(wcag2a/aa+21a/aa) violations: ${tagged.violations.length}, all-default-rules violations: ${full.violations.length}, incomplete: ${full.incomplete.length}`
  );
  return {
    state,
    violations: slim(tagged.violations),
    violationsAllRules: slim(full.violations),
    incomplete: full.incomplete.map((v) => ({ id: v.id, nodesCount: v.nodes.length })),
  };
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(URL, { waitUntil: "networkidle" });
await page.locator("body").waitFor();

const out = [];

// State 1: composer (initial load)
out.push(await scanState(page, "composer"));

// State 2: references tab (open drawer, switch, scan, switch back)
try {
  await page.getByRole("button", { name: /sections menu/i }).click();
  await page.getByRole("button", { name: /^References/ }).click();
  await page.locator(".refs-panel").waitFor({ timeout: 5000 });
  out.push(await scanState(page, "references"));
  await page.getByRole("button", { name: /sections menu/i }).click();
  await page.getByRole("button", { name: /^Studio/ }).click();
  await page.locator("#gallery").waitFor({ timeout: 5000 });
} catch (e) {
  console.log(`[references] not reachable (${e.message?.split("\n")[0]}) — skipped`);
  out.push({ state: "references", skipped: true, reason: e.message });
}

// State 3: gallery (if cards exist; else still scan same DOM as gallery state)
try {
  await page.locator(".card").first().waitFor({ timeout: 5000 });
  out.push(await scanState(page, "gallery"));
} catch {
  console.log("[gallery] no .card nodes found — scanning current DOM as gallery");
  out.push(await scanState(page, "gallery"));
}

// State 3: lightbox (click first card, wait for overlay)
try {
  const card = page.locator(".card").first();
  await card.waitFor({ timeout: 5000 });
  await card.click();
  await page.locator(".overlay").waitFor({ timeout: 5000 });
  out.push(await scanState(page, "lightbox"));
} catch (e) {
  console.log(`[lightbox] not reachable (${e.message?.split("\n")[0]}) — skipped`);
  out.push({ state: "lightbox", skipped: true, reason: "no gallery cards (empty library, fresh profile)" });
}

await browser.close();
mkdirSync("a11y", { recursive: true });
writeFileSync("a11y/axe-results.json", JSON.stringify(out, null, 2));
console.log("Wrote a11y/axe-results.json");
for (const s of out) {
  for (const v of [...(s.violations ?? []), ...(s.violationsAllRules ?? [])]) {
    console.log(`${s.state}: ${v.id} (${v.impact}) x${v.nodesCount} — ${v.help}`);
  }
  if (s.incomplete?.length) {
    console.log(`${s.state} incomplete: ${s.incomplete.map((i) => `${i.id} x${i.nodesCount}`).join(", ")}`);
  }
}
