import { describe, expect, it } from "vitest";
import allowJson from "./guards.allow.json";
import allowText from "./guards.allow.json?raw";
import { type Allowlist, CATEGORIES, FRONTEND, INSTEAD, count, isScanned, scanSource, serialize, zero } from "./scan";

/**
 * Text uses a type role and radii the scale (index.css; docs/notes/design-system-1-tokens.md).
 * Every scanned source file (src/**\/*.{ts,tsx} except tests and src/gen) is searched for
 * Tailwind sizes, arbitrary line-heights and off-scale radii in its string and
 * template literals. guards.allow.json holds what the tree had when the guard landed: a
 * file may lose hits, never gain them, and a file not listed may have none. When a file
 * has fewer than its entry, `pnpm run guards:allow` rewrites the list, so it only shrinks.
 */

const raw = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/gen/**"], { query: "?raw", import: "default", eager: true });
/** Paths relative to gui/frontend, as the scanner and `pnpm run guards:allow` see them. */
const files = Object.fromEntries(
  Object.entries(raw)
    .map(([file, src]) => [file.slice(1), src] as const)
    .filter(([file]) => isScanned(file)),
);
const allow: Allowlist = allowJson;

describe("design-system guard", () => {
  it("scans the tree", () => {
    expect(Object.keys(files).length).toBeGreaterThan(200);
    expect(files["src/components/ui/button.tsx"]).toBeDefined();
  });

  it("no file adds a Tailwind size, arbitrary leading or off-scale radius", () => {
    const problems: string[] = [];
    for (const [file, src] of Object.entries(files)) {
      const key = FRONTEND + file;
      const hits = scanSource(file, src);
      const have = count(hits);
      const allowed = allow[key] ?? zero();
      for (const category of CATEGORIES) {
        if (have[category] <= allowed[category]) continue;
        const where = hits
          .filter((h) => h.category === category)
          .map((h) => `    ${key}:${String(h.line)}  ${h.match}  (/${h.pattern}/)  ${h.text}`)
          .join("\n");
        problems.push(
          `${key}: ${String(have[category])} ${category} hit(s), ${String(allowed[category])} allowed. Use ${INSTEAD[category]}.\n${where}`,
        );
      }
    }
    expect(problems, `\n${problems.join("\n\n")}\n`).toEqual([]);
  });

  it("the allowlist only shrinks: run `pnpm run guards:allow` after removing banned classes", () => {
    const stale: string[] = [];
    for (const [key, allowed] of Object.entries(allow)) {
      const file = key.slice(FRONTEND.length);
      const src = files[file];
      const have = src === undefined ? zero() : count(scanSource(file, src));
      for (const category of CATEGORIES) {
        if (have[category] < allowed[category]) {
          stale.push(`${key}: ${category} is ${String(have[category])}, the allowlist still says ${String(allowed[category])}`);
        }
      }
    }
    expect(stale, `\nThe allowlist is above the tree. Run \`pnpm run guards:allow\` (gui/frontend) and commit src/design/guards.allow.json:\n${stale.join("\n")}\n`).toEqual([]);
  });

  it("guards.allow.json is in the generator's format (`pnpm run guards:allow`)", () => {
    expect(allowText).toBe(serialize(allow));
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
