// N11–N14 visual regressions: picker surface, label overflow, cursor
// alignment, size preview + wheel. Roles/names + geometry only.
import type { Page } from "@playwright/test";
import { test, expect, seedLibrary, gotoTab } from "../fixtures";
import { pngDataUrl } from "../mock-api/png.mjs";

async function pickFirstGeneration(app: Page) {
  await app.getByRole("button", { name: /Choose image|Change image/ }).first().click();
  await expect(app.getByRole("dialog", { name: "Choose image" })).toBeVisible();
  await app.getByRole("button", { name: /^Use image:/ }).first().click();
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
}

async function coarse(app: Page) {
  return app.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
}

test("picker is a surfaced modal with an internal scroll grid", async ({ app }) => {
  await seedLibrary(app, {
    records: Array.from({ length: 20 }, (_, i) => ({
      prompt: `Picker subject ${i}`,
      imageUrl: pngDataUrl(96, 96, "solid"),
    })),
  });
  await app.reload();
  await gotoTab(app, "inpaint");
  await app.getByRole("button", { name: /Choose image|Change image/ }).first().click();
  const panel = app.getByRole("dialog", { name: "Choose image" });
  await expect(panel).toBeVisible();
  // Surfaced: opaque background, desktop width >= 600px.
  const bg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toMatch(/rgba\(.*,\s*0\s*\)/);
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  if (test.info().project.name === "desktop") {
    expect(box!.width).toBeGreaterThanOrEqual(600);
    // Roomy grid: >= 4 columns at 1280px.
    const lefts = await panel.locator(".picker-thumb").evaluateAll((els) => {
      const rs = els.map((el) => (el as HTMLElement).getBoundingClientRect());
      const firstRow = Math.min(...rs.map((r) => r.top));
      return new Set(
        rs.filter((r) => Math.abs(r.top - firstRow) < 4).map((r) => r.left.toFixed(0))
      ).size;
    });
    expect(lefts).toBeGreaterThanOrEqual(4);
  }
  // Only the grid body scrolls: 20 records overflow it, panel keeps its box.
  const body = panel.locator(".picker-body");
  const scrolled = await body.evaluate((el) => el.scrollHeight > el.clientHeight + 20);
  expect(scrolled).toBe(true);
  const heightBefore = box!.height;
  await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  expect((await panel.boundingBox())!.height).toBeCloseTo(heightBefore, 0);
  // Captions tell identical images apart.
  await expect(panel.locator(".picker-cap").first()).toContainText("Picker subject 0");
});

test("200-char source label stays inside the controls panel", async ({ app }) => {
  const longName = `L${"o".repeat(198)}ng`;
  await seedLibrary(app, { references: [{ name: longName }] });
  await app.reload();
  await gotoTab(app, "inpaint");
  await app.getByRole("button", { name: /Choose image|Change image/ }).first().click();
  await app.getByRole("button", { name: /^References/ }).click();
  await app.getByRole("button", { name: `Use reference ${longName}` }).click();
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
  // Accessible name still carries the full label.
  await expect(app.getByRole("button", { name: `Change image, currently: ${longName}` })).toBeVisible();
  const row = await app.locator(".inpaint-source-row").boundingBox();
  const controls = await app.locator(".inpaint-controls").boundingBox();
  expect(row).not.toBeNull();
  expect(controls).not.toBeNull();
  expect(row!.x).toBeGreaterThanOrEqual(controls!.x - 1);
  expect(row!.x + row!.width).toBeLessThanOrEqual(controls!.x + controls!.width + 1);
});

test("brush ring sits exactly under the pointer, top to bottom", async ({ app }) => {
  test.skip(await coarse(app), "cursor ring is a fine-pointer affordance");
  await seedLibrary(app, { records: [{ prompt: "Cursor subject", imageUrl: pngDataUrl(192, 128, "solid") }] });
  await app.reload();
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  const overlay = app.locator(".mask-overlay");
  await overlay.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = (await overlay.boundingBox())!;
  const ring = app.locator(".mask-cursor");
  for (const f of [{ x: 0.5, y: 0.04 }, { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.96 }]) {
    const px = box.x + box.width * f.x;
    const py = box.y + box.height * f.y;
    await app.mouse.move(px, py);
    await expect(ring).toBeVisible();
    const rbox = (await ring.boundingBox())!;
    expect(rbox.width).toBeGreaterThan(0);
    expect(Math.abs(rbox.x + rbox.width / 2 - px)).toBeLessThanOrEqual(1);
    expect(Math.abs(rbox.y + rbox.height / 2 - py)).toBeLessThanOrEqual(1);
  }
  // Page scroll must not drift the frame.
  await app.mouse.wheel(0, 300);
  const px = box.x + box.width * 0.5;
  const fresh = (await overlay.boundingBox())!;
  const py = fresh.y + fresh.height * 0.5;
  await app.mouse.move(px, py);
  const rbox = (await ring.boundingBox())!;
  expect(Math.abs(rbox.x + rbox.width / 2 - px)).toBeLessThanOrEqual(1);
  expect(Math.abs(rbox.y + rbox.height / 2 - py)).toBeLessThanOrEqual(1);
});

test("wheel over Size steps the value without scrolling; preview shows and fades", async ({ app }) => {
  test.skip(await coarse(app), "wheel is a fine-pointer affordance");
  await seedLibrary(app, { records: [{ prompt: "Wheel subject", imageUrl: pngDataUrl(192, 128, "solid") }] });
  await app.reload();
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  const slider = app.getByRole("slider", { name: /Brush size/ });
  const before = Number(await slider.getAttribute("value"));
  const scrollYBefore = await app.evaluate(() => window.scrollY);
  await slider.hover();
  await app.mouse.wheel(0, -240);
  const after = Number(await slider.getAttribute("value"));
  expect(after).toBeGreaterThan(before);
  expect(await app.evaluate(() => window.scrollY)).toBe(scrollYBefore);
  // Centred preview at the true diameter, then gone ~1s after.
  const preview = app.locator(".mask-size-preview");
  await expect(preview).toBeVisible();
  const pbox = (await preview.boundingBox())!;
  expect(Math.abs(pbox.width - after)).toBeLessThanOrEqual(1);
  await expect(preview).toBeHidden({ timeout: 4000 });
});

test("preview diameter matches the painted dab diameter", async ({ app }) => {
  test.skip(await coarse(app), "dab path is shared; measured on desktop");
  await seedLibrary(app, { records: [{ prompt: "Dab subject", imageUrl: pngDataUrl(160, 160, "solid") }] });
  await app.reload();
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  const slider = app.getByRole("slider", { name: /Brush size/ });
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = "44";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const overlay = app.locator(".mask-overlay");
  await overlay.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const box = (await overlay.boundingBox())!;
  // Single click stamps a dab (no drag).
  await app.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await app.mouse.down();
  await app.mouse.up();
  const dabD = await overlay.evaluate((canvas: HTMLCanvasElement) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return -1;
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let maxX = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (d[(y * canvas.width + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    if (maxX < 0) return -1;
    return ((maxX - minX + 1) * canvas.getBoundingClientRect().width) / canvas.width;
  });
  expect(dabD).toBeGreaterThan(0);
  expect(Math.abs(dabD - 44)).toBeLessThanOrEqual(2);
});
