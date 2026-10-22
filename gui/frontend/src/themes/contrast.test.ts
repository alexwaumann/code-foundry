import { describe, expect, it } from "vitest";
import { lightness } from "./color";
import { CONTRAST_PAIRS, contrastFailures } from "./contrastPairs";
import fixtures from "./contrast.fixtures.json";
import { DEFAULT_DARK, DEFAULT_LIGHT, themeById, themeOf, themes, themesFor, type Theme } from "./index";
import { COMPONENT_ALIASES, parseThemeFile, SCHEME_LIGHTNESS, SLOT_NAMES } from "./slots";

// The readability floor every curated theme keeps, on its resolved values (base -> rules ->
// overrides; docs/THEMES.md): the pairs in contrastPairs.ts. A failure means a rule in
// slots.ts or an entry in themes/overrides.json needs work, not a looser number here.
//
// The fixtures are two base-only themes no curated theme resembles (a warm paper light, a
// deep blue dark), so the rules are held to the floor on bases they were not tuned on.

const OPAQUE = /^#[0-9a-f]{6}$/;
const ANY = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

const fixtureThemes: readonly Theme[] = (fixtures as unknown[]).map((f) => themeOf(parseThemeFile(f)));

describe.each([...themes, ...fixtureThemes].map((t) => [t.id, t] as const))("%s", (_, t) => {
  const v = (k: string) => {
    const value = t.vars[k];
    if (value === undefined) throw new Error(`${t.id}: no ${k}`);
    return value;
  };

  it("resolves every slot, each #rrggbb or a #rrggbbaa tint; component, terminal and syntax colours are opaque", () => {
    expect(Object.keys(t.slots)).toEqual(SLOT_NAMES);
    for (const [k, value] of Object.entries(t.slots)) expect(value, k).toMatch(ANY);
    for (const k of Object.keys(COMPONENT_ALIASES)) expect(v(k), k).toMatch(OPAQUE);
    for (const k of SLOT_NAMES.filter((n) => !n.startsWith("--cf-"))) expect(v(k), k).toMatch(OPAQUE);
  });

  it("every contrast pair reaches its floor", () => {
    expect(contrastFailures(t.slots).map((f) => `${f.label}: ${f.ratio.toFixed(2)} < ${String(f.pair.min)} (${f.pair.why})`)).toEqual([]);
  });

  it("the sheet and the pane are at least 3% apart in OKLab lightness", () => {
    expect(Math.abs(lightness(v("--cf-surface")) - lightness(v("--cf-canvas")))).toBeGreaterThanOrEqual(0.03);
  });

  it("popovers are distinct from the pane (a white pane relies on the shadow and border)", () => {
    if (v("--cf-surface") === "#ffffff") return;
    expect(Math.abs(lightness(v("--cf-surface-overlay")) - lightness(v("--cf-surface")))).toBeGreaterThanOrEqual(0.01);
  });

  it("controls, a hovered row and wells are three distinct steps", () => {
    const steps = ["--cf-surface-sunken", "--cf-control", "--cf-control-hover", "--cf-control-active"].map(v);
    expect(new Set(steps).size).toBe(4);
  });

  it("its scheme matches its surface", () => {
    const L = lightness(v("--cf-surface"));
    expect(t.scheme === "dark" ? L <= SCHEME_LIGHTNESS.darkMax : L >= SCHEME_LIGHTNESS.lightMin).toBe(true);
  });
});

describe("contrast pairs", () => {
  it("name only slots, each once per background", () => {
    for (const p of CONTRAST_PAIRS) for (const k of [p.fg, p.bg, ...(p.over ? [p.over] : [])]) expect(SLOT_NAMES, k).toContain(k);
    const keys = CONTRAST_PAIRS.map((p) => `${p.fg}|${p.bg}|${p.over ?? ""}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("report a pair that falls short, with its ratio", () => {
    const slots = { ...themeById.get(DEFAULT_LIGHT)?.slots, "--cf-text-muted": "#bbbbbb" };
    const failures = contrastFailures(slots);
    expect(failures.map((f) => f.label)).toContain("--cf-text-muted on --cf-surface");
    expect(failures.find((f) => f.label === "--cf-text-muted on --cf-surface")?.ratio).toBeLessThan(4.5);
  });

  it("flatten a tint over the slot it is painted on", () => {
    const slots = { ...themeById.get(DEFAULT_DARK)?.slots, "--cf-warning-surface": "#ffd33dff" };
    expect(contrastFailures(slots).map((f) => f.label)).toContain("--cf-warning-text on --cf-warning-surface over --cf-surface");
  });
});

describe("catalog", () => {
  it("has the curated 22, dark first, the defaults (GitHub) first in each", () => {
    expect(themes).toHaveLength(22);
    expect(new Set(themes.map((t) => t.id)).size).toBe(22);
    const dark = themesFor("dark");
    const light = themesFor("light");
    expect(themes).toEqual([...dark, ...light]);
    expect(dark[0]?.id).toBe(DEFAULT_DARK);
    expect(light[0]?.id).toBe(DEFAULT_LIGHT);
  });

  it("the defaults exist with the right scheme", () => {
    expect(themeById.get(DEFAULT_DARK)?.scheme).toBe("dark");
    expect(themeById.get(DEFAULT_LIGHT)?.scheme).toBe("light");
  });

  it("the fixtures are not in it", () => {
    for (const f of fixtureThemes) expect(themeById.has(f.id), f.id).toBe(false);
  });
});
