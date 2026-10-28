// Shared e2e fixtures + contract helpers. Roles/names only — no test ids.
import { test as base, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { InpaintMeta } from "../src/lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
export const MOCK_PORT = process.env.E2E_MOCK_PORT || "4191";
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

interface AllowEntry {
  id: string;
  reason: string;
  /** Scopes the entry: "state" or "state.project". Absent = all states. */
  states?: string[];
  /** Projects this entry never applies to (e.g. dark: contrast is enforced). */
  excludeProjects?: string[];
}
const SHOT_PROJECTS = ["desktop", "mobile", "dark", "dark-mobile"];
const ALLOWLIST: AllowEntry[] = JSON.parse(
  readFileSync(join(HERE, "a11y/allowlist.json"), "utf8")
);

async function mockFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${MOCK_BASE}${path}`, init);
  if (!res.ok) throw new Error(`mock-api ${path} -> ${res.status}`);
  return res.json();
}

export const mockApi = {
  scenario: (scenario: string) =>
    mockFetch("/__mock/scenario", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario }),
    }),
  reset: () => mockFetch("/__mock/reset", { method: "POST" }),
  requests: (): Promise<{ requests: MockRequest[] }> => mockFetch("/__mock/requests"),
  clear: () => mockFetch("/__mock/requests", { method: "DELETE" }),
};

export interface MockRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  scenario: string;
  via: string;
  keyKind: string;
  ts: number;
  aborted: boolean;
}

/** Unique prompt marker per test: parallel-safe request-log filtering. */
export function marker(tag: string) {
  return `e2e-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

export async function loggedWithPrompt(promptPart: string): Promise<MockRequest[]> {
  const { requests } = await mockApi.requests();
  return requests.filter(
    (r) => typeof (r.body as { prompt?: unknown })?.prompt === "string" && (r.body as { prompt: string }).prompt.includes(promptPart)
  );
}

type AppFixtures = {
  /** Fresh isolated page: guard installed, store reset, mock log cleared. */
  app: Page;
  guardHits: string[];
};

export const test = base.extend<AppFixtures>({
  guardHits: async ({}, use) => {
    await use([]);
  },
  app: async ({ browser, guardHits }, use) => {
    const context = await browser.newContext();
    await context.route("**://openrouter.ai/**", (route) => {
      guardHits.push(route.request().url());
      void route.abort();
    });
    const page = await context.newPage();
    await page.goto("/");
    await page.locator("body").waitFor();
    // Store reset only. The mock server is shared across parallel workers:
    // tests self-scope via unique prompt markers, never via global reset.
    await page.evaluate(() => window.__e2e__?.reset());
    await use(page);
    // Loud failure if anything ever left loopback for the real provider.
    expect(guardHits, `real openrouter.ai requests escaped: ${guardHits.join(", ")}`).toEqual([]);
    await context.close();
  },
});

export { expect };

/* ---------- seeding ---------- */

export interface SeedOpts {
  records?: Array<{
    prompt: string;
    aspectRatio?: string;
    resolution?: string;
    cost?: number;
    mediaType?: string;
    refCount?: number;
    imageUrl?: string;
    refImageUrls?: string[];
    model?: string;
    inpaint?: InpaintMeta;
  }>;
  references?: Array<{ name?: string; description?: string; group?: string; imageUrl?: string }>;
}

export async function seedLibrary(page: Page, opts: SeedOpts) {
  const ids = await page.evaluate((o) => window.__e2e__!.seed(o), opts);
  return ids as { recordIds: string[]; referenceIds: string[] };
}

/** Close the mobile Inpaint sheet if open (backdrop would cover the menu). */
export async function closeInpaintControls(page: Page) {
  const dlg = page.getByRole("dialog", { name: "Inpaint controls" });
  if (await dlg.isVisible()) {
    await page.keyboard.press("Escape");
    // Closing slides down over ~0.36s: still "visible" right after Esc.
    await expect(dlg).toBeHidden();
  }
}

/**
 * Open the mobile Inpaint sheet via its peek bar. No-op on desktop (the
 * peek bar is display:none there) and when already open.
 */
export async function ensureInpaintControlsOpen(page: Page) {
  const dlg = page.getByRole("dialog", { name: "Inpaint controls" });
  if (await dlg.isVisible()) return;
  const peek = page.locator("#inpaint-main").getByRole("button", { name: /tap to expand/i });
  if (await peek.isVisible()) {
    await peek.click();
    await expect(dlg).toBeVisible();
  }
}

/**
 * Open the Inpaint source picker through the sheet's Choose/Change button
 * (DOM-first, so the hidden in-sheet copy never wins on mobile).
 */
export async function openSourcePicker(page: Page) {
  await ensureInpaintControlsOpen(page);
  await page.getByRole("button", { name: /Choose image|Change image/ }).first().click();
  await expect(page.getByRole("dialog", { name: "Choose image" })).toBeVisible();
}

/** openSourcePicker + take the first generation, waiting for the editor. */
export async function pickFirstGeneration(page: Page) {
  await openSourcePicker(page);
  await page.getByRole("button", { name: /^Use image:/ }).first().click();
  await expect(page.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
}

export async function gotoTab(page: Page, tab: "studio" | "refs" | "inpaint") {
  // A open mobile sheet + backdrop would intercept the menu: close it first.
  if (await page.getByRole("dialog", { name: "Image composer" }).isVisible()) {
    await page.keyboard.press("Escape");
  }
  await closeInpaintControls(page);
  if (tab === "refs") {
    await page.getByRole("button", { name: /sections menu/i }).click();
    await page.getByRole("link", { name: /^References/ }).click();
    await page.locator("#ref-library").waitFor({ timeout: 8000 });
  } else if (tab === "inpaint") {
    await page.getByRole("button", { name: /sections menu/i }).click();
    await page.getByRole("link", { name: /^Inpaint/ }).click();
    await page.locator("#inpaint-main").waitFor({ timeout: 8000 });
  } else {
    const menu = page.getByRole("button", { name: /sections menu/i });
    if (await menu.isVisible()) {
      await menu.click();
      await page.getByRole("link", { name: /^Studio/ }).click();
    }
    await page.locator("#gallery").waitFor({ timeout: 8000 });
  }
}

export async function fillKey(page: Page, key: string) {
  // The open sheet's backdrop covers the header: close it first (no-op
  // anywhere the Inpaint sheet doesn't exist).
  await closeInpaintControls(page);
  await page.getByRole("button", { name: /OpenRouter API key/ }).click();
  await page.getByRole("textbox", { name: "OpenRouter API key" }).fill(key);
  // Remember + close: the working copy is dropped on modal close unless
  // remembered, and the open modal blocks the composer behind it.
  await page.getByText("Remember on this device (encrypted)").click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "OpenRouter API key" })).toBeHidden();
}

