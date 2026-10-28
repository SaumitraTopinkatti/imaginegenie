// Guard: the dark projects really render dark. Without this a dark run could
// silently fall back to light and "pass" contrast on the wrong palette.
// Runs only under the dark / dark-mobile projects (testMatch in playwright.config.ts).
import { test, expect } from "../fixtures";

// :root[data-theme="dark"] --bg (src/index.css) = #0f1614 = rgb(15, 22, 20).
const DARK_BG = "rgb(15, 22, 20)";

test("dark projects apply the dark theme", async ({ app }) => {
  test.skip(!test.info().project.name.startsWith("dark"), "dark projects only");
  await expect(app.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await app.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
  expect(await app.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(DARK_BG);
});
