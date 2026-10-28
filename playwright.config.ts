// Playwright harness: zero-cost offline a11y + behavior suite.
// Ports: 4190 app (dist-e2e, no CSP), 4191 mock API, 4192 prod preview
// (dist/, real store), 4193 csp-serve (dist-e2e + production headers).
// Override with E2E_APP_PORT / E2E_MOCK_PORT / E2E_PROD_PORT / E2E_CSP_PORT.
import { defineConfig, devices } from "@playwright/test";

const APP = process.env.E2E_APP_PORT || "4190";
const MOCK = process.env.E2E_MOCK_PORT || "4191";
const PROD = process.env.E2E_PROD_PORT || "4192";
const CSP = process.env.E2E_CSP_PORT || "4193";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e-results",
  snapshotPathTemplate: "{testDir}/__aria__/{testFileName}/{arg}{ext}",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://127.0.0.1:${APP}/`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `node e2e/mock-api/server.mjs ${MOCK}`,
      port: Number(MOCK),
      reuseExistingServer: false,
      env: { E2E_MOCK_PORT: MOCK },
    },
    {
      // No CSP headers here: production connect-src forbids loopback, so the
      // mock API would be blocked. Header parity is covered by the csp project.
      command: `node node_modules/vite/bin/vite.js preview --outDir dist-e2e --port ${APP} --strictPort --host 127.0.0.1`,
      port: Number(APP),
      reuseExistingServer: false,
    },
    {
      command: `node node_modules/vite/bin/vite.js preview --port ${PROD} --strictPort --host 127.0.0.1`,
      port: Number(PROD),
      reuseExistingServer: false,
    },
    {
      command: `node scripts/csp-serve.mjs ${CSP} dist-e2e`,
      port: Number(CSP),
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
      testIgnore: ["**/real-store.spec.ts", "**/csp.spec.ts"],
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
      testIgnore: ["**/real-store.spec.ts", "**/csp.spec.ts"],
    },
    {
      name: "reduced-motion",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        reducedMotion: "reduce",
      },
      testMatch: ["**/a11y/states.spec.ts"],
    },
    {
      name: "forced-colors",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        forcedColors: "active",
      },
      testMatch: ["**/a11y/states.spec.ts"],
    },
    // Dark theme: states suite only (+ the dark-project guard). Contrast is
    // enforced here: the global color-contrast allowlist is light-only
    // (excludeProjects in allowlist.json). dark-mobile feeds shots + the gate.
    {
      name: "dark",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 }, colorScheme: "dark" },
      testMatch: ["**/a11y/states.spec.ts", "**/a11y/dark-project.spec.ts"],
    },
    {
      name: "dark-mobile",
      use: {
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        colorScheme: "dark",
      },
      testMatch: ["**/a11y/states.spec.ts", "**/a11y/dark-project.spec.ts"],
    },
    {
      name: "real-store",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${PROD}/` },
      testMatch: ["**/real-store.spec.ts"],
    },
    {
      name: "csp",
      use: { ...devices["Desktop Chrome"], baseURL: `http://127.0.0.1:${CSP}/` },
      testMatch: ["**/csp.spec.ts"],
    },
  ],
});
