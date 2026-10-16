import { describe, expect, it } from "vitest";
import { contrast, lightness } from "../../themes/color.ts";
import { DEFAULT_DARK, DEFAULT_LIGHT, themeById, themes, themesFor } from "./index";

// The readability floor every curated theme keeps (docs/notes/theme-engine-2-engine.md,
// "What the tests assert"). A failure means an override in themes/overrides.json (or a
// guard in themes/convert.ts) needs work, not a looser number here.

const STATUS = ["--destructive", "--success", "--warning", "--info", "--highlight", "--link"] as const;
const HEX = /^#[0-9a-f]{6}$/;

describe.each(themes.map((t) => [t.id, t] as const))("%s", (_, t) => {
  const v = (k: string) => {
    const value = t.vars[k];
    if (value === undefined) throw new Error(`${t.id}: no ${k}`);
    return value;
  };
  const pane = v("--pane");
  const sheet = v("--sheet");

  it("every value is #rrggbb", () => {
    for (const [k, value] of Object.entries(t.vars)) expect(value, k).toMatch(HEX);
  });

  it("foreground is at least 7:1 on the pane", () => {
    expect(contrast(v("--foreground"), pane)).toBeGreaterThanOrEqual(7);
  });

  it("muted-foreground is at least 4.5:1 on the pane and on the sheet", () => {
    expect(contrast(v("--muted-foreground"), pane)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v("--muted-foreground"), sheet)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(STATUS)("%s is at least 4.5:1 on the pane and on the sheet", (k) => {
    expect(contrast(v(k), pane)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v(k), sheet)).toBeGreaterThanOrEqual(4.5);
  });

  it("primary-foreground is at least 4.5:1 on the primary", () => {
    expect(contrast(v("--primary-foreground"), v("--primary"))).toBeGreaterThanOrEqual(4.5);
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

  it("its scheme matches its background", () => {
    expect(lightness(pane) < 0.6 ? "dark" : "light").toBe(t.scheme);
  });
});

describe("catalog", () => {
  it("has the curated 21, dark first, the defaults (GitHub) first in each", () => {
    expect(themes).toHaveLength(21);
    expect(new Set(themes.map((t) => t.id)).size).toBe(21);
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
