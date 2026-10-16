import { describe, expect, it } from "vitest";
import { FRONTEND, INSTEAD, isScanned, scanSource } from "./scan";

/**
 * Text uses a type role and radii the scale (index.css; docs/notes/design-system-1-tokens.md).
 * Every scanned source file (src/**\/*.{ts,tsx} except tests and src/gen) is searched for
 * Tailwind sizes, arbitrary line-heights and off-scale radii in its string and template
 * literals. Strict since docs/notes/design-system-3-sweep-chrome.md: no file may have any
 * (the allowlist the guard landed with reached zero and is gone).
 */

const raw = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/gen/**"], { query: "?raw", import: "default", eager: true });
/** Paths relative to gui/frontend, as the scanner sees them. */
const files = Object.fromEntries(
  Object.entries(raw)
    .map(([file, src]) => [file.slice(1), src] as const)
    .filter(([file]) => isScanned(file)),
);

describe("design-system guard", () => {
  it("scans the tree", () => {
    expect(Object.keys(files).length).toBeGreaterThan(200);
    expect(files["src/components/ui/button.tsx"]).toBeDefined();
  });

  it("no file has a Tailwind size, arbitrary leading or off-scale radius", () => {
    const problems = Object.entries(files).flatMap(([file, src]) =>
      scanSource(file, src).map((h) => `${FRONTEND}${file}:${String(h.line)}  ${h.match}  (/${h.pattern}/)  ${h.text}\n    Use ${INSTEAD[h.category]}.`),
    );
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });
});

describe("scanSource", () => {
  // Each case: the source, then the matches it should report (category:match).
  it.each([
    ["a class string", `const c = "px-2 text-sm font-medium";`, ["size:text-sm"]],
    ["JSX attribute", `<p className="text-xs leading-[18px] rounded">x</p>`, ["size:text-xs", "leading:leading-[18px]", "radius:rounded"]],
    ["template with substitution", "const c = `text-[13px] ${a ? \"font-semibold\" : \"\"} rounded-[7px]`;", ["size:text-[13px]", "radius:rounded-[7px]"]],
    ["every occurrence counts", `const c = "text-sm hover:text-sm md:text-lg";`, ["size:text-sm", "size:text-sm", "size:text-lg"]],
    ["scale radii and roles pass", `const c = "rounded-md rounded-pane rounded-t-lg rounded-full text-body text-caption-sm text-body-sm font-mono";`, []],
    ["weights on a role pass", `const c = "text-label font-semibold text-caption font-medium";`, []],
    ["arbitrary colours are not sizes", `const c = "text-[color-mix(in_oklab,var(--a)_22%,var(--b))] text-[0.86em]";`, ["size:text-[0.86em]"]],
    ["colours pass", `const c = "text-muted-foreground text-link text-foreground/80";`, []],
    ["comments are not read", "// text-sm rounded\n/* font-bold */ const x = 1;", []],
    ["JSX text is not read", `<p>a rounded corner, text-sm</p>`, []],
    ["regex literals are not read", `const re = /text-sm|rounded/;`, []],
    ["English words in strings count", `const s = "rounded up";`, ["radius:rounded"]],
  ])("%s", (_name, source, want) => {
    expect(scanSource("x.tsx", source).map((h) => `${h.category}:${h.match}`)).toEqual(want);
  });

  it("reports the line", () => {
    const [hit] = scanSource("x.tsx", `const a = 1;\nconst b = 2;\nconst c = "text-xs";\n`);
    expect(hit).toMatchObject({ line: 3, text: 'const c = "text-xs";', pattern: String.raw`\btext-(?:xs|sm|base|lg|xl|2xl|3xl)\b` });
  });

  it.each([
    ["src/components/ui/button.tsx", true],
    ["src/lib/utils.ts", true],
    ["src/lib/utils.test.ts", false],
    ["src/components/Foo.test.tsx", false],
    ["src/gen/proto/foo_pb.ts", false],
    ["src/index.css", false],
    ["src/vite-env.d.ts", false],
    ["themes/convert.ts", false],
  ])("isScanned(%s) is %s", (path, want) => {
    expect(isScanned(path)).toBe(want);
  });
});
