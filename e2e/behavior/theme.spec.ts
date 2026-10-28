// Theme preference: system (default) | light | dark. Header toggle (>460px) or
// the same control in the drawer foot (<=460px), persisted under localStorage
// `imaginegenie-theme`, applied before the app mounts.
// Local only: no provider calls (fixture guard covers openrouter.ai anyway).
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

const KEY = "imaginegenie-theme";

const html = (page: Page) => page.locator("html");
const narrow = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 460;

/** <=460px the header toggle is hidden: open the drawer, then use its control. */
async function themeBtn(page: Page, name: string) {
  if (narrow(page)) {
    const nav = page.locator("#side-drawer");
    if (!(await nav.evaluate((el) => el.classList.contains("open")))) {
      await page.getByRole("button", { name: "Open sections menu" }).click();
      await expect(nav).toHaveClass(/open/);
    }
  }
  return page.getByRole("button", { name, exact: true });
}

test("system (default) follows the OS colour scheme live", async ({ app }) => {
  await app.emulateMedia({ colorScheme: "dark" });
  await expect(html(app)).toHaveAttribute("data-theme", "dark");
  await app.emulateMedia({ colorScheme: "light" });
  await expect(html(app)).toHaveAttribute("data-theme", "light");
  expect(await app.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
});

test("toggle cycles System, Light, Dark and persists the choice", async ({ app }) => {
  await app.emulateMedia({ colorScheme: "dark" });
  await (await themeBtn(app, "Theme: System. Switch to Light")).click();
  await expect(html(app)).toHaveAttribute("data-theme", "light");
  expect(await app.evaluate((k) => localStorage.getItem(k), KEY)).toBe("light");
  // An explicit Light ignores the OS switching to dark.
  await app.emulateMedia({ colorScheme: "light" });
  await app.emulateMedia({ colorScheme: "dark" });
  await expect(html(app)).toHaveAttribute("data-theme", "light");
  await (await themeBtn(app, "Theme: Light. Switch to Dark")).click();
  await expect(html(app)).toHaveAttribute("data-theme", "dark");
  expect(await app.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  expect(await app.evaluate((k) => localStorage.getItem(k), KEY)).toBe("dark");
  await (await themeBtn(app, "Theme: Dark. Switch to System")).click();
  await expect(await themeBtn(app, "Theme: System. Switch to Light")).toBeVisible();
  expect(await app.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
  // Back on System: the OS (emulated dark above) decides again.
  await expect(html(app)).toHaveAttribute("data-theme", "dark");
});

test("one theme control per viewport: header above 460px, drawer at 460px and below", async ({ app }) => {
  const header = app.locator(".header-actions .theme-btn");
  const drawerBtn = app.locator(".drawer-theme-btn");
  if (narrow(app)) {
    await expect(header).toBeHidden();
    await expect(drawerBtn).toBeHidden(); // drawer closed
    await (await themeBtn(app, "Theme: System. Switch to Light")).waitFor();
    await expect(drawerBtn).toBeVisible();
    const box = await drawerBtn.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  } else {
    await expect(header).toBeVisible();
    await expect(drawerBtn).toBeHidden();
  }
  await expect(app.getByRole("button", { name: /^Theme: / })).toHaveCount(1);
});

test("placement switches at the 460/461px boundary", async ({ app }) => {
  await app.setViewportSize({ width: 460, height: 844 });
  await expect(app.locator(".header-actions .theme-btn")).toBeHidden();
  await app.setViewportSize({ width: 461, height: 844 });
  await expect(app.locator(".header-actions .theme-btn")).toBeVisible();
  await expect(app.locator(".drawer-theme-btn")).toBeHidden();
});

test("choice survives reload and is set before the app bundle runs", async ({ app }) => {
  await (await themeBtn(app, "Theme: System. Switch to Light")).click();
  await (await themeBtn(app, "Theme: Light. Switch to Dark")).click();
  await expect(html(app)).toHaveAttribute("data-theme", "dark");
  // Hold the app bundle: the classic theme-init.js (in <head>) must already
  // have set data-theme, and React must not have mounted yet (no flash).
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await app.route(/\/assets\/[^/]+\.js$/, async (route) => {
    await gate;
    await route.continue();
  });
  await app.reload({ waitUntil: "commit" });
  await expect(html(app)).toHaveAttribute("data-theme", "dark");
  expect(await app.evaluate(() => document.getElementById("root")?.childElementCount ?? 0)).toBe(0);
  release();
  await expect(await themeBtn(app, "Theme: Dark. Switch to System")).toBeVisible();
  await expect(html(app)).toHaveAttribute("data-theme", "dark");
});

test("invalid stored value falls back to System", async ({ app }) => {
  await app.emulateMedia({ colorScheme: "dark" });
  await app.evaluate((k) => localStorage.setItem(k, "sepia"), KEY);
  await app.reload();
  await expect(html(app)).toHaveAttribute("data-theme", "dark");
  await expect(await themeBtn(app, "Theme: System. Switch to Light")).toBeVisible();
});

test("blocked localStorage does not break the toggle", async ({ app }) => {
  const errors: string[] = [];
  app.on("pageerror", (e) => errors.push(String(e)));
  // Only the theme key throws; every other storage call is untouched.
  await app.addInitScript((key: string) => {
    const proto = Storage.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const m of ["getItem", "setItem", "removeItem"]) {
      const orig = proto[m];
      proto[m] = function (this: unknown, k: unknown, ...rest: unknown[]) {
        if (k === key) throw new DOMException("blocked", "SecurityError");
        return orig.call(this, k, ...rest);
      };
    }
  }, KEY);
  await app.reload();
  await expect(html(app)).toHaveAttribute("data-theme", "light");
  await (await themeBtn(app, "Theme: System. Switch to Light")).click();
  await expect(html(app)).toHaveAttribute("data-theme", "light");
  await (await themeBtn(app, "Theme: Light. Switch to Dark")).click();
  await expect(html(app)).toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
});