export async function openKeyModal(page: Page) {
  await page.getByRole("button", { name: /OpenRouter API key/ }).click();
  await expect(page.getByRole("dialog", { name: "OpenRouter API key" })).toBeVisible();
}

/** Mobile renders the composer as a closed bottom sheet: open it if needed. */
export async function ensureComposerOpen(page: Page) {
  const peek = page.getByRole("button", { name: /tap to expand/i });
  if (await peek.isVisible()) {
    await peek.click();
    await expect(page.getByRole("dialog", { name: "Image composer" })).toBeVisible();
  }
}

/**
 * Wait out the staggered reveal (~1.1 s: loader exit -> fade-in -> merge).
 * Scanning mid-fade catches text at partial opacity and reports a contrast
 * failure that no user ever rests on; the settled card is the truthful state.
 */
export async function awaitRevealSettled(page: Page) {
  await expect(page.locator(".reveal")).toHaveCount(0, { timeout: 15000 });
  // `.reveal` reads 0 before the solo hero's reveal even starts; its loader
  // caption fades out (0.3s) until the slot merges. Wait that out too.
  await expect(page.locator(".gen-caption.fading")).toHaveCount(0, { timeout: 15000 });
}

/**
 * Paint one stroke across the inpaint mask canvas. Mouse drag on fine
 * pointers; a tap (exercises the touch dab path) on coarse pointers.
 */
