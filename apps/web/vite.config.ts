import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
// `vitest/config` re-exports Vite's `defineConfig` widened with the `test` key.
import { defineConfig } from "vitest/config";

/** Where `wrangler dev` serves the registry during local development. */
const WORKER = process.env.REGISTRY_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // `@workspace/ui` is deliberately not aliased: its `exports` map is what
    // routes `./globals.css` to `src/styles/globals.css`, and an alias would
    // flatten that away.
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // In production the Worker serves the dashboard and the API from one origin,
    // so the app only ever issues same-origin requests. Proxying keeps the dev
    // server honest about that, cookies included.
    proxy: {
      "/api": { target: WORKER, changeOrigin: false },
      "/v2": { target: WORKER, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
