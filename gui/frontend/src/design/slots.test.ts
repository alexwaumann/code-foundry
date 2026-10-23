import { describe, expect, it } from "vitest";
import indexCss from "../index.css?raw";
import { COMPONENT_ALIASES, isSlot, SLOT_NAMES } from "@/themes/slots";

/**
 * The theme tiers (docs/notes/theme-slots-1-engine.md), strictly:
 * - index.css's alias block declares exactly COMPONENT_ALIASES, each a bare var() of a slot,
 *   on `:root` and every `[data-theme-scope]`;
 * - every colour Tailwind exposes (`--color-X: var(--X)` in @theme) is an alias there or a
 *   `--cf-*` slot (`--color-cf-X: var(--cf-X)`), and every `--cf-*` slot has its utility;
 * - nothing else under src gives a slot or a component name a colour: no stylesheet
 *   declares one, and no TypeScript pairs one with a colour literal. Slots come from the
 *   resolver (lib/theme.ts, ThemeScope), component names from the alias block.
 */

const code = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

const ALIAS_SELECTOR = ":root,\n[data-theme-scope] {";

function aliasBlock(): Map<string, string> {
  const css = code(indexCss);
  const at = css.indexOf(ALIAS_SELECTOR);
  if (at < 0) throw new Error(`index.css: no "${ALIAS_SELECTOR}" block`);
  const body = css.slice(at + ALIAS_SELECTOR.length, css.indexOf("}", at));
  return new Map([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
}

const stylesheets = import.meta.glob<string>(["/src/**/*.css"], { query: "?raw", import: "default", eager: true });
const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/gen/**", "!/src/**/*.test.{ts,tsx}"], { query: "?raw", import: "default", eager: true });

const COMPONENT = new Set(Object.keys(COMPONENT_ALIASES));
const themed = (name: string) => isSlot(name) || COMPONENT.has(name);

/** Every declaration `--name: value` in a stylesheet, outside comments. */
function declarations(css: string): { name: string; value: string; line: number }[] {
  const src = code(css);
  return [...src.matchAll(/(?<=^|[;{\s])(--[\w-]+)\s*:\s*([^;}]*)/gm)].map((m) => ({ name: m[1] ?? "", value: (m[2] ?? "").trim(), line: src.slice(0, m.index).split("\n").length }));
}

const COLOUR = String.raw`(?:#[0-9a-fA-F]{3,8}\b|(?:oklch|oklab|lch|lab|rgba?|hsla?|hwb|color)\(|(?:white|black|transparent)\b)`;
/** A slot or component name next to a colour literal: a style object's key and value, an arbitrary-property class, a setProperty call. */
const TS_PAIR = new RegExp(String.raw`(--[\w-]+)["'\x60]?\s*[:,=]\s*["'\x60]?\s*${COLOUR}`, "g");

describe("theme tiers", () => {
  it("index.css's alias block is exactly COMPONENT_ALIASES, each a var() of a slot", () => {
    const block = aliasBlock();
    expect(Object.fromEntries(block)).toEqual(Object.fromEntries(Object.entries(COMPONENT_ALIASES).map(([k, slot]) => [k, `var(${slot})`])));
    for (const slot of Object.values(COMPONENT_ALIASES)) expect(SLOT_NAMES, slot).toContain(slot);
  });

  it("every colour Tailwind exposes is a component name in the alias block or a --cf-* slot", () => {
    const exposed = [...code(indexCss).matchAll(/--color-([\w-]+):\s*var\((--[\w-]+)\)/g)].map((m) => ({ utility: m[1] ?? "", name: m[2] ?? "" }));
    expect(exposed.length).toBeGreaterThan(100);
    const block = aliasBlock();
    expect(exposed.filter(({ name }) => !block.has(name) && !(name.startsWith("--cf-") && isSlot(name))).map((e) => e.name)).toEqual([]);
    // A slot's utility is its own name: --color-cf-surface-raised reads --cf-surface-raised.
    expect(exposed.filter(({ utility, name }) => name.startsWith("--cf-") && `--${utility}` !== name)).toEqual([]);
  });

  // docs/notes/theme-slots-2-components.md: components use bg-cf-*, text-cf-*, border-cf-*, ...
  it("every --cf-* slot has a Tailwind utility (--color-cf-<slot>)", () => {
    const exposed = new Set([...code(indexCss).matchAll(/--color-(cf-[\w-]+):\s*var\(--cf-[\w-]+\)/g)].map((m) => `--${m[1] ?? ""}`));
    const cf = SLOT_NAMES.filter((n) => n.startsWith("--cf-"));
    expect(cf).toHaveLength(71);
    expect(cf.filter((n) => !exposed.has(n))).toEqual([]);
  });

  // Tailwind declares `--color-foreground: var(--foreground)` once, on :root, so it resolves to
  // the window's theme there; a rule that reads it paints a preview scope in the window's
  // colours (the type roles did: a dark preview's thread text was the light window's). The
  // rules read the slots, set inline on <html> and on every preview scope.
  it("index.css's own rules never read Tailwind's --color-* (resolved at :root)", () => {
    const lines = code(indexCss)
      .split("\n")
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => text.includes("var(--color-"));
    expect(lines.map((l) => `src/index.css:${String(l.line)}: ${l.text.trim()}`)).toEqual([]);
  });

  it("no stylesheet under src declares a slot or a component name (index.css's alias block aside)", () => {
    expect(Object.keys(stylesheets)).toContain("/src/components/thread/thread.css");
    const hits: string[] = [];
    for (const [file, css] of Object.entries(stylesheets)) {
      const block = file === "/src/index.css" ? code(css).indexOf(ALIAS_SELECTOR) : -1;
      const blockEnd = block < 0 ? -1 : code(css).indexOf("}", block);
      const [from, to] = [code(css).slice(0, block).split("\n").length, code(css).slice(0, blockEnd).split("\n").length];
      for (const d of declarations(css)) {
        if (!themed(d.name)) continue;
        if (block >= 0 && d.line >= from && d.line <= to) continue;
        hits.push(`${file}:${String(d.line)}: ${d.name}: ${d.value}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("no TypeScript under src gives a slot or a component name a colour literal", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(200);
    const hits: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      src.split("\n").forEach((text, i) => {
        for (const m of text.matchAll(TS_PAIR)) if (themed(m[1] ?? "")) hits.push(`${file}:${String(i + 1)}: ${text.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the patterns catch what they guard against", () => {
    const pairs = (s: string) => [...s.matchAll(TS_PAIR)].map((m) => m[1]);
    expect(pairs(`style={{ "--cf-surface": "#ffffff" }}`)).toEqual(["--cf-surface"]);
    // Assembled, so the palette guard (lib/palette.test.ts) does not read this line as a class.
    expect(pairs(`className="[--pane:` + `oklch(0.5_0_0)]"`)).toEqual(["--pane"]);
    expect(pairs(`root.style.setProperty("--primary", "rgb(0 0 0)")`)).toEqual(["--primary"]);
    expect(pairs(`style={{ "--sw-l": slot.light }}`)).toEqual([]);
    expect(pairs(`const v = theme.vars["--pane"];`)).toEqual([]);
    expect(declarations(".a { --primary: #fff; color: var(--primary); }\n.b{--t-x:1px}").map((d) => d.name)).toEqual(["--primary", "--t-x"]);
  });
});