export async function paintStroke(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 8
) {
  // Paints land on raw coordinates: close the sheet first (open, its
  // backdrop swallows taps; closed, its peek bar can catch low ones).
  await closeInpaintControls(page);
  // The sticky header can cover a scrolled-under canvas top: centre it first,
  // then measure fresh (boundingBox is viewport-relative).
  await page.locator(".mask-overlay").evaluate((el) => el.scrollIntoView({ block: "center" }));
  let box = await page.locator(".mask-overlay").boundingBox();
  if (!box) throw new Error("mask canvas not visible");
  const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
  if (coarse) {
    // A tap low on the canvas can land on the fixed peek bar and open the
    // sheet instead of painting: lift the canvas clear, then re-measure.
    const peekBox = await page.locator("#inpaint-main .peek-bar").boundingBox();
    const pts: Array<[number, number]> = [
      [from.x, from.y],
      [(from.x + to.x) / 2, (from.y + to.y) / 2],
      [to.x, to.y],
    ];
    if (peekBox && pts.some(([fx, fy]) => box!.x + box!.width * fx >= peekBox.x - 4 && box!.y + box!.height * fy >= peekBox.y - 4)) {
      await page.locator(".mask-overlay").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.evaluate(() => window.scrollBy(0, -70));
      box = await page.locator(".mask-overlay").boundingBox();
      if (!box) throw new Error("mask canvas not visible");
    }
  }
  const px = (fx: number) => box.x + box.width * fx;
  const py = (fy: number) => box.y + box.height * fy;
  if (coarse) {
    // Touch taps stamp dabs (single-pointer path): endpoints + midpoint.
    await page.touchscreen.tap(px(from.x), py(from.y));
    await page.touchscreen.tap(px((from.x + to.x) / 2), py((from.y + to.y) / 2));
    await page.touchscreen.tap(px(to.x), py(to.y));
    return;
  }
  await page.mouse.move(px(from.x), py(from.y));
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(px(from.x + ((to.x - from.x) * i) / steps), py(from.y + ((to.y - from.y) * i) / steps));
  }
  await page.mouse.up();
}

/* ---------- dialog contract (all 10 Dialogs) ---------- */

export interface DialogContract {
  /** Opens the dialog (already focused opener preferred). */
  open: () => Promise<void>;
  dialogName: string | RegExp;
  role?: "dialog" | "alertdialog";
  /** After Esc: opener regains focus, or this landing target does. */
  returnTo?: string | RegExp;
}

export async function assertDialogContract(page: Page, c: DialogContract) {
  const role = c.role ?? "dialog";
  const dialog = page.getByRole(role, { name: c.dialogName });
  await c.open();
  await expect(dialog).toBeVisible();

  // Focus moves in and #root goes inert.
  const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
  expect(inside, `${c.dialogName}: focus moves into dialog`).toBe(true);
  expect(await page.evaluate(() => (document.getElementById("root") as unknown as { inert?: boolean }).inert))
    .toBe(true);

  // Tab/Shift+Tab wrap and never reach #root.
  const panel = dialog;
  const count = await panel.evaluate((el) =>
    el.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ).length
  );
  for (let i = 0; i < count + 2; i++) {
    await page.keyboard.press("Tab");
    const ok = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(ok, `${c.dialogName}: Tab stays inside (step ${i})`).toBe(true);
  }
  for (let i = 0; i < count + 2; i++) {
    await page.keyboard.press("Shift+Tab");
    const ok = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(ok, `${c.dialogName}: Shift+Tab stays inside (step ${i})`).toBe(true);
  }

  // Esc closes only this layer and returns focus.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  if (c.returnTo) {
    await expect(page.getByRole("button", { name: c.returnTo }).first()).toBeFocused();
  }
}

/** Open a second dialog over the first; Esc must close only the topmost. */
export async function assertLayeredEsc(
  page: Page,
  bottom: { role?: "dialog" | "alertdialog"; name: string },
  top: { role?: "dialog" | "alertdialog"; name: string },
  openTop: () => Promise<void>
) {
  const b = page.getByRole(bottom.role ?? "dialog", { name: bottom.name });
  const t = page.getByRole(top.role ?? "dialog", { name: top.name });
  await expect(b).toBeVisible();
  await openTop();
  await expect(t).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(t).toBeHidden();
  await expect(b).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(b).toBeHidden();
}

