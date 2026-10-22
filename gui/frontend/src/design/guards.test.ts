import { describe, expect, it } from "vitest";
import { isSlot } from "@/themes/slots";
import { declaredCfProperties, FRONTEND, INSTEAD, isColourScanned, isScanned, scanColours, scanSlotRefs, scanSource, scanStylesheet, stringLiterals } from "./scan";

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

/**
 * Colours are the semantic slots (docs/notes/theme-slots-2-components.md): outside
 * components/ui (vendored shadcn), no scanned source file and no stylesheet under src uses a
 * shadcn component name (`bg-card`, `text-muted-foreground`, `bg-warning/10`, `var(--border)`,
 * `theme.vars["--pane"]`) or Tailwind's `var(--color-*)`. Strict: no allowlist.
 */
const stylesheets = Object.fromEntries(Object.entries(import.meta.glob<string>("/src/**/*.css", { query: "?raw", import: "default", eager: true })).map(([file, src]) => [file.slice(1), src] as const));

describe("colour guard", () => {
  it("scans the tree and the stylesheets", () => {
    expect(Object.keys(files).filter(isColourScanned).length).toBeGreaterThan(200);
    expect(Object.keys(stylesheets)).toEqual(expect.arrayContaining(["src/index.css", "src/components/thread/thread.css"]));
  });

  it("no file outside components/ui uses a shadcn colour name", () => {
    const problems = [
      ...Object.entries(files)
        .filter(([file]) => isColourScanned(file))
        .flatMap(([file, src]) => scanColours(file, src).map((h) => ({ file, h }))),
      ...Object.entries(stylesheets).flatMap(([file, css]) => scanStylesheet(file, css).map((h) => ({ file, h }))),
    ].map(({ file, h }) => `${FRONTEND}${file}:${String(h.line)}  ${h.match}  ${h.text}\n    Use ${h.instead}.`);
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });

  it.each([
    ["src/components/ui/button.tsx", false],
    ["src/components/sidebar/SidebarRow.tsx", true],
    ["src/themes/slots.ts", true],
  ])("isColourScanned(%s) is %s", (path, want) => {
    expect(isColourScanned(path)).toBe(want);
  });
});

describe("scanColours", () => {
  // Each case: the source, then the matches it should report (kind:match).
  it.each([
    ["utilities", `const c = "bg-card text-muted-foreground border-border";`, ["utility:bg-card", "utility:text-muted-foreground", "utility:border-border"]],
    ["variants and opacity", `const c = "hover:bg-sidebar-accent/50 dark:bg-warning/10 [&>*]:bg-destructive";`, ["utility:bg-sidebar-accent", "utility:bg-warning", "utility:bg-destructive"]],
    ["the longest name wins", `const c = "text-sidebar-accent-foreground border-pane-border";`, ["utility:text-sidebar-accent-foreground", "utility:border-pane-border"]],
    ["var() in an arbitrary value", `const c = "[--chip-accent:var(--info)] shadow-[0_0_0_2px_color-mix(in_oklab,var(--primary)_25%,transparent)]";`, ["variable:var(--info)", "variable:var(--primary)"]],
    ["Tailwind's --color-*", `const c = "text-[color-mix(in_oklab,var(--chip-accent)_22%,var(--color-foreground))]";`, ["tailwind:var(--color-foreground"]],
    ["a component name as a key read", `const v = theme.vars["--pane"]; const t = [["background", "--pane"]];`, ["name:\"--pane\"", "name:\"--pane\""]],
    ["slots pass", `const c = "bg-cf-surface-raised text-cf-text-muted hover:bg-cf-sidebar-row-hover bg-cf-warning-surface border-cf-divider [--chip-accent:var(--cf-info)]";`, []],
    ["the link role and non-colour utilities pass", `const c = "text-link text-caption bg-transparent border-0 ring-1 outline-none";`, []],
    ["a declaring key passes", `const A = { "--card": "--cf-surface-raised" };`, []],
    ["other custom properties pass", `const c = "[--wails-draggable:no-drag] var(--cf-flame-ink) var(--t-mono)";`, []],
    ["comments are not read", "// bg-card var(--border)\nconst x = 1;", []],
  ])("%s", (_name, source, want) => {
    expect(scanColours("x.tsx", source).map((h) => `${h.kind}:${h.match}`)).toEqual(want);
  });

  it("says which slot to use", () => {
    expect(scanColours("x.tsx", `const c = "hover:bg-sidebar-accent/50 text-muted-foreground"; const v = "var(--border)"; const k = "--pane";`).map((h) => h.instead)).toEqual([
      "bg-cf-sidebar-row-selected",
      "text-cf-text-muted",
      "var(--cf-border)",
      '"--cf-surface"',
    ]);
  });

  it("reads stylesheets: var(), --color-* and @apply, not comments or index.css's defining blocks", () => {
    const css = [
      "/* var(--border) */",
      ".a { color: var(--muted-foreground); border: 1px solid var(--cf-border); }",
      ".b { @apply bg-card text-cf-text; }",
      ".c { color: var(--color-foreground); }",
    ].join("\n");
    expect(scanStylesheet("src/components/x.css", css).map((h) => `${String(h.line)}:${h.kind}:${h.match}`)).toEqual(["2:variable:var(--muted-foreground)", "3:utility:bg-card", "4:tailwind:var(--color-foreground"]);
    const index = "@theme inline {\n  --color-card: var(--card);\n}\n:root,\n[data-theme-scope] {\n  --card: var(--cf-surface-raised);\n}\n.x { color: var(--card); }\n";
    expect(scanStylesheet("src/index.css", index).map((h) => `${String(h.line)}:${h.match}`)).toEqual(["8:var(--card)"]);
  });
});

