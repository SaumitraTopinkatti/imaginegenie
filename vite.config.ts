import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // E2E mode (`vite build --mode e2e`): alias the encrypted store to the
  // in-memory mock and point the API base at the loopback mock server.
  // Normal build/dev return the object below unchanged (byte-for-byte safe).
  if (mode === "e2e") {
    const mockPort = process.env.E2E_MOCK_PORT || "4191";
    process.env.VITE_OPENROUTER_BASE ??= `http://127.0.0.1:${mockPort}/api/v1`;
    process.env.VITE_OPENROUTER_API_KEY = "";
    return {
      plugins: [react()],
      server: { port: 5173 },
      resolve: {
        alias: [
          // Exact specifiers as written in src (matched pre-resolution):
          // App.tsx uses ./lib/secureStore, components use ../lib/secureStore,
          // lib/*.ts uses ./secureStore.
          { find: "./lib/secureStore", replacement: "/e2e/mocks/secureStore.mock.ts" },
          { find: "../lib/secureStore", replacement: "/e2e/mocks/secureStore.mock.ts" },
          { find: "./secureStore", replacement: "/e2e/mocks/secureStore.mock.ts" },
        ],
      },
      build: { outDir: "dist-e2e" },
    };
  }
  return {
    plugins: [react()],
    server: { port: 5173 },
  };
});
