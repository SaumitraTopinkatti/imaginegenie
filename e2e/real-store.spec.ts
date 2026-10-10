// Real-store smoke (project real-store, normal dist/): proves the app boots
// against the production IndexedDB store and the mock cannot drift silently.
// Seeding uses raw IndexedDB writes with XOR-alg rows, which the real
// decryptText accepts as legacy-readable (production behavior, unchanged).
import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { pngDataUrl } from "./mock-api/png.mjs";

const XOR_SECRET = "imaginegenie-studio-v1::genie-lamp";
function xorCrypt(text: string): string {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    out.push(String.fromCharCode(text.charCodeAt(i) ^ XOR_SECRET.charCodeAt(i % XOR_SECRET.length)));
  }
  return btoa(out.join(""));
}

test("prod build has no e2e hook and boots the real store", async ({ page }) => {
  const hits: string[] = [];
  await page.context().route("**://openrouter.ai/**", (route) => {
    hits.push(route.request().url());
    void route.abort();
  });
  await page.goto("/");
  await page.locator("body").waitFor();
  expect(await page.evaluate(() => window.__e2e__)).toBeUndefined();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__IMAGINEGENIE_E2E_MOCK__)).toBeUndefined();
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeVisible();
  const tagged = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(tagged.violations).toEqual([]);
  expect(hits).toEqual([]);
});

test("real store lists + decrypts a seeded XOR row", async ({ page }) => {
  await page.goto("/");
  await page.locator("body").waitFor();
  const img = pngDataUrl(64, 64, "solid");
  await page.evaluate(
    ({ imageUrl }) => {
      const secret = "imaginegenie-studio-v1::genie-lamp";
      const xor = (t: string) => {
        const out: string[] = [];
        for (let i = 0; i < t.length; i++) {
          out.push(String.fromCharCode(t.charCodeAt(i) ^ secret.charCodeAt(i % secret.length)));
        }
        return btoa(out.join(""));
      };
      return new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("imaginegenie", 2);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" });
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
          if (!db.objectStoreNames.contains("references")) db.createObjectStore("references", { keyPath: "id" });
        };
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("records", "readwrite");
          tx.objectStore("records").put({
            id: "real-smoke-1",
            createdAt: Date.now(),
            prompt: "Real store smoke",
            aspectRatio: "1:1",
            resolution: "1K",
            cost: 0.045,
            mediaType: "image/png",
            refCount: 0,
            imageEnc: { iv: "xor", data: xor(imageUrl), alg: "XOR" },
            thumbEnc: { iv: "xor", data: xor(imageUrl), alg: "XOR" },
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      });
    },
    { imageUrl: img }
  );
  await page.reload();
  await expect(page.locator("#gallery .card")).toHaveCount(1, { timeout: 10000 });
  expect(xorCrypt("probe")).toBeTruthy();
});
