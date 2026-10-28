// Inpaint flows: prompt wrap + ref order, knob, guards, cancel, tag,
// mid-flight tab switch, composite pixels, backup survival. Roles/names only.
import type { Page } from "@playwright/test";
import { test, expect, seedLibrary, gotoTab, fillKey, loggedWithPrompt, paintStroke, marker, openSourcePicker, pickFirstGeneration, ensureInpaintControlsOpen, closeInpaintControls, type MockRequest } from "../fixtures";
import { pngDataUrl } from "../mock-api/png.mjs";

async function fullFlow(app: Page, instruction: string) {
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await ensureInpaintControlsOpen(app);
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(instruction);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
}

function refsOf(r: MockRequest): Array<{ url: string }> {
  const body = r.body as { input_references?: Array<{ image_url?: { url?: string } }> };
  return (body.input_references ?? []).map((e) => ({ url: e.image_url?.url ?? "" }));
}

/** Extra-reference upload: the section's own file input (hidden, always mounted). */
const extraInput = (app: Page) => app.locator('#inpaint-main input[type="file"]');
function pngFile(w: number, h: number, kind: "solid" | "gradient", name = "extra.png") {
  return { name, mimeType: "image/png", buffer: Buffer.from(pngDataUrl(w, h, kind).split(",")[1], "base64") };
}
async function decodedDims(app: Page, urls: string[]) {
  return app.evaluate(async (list: string[]) => {
    const sizes: number[][] = [];
    for (const u of list) {
      const img = new Image();
      img.src = u;
      await img.decode();
      sizes.push([img.naturalWidth, img.naturalHeight]);
    }
    return sizes;
  }, urls);
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
  await ensureInpaintControlsOpen(app);
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
  await ensureInpaintControlsOpen(app);
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`guarded ${m}`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator("#inpaint-error")).toContainText("Choose an image");
  // No mask.
  await pickFirstGeneration(app);
  await ensureInpaintControlsOpen(app);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator("#inpaint-error")).toContainText("Paint the area");
  // Empty instruction.
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await ensureInpaintControlsOpen(app);
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
  await ensureInpaintControlsOpen(app);
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
  await ensureInpaintControlsOpen(app);
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
  await ensureInpaintControlsOpen(app);
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
  await ensureInpaintControlsOpen(app);
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
  await ensureInpaintControlsOpen(app);
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
  await ensureInpaintControlsOpen(app);
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
  // Scope to .lb-body: the mobile .lb-dock (sibling, outside the body) has its own Inpaint button.
  await app.getByRole("dialog", { name: "Generation details" }).locator(".lb-body").getByRole("button", { name: "Inpaint", exact: true }).click();
  await expect(app.locator("#inpaint-main")).toBeFocused();
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
  // Viewer entry.
  await gotoTab(app, "refs");
  await app.getByRole("button", { name: "View Entry ref full size" }).first().click();
  await app.getByRole("dialog", { name: "Reference image" }).getByRole("button", { name: "Inpaint", exact: true }).click();
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
  // Picker references segment.
  await openSourcePicker(app);
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
  await ensureInpaintControlsOpen(app);
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill("history check");
  // Undo/Redo live in the mask toolbar behind the sheet's backdrop.
  await closeInpaintControls(app);
  // Undo until the mask is empty (tap path paints several dab strokes).
  const undoBtn = app.getByRole("button", { name: "Undo" });
  for (let i = 0; i < 5 && await undoBtn.isEnabled(); i++) await undoBtn.click();
  await ensureInpaintControlsOpen(app);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator("#inpaint-error")).toContainText("Paint the area");
  await closeInpaintControls(app);
  await app.getByRole("button", { name: "Redo" }).click();
  await ensureInpaintControlsOpen(app);
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

/* ---------- optional extra references (Seedream) ---------- */

async function paintedInpaint(app: Page, records: Array<{ prompt: string; imageUrl: string }>) {
  await seedLibrary(app, { records });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await ensureInpaintControlsOpen(app);
}

test("uploaded extra refs follow the base images: order, prompt, cost", async ({ app }) => {
  const m = marker("inpaint-extra");
  await paintedInpaint(app, [{ prompt: "Extra source", imageUrl: pngDataUrl(192, 128, "solid") }]);
  await extraInput(app).setInputFiles([pngFile(40, 40, "gradient", "a.png"), pngFile(40, 40, "solid", "b.png")]);
  await expect(app.getByText("2 / 12", { exact: true })).toBeVisible();
  await expect(app.getByRole("button", { name: "Remove reference 2" })).toBeVisible();
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`extra two ${m}`);
  // 1K: 0.045 + 4 refs x 0.003 = 0.057.
  await expect(app.getByRole("button", { name: /Generate · \$0\.057/ })).toBeVisible();
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect((reqs[0].body as { prompt: string }).prompt).toContain("The last 2 attached images are extra references");
  const refs = refsOf(reqs[0]);
  expect(refs).toHaveLength(4);
  // Base pair share the source grid; the extras keep their own upload size, in order.
  const dims = await decodedDims(app, refs.map((r) => r.url));
  expect(dims[0]).toEqual(dims[1]);
  expect(dims[0]).not.toEqual([40, 40]);
  expect(dims[2]).toEqual([40, 40]);
  expect(dims[3]).toEqual([40, 40]);
});

