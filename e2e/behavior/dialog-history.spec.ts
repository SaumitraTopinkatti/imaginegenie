// Back-to-close history: Back dismisses the topmost layer (viewer, dialog,
// sheet, drawer) instead of leaving the page, with no empty presses.
import type { Page } from "@playwright/test";
import { test, expect, seedLibrary, gotoTab, ensureComposerOpen } from "../fixtures";

/** Settle on the live layer depth (history entries reconcile in a microtask). */
async function waitLayers(app: Page, n: number) {
  await expect
    .poll(() => app.evaluate(() => (window.history.state as { igLayer?: number } | null)?.igLayer ?? -1), { timeout: 8000 })
    .toBe(n);
}

async function openLightbox(app: Page) {
  await app.getByRole("button", { name: /^Open image 1:/ }).click();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeVisible();
  await waitLayers(app, 1);
}

async function openViewer(app: Page) {
  await app.getByRole("button", { name: "View generated image full size" }).click();
  await expect(app.getByRole("dialog", { name: "Generated image" })).toBeVisible();
  await waitLayers(app, 2);
}

test("Back closes viewer, then lightbox, then routes", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "History layers" }] });
  await app.goto("/");
  await gotoTab(app, "refs");
  await gotoTab(app, "studio");
  await openLightbox(app);
  await openViewer(app);
  await app.goBack();
  await expect(app.getByRole("dialog", { name: "Generated image" })).toBeHidden();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeVisible();
  expect(app.url()).toMatch(/\/$/);
  await app.goBack();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeHidden();
  expect(app.url()).toMatch(/\/$/);
  await app.goBack();
  await expect(app.locator("#ref-library")).toBeVisible();
});

test("button close consumes its entry: one Back routes", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Entry consumed" }] });
  await app.goto("/");
  await gotoTab(app, "refs");
  await gotoTab(app, "studio");
  await openLightbox(app);
  await app.getByRole("dialog", { name: "Generation details" }).getByRole("button", { name: "Close", exact: true }).click();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeHidden();
  await waitLayers(app, 0);
  await app.goBack();
  await expect(app.locator("#ref-library")).toBeVisible();
});

test("viewer Inpaint lands deep-linked; one Back returns with no dialog", async ({ app }) => {
  const { recordIds } = await seedLibrary(app, { records: [{ prompt: "Viewer inpaint" }] });
  await app.goto("/");
  await openLightbox(app);
  await openViewer(app);
  await app.getByRole("dialog", { name: "Generated image" }).getByRole("button", { name: "Inpaint", exact: true }).click();
  await expect(app.locator("#inpaint-main")).toBeVisible();
  await expect(app).toHaveURL(new RegExp(`/inpaint\\?src=gen:${recordIds[0]}`));
  await app.goBack();
  await expect(app.locator("#gallery")).toBeVisible();
  await expect(app).toHaveURL(/\/$/);
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeHidden();
});

test("clear step 2 closes on Back; next Back routes", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Clear me" }] });
  await app.goto("/");
  await gotoTab(app, "refs");
  await gotoTab(app, "studio");
  await app.getByRole("button", { name: "Library", exact: true }).click();
  await app.getByRole("button", { name: "Clear library" }).click();
  await expect(app.getByRole("alertdialog", { name: /Delete all \d+ images/ })).toBeVisible();
  await app.getByRole("button", { name: "Continue" }).click();
  await expect(app.getByRole("alertdialog", { name: "Are you absolutely sure?" })).toBeVisible();
  await app.goBack();
  await expect(app.getByRole("alertdialog")).toBeHidden();
  // Step state was aborted: no dialog, same page, and the next Back routes.
  await expect(app.locator("#gallery")).toBeVisible();
  await app.goBack();
  await expect(app.locator("#ref-library")).toBeVisible();
});

