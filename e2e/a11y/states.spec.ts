// State-driven axe suite: every risky UI state the old gate never reached.
// Tags: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice.
// Emulation projects (reduced-motion, forced-colors) run a subset; ARIA
// snapshots assert on desktop only. Roles/names only — no test ids.
import type { Page } from "@playwright/test";
import { test, expect, scanState, seedLibrary, gotoTab, fillKey, openKeyModal, ensureComposerOpen, awaitRevealSettled, paintStroke, marker, openSourcePicker, pickFirstGeneration, ensureInpaintControlsOpen } from "../fixtures";
import { pngDataUrl } from "../mock-api/png.mjs";

const EMU_SUBSET = new Set([
  "composer-empty",
  "gallery-populated",
  "lightbox",
  "lightbox-with-refs",
  "key-empty",
  "refs-populated",
  "delete-confirm",
  "inpaint-editing",
]);
const isEmu = () => test.info().project.name === "reduced-motion" || test.info().project.name === "forced-colors";
const skipUnlessEmu = (name: string) => test.skip(isEmu() && !EMU_SUBSET.has(name), "emulation subset");

async function openMenu(app: Page) {
  await app.getByRole("button", { name: "Library", exact: true }).click();
  await app.locator("#lib-menu").waitFor({ timeout: 5000 });
}

test("composer-empty", async ({ app }) => {
  skipUnlessEmu("composer-empty");
  test.skip(test.info().project.name === "mobile", "mobile composer is a closed sheet; see mobile-sheet-open");
  await expect(app.getByRole("textbox", { name: "Prompt", exact: true })).toBeVisible();
  await scanState(app, "composer-empty");
  if (test.info().project.name === "desktop") {
    await expect(app.locator("#gallery")).toMatchAriaSnapshot();
  }
});

test("composer-filled", async ({ app }) => {
  skipUnlessEmu("composer-filled");
  test.skip(test.info().project.name === "mobile", "mobile composer is a closed sheet; see mobile-sheet-open");
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill("A teal lighthouse at dusk, cinematic");
  await app.getByLabel("Seed (optional)").fill("42");
  await app.getByRole("button", { name: "More images" }).click();
  await scanState(app, "composer-filled");
});

test("composer-error", async ({ app }) => {
  skipUnlessEmu("composer-error");
  test.skip(test.info().project.name === "mobile", "mobile composer is a closed sheet; see mobile-sheet-open");
  await app.getByRole("button", { name: /Generate/ }).click();
  await expect(app.locator("#gen-error")).toContainText("API key");
  await scanState(app, "composer-error");
});

test("generating", async ({ app }) => {
  skipUnlessEmu("generating");
  test.skip(test.info().project.name === "mobile", "mobile composer is a closed sheet; see mobile-sheet-open");
  await fillKey(app, "sk-or-test-ok");
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill("mid-flight loader [[mock:delay,ms=15000]]");
  await app.getByRole("button", { name: /Generate/ }).click();
  await expect(app.getByText(/Working…/)).toBeVisible({ timeout: 8000 });
  await scanState(app, "generating");
  await app.getByRole("button", { name: "Cancel" }).click();
});

test("gallery-populated", async ({ app }) => {
  skipUnlessEmu("gallery-populated");
  await seedLibrary(app, {
    records: [
      { prompt: "Square teal study", aspectRatio: "1:1" },
      { prompt: "Wide coastline panorama", aspectRatio: "16:9", cost: 0.09, resolution: "2K" },
      { prompt: "Tall lighthouse", aspectRatio: "9:16", mediaType: "image/webp" },
      {
        prompt: "Still life with two refs",
        aspectRatio: "3:2",
        refCount: 2,
        refImageUrls: [pngDataUrl(64, 64, "solid"), pngDataUrl(72, 128, "gradient")],
      },
    ],
  });
  await app.reload();
  await expect(app.locator(".card").first()).toBeVisible({ timeout: 8000 });
  await expect(app.locator(".card")).toHaveCount(4);
  await scanState(app, "gallery-populated");
  if (test.info().project.name === "desktop") {
    await expect(app.locator("#gallery")).toMatchAriaSnapshot();
  }
});

