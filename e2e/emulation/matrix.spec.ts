// Emulation matrix: viewport reflow, WCAG 1.4.12 text spacing, target size.
// Runs on desktop + mobile projects only (reduced-motion/forced-colors run
// the states subset instead). Skipped there to keep runtime sane.
import type { Page } from "@playwright/test";
import { test, expect, seedLibrary, gotoTab, ensureComposerOpen } from "../fixtures";

const isEmu = () => test.info().project.name === "reduced-motion" || test.info().project.name === "forced-colors";
test.beforeEach(() => test.skip(isEmu(), "covered by states subset"));

async function assertNoPageHScroll(app: Page) {
  const overflow = await app.evaluate(() => {
    const el = document.scrollingElement!;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, "no horizontal page scroll").toBeLessThanOrEqual(1);
}

for (const [w, h] of [[320, 256], [640, 360], [960, 540], [1280, 720]] as Array<[number, number]>) {
  test(`viewport ${w}x${h}: no h-scroll, Generate reachable`, async ({ app }) => {
    await seedLibrary(app, { records: [{ prompt: `Reflow ${w}` }] });
    await app.setViewportSize({ width: w, height: h });
    await app.reload();
    await assertNoPageHScroll(app);
    if (w <= 900) {
      await app.getByRole("button", { name: /tap to expand/i }).click();
      await expect(app.getByRole("dialog", { name: "Image composer" })).toBeVisible();
    }
    await expect(app.getByRole("button", { name: /Generate/ })).toBeVisible();
    await expect(app.locator("#gallery .card").first()).toBeVisible();
  });
}

test("1.4.12 text spacing: no clipped controls, no page scroll", async ({ app }) => {
  await seedLibrary(app, {
    records: [{ prompt: "Spacing probe with a fairly long prompt snippet for wrapping" }],
    references: [{ name: "Spaced ref", description: "A longer description to wrap", group: "group-one" }],
  });
  await ensureComposerOpen(app);
  await app.getByRole("textbox", { name: "Prompt", exact: true }).fill("Spacing probe prompt with enough words to wrap across lines");
  await app.addStyleTag({
    content: `* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p, .desc, .prompt-snippet { margin-bottom: 2em !important; }`,
  });
  await assertNoPageHScroll(app);
  await expect(app.getByRole("button", { name: /Generate/ })).toBeVisible();
  // Controls keep their text inside their boxes.
  const clipped = await app.evaluate(() => {
    const bad: string[] = [];
    for (const el of document.querySelectorAll("button, input, select, a")) {
      const h = el as HTMLElement;
      if (!(h.offsetWidth > 0 && h.offsetHeight > 0)) continue;
      if (h.scrollWidth > h.clientWidth + 3 || h.scrollHeight > h.clientHeight + 3) {
        bad.push(`${h.tagName}:${(h.textContent || h.getAttribute("aria-label") || "").trim().slice(0, 40)}`);
      }
    }
    return bad.slice(0, 10);
  });
  expect(clipped, "controls without clipped text").toEqual([]);
  await gotoTab(app, "refs");
  await assertNoPageHScroll(app);
});

test("target-size sweep: visible controls meet 24px or spacing", async ({ app }) => {
  await seedLibrary(app, {
    records: [{ prompt: "Targets" }],
    references: [{ name: "Target ref" }],
  });
  await gotoTab(app, "refs");
  await gotoTab(app, "studio");
  expect(await visibleTargetViolations(app), "undersized visible targets without spacing").toEqual([]);
});

test("target-size sweep: inpaint editor controls", async ({ app }) => {
  await seedLibrary(app, { records: [{ prompt: "Inpaint targets" }] });
  await app.reload();
  await gotoTab(app, "inpaint");
  await app.getByRole("button", { name: /Choose image|Change image/ }).first().click();
  await app.getByRole("button", { name: /^Use image:/ }).first().click();
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
  expect(await visibleTargetViolations(app), "undersized inpaint targets without spacing").toEqual([]);
});

async function visibleTargetViolations(app: Page): Promise<string[]> {
  return app.evaluate(() => {
    // Closed <details> content keeps layout boxes in some engines while being
    // neither visible nor interactive: skip it like display:none.
    const els = [...document.querySelectorAll("button, a[href], input, select, [role=button]")].filter(
      (el) => {
        const h = el as HTMLElement;
        if (h.closest("details:not([open])")) return false;
        const cs = getComputedStyle(h);
        if (cs.opacity === "0" || cs.visibility === "hidden" || cs.display === "none") return false;
        const r = h.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }
    );
    const rects = els.map((el) => (el as HTMLElement).getBoundingClientRect());
    const bad: string[] = [];
    els.forEach((el, i) => {
      const r = rects[i];
      if (r.width >= 24 && r.height >= 24) return;
      // 2.5.8 spacing exception: every neighbor keeps a clear gap.
      let gap = Infinity;
      rects.forEach((o, j) => {
        if (i === j) return;
        const dx = Math.max(0, Math.max(r.left - o.right, o.left - r.right));
        const dy = Math.max(0, Math.max(r.top - o.bottom, o.top - r.bottom));
        gap = Math.min(gap, Math.hypot(dx, dy));
      });
      if (gap < 12) {
        const h = el as HTMLElement;
        bad.push(`${h.tagName}:${(h.getAttribute("aria-label") || h.textContent || "").trim().slice(0, 40)} ${Math.round(r.width)}x${Math.round(r.height)} gap=${Math.round(gap)}`);
      }
    });
    return bad;
  });
}
