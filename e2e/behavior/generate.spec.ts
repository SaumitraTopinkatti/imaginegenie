// Generation behavior against the mock API. Each test uses a unique prompt
// marker and filters the shared request log by it (parallel-safe).
import type { Page } from "@playwright/test";
import { test, expect, fillKey, seedLibrary, ensureComposerOpen, loggedWithPrompt, marker } from "../fixtures";

async function generate(app: Page, prompt: string) {
  await ensureComposerOpen(app);
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
  await app.getByRole("button", { name: /Generate/ }).click();
}

test("success single: request shape + card", async ({ app }) => {
  const m = marker("ok1");
  await fillKey(app, "sk-or-test-ok");
  await ensureComposerOpen(app);
  await app.getByLabel("Seed (optional)").fill("7");
  await generate(app, `single success ${m}`);
  await expect(app.locator(".toasts").getByText("Image ready")).toBeVisible({ timeout: 15000 });
  await expect(app.locator("#gallery .card")).toHaveCount(1);
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  const b = reqs[0].body as Record<string, unknown>;
  expect(b.n).toBe(1);
  expect(b.model).toBe("bytedance-seed/seedream-5-0-pro");
  expect(b.resolution).toBe("1K");
  expect(b.aspect_ratio).toBe("auto");
  expect(b.seed).toBe(7);
  expect(reqs[0].keyKind).toBe("sk-or-test-ok");
  expect(reqs[0].headers.authorization).toBeUndefined();
});