test("lightbox", async ({ app }) => {
  skipUnlessEmu("lightbox");
  await seedLibrary(app, { records: [{ prompt: "Lightbox subject" }] });
  await app.reload();
  await app.getByRole("button", { name: /^Open image 1:/ }).click();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeVisible();
  await scanState(app, "lightbox");
  if (test.info().project.name === "desktop") {
    await expect(app.getByRole("dialog", { name: "Generation details" })).toMatchAriaSnapshot();
  }
});

test("lightbox-with-refs", async ({ app }) => {
  skipUnlessEmu("lightbox-with-refs");
  await seedLibrary(app, {
    records: [
      {
        prompt: "Subject with refs",
        refCount: 2,
        refImageUrls: [pngDataUrl(64, 64, "solid"), pngDataUrl(64, 64, "gradient")],
      },
    ],
  });
  await app.reload();
  await app.getByRole("button", { name: /^Open image 1:/ }).click();
  await expect(app.getByRole("button", { name: "View reference 1 full size" }).first()).toBeVisible();
  await scanState(app, "lightbox-with-refs");
});

test("viewer-over-lightbox", async ({ app }) => {
  skipUnlessEmu("viewer-over-lightbox");
  await seedLibrary(app, {
    records: [
      { prompt: "Subject with one ref", refCount: 1, refImageUrls: [pngDataUrl(64, 64, "solid")] },
    ],
  });
  await app.reload();
  await app.getByRole("button", { name: /^Open image 1:/ }).click();
  await app.getByRole("button", { name: "View reference 1 full size" }).first().click();
  await expect(app.getByRole("dialog", { name: "Reference image" })).toBeVisible();
  await scanState(app, "viewer-over-lightbox");
});

test("delete-confirm", async ({ app }) => {
  skipUnlessEmu("delete-confirm");
  await seedLibrary(app, { records: [{ prompt: "Doomed image" }] });
  await app.reload();
  await app.getByRole("button", { name: "Delete image 1" }).click();
  await expect(app.getByRole("alertdialog")).toBeVisible();
  await scanState(app, "delete-confirm");
  if (test.info().project.name === "desktop") {
    await expect(app.getByRole("alertdialog")).toMatchAriaSnapshot();
  }
});

test("clear-step1", async ({ app }) => {
  skipUnlessEmu("clear-step1");
  await seedLibrary(app, { records: [{ prompt: "One" }, { prompt: "Two" }] });
  await app.reload();
  await openMenu(app);
  await app.getByRole("button", { name: "Clear library" }).click();
  await expect(app.getByRole("heading", { name: /Delete all 2 images/ })).toBeVisible();
  await scanState(app, "clear-step1");
});

test("clear-step2", async ({ app }) => {
  skipUnlessEmu("clear-step2");
  await seedLibrary(app, { records: [{ prompt: "One" }] });
  await app.reload();
  await openMenu(app);
  await app.getByRole("button", { name: "Clear library" }).click();
  await app.getByRole("button", { name: "Continue" }).click();
  await expect(app.getByLabel("Type DELETE to confirm")).toBeVisible();
  await scanState(app, "clear-step2");
});

test("key-empty", async ({ app }) => {
  skipUnlessEmu("key-empty");
  await app.getByRole("button", { name: /OpenRouter API key/ }).click();
  await expect(app.getByRole("dialog", { name: "OpenRouter API key" })).toBeVisible();
  await scanState(app, "key-empty");
  if (test.info().project.name === "desktop") {
    await expect(app.getByRole("dialog", { name: "OpenRouter API key" })).toMatchAriaSnapshot();
  }
});

