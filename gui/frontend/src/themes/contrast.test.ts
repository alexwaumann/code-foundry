import { describe, expect, it } from "vitest";
import { contrast, flatten, lightness } from "./color";
import { DEFAULT_DARK, DEFAULT_LIGHT, themeById, themes, themesFor } from "./index";
import { COMPONENT_ALIASES, SLOT_NAMES } from "./slots";

// The readability floor every curated theme keeps, on its resolved values (base -> rules ->
// overrides; docs/notes/theme-slots-1-engine.md). A failure means a rule in slots.ts or an
// entry in themes/overrides.json needs work, not a looser number here.

const STATUS = ["--destructive", "--success", "--warning", "--info", "--highlight", "--link"] as const;
const TONES = ["success", "warning", "error", "info", "highlight", "update"] as const;
const OPAQUE = /^#[0-9a-f]{6}$/;
const ANY = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

describe.each(themes.map((t) => [t.id, t] as const))("%s", (_, t) => {
  const v = (k: string) => {
    const value = t.vars[k];
    if (value === undefined) throw new Error(`${t.id}: no ${k}`);
    return value;
  };
  const pane = v("--pane");
  const sheet = v("--sheet");

  it("resolves every slot, each #rrggbb or a #rrggbbaa tint; component, terminal and syntax colours are opaque", () => {
    expect(Object.keys(t.slots)).toEqual(SLOT_NAMES);
    for (const [k, value] of Object.entries(t.slots)) expect(value, k).toMatch(ANY);
    for (const k of Object.keys(COMPONENT_ALIASES)) expect(v(k), k).toMatch(OPAQUE);
    for (const k of SLOT_NAMES.filter((n) => !n.startsWith("--cf-"))) expect(v(k), k).toMatch(OPAQUE);
  });

  it("foreground is at least 7:1 on the pane", () => {
    expect(contrast(v("--foreground"), pane)).toBeGreaterThanOrEqual(7);
  });

  it("muted-foreground is at least 4.5:1 on the pane and on the sheet", () => {
    expect(contrast(v("--muted-foreground"), pane)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v("--muted-foreground"), sheet)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["--cf-text-secondary", "--cf-placeholder", "--cf-icon-muted", "--cf-sidebar-muted-foreground"])("%s is at least 4.5:1 on the pane and on the sheet", (k) => {
    expect(contrast(v(k), pane)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v(k), sheet)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(STATUS)("%s is at least 4.5:1 on the pane and on the sheet", (k) => {
    expect(contrast(v(k), pane)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v(k), sheet)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(TONES)("%s-foreground is at least 4.5:1 on a solid %s fill", (tone) => {
    expect(contrast(v(`--cf-${tone}-foreground`), v(`--cf-${tone}`))).toBeGreaterThanOrEqual(4.5);
  });

  it("primary-foreground is at least 4.5:1 on the primary", () => {
    expect(contrast(v("--primary-foreground"), v("--primary"))).toBeGreaterThanOrEqual(4.5);
  });

  it("accent-surface-foreground is at least 4.5:1 on the accent surface over the pane", () => {
    expect(contrast(v("--cf-accent-surface-foreground"), flatten(v("--cf-accent-surface"), pane))).toBeGreaterThanOrEqual(4.5);
  });

  it("the sheet and the pane are at least 3% apart in OKLab lightness", () => {
    expect(Math.abs(lightness(pane) - lightness(sheet))).toBeGreaterThanOrEqual(0.03);
  });

  it("popovers are distinct from the pane (a white pane relies on the shadow and border)", () => {
    if (pane === "#ffffff") return;
    expect(Math.abs(lightness(v("--popover")) - lightness(pane))).toBeGreaterThanOrEqual(0.01);
  });

  it("the terminal selection leaves the text readable", () => {
    expect(contrast(v("--terminal-fg"), v("--terminal-selection"))).toBeGreaterThanOrEqual(3);
  });

  it("code comments are at least 3:1 on the pane", () => {
    expect(contrast(v("--syn-com"), pane)).toBeGreaterThanOrEqual(3);
  });

  it("chart colours are at least 3:1 on the pane", () => {
    for (let i = 1; i <= 6; i++) expect(contrast(v(`--cf-chart-${String(i)}`), pane), String(i)).toBeGreaterThanOrEqual(3);
  });

  it("its scheme matches its background", () => {
    expect(lightness(pane) < 0.6 ? "dark" : "light").toBe(t.scheme);
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
});