/**
 * Every `cf-*` utility and `var(--cf-*)` names something that exists
 * (docs/notes/theme-slots-3-hardening.md): a utility a slot, a var() a slot or a property
 * declared somewhere under src (a stylesheet's `--cf-zoom: 1`, a style object's
 * `"--cf-backdrop-wide"` key, a `setProperty("--cf-zoom", …)`). Scans the same sources and
 * every stylesheet; components/ui too.
 */
const declaredCf = new Set([
  ...Object.values(stylesheets).flatMap(declaredCfProperties),
  ...Object.entries(files).flatMap(([file, src]) =>
    stringLiterals(file, src)
      .filter((l) => l.key)
      .map((l) => /^["'`](--cf-[a-z0-9-]+)["'`]$/.exec(l.raw)?.[1] ?? "")
      .filter(Boolean),
  ),
  ...Object.values(files).flatMap((src) => [...src.matchAll(/setProperty\(\s*["'](--cf-[a-z0-9-]+)["']/g)].map((m) => m[1] ?? "")),
]);
const knownRef = (name: string, kind: "utility" | "variable") => isSlot(name) || (kind === "variable" && declaredCf.has(name));

describe("slot-name guard", () => {
  it("knows the declared non-slot properties", () => {
    expect([...declaredCf].filter((n) => !isSlot(n))).toEqual(expect.arrayContaining(["--cf-zoom", "--cf-flame-ink", "--cf-backdrop-wide"]));
  });

  it("no utility or var() names a slot that does not exist", () => {
    const problems = [...Object.entries(files), ...Object.entries(stylesheets)].flatMap(([file, src]) =>
      scanSlotRefs(file, src, knownRef).map((h) => `${FRONTEND}${file}:${String(h.line)}  ${h.match}  ${h.text}\n    ${h.name} is not a slot (src/themes/slots.ts SLOT_NAMES).`),
    );
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });

  it.each([
    ["a misspelt utility", `const c = "text-cf-sucess";`, ["--cf-sucess"]],
    ["a retired slot", `const c = "hover:bg-cf-sidebar-row-active/50";`, ["--cf-sidebar-row-active"]],
    ["a misspelt var()", `const c = "[--chip-accent:var(--cf-infoo)]";`, ["--cf-infoo"]],
    ["a component name with cf-", `const c = "bg-cf-card";`, ["--cf-card"]],
    ["a utility on a declared non-slot", `const c = "bg-cf-zoom";`, ["--cf-zoom"]],
    ["slots, opacity and variants pass", `const c = "bg-cf-surface-raised hover:text-cf-warning-text/80 [&>*]:border-cf-divider var(--cf-error-text) var(--cf-zoom)";`, []],
    ["class names that are not utilities pass", `const c = "cf-thread cf-markdown cf-code-view";`, []],
  ])("%s", (_name, source, want) => {
    expect(scanSlotRefs("x.tsx", source, knownRef).map((h) => h.name)).toEqual(want);
  });

  it("reads stylesheets outside comments", () => {
    const css = "/* var(--cf-nope) */\n.a { color: var(--cf-text-mutd); background: var(--cf-surface); }\n.b { @apply text-cf-texxt; }\n";
    expect(scanSlotRefs("src/x.css", css, knownRef).map((h) => `${String(h.line)}:${h.name}`)).toEqual(["2:--cf-text-mutd", "3:--cf-texxt"]);
  });
});