test("key-ok", async ({ app }) => {
  skipUnlessEmu("key-ok");
  await fillKey(app, "sk-or-test-ok");
  await openKeyModal(app);
  await app.getByRole("button", { name: "Test", exact: true }).click();
  await expect(app.getByRole("dialog", { name: "OpenRouter API key" }).getByRole("status")).toContainText("accepted");
  await scanState(app, "key-ok");
});

test("key-err", async ({ app }) => {
  skipUnlessEmu("key-err");
  await fillKey(app, "sk-or-test-401");
  await openKeyModal(app);
  await app.getByRole("button", { name: "Test", exact: true }).click();
  await expect(app.getByRole("alert")).toContainText("Key rejected");
  await scanState(app, "key-err");
});

test("backup-export", async ({ app }) => {
  skipUnlessEmu("backup-export");
  await seedLibrary(app, { records: [{ prompt: "Back me up" }] });
  await app.reload();
  await openMenu(app);
  await app.getByRole("button", { name: "Back up library" }).click();
  await app.getByLabel("Passphrase", { exact: true }).fill("correct-horse-99");
  await app.getByLabel("Confirm passphrase").fill("correct-horse-99");
  await scanState(app, "backup-export");
});

test("backup-restore", async ({ app }) => {
  skipUnlessEmu("backup-restore");
  await seedLibrary(app, { records: [{ prompt: "Round trip" }] });
  await app.reload();
  await openMenu(app);
  await app.getByRole("button", { name: "Back up library" }).click();
  await app.getByLabel("Passphrase", { exact: true }).fill("correct-horse-99");
  await app.getByLabel("Confirm passphrase").fill("correct-horse-99");
  const [dl] = await Promise.all([
    app.waitForEvent("download"),
    app.getByRole("button", { name: "Download backup" }).click(),
  ]);
  const path = await dl.path();
  await app.keyboard.press("Escape");
  await app.evaluate(() => window.__e2e__?.reset());
  await app.reload();
  await app.locator('input[type="file"][accept="application/json"]').setInputFiles(path!);
  await expect(app.getByRole("heading", { name: "Restore backup" })).toBeVisible();
  await app.getByLabel("Passphrase", { exact: true }).fill("correct-horse-99");
  await scanState(app, "backup-restore");
});

test("backup-wrong-pass", async ({ app }) => {
  skipUnlessEmu("backup-wrong-pass");
  await seedLibrary(app, { records: [{ prompt: "Round trip" }] });
  await app.reload();
  await openMenu(app);
  await app.getByRole("button", { name: "Back up library" }).click();
  await app.getByLabel("Passphrase", { exact: true }).fill("correct-horse-99");
  await app.getByLabel("Confirm passphrase").fill("correct-horse-99");
  const [dl] = await Promise.all([
    app.waitForEvent("download"),
    app.getByRole("button", { name: "Download backup" }).click(),
  ]);
  const path = await dl.path();
  await app.keyboard.press("Escape");
  await app.evaluate(() => window.__e2e__?.reset());
  await app.reload();
  await app.locator('input[type="file"][accept="application/json"]').setInputFiles(path!);
  await expect(app.getByRole("heading", { name: "Restore backup" })).toBeVisible();
  await app.getByLabel("Passphrase", { exact: true }).fill("wrong-pass-00");
  await app.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(app.getByRole("alert")).toContainText("Wrong passphrase");
  await scanState(app, "backup-wrong-pass");
});

test("backup-legacy", async ({ app }) => {
  skipUnlessEmu("backup-legacy");
  const img = pngDataUrl(64, 64, "solid");
  const enc = (s: string) => ({ iv: "mock", data: Buffer.from(s).toString("base64"), alg: "AES-GCM-256" });
  const legacy = {
    app: "imaginegenie",
    schemaVersion: 2,
    version: 1,
    exportedAt: new Date().toISOString(),
    records: [
      {
        id: "legacy-1",
        createdAt: Date.now(),
        prompt: "Legacy row",
        aspectRatio: "1:1",
        resolution: "1K",
        cost: 0.045,
        mediaType: "image/png",
        refCount: 0,
        imageEnc: enc(img),
        thumbEnc: enc(img),
      },
    ],
    references: [],
  };
  await app.locator('input[type="file"][accept="application/json"]').setInputFiles({
    name: "legacy.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(legacy)),
  });
  await expect(app.getByRole("heading", { name: "Restore old backup?" })).toBeVisible();
  await scanState(app, "backup-legacy");
});