/* ---------- shot capture (visual review, env-gated) ---------- */

// Best-effort viewport screenshot for human/model visual review. Runs only
// when E2E_SHOTS_RUN is set (by scripts/e2e-shots.mjs) on desktop/mobile
// and their dark variants. Never throws: capture failure must not fail the a11y test.
export async function captureShot(page: Page, state: string): Promise<void> {
  const runId = process.env.E2E_SHOTS_RUN;
  if (!runId) return;
  const project = test.info().project.name.replace(/[^a-z0-9-]+/gi, "-");
  if (!SHOT_PROJECTS.includes(project)) return;
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(ROOT, "a11y/shots");
    mkdirSync(dir, { recursive: true });
    try {
      await page.evaluate(() => Promise.race([
        document.fonts.ready,
        new Promise((r) => setTimeout(r, 3000)),
      ]));
    } catch { /* font wait is advisory */ }
    const [viewport, path, fontLoaded] = await Promise.all([
      page.viewportSize(),
      page.evaluate(() => location.pathname + location.search),
      page.evaluate(() => {
        try {
          return document.fonts.check('italic 16px "Instrument Serif"');
        } catch {
          return false;
        }
      }),
    ]);
    const shot = join(dir, `${state}.${project}.png`);
    await page.screenshot({ path: shot, fullPage: false, scale: "css" });
    writeFileSync(
      join(dir, `${state}.${project}.meta.json`),
      JSON.stringify({
        runId, state, project, viewport, path, fontLoaded,
        capturedAt: new Date().toISOString(),
      }, null, 2)
    );
  } catch (e) {
    console.warn(`${state}: shot capture failed — ${String(e)}`);
  }
}

/* ---------- axe state scan ---------- */

export interface AxeStateResult {
  state: string;
  violations: unknown[];
  violationsAllRules: unknown[];
  incomplete: unknown[];
}

function slim(violations: Array<{ id: string; impact?: string | null; nodes: Array<{ target: unknown }>; help: string; helpUrl: string }>) {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodesCount: v.nodes.length,
    help: v.help,
    helpUrl: v.helpUrl,
    sampleTargets: v.nodes.slice(0, 3).map((n) => n.target),
  }));
}

export async function scanState(page: Page, state: string): Promise<AxeStateResult> {
  await captureShot(page, state);
  const tagged = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const full = await new AxeBuilder({ page }).analyze();
  const project = test.info().project.name.replace(/[^a-z0-9-]+/gi, "-");
  const applicable = ALLOWLIST.filter(
    (a) =>
      (!a.states || a.states.includes(state) || a.states.includes(`${state}.${project}`)) &&
      !(a.excludeProjects ?? []).includes(project)
  );
  const allowed = new Set(applicable.map((a) => a.id));
  const blocking = [...tagged.violations, ...full.violations].filter((v) => !allowed.has(v.id));
  for (const v of blocking) {
    console.log(`${state}: ${v.id} (${v.impact}) x${v.nodes.length} — ${v.help}`);
  }
  expect(blocking, `${state}: axe violations (allowlisted: ${[...allowed].join(",") || "none"})`).toEqual([]);
  const result: AxeStateResult = {
    state,
    violations: slim(tagged.violations),
    violationsAllRules: slim(full.violations),
    incomplete: full.incomplete.map((v) => ({
      id: v.id,
      nodesCount: v.nodes.length,
      sampleTargets: v.nodes.slice(0, 3).map((n) => n.target),
    })),
  };
  // Per-test file: unique per (state, project), so parallel workers never race.
  // scripts/e2e-merge-axe.mjs folds these into a11y/axe-results.json.
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(ROOT, "a11y/states"), { recursive: true });
  writeFileSync(join(ROOT, "a11y/states", `${state}.${project}.json`), JSON.stringify(result, null, 2));
  console.log(
    `[${state}] violations: ${tagged.violations.length}, all-rules: ${full.violations.length}, incomplete: ${full.incomplete.map((v) => `${v.id}x${v.nodes.length}`).join(",") || "none"}`
  );
  return result;
}
