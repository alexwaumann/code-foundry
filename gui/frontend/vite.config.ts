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
    // itself against the list, and only a parent directory matches it. The plugin tests read
    // the hello demo's captured views the daemon's tests use (src/test/pluginFixtures.ts), and
    // the page bridge script's test the daemon's script (src/lib/cfBridgeScript.test.ts), and
    // the bridge sources test the pages skill's field list (src/api/bridgeSourcesDoc.test.ts),
    // and the markdown text test the rendered text fixture agent search's daemon side checks
    // too (src/lib/markdownText.test.tsx), and the task items test the cases the daemon's
    // parser checks (src/lib/taskItems.test.tsx), and the shell geometry test the layout
    // package's rectangles (src/shell/geometry/rects.test.ts).
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        path.resolve(import.meta.dirname, "../../docs"),
        path.resolve(import.meta.dirname, "../../internal/store/plugin/testdata/hello-demo"),
        path.resolve(import.meta.dirname, "../../internal/store/thread/testdata"),
        path.resolve(import.meta.dirname, "../../internal/store/gh/testdata"),
        path.resolve(import.meta.dirname, "../../internal/bridge"),
        path.resolve(import.meta.dirname, "../../internal/layout/testdata"),
        path.resolve(import.meta.dirname, "../../internal/preview"),
        path.resolve(import.meta.dirname, "../../internal/skills/files"),
        path.resolve(import.meta.dirname, "../../pluginsdk/ui"),
      ],
    },
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  plugins: [react(), tailwindcss(), wails("./bindings")],
  build: {
    // The dictation overlay's panel loads its own small page, not the app (gui/overlay.go);
    // so does a plugin surface's shot (src/shot/main.tsx).
    rolldownOptions: { input: { main: "index.html", "dictation-overlay": "dictation-overlay.html", shot: "shot.html" } },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "themes/**/*.test.ts", "mock/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    // Vitest hands stylesheets back empty; "?raw" ones keep their text so the palette guard
    // (src/lib/palette.test.ts) can read them. Plain CSS imports stay empty.
    css: { include: [/\.css\?raw$/] },
    // Sucrase's deep ESM modules (src/pagelib/source.ts) import without extensions: run them through Vite.
    server: { deps: { inline: ["sucrase"] } },
  },
});
