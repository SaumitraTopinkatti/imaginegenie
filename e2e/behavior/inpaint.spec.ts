// Inpaint flows: prompt wrap + ref order, knob, guards, cancel, tag,
// mid-flight tab switch, composite pixels, backup survival. Roles/names only.
import type { Page } from "@playwright/test";
import { test, expect, seedLibrary, gotoTab, fillKey, loggedWithPrompt, paintStroke, marker, type MockRequest } from "../fixtures";
import { pngDataUrl } from "../mock-api/png.mjs";

async function openPicker(app: Page) {
  await app.getByRole("button", { name: /Choose image|Change image/ }).first().click();
  await expect(app.getByRole("dialog", { name: "Choose image" })).toBeVisible();
}

async function pickFirstGeneration(app: Page) {
  await openPicker(app);
  await app.getByRole("button", { name: /^Use image:/ }).first().click();
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
}

async function fullFlow(app: Page, instruction: string) {
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(instruction);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
}

function refsOf(r: MockRequest): Array<{ url: string }> {
  const body = r.body as { input_references?: Array<{ image_url?: { url?: string } }> };
  return (body.input_references ?? []).map((e) => ({ url: e.image_url?.url ?? "" }));
}

test("default flow sends [original, marked] with the wrapped prompt", async ({ app }) => {
  const m = marker("inpaint-default");
  await seedLibrary(app, { records: [{ prompt: "Source scene", imageUrl: pngDataUrl(192, 128, "solid") }] });
  await fullFlow(app, `replace this with a basketball ${m}`);
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  const body = reqs[0].body as { prompt: string; n: number; aspect_ratio: string };
  expect(body.n).toBe(1);
  expect(body.aspect_ratio).not.toBe("auto");
  expect(body.aspect_ratio).toBe("3:2");
  expect(body.prompt).toContain(`replace this with a basketball ${m}`);
  expect(body.prompt).toContain("Two images");
  const refs = refsOf(reqs[0]);
  expect(refs).toHaveLength(2);
  // Both refs decode to identical dimensions (D3: same base canvas).
  const dims = await app.evaluate(async (urls: string[]) => {
    const sizes = [];
    for (const u of urls) {
      const img = new Image();
      img.src = u;
      await img.decode();
      sizes.push([img.naturalWidth, img.naturalHeight]);
    }
    return sizes;
  }, refs.map((r) => r.url));
  expect(dims[0]).toEqual(dims[1]);
  // Saved + tagged in Studio with the instruction (not the wrapper).
  await gotoTab(app, "studio");
  await expect(app.getByText(`replace this with a basketball ${m}`).first()).toBeVisible();
  await expect(app.locator("#gallery").getByText("Inpaint", { exact: true }).first()).toBeVisible();
});

test("knob off sends only the marked copy", async ({ app }) => {
  const m = marker("inpaint-knob");
  await seedLibrary(app, { records: [{ prompt: "Knob source", imageUrl: pngDataUrl(128, 128, "solid") }] });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`remove it ${m}`);
  await app.getByText("Advanced").click();
  await app.getByText("Send original as reference").click();
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect(refsOf(reqs[0])).toHaveLength(1);
  expect((reqs[0].body as { prompt: string }).prompt).toContain("One image is attached");
});

test("guards send zero requests", async ({ app }) => {
  const m = marker("inpaint-guard");
  await seedLibrary(app, { records: [{ prompt: "Guard source", imageUrl: pngDataUrl(128, 128, "solid") }] });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  // No source.
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`guarded ${m}`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator("#inpaint-error")).toContainText("Choose an image");
  // No mask.
  await pickFirstGeneration(app);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator("#inpaint-error")).toContainText("Paint the area");
  // Empty instruction.
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill("");
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator("#inpaint-error")).toContainText("Describe the change");
  expect(await loggedWithPrompt(m)).toEqual([]);
});

test("no key and degraded crypto send zero requests", async ({ app }) => {
  const m = marker("inpaint-key");
  await seedLibrary(app, { records: [{ prompt: "Key source", imageUrl: pngDataUrl(128, 128, "solid") }] });
  await app.reload();
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`keyless ${m}`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator("#inpaint-error")).toContainText("API key");
  await fillKey(app, "sk-or-test-ok");
  await app.evaluate(() => window.__e2e__?.setDegraded("WebCrypto is unavailable (e2e)."));
  await app.reload();
  await gotoTab(app, "inpaint");
  // Strokes don't survive reload (memory-only): repaint.
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`keyless ${m}`);
  // Degraded disables the button outright (mirrors Studio): nothing to click.
  await expect(app.getByRole("button", { name: /Generate ·/ })).toBeDisabled();
  expect(await loggedWithPrompt(m)).toEqual([]);
});

