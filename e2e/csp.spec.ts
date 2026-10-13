// Header-parity smoke (project csp, dist-e2e under production headers):
// asserts the shipped CSP/security headers without breaking the main suite
// (connect-src forbids loopback, so generation stays on the no-CSP project).
import { test, expect } from "@playwright/test";

test("production headers ship on the e2e bundle", async ({ page }) => {
  const resp = await page.goto("/");
  expect(resp).not.toBeNull();
  const headers = resp!.headers();
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("connect-src 'self' https://openrouter.ai");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeVisible();
});

test("deep links serve index.html with production headers", async ({ page }) => {
  const resp = await page.goto("/inpaint");
  expect(resp?.status()).toBe(200);
  expect(resp!.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  await expect(page.getByRole("heading", { name: /Inpaint/ })).toBeVisible();
});

test("loopback API is blocked by connect-src (documents the split)", async ({ page }) => {
  await page.goto("/");
  const blocked = await page.evaluate(async () => {
    try {
      await fetch("http://127.0.0.1:4191/__mock/requests");
      return false;
    } catch {
      return true;
    }
  });
  expect(blocked).toBe(true);
});
