// API-key flows: normalisation, truthful Test (/key), auth gate, remember.
// Roles/names only — never the key value, length or prefix in assertions.
import type { Page } from "@playwright/test";
import { test, expect, seedLibrary, gotoTab, fillKey, openKeyModal, mockApi, paintStroke, loggedWithPrompt, marker, ensureComposerOpen, pickFirstGeneration, ensureInpaintControlsOpen } from "../fixtures";
import { pngDataUrl } from "../mock-api/png.mjs";

/** As pasted from a doc: padding, quotes, Bearer prefix, trailing newline. */
const MANGLED = `  "Bearer sk-or-test-ok"\n`;

async function generateStudio(app: Page, prompt: string) {
  await ensureComposerOpen(app);
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill(prompt);
  await app.getByRole("button", { name: /Generate/ }).click();
}

test("test ok shows label + limit via role=status", async ({ app }) => {
  await fillKey(app, "sk-or-test-ok");
  await openKeyModal(app);
  await app.getByRole("button", { name: "Test", exact: true }).click();
  await expect(app.getByRole("dialog", { name: "OpenRouter API key" }).getByRole("status")).toContainText(
    'Works — key "mock key" accepted (limit remaining: 10).'
  );
  const { requests } = await mockApi.requests();
  const keys = requests.filter((r) => r.path === "/api/v1/key");
  // Shared server: other parallel tests hit /key too — assert existence.
  expect(keys.some((r) => r.keyKind === "sk-or-test-ok")).toBe(true);
});

test("test err announced via role=alert", async ({ app }) => {
  await fillKey(app, "sk-or-test-401");
  await openKeyModal(app);
  await app.getByRole("button", { name: "Test", exact: true }).click();
  await expect(app.getByRole("alert")).toContainText("Key rejected");
});

test("rejected key badge reads Check key until the key changes", async ({ app }) => {
  await fillKey(app, "sk-or-test-401");
  await openKeyModal(app);
  await app.getByRole("button", { name: "Test", exact: true }).click();
  await expect(app.getByRole("alert")).toContainText("Key rejected");
  await app.getByRole("button", { name: "Close", exact: true }).click();
  await expect(app.getByRole("button", { name: /OpenRouter API key.*Check key/ })).toBeVisible();
  await openKeyModal(app);
  await app.getByRole("textbox", { name: "OpenRouter API key" }).fill("sk-or-test-ok");
  await app.getByRole("button", { name: "Close", exact: true }).click();
  await expect(app.getByRole("button", { name: /OpenRouter API key.*Connected/ })).toBeVisible();
});

test("pasted Bearer/quotes/whitespace normalises in the field", async ({ app }) => {
  await openKeyModal(app);
  await app.getByRole("textbox", { name: "OpenRouter API key" }).fill(MANGLED);
  await expect(app.getByRole("textbox", { name: "OpenRouter API key" })).toHaveValue("sk-or-test-ok");
  await app.getByRole("button", { name: "Close", exact: true }).click();
});

test("suspicious shape warns without blocking", async ({ app }) => {
  await openKeyModal(app);
  await app.getByRole("textbox", { name: "OpenRouter API key" }).fill("junk");
  await expect(app.getByText(/doesn.t look like an OpenRouter key/)).toBeVisible();
  // Warned, not blocked: Test still runs and reports the provider's answer.
  await app.getByRole("button", { name: "Test", exact: true }).click();
  await expect(app.getByRole("alert")).toContainText("Key rejected");
  await app.getByRole("button", { name: "Close", exact: true }).click();
});

test("mangled pasted key generates in Studio with a clean header", async ({ app }) => {
  const m = marker("key-mangled-studio");
  await fillKey(app, MANGLED);
  await generateStudio(app, `mangled key studio ${m}`);
  await expect(app.locator("#gallery .card")).toHaveCount(1, { timeout: 15000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect(reqs[0].keyKind).toBe("sk-or-test-ok");
});

test("mangled pasted key generates in Inpaint with a clean header", async ({ app }) => {
  const m = marker("key-mangled-inpaint");
  await seedLibrary(app, { records: [{ prompt: "Key source", imageUrl: pngDataUrl(128, 128, "solid") }] });
  await app.reload();
  await fillKey(app, MANGLED);
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await ensureInpaintControlsOpen(app);
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`mangled key inpaint ${m}`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect(reqs[0].keyKind).toBe("sk-or-test-ok");
});

test("garbage key surfaces the 401 copy on Generate", async ({ app }) => {
  const m = marker("key-garbage");
  await fillKey(app, "junk");
  await generateStudio(app, `garbage key ${m}`);
  await expect(app.locator("#gen-error")).toContainText("Key rejected", { timeout: 10000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect(reqs[0].keyKind).toBe("other");
});

test("remember-key survives reload; forgetting clears it", async ({ app }) => {
  await fillKey(app, "sk-or-test-ok"); // fillKey remembers + closes
  await app.reload();
  await expect(app.getByRole("button", { name: /Connected/ })).toBeVisible({ timeout: 8000 });
  await openKeyModal(app);
  await app.getByText("Remember on this device (encrypted)").click(); // uncheck
  await app.getByRole("button", { name: "Close", exact: true }).click();
  await app.reload();
  await expect(app.getByRole("button", { name: /Connected/ })).toBeHidden();
});
