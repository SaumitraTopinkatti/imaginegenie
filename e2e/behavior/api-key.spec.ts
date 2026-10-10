// API-key flows: Test ok/err announcements, request shape, remember flow.
import { test, expect, fillKey, openKeyModal, mockApi } from "../fixtures";

test("test ok announced via role=status", async ({ app }) => {
  await fillKey(app, "sk-or-test-ok");
  await openKeyModal(app);
  await app.getByRole("button", { name: "Test", exact: true }).click();
  await expect(app.getByRole("dialog", { name: "OpenRouter API key" }).getByRole("status")).toContainText("Works — your key is valid.");
  const { requests } = await mockApi.requests();
  const eps = requests.filter((r) => r.path.includes("/images/models/"));
  // Shared server: other parallel tests hit endpoints too — assert existence.
  expect(eps.some((r) => r.keyKind === "sk-or-test-ok")).toBe(true);
});

test("test err announced via role=alert", async ({ app }) => {
  await fillKey(app, "sk-or-test-401");
  await openKeyModal(app);
  await app.getByRole("button", { name: "Test", exact: true }).click();
  await expect(app.getByRole("alert")).toContainText("Invalid API key");
});

test("remember-key survives reload; forgetting clears it", async ({ app }) => {
  await fillKey(app, "sk-or-test-ok"); // fillKey remembers + closes
  await app.reload();
  await expect(app.getByRole("button", { name: /Connected/ })).toBeVisible({ timeout: 8000 });
  await openKeyModal(app);
  await app.getByText("Remember on this device (encrypted)").click(); // uncheck
  await app.getByRole("button", { name: "Close", exact: true }).click();
  await app.reload();
  await expect(app.getByRole("button", { name: /Connected/ })).toBeHidden();
});

test("endpoints-empty still connects", async ({ app }) => {
  await mockApi.scenario("endpoints-empty");
  try {
    await fillKey(app, "sk-or-test-ok");
    await openKeyModal(app);
    await app.getByRole("button", { name: "Test", exact: true }).click();
    // UI message is the same success text; the scenario is proven by the log.
    await expect(app.getByRole("dialog", { name: "OpenRouter API key" }).getByRole("status")).toContainText("Works");
    const { requests } = await mockApi.requests();
    const eps = requests.filter((r) => r.path.includes("/images/models/"));
    expect(eps.length).toBeGreaterThan(0);
    expect(eps[eps.length - 1].scenario).toBe("endpoints-empty");
  } finally {
    await mockApi.scenario("ok");
  }
});
