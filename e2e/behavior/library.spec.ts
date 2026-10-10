// Library flows: backup round trip, cross-tab sync, degraded pre-POST block.
import { test, expect, seedLibrary, gotoTab, ensureComposerOpen, loggedWithPrompt, marker } from "../fixtures";
import { pngDataUrl } from "../mock-api/png.mjs";

test("backup round trip restores records + references", async ({ app }) => {
  await seedLibrary(app, {
    records: [{ prompt: "Keep me" }],
    references: [{ name: "Keep ref" }],
  });
  await app.reload();
  await app.getByRole("button", { name: "Library", exact: true }).click();
  await app.getByRole("button", { name: "Back up library" }).click();
  await app.getByLabel("Passphrase", { exact: true }).fill("round-trip-99");
  await app.getByLabel("Confirm passphrase").fill("round-trip-99");
  const [dl] = await Promise.all([
    app.waitForEvent("download"),
    app.getByRole("button", { name: "Download backup" }).click(),
  ]);
  const path = await dl.path();
  await app.keyboard.press("Escape");
  await app.evaluate(() => window.__e2e__?.reset());
  await app.reload();
  await expect(app.locator("#gallery .card")).toHaveCount(0);
  await app.locator('input[type="file"][accept="application/json"]').setInputFiles(path!);
  await app.getByLabel("Passphrase", { exact: true }).fill("round-trip-99");
  await app.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(app.locator("#gallery .card")).toHaveCount(1, { timeout: 10000 });
  await gotoTab(app, "refs");
  await expect(app.locator(".ref-card")).toHaveCount(1);
});

test("two pages in one context stay in sync", async ({ app }) => {
  const second = await app.context().newPage();
  try {
    await second.goto("/");
    await second.locator("body").waitFor();
    await second.evaluate(() => window.__e2e__?.reset());
    await seedLibrary(app, { records: [{ prompt: "Synced image", imageUrl: pngDataUrl(64, 64, "solid") }] });
    await expect(second.locator("#gallery .card")).toHaveCount(1, { timeout: 10000 });
  } finally {
    await second.close();
  }
});

test("degraded mode blocks generation before any POST", async ({ app }) => {
  const m = marker("degraded");
  await app.evaluate(() => window.__e2e__?.setDegraded("WebCrypto is unavailable (e2e)."));
  await app.reload();
  await expect(app.getByRole("alert")).toContainText("Encryption unavailable");
  await ensureComposerOpen(app);
  await expect(app.getByRole("button", { name: /Generate/ })).toBeDisabled();
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill(`blocked ${m}`);
  expect(await loggedWithPrompt(m)).toEqual([]);
});
