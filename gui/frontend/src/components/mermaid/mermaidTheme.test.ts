import { describe, expect, it } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT, themeById, themes, type Theme } from "@/themes";
import { diagramCss, diagramThemeOf, mermaidThemeVariables } from "./mermaidTheme";

function theme(id: string): Theme {
  const t = themeById.get(id);
  if (!t) throw new Error(`no theme ${id}`);
  return t;
}

describe("mermaidThemeVariables", () => {
  it.each([DEFAULT_DARK, DEFAULT_LIGHT])("%s: the sketch's tokens for nodes, text and edges", (id) => {
    const t = theme(id);
    const v = mermaidThemeVariables(t);
    const s = (name: string) => t.slots[name]?.slice(0, 7);
    expect(v.darkMode).toBe(t.scheme === "dark");
    expect(v.background).toBe(s("--cf-surface"));
    expect(v.primaryColor).toBe(s("--cf-surface-sunken"));
    expect(v.mainBkg).toBe(s("--cf-surface-sunken"));
    expect(v.primaryBorderColor).toBe(s("--cf-border-strong"));
    expect(v.primaryTextColor).toBe(s("--cf-text"));
    expect(v.textColor).toBe(s("--cf-text"));
    expect(v.lineColor).toBe(s("--cf-text-muted"));
    expect(v.edgeLabelBackground).toBe(s("--cf-surface"));
    expect(v.pie1).toBe(s("--cf-chart-1"));
    expect(v.pie7).toBe(s("--cf-chart-1"));
    expect(v.fontFamily).toContain("-apple-system");
  });

  it("every catalog theme maps to opaque #rrggbb colours (Mermaid mixes them itself)", () => {
    for (const t of themes) {
      for (const [k, v] of Object.entries(mermaidThemeVariables(t))) {
        if (typeof v !== "string" || k.startsWith("font")) continue;
        expect(v, `${t.id} ${k}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("a theme with other colours gives other variables (a re-render, not a reused one)", () => {
    expect(diagramThemeOf(theme(DEFAULT_DARK))).not.toEqual(diagramThemeOf(theme(DEFAULT_LIGHT)));
  });
});

describe("diagramCss", () => {
  it("draws an edge's label in the theme's muted text, on an opaque patch", () => {
    const t = theme(DEFAULT_LIGHT);
    const css = diagramCss(t);
    expect(css).toContain(`.edgeLabel text{fill:${String(t.slots["--cf-text-muted"]?.slice(0, 7))}`);
    expect(css).toContain(".edgeLabel rect{opacity:1}");
  });
});
