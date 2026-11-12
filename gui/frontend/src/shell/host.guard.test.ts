import { describe, expect, it } from "vitest";

/**
 * Surfaces reach their tabs through the host seam (shell/host.ts), never the classic side
 * panel's store, so the shell can swap the seam's implementation without touching them
 * (docs/notes/shell-8-host-seam.md). Every source file under src (tests, test helpers and
 * generated code aside) is searched for an import of stores/panel.ts; only the panel's own
 * code may have one.
 */

const PANEL = "src/stores/panel.ts";

/** What may import stores/panel.ts: a folder (ends in "/") or a file, with why. */
const ALLOWED: Readonly<Record<string, string>> = {
  "src/shell/host.ts": "the seam: its classic half delegates to the store",
  "src/components/panel/": "the side panel itself",
  "src/components/bottom/": "the bottom panel: it hides while the side panel is expanded",
  "src/stores/bottomPanel.ts": "the bottom panel's store: its keys are the side panel's",
  "src/stores/bottomActions.ts": "the bottom panel's actions: they expand and read the side panel",
  "src/stores/views.ts": "the side panel's commands (view.panel.*)",
  "src/stores/threadPanelIntent.ts": "the side panel's intents from the daemon",
  "src/stores/archiveCleanup.ts": "resets a put-away thread's panels (the layout's job in the shell)",
  "src/App.tsx": "the classic window: an expanded side panel hides the content pane",
};

const raw = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/gen/**"], { query: "?raw", import: "default", eager: true });
/** Paths relative to gui/frontend. */
const files = Object.fromEntries(Object.entries(raw).map(([file, src]) => [file.slice(1), src] as const));

function scanned(path: string): boolean {
  return !/\.test\.tsx?$/.test(path) && !path.startsWith("src/test/") && !path.endsWith(".d.ts");
}

function allowed(path: string): boolean {
  return Object.keys(ALLOWED).some((a) => (a.endsWith("/") ? path.startsWith(a) : path === a));
}

/** A module specifier resolved against the importing file, without an extension; null for a package. */
function resolveSpecifier(from: string, spec: string): string | null {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`.replace(/\.tsx?$/, "");
  if (!spec.startsWith(".")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/").replace(/\.tsx?$/, "");
}

/** The specifiers a source imports: static, re-exported, dynamic, and type-only. */
function importsOf(src: string): string[] {
  const re = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  return Array.from(src.matchAll(re), (m) => m[1] ?? "");
}

function importsPanel(path: string, src: string): boolean {
  return importsOf(src).some((s) => resolveSpecifier(path, s) === PANEL.replace(/\.ts$/, ""));
}

describe("host seam guard", () => {
  it("scans the tree", () => {
    expect(Object.keys(files).length).toBeGreaterThan(200);
    expect(files[PANEL]).toBeDefined();
    expect(importsPanel("src/shell/host.ts", files["src/shell/host.ts"] ?? "")).toBe(true);
  });

  it("only the panel's own code imports stores/panel.ts", () => {
    const hits = Object.entries(files)
      .filter(([path, src]) => scanned(path) && path !== PANEL && !allowed(path) && importsPanel(path, src))
      .map(([path]) => `${path}: import from @/shell/host instead of @/stores/panel`);
    expect(hits, `\n${hits.join("\n")}\n`).toEqual([]);
  });

  it("every allowed file exists", () => {
    const missing = Object.keys(ALLOWED).filter((a) => !Object.keys(files).some((f) => (a.endsWith("/") ? f.startsWith(a) : f === a)));
    expect(missing).toEqual([]);
  });
});

describe("importsOf and resolveSpecifier", () => {
  it.each([
    ["src/stores/x.ts", `import { a } from "./panel";`, true],
    ["src/stores/x.ts", `import type { Tab } from "./panel";`, true],
    ["src/stores/x.ts", `export { a } from "./panel";`, true],
    ["src/components/a/x.tsx", `const m = await import("@/stores/panel");`, true],
    ["src/components/a/x.tsx", `import { a } from "../../stores/panel";`, true],
    ["src/components/a/x.tsx", `import { a } from "@/stores/panel.ts";`, true],
    ["src/stores/x.ts", `import { a } from "./panelThing";`, false],
    ["src/components/panel/x.tsx", `import { a } from "./panel";`, false],
    ["src/stores/x.ts", `import { a } from "@/shell/host";`, false],
    ["src/stores/x.ts", `// see stores/panel.ts keyOf`, false],
  ])("%s: %s", (path, src, want) => {
    expect(importsPanel(path, src)).toBe(want);
  });
});