test("forward after a Back-close reopens nothing", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "No reopen" }] });
  await app.goto("/");
  await openLightbox(app);
  await app.goBack();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeHidden();
  await app.goForward();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeHidden();
  await expect(app.locator("#gallery")).toBeVisible();
  expect(app.url()).toMatch(/\/$/);
});

test("reload with a lightbox open leaves no stuck state", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Reload residue" }] });
  await app.goto("/");
  await gotoTab(app, "refs");
  await gotoTab(app, "studio");
  await openLightbox(app);
  await app.reload();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeHidden();
  // The boot entry is normalized (no modal reopens), but the pre-modal
  // duplicate entry survives the reload: first Back stays put, second routes.
  await app.goBack();
  await expect(app.locator("#gallery")).toBeVisible();
  await app.goBack();
  await expect(app.locator("#ref-library")).toBeVisible();
});

test("Back closes the drawer and the composer sheet", async ({ app }) => {
  test.skip(test.info().project.name !== "mobile", "sheets and drawer Back rules are mobile-first");
  await app.goto("/");
  await app.getByRole("button", { name: /sections menu/i }).click();
  await expect(app.getByRole("link", { name: /^References/ })).toBeVisible();
  await app.goBack();
  await expect(app.getByRole("link", { name: /^References/ })).toBeHidden();
  await ensureComposerOpen(app);
  await expect(app.getByRole("dialog", { name: "Image composer" })).toBeVisible();
  await app.goBack();
  await expect(app.getByRole("dialog", { name: "Image composer" })).toBeHidden();
  expect(app.url()).toMatch(/\/$/);
});

test("Back close returns focus to the opener", async ({ app }) => {
  test.skip(test.info().project.name !== "desktop", "focus assertions are desktop-only");
  await seedLibrary(app, { records: [{ prompt: "Focus return" }] });
  await app.goto("/");
  await openLightbox(app);
  await openViewer(app);
  await app.goBack();
  await expect(app.getByRole("button", { name: "View generated image full size" })).toBeFocused();
});

test("mobile Close sits in the right-thumb zone", async ({ app }) => {
  test.skip(test.info().project.name !== "mobile", "thumb geometry is mobile-only");
  await seedLibrary(app, { records: [{ prompt: "Thumb zone" }] });
  await app.goto("/");
  await openLightbox(app);
  const vp = app.viewportSize() ?? { width: 390, height: 844 };
  const lbClose = await app.getByRole("dialog", { name: "Generation details" }).getByRole("button", { name: "Close", exact: true }).boundingBox();
  expect(lbClose).not.toBeNull();
  expect(lbClose!.y).toBeGreaterThan(vp.height * 0.8);
  expect(lbClose!.x).toBeGreaterThan(vp.width / 2);
  expect(lbClose!.height).toBeGreaterThanOrEqual(48);
  await openViewer(app);
  const vClose = await app.getByRole("dialog", { name: "Generated image" }).getByRole("button", { name: "Close", exact: true }).boundingBox();
  expect(vClose).not.toBeNull();
  expect(vClose!.y).toBeGreaterThan(vp.height * 0.85);
  expect(vClose!.x).toBeGreaterThan(vp.width / 2);
  expect(vClose!.height).toBeGreaterThanOrEqual(48);
});

test("mobile swipe-down closes the viewer only", async ({ app }) => {
  test.skip(test.info().project.name !== "mobile", "touch swipe is mobile-only");
  await seedLibrary(app, { records: [{ prompt: "Swipe away" }] });
  await app.goto("/");
  await openLightbox(app);
  await openViewer(app);
  await app.locator(".ref-view-img").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const mk = (type: string, y: number) => {
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === "touchstart" ? [t] : [],
          changedTouches: [t],
        })
      );
    };
    mk("touchstart", r.y + 100);
    mk("touchend", r.y + 220);
  });
  await expect(app.getByRole("dialog", { name: "Generated image" })).toBeHidden();
  await expect(app.getByRole("dialog", { name: "Generation details" })).toBeVisible();
});