test("knob off with one extra sends [marked, extra]", async ({ app }) => {
  const m = marker("inpaint-extra-knob");
  await paintedInpaint(app, [{ prompt: "Extra knob source", imageUrl: pngDataUrl(128, 128, "solid") }]);
  await extraInput(app).setInputFiles([pngFile(48, 48, "gradient")]);
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`remove it ${m}`);
  await app.getByText("Advanced").click();
  await app.getByText("Send original as reference").click();
  // 1K: 0.045 + 2 refs x 0.003 = 0.051.
  await expect(app.getByRole("button", { name: /Generate · \$0\.051/ })).toBeVisible();
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect(refsOf(reqs[0])).toHaveLength(2);
  const prompt = (reqs[0].body as { prompt: string }).prompt;
  expect(prompt).toContain("One image is attached");
  expect(prompt).toContain("The last attached image is an extra reference");
});

test("library refs: multi-select adds the picks in one step", async ({ app }) => {
  const m = marker("inpaint-extra-lib");
  await seedLibrary(app, {
    records: [{ prompt: "Lib source", imageUrl: pngDataUrl(128, 128, "solid") }],
    references: [
      { name: "Lib one", imageUrl: pngDataUrl(64, 64, "gradient") },
      { name: "Lib two", imageUrl: pngDataUrl(64, 64, "solid") },
    ],
  });
  await app.reload();
  await fillKey(app, "sk-or-test-ok");
  await gotoTab(app, "inpaint");
  await pickFirstGeneration(app);
  await paintStroke(app, { x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 });
  await ensureInpaintControlsOpen(app);
  await app.getByRole("button", { name: "From library" }).click();
  const dlg = app.getByRole("dialog", { name: "Add reference images" });
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "Select reference Lib one" }).click();
  await dlg.getByRole("button", { name: "Select reference Lib two" }).click();
  await expect(dlg.getByRole("button", { name: "Select reference Lib two" })).toHaveAttribute("aria-pressed", "true");
  await dlg.getByRole("button", { name: "Add 2 references" }).click();
  await expect(dlg).toBeHidden();
  await expect(app.getByText("2 / 12", { exact: true })).toBeVisible();
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`library pick ${m}`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator(".inpaint-result-img")).toBeVisible({ timeout: 20000 });
  const reqs = await loggedWithPrompt(m);
  expect(reqs).toHaveLength(1);
  expect(refsOf(reqs[0])).toHaveLength(4);
  expect((reqs[0].body as { prompt: string }).prompt).toContain("The last 2 attached images are extra references");
});

test("extra cap: over-limit upload refused, remove frees a slot", async ({ app }) => {
  await paintedInpaint(app, [{ prompt: "Cap source", imageUrl: pngDataUrl(128, 128, "solid") }]);
  const thirteen = Array.from({ length: 13 }, (_, i) => pngFile(24, 24, "solid", `r${i}.png`));
  await extraInput(app).setInputFiles(thirteen);
  await expect(app.getByText("Limit is 12 extra references (14 total)", { exact: false })).toBeVisible();
  await expect(app.getByText("0 / 12", { exact: true })).toBeVisible();
  await extraInput(app).setInputFiles(thirteen.slice(0, 2));
  await expect(app.getByText("2 / 12", { exact: true })).toBeVisible();
  await app.getByRole("button", { name: "Remove reference 1" }).click();
  await expect(app.getByText("1 / 12", { exact: true })).toBeVisible();
  await expect(app.getByRole("button", { name: "Remove reference 2" })).toBeHidden();
});

test("knob on with 13 extras: blocked before any request", async ({ app }) => {
  const m = marker("inpaint-extra-cap");
  await paintedInpaint(app, [{ prompt: "Over cap source", imageUrl: pngDataUrl(128, 128, "solid") }]);
  // Knob off leaves 13 slots; turning it back on makes 2 + 13 = 15 > 14.
  await app.getByText("Advanced").click();
  await app.getByText("Send original as reference").click();
  await extraInput(app).setInputFiles(Array.from({ length: 13 }, (_, i) => pngFile(24, 24, "solid", `c${i}.png`)));
  await expect(app.getByText("13 / 13", { exact: true })).toBeVisible();
  await app.getByText("Send original as reference").click();
  await expect(app.getByText("13 / 12 · remove 1", { exact: true })).toBeVisible();
  await app.getByRole("textbox", { name: "Inpaint instruction" }).fill(`over cap ${m}`);
  await app.getByRole("button", { name: /Generate ·/ }).click();
  await expect(app.locator("#inpaint-error")).toContainText("remove 1");
  await expect(app.locator("#inpaint-error")).toContainText("No request was sent");
  expect(await loggedWithPrompt(m)).toEqual([]);
});

test("extra refs survive a tab switch", async ({ app }) => {
  await paintedInpaint(app, [{ prompt: "Switch source", imageUrl: pngDataUrl(128, 128, "solid") }]);
  await extraInput(app).setInputFiles([pngFile(32, 32, "gradient")]);
  await expect(app.getByText("1 / 12", { exact: true })).toBeVisible();
  await gotoTab(app, "studio");
  await gotoTab(app, "inpaint");
  await ensureInpaintControlsOpen(app);
  await expect(app.getByText("1 / 12", { exact: true })).toBeVisible();
  await expect(app.getByRole("button", { name: "Remove reference 1" })).toBeVisible();
});