test("lib-menu-open", async ({ app }) => {
  skipUnlessEmu("lib-menu-open");
  await seedLibrary(app, { records: [{ prompt: "Menu subject" }] });
  await app.reload();
  await openMenu(app);
  await scanState(app, "lib-menu-open");
});

test("refs-empty", async ({ app }) => {
  skipUnlessEmu("refs-empty");
  await gotoTab(app, "refs");
  await expect(app.getByRole("heading", { name: "No references yet" })).toBeVisible();
  await scanState(app, "refs-empty");
});

test("refs-populated", async ({ app }) => {
  skipUnlessEmu("refs-populated");
  await seedLibrary(app, {
    references: [
      { name: "Teal fox", description: "Mascot study", group: "chars" },
      { name: "Harbor dusk", group: "places" },
      { name: "Loose leaf" },
    ],
  });
  await gotoTab(app, "refs");
  await expect(app.locator(".ref-card")).toHaveCount(3);
  await scanState(app, "refs-populated");
  if (test.info().project.name === "desktop") {
    await expect(app.locator("#ref-library")).toMatchAriaSnapshot();
  }
});

test("refs-edit-combobox", async ({ app }) => {
  skipUnlessEmu("refs-edit-combobox");
  await seedLibrary(app, {
    references: [
      { name: "Teal fox", group: "" },
      { name: "Harbor dusk", group: "places" },
      { name: "Leaf", group: "chars" },
    ],
  });
  await gotoTab(app, "refs");
  await app.getByRole("button", { name: "Edit Teal fox" }).click();
  await app.getByLabel("Reference group").click();
  await expect(app.getByRole("listbox", { name: "Existing groups" })).toBeVisible();
  await scanState(app, "refs-edit-combobox");
});

test("refs-delete-dialog", async ({ app }) => {
  skipUnlessEmu("refs-delete-dialog");
  await seedLibrary(app, { references: [{ name: "Goner" }] });
  await gotoTab(app, "refs");
  await app.getByRole("button", { name: "Delete Goner" }).click();
  await expect(app.getByRole("alertdialog")).toBeVisible();
  await scanState(app, "refs-delete-dialog");
});

test("refs-clear-dialog", async ({ app }) => {
  skipUnlessEmu("refs-clear-dialog");
  await seedLibrary(app, { references: [{ name: "One" }, { name: "Two" }] });
  await gotoTab(app, "refs");
  await app.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(app.getByRole("alertdialog")).toBeVisible();
  await scanState(app, "refs-clear-dialog");
});

test("drawer-open", async ({ app }) => {
  skipUnlessEmu("drawer-open");
  await app.getByRole("button", { name: /sections menu/i }).click();
  await expect(app.getByRole("navigation", { name: "Sections" })).toBeVisible();
  await scanState(app, "drawer-open");
});

test("inpaint-empty", async ({ app }) => {
  skipUnlessEmu("inpaint-empty");
  test.skip(test.info().project.name === "mobile", "mobile inpaint controls are a closed sheet; see inpaint-sheet-open");
  await gotoTab(app, "inpaint");
  await expect(app.getByRole("heading", { name: /Inpaint/ })).toBeVisible();
  await scanState(app, "inpaint-empty");
  if (test.info().project.name === "desktop") {
    await expect(app.locator("#inpaint-main")).toMatchAriaSnapshot();
  }
});

