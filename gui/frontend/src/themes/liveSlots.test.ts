import { describe, expect, it } from "vitest";
import themesMd from "../../../../docs/THEMES.md?raw";
import { COMPONENT_ALIASES, SLOT_NAMES } from "./slots";

/**
 * docs/THEMES.md's "Live slots" (what an override editor and a model are told has effect in
 * the app) against the code: the two lists partition the --cf-* slots, every live slot is
 * read somewhere under src outside the theme engine and index.css's defining blocks, and no
 * pages-only slot is.
 */

const section = themesMd.slice(themesMd.indexOf("### Live slots"), themesMd.indexOf("## Checking a theme"));
const pagesAt = section.indexOf("Pages only");
const names = (s: string) => [...s.matchAll(/`(--cf-[a-z0-9-]+)`/g)].map((m) => m[1] ?? "");
const live = names(section.slice(0, pagesAt));
const pagesOnly = names(section.slice(pagesAt));

const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx,css}", "!/src/gen/**", "!/src/themes/**", "!/src/**/*.test.{ts,tsx}", "!/src/design/**"], { query: "?raw", import: "default", eager: true });

/** The sources with index.css's two defining blocks (@theme and the alias block) blanked. */
const code = Object.entries(sources).map(([file, src]) => {
  if (file !== "/src/index.css") return src;
  let out = src;
  for (const head of ["@theme inline {", ":root,\n[data-theme-scope] {"]) {
    const at = out.indexOf(head);
    const end = out.indexOf("}", at);
    out = out.slice(0, at) + out.slice(end);
  }
  return out;
});

/**
 * Whether a slot is read: its utility (`bg-cf-x`), a var(), its name as a literal
 * (`theme.slots["--cf-x"]`), or the same for a component name aliased to it (shadcn's
 * `bg-destructive` in components/ui reads --cf-error).
 */
function used(slot: string): boolean {
  const aliases = Object.entries(COMPONENT_ALIASES)
    .filter(([, s]) => s === slot)
    .map(([name]) => name);
  return [slot, ...aliases].some((name) => {
    const short = name.slice(2);
    const re = new RegExp(String.raw`(?<![\w-])(?:[a-z]+(?:-[a-z]+)*:)*(?:bg|text|border|ring|fill|stroke|outline|decoration|divide|caret|accent|shadow|from|via|to|placeholder)-${short}(?![\w-])|var\(${name}(?![\w-])|["'\x60]${name}["'\x60]`);
    return code.some((src) => re.test(src));
  });
}

describe("THEMES.md live slots", () => {
  it("lists every --cf-* slot once, as live or pages-only", () => {
    const cf = SLOT_NAMES.filter((n) => n.startsWith("--cf-"));
    expect([...live, ...pagesOnly].sort()).toEqual([...cf].sort());
    expect(new Set([...live, ...pagesOnly]).size).toBe(cf.length);
  });

  it("every live slot is read by the app", () => {
    expect(live.filter((s) => !used(s))).toEqual([]);
  });

  it("no pages-only slot is (move it to the live list when one is)", () => {
    expect(pagesOnly.filter(used)).toEqual([]);
  });
});
