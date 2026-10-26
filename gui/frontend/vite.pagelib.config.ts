/**
 * The page library (docs/notes/page-library.md): what a page the model shows loads from the
 * daemon's /cf/ to be a React app with the app's own components, no build step. Built from
 * the app's sources into internal/pagelib/dist, which the daemon embeds and serves; the
 * output is committed like generated code (`make pagelib`, run by `make gen`; `make check`
 * rebuilds it and fails on a diff). Two passes, picked by --mode:
 *
 * - modules: ES modules the import map names. react.js, react-dom.js, react-dom-client.js
 *   and jsx-runtime.js re-export the app's React (one instance, in a shared chunk); ui.js is
 *   every components/ui component plus cn (src/pagelib/ui.ts), ui.css its stylesheet;
 *   icons.js is all of lucide-react. Shared code lands in chunks/, so ui.js and a page's
 *   `import "react"` get the same module whatever the import map says.
 * - scripts: classic scripts, which run before any module loads: jsx.js (the import map and
 *   the in-browser TSX transform, src/pagelib/jsx.ts) and tailwind.js (the app's @theme as a
 *   text/tailwindcss style, then the Tailwind v4 browser runtime as published).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { appTheme, pageSafelist } from "./src/pagelib/theme.ts";

const here = import.meta.dirname;
const outDir = path.resolve(here, "../../internal/pagelib/dist");
const require = createRequire(import.meta.url);

/** The React modules the import map names, by the file each is served as. */
const REACT_MODULES: Record<string, string> = {
  react: "react",
  "react-dom": "react-dom",
  "react-dom-client": "react-dom/client",
  "jsx-runtime": "react/jsx-runtime",
};

/** Re-exports every name the module has (its default too, for `import React from "react"`). */
function reactEntry(spec: string): string {
  const mod = require(spec) as Record<string, unknown>;
  const names = Object.keys(mod).filter((n) => n !== "default" && /^[A-Za-z_$][\w$]*$/.test(n));
  const lines = [`export { ${names.join(", ")} } from ${JSON.stringify(spec)};`];
  if (!spec.includes("/")) lines.push(`import d from ${JSON.stringify(spec)};`, "export default d;");
  return lines.join("\n") + "\n";
}

const VIRTUAL = "\0cf-pagelib:";

/** The React entries as virtual modules (their export lists are read from the packages). */
function reactEntries(): Plugin {
  return {
    name: "cf-pagelib-react",
    enforce: "pre",
    resolveId(id) {
      const at = id.indexOf("cf-pagelib:");
      return at >= 0 ? "\0" + id.slice(at) : undefined;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL)) return undefined;
      const spec = REACT_MODULES[id.slice(VIRTUAL.length)];
      return spec ? reactEntry(spec) : undefined;
    },
  };
}

/**
 * src/pagelib/ui.css with its `cf:app-theme` and `cf:safelist` markers filled: index.css's
 * @theme and type roles (so the utility names are the app's) and the page safelist. A load
 * hook, so @tailwindcss/vite compiles the filled text.
 */
function uiStylesheet(): Plugin {
  const file = path.resolve(here, "src/pagelib/ui.css");
  const index = path.resolve(here, "src/index.css");
  return {
    name: "cf-pagelib-css",
    enforce: "pre",
    load(id) {
      if (id.split("?")[0] !== file) return undefined;
      this.addWatchFile(index);
      return readFileSync(file, "utf8")
        .replace("/* cf:app-theme */", appTheme(readFileSync(index, "utf8")))
        .replace("/* cf:safelist */", pageSafelist(readFileSync(index, "utf8")));
    },
  };
}

/** tailwind.js: the app's theme for the runtime, then @tailwindcss/browser unchanged. */
function tailwindRuntime(): Plugin {
  return {
    name: "cf-pagelib-tailwind",
    generateBundle() {
      const runtime = readFileSync(require.resolve("@tailwindcss/browser"), "utf8");
      // The base after the runtime's preflight (`border: 0 solid`, placeholders at half the
      // text colour), which comes after ui.css's in the base layer: ui.css's border and
      // placeholder colours again, so the components look the same with the runtime. A
      // mockup without theme.css keeps the preflight's (the fallbacks).
      const base =
        "@layer base {\n  *, ::before, ::after, ::backdrop { border-color: var(--cf-border, currentColor); }\n" +
        "  ::placeholder { color: var(--cf-placeholder, color-mix(in oklab, currentColor 50%, transparent)); }\n}\n";
      const css = '@import "tailwindcss";\n' + appTheme(readFileSync(path.resolve(here, "src/index.css"), "utf8")) + base;
      const prelude = [
        "/* Code Foundry's Tailwind runtime (/cf/tailwind.js, docs/notes/page-library.md): the app's @theme and",
        " * type roles as the first text/tailwindcss style, then @tailwindcss/browser " + (require("@tailwindcss/browser/package.json") as { version: string }).version + ". */",
        "(function(){if(document.querySelector(\"style[data-cf-theme]\"))return;var s=document.createElement(\"style\");",
        "s.setAttribute(\"type\",\"text/tailwindcss\");s.setAttribute(\"data-cf-theme\",\"\");s.textContent=" + JSON.stringify(css) + ";",
        "(document.head||document.documentElement).prepend(s);})();",
      ].join("\n");
      this.emitFile({ type: "asset", fileName: "tailwind.js", source: prelude + "\n" + runtime });
    },
  };
}

/** ui-exports.json: ui.js's export names, sorted, for the pages skill's test (internal/skills). */
function uiExports(): Plugin {
  return {
    name: "cf-pagelib-exports",
    generateBundle(_opts, bundle) {
      const ui = bundle["ui.js"];
      if (ui?.type !== "chunk") throw new Error("no ui.js in the bundle");
      this.emitFile({ type: "asset", fileName: "ui-exports.json", source: JSON.stringify([...ui.exports].sort(), null, 1) + "\n" });
    },
  };
}

export default defineConfig(({ mode }) => {
  const shared = {
    configFile: false as const,
    publicDir: false as const,
    resolve: {
      alias: [
        // The ui primitives scale Radix offsets by the app's zoom (lib/zoom.ts, which reads the
        // app's store and the Wails runtime); a page has no zoom.
        { find: "@/lib/zoom", replacement: path.resolve(here, "src/pagelib/zoom.ts") },
        { find: "@", replacement: path.resolve(here, "src") },
      ],
    },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "warn" as const,
  };
  if (mode === "scripts") {
    return {
      ...shared,
      plugins: [tailwindRuntime()],
      build: {
        outDir,
        emptyOutDir: false,
        sourcemap: false,
        lib: { entry: path.resolve(here, "src/pagelib/jsx.ts"), formats: ["iife" as const], name: "__cfJsxModule", fileName: () => "jsx.js" },
      },
    };
  }
  return {
    ...shared,
    plugins: [reactEntries(), uiStylesheet(), react(), tailwindcss(), uiExports()],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      cssCodeSplit: false,
      lib: {
        entry: {
          ...Object.fromEntries(Object.keys(REACT_MODULES).map((name) => [name, `cf-pagelib:${name}`])),
          ui: path.resolve(here, "src/pagelib/ui.ts"),
          icons: path.resolve(here, "src/pagelib/icons.ts"),
        },
        formats: ["es" as const],
        cssFileName: "ui",
      },
      rolldownOptions: {
        output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[hash].js", minify: true },
      },
    },
  };
});
