// Keyboard/focus contract: all 8 Dialogs + app-specific key behavior.
import type { Page } from "@playwright/test";
import { test, expect, assertDialogContract, assertLayeredEsc, seedLibrary, gotoTab, fillKey, ensureComposerOpen, loggedWithPrompt, marker } from "../fixtures";
import { pngDataUrl } from "../mock-api/png.mjs";

async function openMenu(app: Page) {
  await app.getByRole("button", { name: "Library", exact: true }).click();
  await app.locator("#lib-menu").waitFor({ timeout: 5000 });
}

test("contract: lightbox", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Contract peak" }] });
  await app.reload();
  await assertDialogContract(app, {
    open: async () => {
      await app.getByRole("button", { name: /^Open image 1:/ }).click();
    },
    dialogName: "Generation details",
    returnTo: /^Open image 1:/,
  });
});

test("contract: viewer over lightbox + layered Esc", async ({ app }) => {
  await seedLibrary(app, {
    records: [{ prompt: "Layered", refCount: 1, refImageUrls: [pngDataUrl(64, 64, "solid")] }],
  });
  await app.reload();
  await app.getByRole("button", { name: /^Open image 1:/ }).click();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeVisible();
  await assertDialogContract(app, {
    open: async () => {
      await app.getByRole("button", { name: "View reference 1 full size" }).first().click();
    },
    dialogName: "Reference image",
    returnTo: "View reference 1 full size",
  });
  // Re-open both layers: one Esc closes only the viewer.
  await app.getByRole("button", { name: "View reference 1 full size" }).first().click();
  await assertLayeredEsc(
    app,
    { name: "Generation details" },
    { name: "Reference image" },
    async () => {}
  );
});

test("contract: studio delete confirm", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Delete me" }] });
  await app.reload();
  await assertDialogContract(app, {
    open: async () => {
      await app.getByRole("button", { name: "Delete image 1" }).click();
    },
    dialogName: "Delete this image?",
    role: "alertdialog",
    returnTo: "Delete image 1",
  });
});

test("contract: clear step1 + step2", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Clear me" }] });
  await app.reload();
  await openMenu(app);
  await assertDialogContract(app, {
    open: async () => {
      await app.getByRole("button", { name: "Clear library" }).click();
    },
    dialogName: /Delete all \d+ images/,
    role: "alertdialog",
    // The menu closes on item click, so the opener unmounts — the dialog
    // returns focus to the stable Library menu trigger instead. Scoped:
    // "Library" substring-matches the composer's "Open reference library".
  });
  await expect(app.locator(".menu-wrap").getByRole("button", { name: "Library", exact: true })).toBeFocused();
  // Step 2 is a fresh Dialog (key remount): contract again.
  await openMenu(app);
  await app.getByRole("button", { name: "Clear library" }).click();
  await app.getByRole("button", { name: "Continue" }).click();
  const step2 = app.getByRole("alertdialog", { name: "Are you absolutely sure?" });
  await expect(step2).toBeVisible();
  expect(await step2.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await app.getByLabel("Type DELETE to confirm").fill("DELETE");
  await expect(app.getByRole("button", { name: "Delete all" })).toBeEnabled();
  await app.keyboard.press("Escape");
  await expect(step2).toBeHidden();
  await expect(app.locator(".menu-wrap").getByRole("button", { name: "Library", exact: true })).toBeFocused();
});

test("contract: key modal", async ({ app }) => {
  await assertDialogContract(app, {
    open: async () => {
      await app.getByRole("button", { name: /OpenRouter API key/ }).click();
    },
    dialogName: "OpenRouter API key",
    returnTo: /OpenRouter API key/,
  });
});

test("contract: backup export", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Export me" }] });
  await app.reload();
  await openMenu(app);
  await assertDialogContract(app, {
    open: async () => {
      await app.getByRole("button", { name: "Back up library" }).click();
    },
    dialogName: "Protect backup",
  });
  // Menu-launched like clear-all: Esc returns to the Library trigger (scoped,
  // see clear-step1: "Library" also substring-matches "Open reference library").
  await expect(app.locator(".menu-wrap").getByRole("button", { name: "Library", exact: true })).toBeFocused();
});

test("contract: refs delete", async ({ app }) => {
  await seedLibrary(app, { references: [{ name: "Ref gone" }] });
  await gotoTab(app, "refs");
  await assertDialogContract(app, {
    open: async () => {
      await app.getByRole("button", { name: "Delete Ref gone" }).click();
    },
    dialogName: "Delete this reference?",
    role: "alertdialog",
  });
  // Opener is removed by deletion path; landing target is the section.
  await app.getByRole("button", { name: "Delete Ref gone" }).click();
  await app.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(app.locator("#ref-library")).toBeFocused();
});

test("contract: refs clear", async ({ app }) => {
  await seedLibrary(app, { references: [{ name: "Ref one" }] });
  await gotoTab(app, "refs");
  await assertDialogContract(app, {
    open: async () => {
      await app.getByRole("button", { name: "Clear", exact: true }).click();
    },
    dialogName: /Delete all \d+ references/,
    role: "alertdialog",
    returnTo: "Clear",
  });
});

