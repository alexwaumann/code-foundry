/// <reference types="vitest/config" />
import path from "node:path";
import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wails from "@wailsio/runtime/plugins/vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
    // The help overlay's guide is the repo's docs/GETTING-STARTED.md, imported with ?raw
    // (components/help/guide.ts). The directory, not the file: Vite checks "file.md?raw"
    // itself against the list, and only a parent directory matches it.
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), path.resolve(import.meta.dirname, "../../docs")] },
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  plugins: [react(), tailwindcss(), wails("./bindings")],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
    // Vitest hands stylesheets back empty; "?raw" ones keep their text so the palette guard
    // (src/lib/palette.test.ts) can read them. Plain CSS imports stay empty.
    css: { include: [/\.css\?raw$/] },
  },
});