test("inpaint-picker-open", async ({ app }) => {
  skipUnlessEmu("inpaint-picker-open");
  await seedLibrary(app, { records: [{ prompt: "Picker subject", imageUrl: pngDataUrl(256, 256, "solid") }] });
  await app.reload();
  await gotoTab(app, "inpaint");
  await openSourcePicker(app);
  await scanState(app, "inpaint-picker-open");
});

test("inpaint-editing", async ({ app }) => {
  skipUnlessEmu("inpaint-editing");
  await seedLibrary(app, { records: [{ prompt: "Editing subject", imageUrl: pngDataUrl(256, 256, "solid") }] });
  await app.reload();
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await scanState(app, "inpaint-editing");
});

test("inpaint-result", async ({ app }) => {
  skipUnlessEmu("inpaint-result");
  await seedLibrary(app, { records: [{ prompt: "Result source", imageUrl: pngDataUrl(256, 256, "solid") }] });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await ensureInpaintControlsOpen(app);
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill("state result check");
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
  await scanState(app, "inpaint-result");
});

test("mobile-sheet-open", async ({ app }) => {
  test.skip(test.info().project.name !== "mobile", "mobile sheet only");
  await app.getByRole("button", { name: /tap to expand/i }).click();
  await expect(app.getByRole("dialog", { name: "Image composer" })).toBeVisible();
  await scanState(app, "mobile-sheet-open");
});

test("inpaint-sheet-open", async ({ app }) => {
  skipUnlessEmu("inpaint-sheet-open");
  test.skip(test.info().project.name !== "mobile", "mobile sheet only");
  await seedLibrary(app, { records: [{ prompt: "Sheet state scene", imageUrl: pngDataUrl(256, 256, "solid") }] });
  await app.reload();
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await ensureInpaintControlsOpen(app);
  await scanState(app, "inpaint-sheet-open");
});

test("degraded-banner", async ({ app }) => {
  skipUnlessEmu("degraded-banner");
  await app.evaluate(() => window.__e2e__?.setDegraded("WebCrypto is unavailable (e2e)."));
  await app.reload();
  await expect(app.getByRole("alert")).toContainText("Encryption unavailable");
  await scanState(app, "degraded-banner");
});

test("unreadable-bar", async ({ app }) => {
  skipUnlessEmu("unreadable-bar");
  const { recordIds } = await seedLibrary(app, {
    records: [{ prompt: "Readable" }, { prompt: "Lost key" }],
  });
  await app.evaluate((ids) => window.__e2e__?.markUnreadable(ids), [recordIds[1]]);
  await app.reload();
  await expect(app.getByRole("alert")).toContainText("can't be decrypted");
  await scanState(app, "unreadable-bar");
});

test("toast-ok", async ({ app }) => {
  skipUnlessEmu("toast-ok");
  await fillKey(app, "sk-or-test-ok");
  await ensureComposerOpen(app);
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill("toast ok");
  await app.getByRole("button", { name: /Generate/ }).click();
  const toast = app.locator(".toasts").getByText("Image ready");
  await expect(toast).toBeVisible({ timeout: 15000 });
  // Settle the staggered reveal first: mid-fade text scans below AA.
  await awaitRevealSettled(app);
  await scanState(app, "toast-ok");
});

test("toast-err-sticky", async ({ app }) => {
  skipUnlessEmu("toast-err-sticky");
  await fillKey(app, "sk-or-test-ok");
  await ensureComposerOpen(app);
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill(`partial ${marker("toast")} [[mock:fail-nth,n=2]]`);
  await app.getByRole("button", { name: "More images" }).click();
  await app.getByRole("button", { name: /Generate/ }).click();
  const toast = app.locator(".toasts").getByText(/saved 1 · failed 1/);
  await expect(toast).toBeVisible({ timeout: 15000 });
  await expect(app.getByRole("button", { name: "Dismiss notification" }).first()).toBeVisible();
  // One image still reveals: settle before scanning (see toast-ok).
  await awaitRevealSettled(app);
  await scanState(app, "toast-err-sticky");
});