test("card thumb opens via keyboard; actions do not", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Keyboard card" }] });
  await app.reload();
  const thumb = app.getByRole("button", { name: /^Open image 1:/ });
  await thumb.focus();
  await app.keyboard.press("Enter");
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeVisible();
  await app.keyboard.press("Escape");
  // Enter on an action button acts, never opens the lightbox.
  await app.getByRole("button", { name: "Delete image 1" }).focus();
  await app.keyboard.press("Enter");
  await expect(app.getByRole("alertdialog", { name: "Delete this image?" })).toBeVisible();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeHidden();
});

test("skip links land on focusable targets in both tabs", async ({ app }) => {
  await app.getByRole("link", { name: "Skip to gallery" }).focus();
  await app.keyboard.press("Enter");
  await expect(app.locator("#gallery")).toBeFocused();
  await gotoTab(app, "refs");
  await app.getByRole("link", { name: "Skip to references" }).focus();
  await app.keyboard.press("Enter");
  await expect(app.locator("#ref-library")).toBeFocused();
});

test("tab switch sets focus and title", async ({ app }) => {
  await gotoTab(app, "refs");
  await expect(app).toHaveTitle(/References/);
  await expect(app.locator("#ref-library")).toBeFocused();
  await app.getByRole("button", { name: /sections menu/i }).click();
  await app.getByRole("button", { name: /^Studio/ }).click();
  await expect(app).toHaveTitle(/Studio/);
  await expect(app.locator("#gallery")).toBeFocused();
});

test("library menu: arrows, Home/End, Esc returns focus", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Menu keys" }] });
  await app.reload();
  const toggle = app.getByRole("button", { name: "Library", exact: true });
  await toggle.click();
  const menu = app.locator("#lib-menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("button");
  await expect(items.first()).toBeFocused();
  await app.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await app.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await app.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await app.keyboard.press("ArrowUp");
  await expect(items.last()).toBeFocused();
  await app.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(toggle).toBeFocused();
});

test("group combobox: arrows pick, Enter selects, Esc closes list", async ({ app }) => {
  // The group field is a true combobox: click opens the suggestion list,
  // arrows/Enter/Esc work without leaving the field (typing path below).
  await seedLibrary(app, {
    references: [
      { name: "Fox", group: "" },
      { name: "Harbor", group: "places" },
      { name: "Leaf", group: "chars" },
    ],
  });
  await gotoTab(app, "refs");
  await app.getByRole("button", { name: "Edit Fox" }).click();
  const group = app.getByLabel("Reference group");
  await group.click();
  await expect(app.getByRole("listbox", { name: "Existing groups" })).toBeVisible();
  await app.keyboard.press("ArrowDown");
  await app.keyboard.press("Enter");
  await expect(group).toHaveValue("places");
  await expect(app.getByRole("listbox", { name: "Existing groups" })).toBeHidden();
  // Esc with open list closes the list first, not the draft. Focus never
  // left the field (that was the old defect), so reopen with ArrowDown.
  await app.keyboard.press("ArrowDown");
  await expect(app.getByRole("listbox", { name: "Existing groups" })).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(app.getByRole("listbox", { name: "Existing groups" })).toBeHidden();
  await expect(group).toBeFocused();
  await app.keyboard.press("Escape");
  await expect(group).toBeHidden();
});

test("group combobox: typing keeps focus and value", async ({ app }) => {
  // Regression: the edit focus effect re-ran on every draft keystroke and
  // yanked focus back to the name field after each character.
  await seedLibrary(app, {
    references: [
      { name: "Typist", group: "" },
      { name: "Harbor", group: "places" },
    ],
  });
  await gotoTab(app, "refs");
  await app.getByRole("button", { name: "Edit Typist" }).click();
  const group = app.getByLabel("Reference group");
  await group.click();
  await app.keyboard.type("harbor");
  await expect(group).toBeFocused();
  await expect(group).toHaveValue("harbor");
});

test("edit Save/Cancel returns focus to Edit", async ({ app }) => {
  await seedLibrary(app, { references: [{ name: "Editable" }] });
  await gotoTab(app, "refs");
  const edit = app.getByRole("button", { name: "Edit Editable" });
  await edit.click();
  await expect(app.getByLabel("Reference name")).toBeFocused();
  await app.keyboard.press("Escape");
  await expect(edit).toBeFocused();
  await edit.click();
  await app.getByLabel("Reference name").fill("Renamed");
  await app.getByRole("button", { name: "Save", exact: true }).click();
  await expect(app.getByRole("button", { name: "Edit Renamed" })).toBeFocused();
});

test("studio delete lands on gallery", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Vanish" }] });
  await app.reload();
  await app.getByRole("button", { name: "Delete image 1" }).click();
  await app.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(app.locator("#gallery")).toBeFocused();
  await expect(app.locator(".card")).toHaveCount(0);
});

test("Ctrl+Enter is composer-scoped", async ({ app }) => {
  const m = marker("ctrlenter");
  await fillKey(app, "sk-or-test-ok");
  await ensureComposerOpen(app);
  // Non-empty prompt + key set: WOULD generate from the composer.
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill(`scoped ${m}`);
  await app.getByLabel("Search prompts").focus();
  await app.keyboard.press("Control+Enter");
  // Negative assertion needs a dwell: poll the marker-scoped log briefly.
  await app.waitForTimeout(800);
  expect(await loggedWithPrompt(m)).toEqual([]);
  await app.keyboard.press("Escape");
});
