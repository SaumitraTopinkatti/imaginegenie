// Inpaint sizing (N20): the loader keeps the canvas box on tall sources and
// the result lands at exactly the painted size. Roles/names only.
import type { Page } from "@playwright/test";
import { test, expect, seedLibrary, gotoTab, fillKey, paintStroke, marker } from "../fixtures";
import { pngDataUrl } from "../mock-api/png.mjs";

async function setupTall(app: Page, m: string, delayMs: number) {
  await seedLibrary(app, { records: [{ prompt: "Tall source", imageUrl: pngDataUrl(96, 192, "solid") }] });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await app.getByRole("button", { name: /Choose image|Change image/ }).first().click();
  await expect(app.getByRole("dialog", { name: "Choose image" })).toBeVisible();
  await app.getByRole("button", { name: /^Use image:/ }).first().click();
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
  // Border-inclusive canvas box: the wrap hugs the base image 1:1 (N4a).
  const canvasBox = await app.locator(".mask-canvas-wrap").boundingBox();
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`tall ${m} [[mock:delay,ms=${delayMs}]]`);
  return canvasBox!;
}

test("loader on a tall source stays viewport-fit and doesn't grow the page", async ({ app }) => {
  const m = marker("inpaint-loader-fit");
  const canvasBox = await setupTall(app, m, 4000);
  const pageBefore = await app.evaluate(() => document.scrollingElement?.scrollHeight ?? 0);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  const frame = app.locator(".inpaint-loader .denoise-frame");
  await expect(frame).toBeVisible();
  const box = await frame.boundingBox();
  const vh = await app.evaluate(() => window.innerHeight);
  // Pinned to the measured canvas box (N20): no jump, fully on screen.
  expect(Math.abs(box!.width - canvasBox.width)).toBeLessThanOrEqual(3);
  expect(Math.abs(box!.height - canvasBox.height)).toBeLessThanOrEqual(3);
  expect(box!.height).toBeLessThanOrEqual(vh * 0.7 + 2);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 4);
  const pageDuring = await app.evaluate(() => document.scrollingElement?.scrollHeight ?? 0);
  expect(pageDuring).toBeLessThanOrEqual(pageBefore + 8);
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
});

test("result lands at the painted canvas size", async ({ app }) => {
  const m = marker("inpaint-result-size");
  const canvasBox = await setupTall(app, m, 500);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  const img = app.locator(".inpaint-result-img");
  await expect(img).toBeVisible({ timeout: 20000 });
  // Same column, same max constraints (N20): Before/After match the canvas.
  const r = await img.boundingBox();
  expect(Math.abs(r!.width - canvasBox.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(r!.height - canvasBox.height)).toBeLessThanOrEqual(2);
});