test("cancel aborts the run", async ({ app }) => {
  const m = marker("inpaint-cancel");
  await seedLibrary(app, { records: [{ prompt: "Cancel source", imageUrl: pngDataUrl(128, 128, "solid") }] });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`slow one ${m} [[mock:delay,ms=8000]]`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.getByRole("button", { name: /^Cancel ·/ })).toBeVisible();
  await app.getByRole("button", { name: /^Cancel ·/ }).click();
  await expect(app.locator("#inpaint-error")).toContainText("Cancelled", { timeout: 10000 });
  await expect(app.locator(".mask-overlay")).toBeVisible();
});

test("tab switch mid-flight still lands the result", async ({ app }) => {
  const m = marker("inpaint-flight");
  await seedLibrary(app, { records: [{ prompt: "Flight source", imageUrl: pngDataUrl(128, 128, "solid") }] });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`patient ${m} [[mock:delay,ms=4000]]`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await gotoTab(app, "studio");
  await expect(app.locator(".inpaint-result-img")).toBeHidden();
  await gotoTab(app, "inpaint");
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
  await gotoTab(app, "studio");
  await expect(app.locator("#gallery").getByText("Inpaint", { exact: true }).first()).toBeVisible();
});

test("marked overlay is translucent and uniform; refs share dimensions", async ({ app }) => {
  const m = marker("inpaint-tint");
  await seedLibrary(app, { records: [{ prompt: "Tint source", imageUrl: pngDataUrl(160, 160, "solid") }] });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  // Crossing strokes: overlap must not stack darker (D2 vector replay).
  await paintStroke(app, { x: 0.2, y: 0.4 }, { x: 0.8, y: 0.4 });
  await paintStroke(app, { x: 0.5, y: 0.2 }, { x: 0.5, y: 0.6 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`tint check ${m}`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
  const reqs = await loggedWithPrompt(m);
  const refs = refsOf(reqs[0]);
  expect(refs).toHaveLength(2);
  // Sample points depend on the input path: desktop drags cross at (0.5,0.4)
  // while mobile taps land dabs at the stroke endpoints.
  const mobile = test.info().project.name === "mobile";
  const pts = mobile
    ? { a: [0.2, 0.4] as const, b: [0.5, 0.2] as const }
    : { a: [0.3, 0.4] as const, b: [0.5, 0.4] as const };
  const check = await app.evaluate(
    async ({ urls, a, b }: { urls: string[]; a: readonly [number, number]; b: readonly [number, number] }) => {    const load = async (u: string) => {
      const img = new Image();
      img.src = u;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")!.drawImage(img, 0, 0);
      return c;
    };
    const [orig, marked] = await Promise.all(urls.map(load));
    const sameDims = orig.width === marked.width && orig.height === marked.height;
    const mctx = marked.getContext("2d", { willReadFrequently: true })!;
    const px = (fx: number, fy: number) => {
      const d = mctx.getImageData(Math.floor(marked.width * fx), Math.floor(marked.height * fy), 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const single = px(a[0], a[1]);
    const cross = px(b[0], b[1]);
    const diff = Math.abs(single[0] - cross[0]) + Math.abs(single[1] - cross[1]) + Math.abs(single[2] - cross[2]);
    // Marked copy is red-shifted vs the clean original at the same point.
    const clean = (() => {
      const c = orig.getContext("2d", { willReadFrequently: true })!;
      const d = c.getImageData(Math.floor(orig.width * 0.5), Math.floor(orig.height * 0.4), 1, 1).data;
      return [d[0], d[1], d[2]];
    })();
    const shift = Math.abs(cross[0] - clean[0]) + Math.abs(cross[1] - clean[1]) + Math.abs(cross[2] - clean[2]);
    return { sameDims, diff, shift };
  }, { urls: refs.map((r) => r.url), a: pts.a, b: pts.b });
  expect(check.sameDims).toBe(true);
  expect(check.diff).toBeLessThanOrEqual(18);
  expect(check.shift).toBeGreaterThan(30);
});

test("pixel-exact composite: outside equals source, centre equals output", async ({ app }) => {
  const m = marker("inpaint-pixel");
  const srcUrl = pngDataUrl(128, 128, "solid");
  await seedLibrary(app, { records: [{ prompt: "Pixel source", imageUrl: srcUrl }] });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.4, y: 0.4 }, { x: 0.6, y: 0.6 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`pixel check ${m}`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
  await gotoTab(app, "studio");
  const resultUrl: string = await app.evaluate(() => {
    const img = document.querySelector("#gallery .card img") as HTMLImageElement | null;
    return img?.src ?? "";
  });
  const outUrl = pngDataUrl(96, 96, "gradient"); // mock output fixture
  const cmp = await app.evaluate(
    async ({ result, src, out }: { result: string; src: string; out: string }) => {
      const load = async (u: string) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d")!.drawImage(img, 0, 0);
        return c;
      };
      const [r, s, o] = await Promise.all([load(result), load(src), load(out)]);
      const px = (c: HTMLCanvasElement, fx: number, fy: number) => {
        const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(
          Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1
        ).data;
        return [d[0], d[1], d[2]];
      };
      const dist = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      return {
        outside: dist(px(r, 0.05, 0.05), px(s, 0.05, 0.05)),
        centre: dist(px(r, 0.5, 0.5), px(o, 0.5, 0.5)),
      };
    },
    { result: resultUrl, src: srcUrl, out: outUrl }
  );
  // JPEG round trips: small tolerance, not exact equality.
  expect(cmp.outside).toBeLessThanOrEqual(36);
  expect(cmp.centre).toBeLessThanOrEqual(60);
});

test("entry points: lightbox, viewer and references segment", async ({ app }) => {
  await seedLibrary(app, {
    records: [{ prompt: "Entry gen", imageUrl: pngDataUrl(128, 128, "solid") }],
    references: [{ name: "Entry ref", imageUrl: pngDataUrl(128, 128, "gradient") }],
  });
  await app.reload();
  await app.getByRole("button", { name: /^Open image 1:/ }).click();
  await app.getByRole("dialog", { name: "Generation details" }).getByRole("button", { name: "Inpaint", exact: true }).click();
  await expect(app.locator("#inpaint-main")).toBeFocused();
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
  // Viewer entry.
  await gotoTab(app, "refs");
  await app.getByRole("button", { name: "View Entry ref full size" }).first().click();
  await app.getByRole("dialog", { name: "Reference image" }).getByRole("button", { name: "Inpaint", exact: true }).click();
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
  // Picker references segment.
  await openPicker(app);
  await app.getByRole("button", { name: "References", exact: true }).click();
  await app.getByRole("button", { name: "Use reference Entry ref" }).click();
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
});

test("undo/redo/clear gate the mask", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "History source", imageUrl: pngDataUrl(128, 128, "solid") }] });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill("history check");
  // Undo until the mask is empty (tap path paints several dab strokes).
  const undoBtn = app.getByRole("button", { name: "Undo" });
  for (let i = 0; i < 5 && await undoBtn.isEnabled(); i++) await undoBtn.click();
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator("#inpaint-error")).toContainText("Paint the area");
  await app.getByRole("button", { name: "Redo" }).click();
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
});

