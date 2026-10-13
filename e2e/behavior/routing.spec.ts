// History-API routing: deep links, back/forward, unknown paths, ?src=
// resolution. Roles/names only — URLs asserted via toHaveURL.
import { test, expect, seedLibrary, gotoTab } from "../fixtures";

test("direct goto lands on each page with title, skip link and aria-current", async ({ app }) => {
  const cases = [
    { path: "/references", title: /References/, section: "#ref-library", link: /^References/, skip: "Skip to references" },
    { path: "/inpaint", title: /Inpaint/, section: "#inpaint-main", link: /^Inpaint/, skip: "Skip to inpaint" },
  ] as const;
  for (const c of cases) {
    await app.goto(c.path);
    await expect(app.locator(c.section)).toBeVisible();
    await expect(app).toHaveTitle(c.title);
    await expect(app.getByRole("link", { name: c.skip })).toBeVisible();
    // Drawer links hide with the closed drawer (aria-hidden): open it first.
    await app.getByRole("button", { name: /sections menu/i }).click();
    const link = app.getByRole("link", { name: c.link });
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(link).toHaveAttribute("href", c.path);
    await app.keyboard.press("Escape");
  }
  await app.goto("/");
  await expect(app.locator("#gallery")).toBeVisible();
  await expect(app).toHaveTitle(/Studio/);
});

test("unknown path and odd casing normalise to Studio at /", async ({ app }) => {
  await app.goto("/nope");
  await expect(app.locator("#gallery")).toBeVisible();
  await expect(app).toHaveURL(/\/$/);
  await app.goto("/REFERENCES/");
  await expect(app.locator("#ref-library")).toBeVisible();
});

test("back/forward cycles Studio, References, Inpaint", async ({ app }) => {
  await app.goto("/");
  await gotoTab(app, "refs");
  await expect(app).toHaveURL(/\/references$/);
  await gotoTab(app, "inpaint");
  await expect(app).toHaveURL(/\/inpaint$/);
  await app.goBack();
  await expect(app.locator("#ref-library")).toBeVisible();
  await expect(app).toHaveURL(/\/references$/);
  await app.goBack();
  await expect(app.locator("#gallery")).toBeVisible();
  await expect(app).toHaveURL(/\/$/);
  await app.goForward();
  await expect(app.locator("#ref-library")).toBeVisible();
});

test("drawer links carry the real href (open-in-new-tab works)", async ({ app }) => {
  await app.getByRole("button", { name: /sections menu/i }).click();
  await expect(app.getByRole("link", { name: /^Studio/ })).toHaveAttribute("href", "/");
  await expect(app.getByRole("link", { name: /^References/ })).toHaveAttribute("href", "/references");
  await expect(app.getByRole("link", { name: /^Inpaint/ })).toHaveAttribute("href", "/inpaint");
});

test("inpaint ?src=gen: loads that image after a reload", async ({ app }) => {
  const { recordIds } = await seedLibrary(app, { records: [{ prompt: "Deep link source" }] });
  await app.goto(`/inpaint?src=gen:${recordIds[0]}`);
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
  await expect(app).toHaveURL(new RegExp(`/inpaint\\?src=gen:${recordIds[0]}$`));
});

test("inpaint ?src=ref: loads that reference after a reload", async ({ app }) => {
  const { referenceIds } = await seedLibrary(app, { references: [{ name: "Deep ref" }] });
  await app.goto(`/inpaint?src=ref:${referenceIds[0]}`);
  await expect(app.locator(".mask-overlay")).toBeVisible({ timeout: 8000 });
});

test("missing ?src= id toasts and cleans the URL", async ({ app }) => {
  await app.goto("/inpaint?src=gen:does-not-exist");
  await expect(app.getByRole("status").getByText("That image isn't in the library anymore")).toBeVisible();
  await expect(app).toHaveURL(/\/inpaint$/);
});