test("count 4 fans out four n:1 calls", async ({ app }) => {
  const m = marker("fan4");
  await fillKey(app, "sk-or-test-ok");
  await ensureComposerOpen(app);
  for (let i = 0; i < 3; i++) await app.getByRole("button", { name: "More images" }).click();
  await generate(app, `fan out ${m}`);
  await expect(app.locator("#gallery .card")).toHaveCount(4, { timeout: 20000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(4);
  for (const r of reqs) expect((r.body as Record<string, unknown>).n).toBe(1);
});

test("partial failure: sticky toast + surviving card", async ({ app }) => {
  const m = marker("partial");
  await fillKey(app, "sk-or-test-ok");
  await ensureComposerOpen(app);
  await app.getByRole("button", { name: "More images" }).click();
  await generate(app, `partial ${m} [[mock:fail-nth,n=2]]`);
  await expect(app.locator(".toasts").getByText(/saved 1 · failed 1/)).toBeVisible({ timeout: 15000 });
  await expect(app.locator("#gallery .card")).toHaveCount(1);
  expect((await loggedWithPrompt(m))).toHaveLength(2);
});

test("cancel mid-flight aborts the request", async ({ app }) => {
  const m = marker("cancel");
  await fillKey(app, "sk-or-test-ok");
  await generate(app, `cancel me ${m} [[mock:delay,ms=15000]]`);
  await expect(app.getByText(/Working…/)).toBeVisible({ timeout: 8000 });
  await app.getByRole("button", { name: "Cancel" }).click();
  await expect(app.locator("#gen-error")).toContainText("Cancelled");
  await expect
    .poll(async () => (await loggedWithPrompt(m)).filter((r) => r.aborted).length, { timeout: 8000 })
    .toBe(1);
});

for (const [key, text] of [
  ["sk-or-test-401", "Key rejected"],
  ["sk-or-test-402", "Insufficient balance"],
  ["sk-or-test-429", "Rate limited"],
  ["sk-or-test-500", "Provider error"],
] as Array<[string, string]>) {
  test(`error surfaces: ${key}`, async ({ app }) => {
    await fillKey(app, key);
    await generate(app, `err case ${marker(key)}`);
    await expect(app.locator("#gen-error")).toContainText(text, { timeout: 10000 });
  });
}

for (const [directive, text] of [
  ["invalid-json", "not JSON"],
  ["empty-data", "no image"],
  ["url-instead-of-b64", "URL instead"],
] as Array<[string, string]>) {
  test(`malformed provider body: ${directive}`, async ({ app }) => {
    await fillKey(app, "sk-or-test-ok");
    await generate(app, `malformed ${marker(directive)} [[mock:${directive}]]`);
    await expect(app.locator("#gen-error")).toContainText(text, { timeout: 10000 });
  });
}

test("huge payload does not hang the UI", async ({ app }) => {
  await fillKey(app, "sk-or-test-ok");
  await generate(app, `huge ${marker("huge")} [[mock:huge-payload]]`);
  await expect(app.locator("#gallery .card")).toHaveCount(1, { timeout: 30000 });
});

test("hero loader stays square across mid-run shape change", async ({ app }) => {
  test.skip(test.info().project.name === "mobile", "mobile composer sheet covers the hero mid-run");
  // Empty library: a lone slot renders the hero path.
  const m = marker("hero");
  await fillKey(app, "sk-or-test-ok");
  await ensureComposerOpen(app);
  await app.getByRole("button", { name: "Aspect ratio 16:9" }).click();
  await generate(app, `hero square ${m} [[mock:delay,ms=4000]]`);
  const frame = app.locator(".gallery-hero .denoise-frame");
  await expect(frame).toBeVisible({ timeout: 8000 });
  const first = await frame.boundingBox();
  expect(first).not.toBeNull();
  expect(first!.width / first!.height).toBeGreaterThan(0.95);
  expect(first!.width / first!.height).toBeLessThan(1.05);
  await ensureComposerOpen(app);
  await app.getByRole("button", { name: "Aspect ratio 9:16" }).click();
  const second = await frame.boundingBox();
  expect(second).not.toBeNull();
  expect(Math.abs(second!.width - first!.width)).toBeLessThan(2);
  expect(Math.abs(second!.height - first!.height)).toBeLessThan(2);
  // Caption shows the run's shape, not the live picker.
  await expect(app.locator(".gallery-hero .gen-meta").first()).toContainText("16:9");
  const stage = app.locator(".gallery-hero .hero-stage");
  await expect(stage).toBeVisible({ timeout: 20000 });
  const revealed = await stage.boundingBox();
  expect(revealed).not.toBeNull();
  expect(Math.abs(revealed!.width - first!.width)).toBeLessThan(2);
  expect(Math.abs(revealed!.height - first!.height)).toBeLessThan(2);
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect((reqs[0].body as Record<string, unknown>).aspect_ratio).toBe("16:9");
});

test("lightbox image click opens the full-size viewer", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Viewer subject" }] });
  await app.reload();
  await app.getByRole("button", { name: /^Open image 1:/ }).click();
  const lightbox = app.getByRole("dialog", { name: "Generation details" });
  await expect(lightbox).toBeVisible();
  await lightbox.getByRole("button", { name: "View generated image full size" }).click();
  const viewer = app.getByRole("dialog", { name: "Generated image" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("img").first()).toBeVisible();
  // Layered Esc: viewer closes, lightbox stays.
  await app.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(lightbox).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
});

test("reveal: square loader, same grid position, no jump", async ({ app }) => {
  // A seeded record forces the grid layout (a lone slot renders the hero).
  await seedLibrary(app, { records: [{ prompt: "Grid anchor" }] });
  await app.reload();
  await expect(app.locator("#gallery .card")).toHaveCount(1);
  await fillKey(app, "sk-or-test-ok");
  await generate(app, `reveal ${marker("reveal")} [[mock:delay,ms=4000]]`);
  const pending = app.locator(".pending-card").first();
  await expect(pending).toBeVisible({ timeout: 8000 });
  const canvasBox = await pending.locator("canvas").boundingBox();
  expect(canvasBox).not.toBeNull();
  const ratio = canvasBox!.width / canvasBox!.height;
  expect(ratio).toBeGreaterThan(0.95);
  expect(ratio).toBeLessThan(1.05);
  const before = await pending.boundingBox();
  await expect(app.locator("#gallery .card")).toHaveCount(2, { timeout: 20000 });
  const card = app.locator("#gallery .card").first();
  const after = await card.boundingBox();
  expect(Math.abs(after!.x - before!.x)).toBeLessThan(4);
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(4);
});