test("backup round trip keeps inpaint metadata", async ({ app }) => {
  const m = marker("inpaint-backup");
  await seedLibrary(app, { records: [{ prompt: "Backup source", imageUrl: pngDataUrl(128, 128, "solid") }] });
  await fullFlow(app, `backup lady ${m}`);
  await gotoTab(app, "studio");
  await app.getByRole("button", { name: "Library", exact: true }).click();
  await app.getByRole("button", { name: "Back up library" }).click();
  await app.getByLabel("Passphrase", { exact: true }).fill("inpaint-rt-99");
  await app.getByLabel("Confirm passphrase").fill("inpaint-rt-99");
  const [dl] = await Promise.all([
    app.waitForEvent("download"),
    app.getByRole("button", { name: "Download backup" }).click(),
  ]);
  const path = await dl.path();
  await app.keyboard.press("Escape");
  await app.evaluate(() => window.__e2e__?.reset());
  await app.reload();
  await app.locator('input[type="file"][accept="application/json"]').setInputFiles(path!);
  await app.getByLabel("Passphrase", { exact: true }).fill("inpaint-rt-99");
  await app.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(app.locator("#gallery .card")).toHaveCount(2, { timeout: 10000 });
  await expect(app.getByText(`backup lady ${m}`).first()).toBeVisible();
  await expect(app.locator("#gallery").getByText("Inpaint", { exact: true }).first()).toBeVisible();
});
