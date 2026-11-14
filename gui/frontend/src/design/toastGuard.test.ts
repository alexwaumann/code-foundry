import { describe, expect, it } from "vitest";
import { FRONTEND, sonnerRefs } from "./scan";

/**
 * Every toast goes through lib/notify (docs/notes/toast-levels.md), which is how every toast
 * has a level and a short title. So no file under src names the "sonner" module (an import,
 * a re-export, a dynamic or type import, a vi.mock) but lib/notify.ts and
 * components/ui/sonner.tsx (the Toaster, and the toast @cf/ui hands pages). Tests too: a test
 * mounts the Toaster from components/ui/sonner and mocks @/lib/notify. Strict: no allowlist.
 */

const ALLOWED = new Set(["src/lib/notify.ts", "src/components/ui/sonner.tsx"]);

const raw = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/gen/**"], { query: "?raw", import: "default", eager: true });
const files = Object.fromEntries(Object.entries(raw).map(([file, src]) => [file.slice(1), src] as const));

describe("toast guard", () => {
  it("scans the tree, tests included", () => {
    expect(Object.keys(files).length).toBeGreaterThan(400);
    expect(files["src/lib/notify.test.tsx"]).toBeDefined();
    expect(sonnerRefs("src/lib/notify.ts", files["src/lib/notify.ts"] ?? "")).toHaveLength(1);
  });

  it("no file but lib/notify and components/ui/sonner names sonner", () => {
    const problems = Object.entries(files)
      .filter(([file]) => !ALLOWED.has(file))
      .flatMap(([file, src]) => sonnerRefs(file, src).map((h) => `${FRONTEND}${file}:${String(h.line)}  ${h.text}`));
    expect(problems, `\n${problems.join("\n")}\n\n    Show toasts with notify from @/lib/notify; a test mounts Toaster from @/components/ui/sonner and mocks @/lib/notify.\n`).toEqual([]);
  });
});

describe("sonnerRefs", () => {
  it.each([
    ["an import", `import { toast } from "sonner";`, 1],
    ["a type import", `import type { ToasterProps } from 'sonner';`, 1],
    ["a re-export", `export { toast } from "sonner";`, 1],
    ["a dynamic import", `const m = await import("sonner");`, 1],
    ["a mock", `vi.mock("sonner", () => ({ toast }));`, 1],
    ["an import type in a mock", `vi.mock("x", async (orig) => { const m = await orig<typeof import("sonner")>(); });`, 1],
    ["the notify module passes", `import { notify } from "@/lib/notify";`, 0],
    ["sonner's attributes pass", `el.closest("[data-sonner-toaster]");`, 0],
    ["comments pass", `// import { toast } from "sonner";`, 0],
  ])("%s", (_name, source, want) => {
    expect(sonnerRefs("x.ts", source)).toHaveLength(want);
  });
});
