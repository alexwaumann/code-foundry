import { describe, expect, it } from "vitest";

/**
 * Every tooltip is the shadcn Tooltip (`Tip` in components/ui/tooltip.tsx), themed and
 * anchored to its element; WebKit's native `title` tooltip is neither
 * (docs/notes/theme-3-tooltips.md). Every non-test .tsx under src is read as text and
 * searched for a `title` reaching the DOM:
 * - a `title=` JSX attribute on a DOM element (`<span title=…>`), or on a component
 *   that is not in OWN_TITLE (those take `title` as their own visible text: a section
 *   heading, a menu item's label);
 * - a `title:` key in a JSX spread (`{...{ title: x }}`);
 * - a DOM write: `el.title = …` (document.title, the window's title, is fine) or
 *   `setAttribute("title", …)`.
 */

const sources = import.meta.glob<string>(["/src/**/*.tsx", "!/src/**/*.test.tsx", "!/src/gen/**"], { query: "?raw", import: "default", eager: true });

/** Components whose `title` prop is their own visible text, not a tooltip. */
const OWN_TITLE: { file: string; component: string; why: string }[] = [
  { file: "/src/components/pr/PrSummary.tsx", component: "Section", why: "the collapsible section's heading" },
  { file: "/src/components/pr/PrMenu.tsx", component: "Item", why: "the menu item's label" },
  { file: "/src/components/pr/ReviewButton.tsx", component: "Item", why: "the Review menu item's label (PrMenu's Item)" },
  { file: "/src/components/pr/PullRequestSurface.tsx", component: "Centered", why: "the empty state's heading" },
];

interface Hit {
  file: string;
  line: number;
  tag: string;
  text: string;
}

const lineOf = (src: string, at: number) => src.slice(0, at).split("\n").length;

/**
 * The JSX tag a `title=` at `at` belongs to: walk back to the `<` that opens it, skipping
 * `{…}` expressions (arrow functions, comparisons and generics live in those).
 */
function tagAt(src: string, at: number): string {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = src[i];
    if (c === "}") depth++;
    else if (c === "{") depth--;
    else if (c === "<" && depth === 0) {
      const m = /^<([A-Za-z][\w.]*)/.exec(src.slice(i));
      if (m) return m[1] ?? "?";
    }
  }
  return "?";
}

function titleAttributes(): Hit[] {
  const hits: Hit[] = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/(?<![\w.-])title=/g)) {
      const line = lineOf(src, m.index);
      hits.push({ file, line, tag: tagAt(src, m.index), text: src.split("\n")[line - 1]?.trim() ?? "" });
    }
  }
  return hits;
}

const ownTitle = (h: Hit) => OWN_TITLE.some((o) => o.file === h.file && o.component === h.tag);
const show = (hits: Hit[]) => hits.map((h) => `${h.file}:${String(h.line)} <${h.tag}>: ${h.text}`);

function scan(re: RegExp): string[] {
  const out: string[] = [];
  for (const [file, src] of Object.entries(sources)) {
    src.split("\n").forEach((text, i) => {
      if (re.test(text)) out.push(`${file}:${String(i + 1)}: ${text.trim()}`);
    });
  }
  return out;
}

describe("tooltip guard", () => {
  it("reads the sources", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(sources["/src/components/command/CommandButton.tsx"]).toContain("<Tip");
  });

  it("finds the tag of a title attribute, also across lines and past arrow functions", () => {
    const src = `<div onClick={() => a > b}\n  title="x"><Section\n  extra={<b />}\n  title={<>y</>}>`;
    expect([...src.matchAll(/(?<![\w.-])title=/g)].map((m) => tagAt(src, m.index))).toEqual(["div", "Section"]);
  });

  it("no native title tooltips: wrap the element in <Tip label=…> (components/ui/tooltip.tsx)", () => {
    expect(show(titleAttributes().filter((h) => !ownTitle(h)))).toEqual([]);
  });

  it("no title in a JSX spread, and no title written to the DOM", () => {
    expect(scan(/\{\.\.\.\{[^}]*\btitle\s*:/)).toEqual([]);
    expect(scan(/(?<!document)\.title\s*=(?!=)|setAttribute\(\s*["']title["']/)).toEqual([]);
  });

  it("every OWN_TITLE entry is still used (drop stale ones)", () => {
    const hits = titleAttributes();
    const stale = OWN_TITLE.filter((o) => !hits.some((h) => h.file === o.file && h.tag === o.component));
    expect(stale.map((o) => `${o.file}: ${o.component}`)).toEqual([]);
  });
});

/**
 * Radix reaches the app only through the shadcn wrappers in components/ui, styled there
 * from the tokens (docs/notes/theme-5-cleanup.md); call sites import the wrapper. The
 * hand-rolled copies of the wrappers stay gone: key chips are `Kbd`, radios `RadioGroup`,
 * switches `Switch`, checkboxes `Checkbox`, progress bars `Progress`. No allowlist.
 */
const allSources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/gen/**", "!/src/components/ui/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

function scanAll(re: RegExp): string[] {
  const out: string[] = [];
  for (const [file, src] of Object.entries(allSources)) {
    src.split("\n").forEach((text, i) => {
      if (re.test(text)) out.push(`${file}:${String(i + 1)}: ${text.trim()}`);
    });
  }
  return out;
}

const RADIX_IMPORT = /from\s+["'](?:radix-ui|@radix-ui\/[\w-]+)["']/;
const HAND_ROLLED = /<kbd\b|role=["'{]+(?:radio|radiogroup|switch|checkbox|progressbar)["'}]/;

describe("shadcn primitives guard", () => {
  it("reads the sources outside components/ui", () => {
    expect(Object.keys(allSources).length).toBeGreaterThan(100);
    expect(Object.keys(allSources).some((f) => f.startsWith("/src/components/ui/"))).toBe(false);
    expect(allSources["/src/components/publish/PublishPicker.tsx"]).toContain("@/components/ui/radio-group");
  });

  it("no direct radix-ui import outside components/ui: use the shadcn wrapper", () => {
    expect(scanAll(RADIX_IMPORT)).toEqual([]);
  });

  it("no hand-rolled kbd, radio, switch, checkbox or progress bar: use Kbd, RadioGroup, Switch, Checkbox, Progress", () => {
    expect(scanAll(HAND_ROLLED)).toEqual([]);
  });

  it("the patterns catch what they guard against", () => {
    for (const s of ['import { RadioGroup } from "radix-ui";', "import { Slot } from 'radix-ui'", 'import * as Tabs from "@radix-ui/react-tabs";']) expect(RADIX_IMPORT.test(s), s).toBe(true);
    for (const s of ['import { RadioGroup } from "@/components/ui/radio-group";', "// radix-ui writes data-state"]) expect(RADIX_IMPORT.test(s), s).toBe(false);
    for (const s of ["<kbd>⌘K</kbd>", '<button role="radio"', "role={\"switch\"}", '<div role="progressbar">', '<div role="radiogroup"']) expect(HAND_ROLLED.test(s), s).toBe(true);
    for (const s of ["<Kbd size=\"sm\">", '<div role="group"', 'role="tab"', 'role="option"']) expect(HAND_ROLLED.test(s), s).toBe(false);
  });
});
