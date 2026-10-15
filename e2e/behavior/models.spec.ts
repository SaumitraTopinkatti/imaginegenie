// Dual-model behavior: Seedream default + Qwen alongside. Roles/names only.
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  fillKey,
  seedLibrary,
  ensureComposerOpen,
  loggedWithPrompt,
  marker,
  gotoTab,
  paintStroke,
  pickFirstGeneration,
  ensureInpaintControlsOpen,
  awaitRevealSettled,
} from "../fixtures";
import { pngDataUrl } from "../mock-api/png.mjs";

const SEEDREAM_ID = "bytedance-seed/seedream-5-0-pro";
const QWEN_ID = "qwen/qwen-image-3-pro-20260805";

async function generate(app: Page, prompt: string) {
  await ensureComposerOpen(app);
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
  await app.getByRole("button", { name: /Generate/ }).click();
}

async function selectModel(app: Page, id: "seedream" | "qwen") {
  await ensureComposerOpen(app);
  await app.getByLabel("Model").selectOption(id);
}

test("default is Seedream on load", async ({ app }) => {
  const m = marker("model-default");
  await fillKey(app, "sk-or-test-ok");
  await ensureComposerOpen(app);
  await expect(app.getByLabel("Model")).toHaveValue("seedream");
  await generate(app, `default model ${m}`);
  await expect(app.locator(".toasts").getByText("Image ready")).toBeVisible({ timeout: 15000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect((reqs[0].body as Record<string, unknown>).model).toBe(SEEDREAM_ID);
});

test("Qwen single: snap, request id, tag, lightbox", async ({ app }) => {
  const m = marker("model-qwen1");
  await fillKey(app, "sk-or-test-ok");
  await ensureComposerOpen(app);
  await selectModel(app, "qwen");
  // auto isn't in Qwen's list: snaps to 1:1 with a toast.
  await expect(app.locator(".toasts").getByText(/isn't supported by Qwen/)).toBeVisible({ timeout: 8000 });
  await app.getByLabel("Seed (optional)").fill("7");
  await generate(app, `qwen single ${m}`);
  await expect(app.locator(".toasts").getByText("Image ready")).toBeVisible({ timeout: 15000 });
  await awaitRevealSettled(app);
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  const b = reqs[0].body as Record<string, unknown>;
  expect(b.model).toBe(QWEN_ID);
  expect(b.aspect_ratio).toBe("1:1");
  expect(b.seed).toBe(7);
  expect(b.n).toBe(1);
  await expect(app.locator("#gallery .card").getByText("Qwen", { exact: true }).first()).toBeVisible();
  // Lightbox shows the full model label.
  await app.locator("#gallery .card").first().getByRole("button", { name: /^Open image/ }).click();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeVisible();
  await expect(app.getByRole("dialog", { name: "Generation details" }).getByText("Qwen Image 3 Pro")).toBeVisible();
});

test("Qwen count 3 fans out three n:1 Qwen calls", async ({ app }) => {
  const m = marker("model-qwen3");
  await fillKey(app, "sk-or-test-ok");
  await ensureComposerOpen(app);
  await selectModel(app, "qwen");
  await app.getByRole("button", { name: "More images" }).click();
  await app.getByRole("button", { name: "More images" }).click();
  await generate(app, `qwen fanout ${m}`);
  await expect(app.locator("#gallery .card")).toHaveCount(3, { timeout: 20000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(3);
  for (const r of reqs) {
    expect((r.body as Record<string, unknown>).model).toBe(QWEN_ID);
    expect((r.body as Record<string, unknown>).n).toBe(1);
  }
});

test("Qwen over-cap refs: blocked before POST, tray kept", async ({ app }) => {
  const refs = Array.from({ length: 6 }, (_, i) => pngDataUrl(48 + i, 48, "solid"));
  await seedLibrary(app, {
    records: [{ prompt: "Six ref anchor", refCount: 6, refImageUrls: refs }],
  });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  // Retry restores 6 refs under Seedream caps.
  await app.locator("#gallery .card").first().getByRole("button", { name: /Retry image/ }).click();
  await ensureComposerOpen(app);
  await selectModel(app, "qwen");
  const m = marker("model-overcap");
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill(`over cap ${m}`);
  await app.getByRole("button", { name: /Generate/ }).click();
  await expect(app.locator("#gen-error")).toContainText("up to 4 references", { timeout: 8000 });
  expect(await loggedWithPrompt(m)).toHaveLength(0);
  // Tray untouched: switching back to Seedream unblocks.
  await selectModel(app, "seedream");
  await app.getByRole("button", { name: /Generate/ }).click();
  await expect(app.locator(".toasts").getByText("Image ready")).toBeVisible({ timeout: 20000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect((reqs[0].body as Record<string, unknown>).model).toBe(SEEDREAM_ID);
});

test("retry restores the record's model", async ({ app }) => {
  await seedLibrary(app, {
    records: [
      { prompt: "Qwen seed rec", model: QWEN_ID },
      { prompt: "Legacy seed rec" },
    ],
  });
  await app.reload();
  // NB: no ensureComposerOpen — on mobile the open sheet would cover the cards.
  await app.locator("#gallery .card").getByText("Qwen seed rec").isVisible();
  // Cards render newest-first; find each card's retry via its prompt snippet.
  const qwenCard = app.locator("#gallery .card", { hasText: "Qwen seed rec" }).first();
  await qwenCard.getByRole("button", { name: /Retry image/ }).click();
  await expect(app.getByLabel("Model")).toHaveValue("qwen");
  // Retry opens the composer sheet on mobile: close it before touching another card.
  await app.keyboard.press("Escape");
  const legacyCard = app.locator("#gallery .card", { hasText: "Legacy seed rec" }).first();
  await legacyCard.getByRole("button", { name: /Retry image/ }).click();
  await expect(app.getByLabel("Model")).toHaveValue("seedream");
});

test("search qwen filters to Qwen records", async ({ app }) => {
  await seedLibrary(app, {
    records: [
      { prompt: "Sunny harbor", model: QWEN_ID },
      { prompt: "Foggy pier" },
    ],
  });
  await app.reload();
  await app.getByRole("textbox", { name: "Search prompts" }).fill("qwen");
  await expect(app.locator("#gallery .card")).toHaveCount(1);
  await expect(app.locator("#gallery .card").first()).toContainText("Sunny harbor");
});

test("inpaint still sends Seedream", async ({ app }) => {
  const m = marker("model-inpaint");
  await seedLibrary(app, { records: [{ prompt: "Inpaint source", imageUrl: pngDataUrl(192, 128, "solid") }] });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await ensureInpaintControlsOpen(app);
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`fix the roof ${m}`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect((reqs[0].body as Record<string, unknown>).model).toBe(SEEDREAM_ID);
});
