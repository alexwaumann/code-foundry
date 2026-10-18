import { describe, expect, it } from "vitest";
import { themes } from "@/themes";
import { codeThemeName, codeThemeOf } from "./codeTheme";

const HEX = /^#[0-9a-f]{6}$/i;

describe("codeThemeOf", () => {
  it.each(themes.map((t) => [t.id, t] as const))("%s is a complete Shiki theme", (_, theme) => {
    const t = codeThemeOf(theme);
    expect(t.name).toBe(codeThemeName(theme.id));
    expect(t.type).toBe(theme.scheme);
    expect(t.colors?.["editor.background"]).toBe(theme.vars["--pane"]);
    expect(t.colors?.["editor.foreground"]).toBe(theme.vars["--syn-fg"]);
    for (const v of Object.values(t.colors ?? {})) expect(v).toMatch(HEX);
    expect(t.tokenColors?.length).toBeGreaterThan(0);
    for (const rule of t.tokenColors ?? []) {
      expect(rule.scope?.length).toBeGreaterThan(0);
      expect(rule.settings.foreground).toMatch(HEX);
    }
    // Comments and keywords take the thread's own syntax colours.
    const colourOf = (scope: string) => t.tokenColors?.find((r) => Array.isArray(r.scope) && r.scope.includes(scope))?.settings.foreground;
    expect(colourOf("comment")).toBe(theme.vars["--syn-com"]);
    expect(colourOf("keyword")).toBe(theme.vars["--syn-kw"]);
    expect(colourOf("string")).toBe(theme.vars["--syn-str"]);
  });

  it("names every theme distinctly", () => {
    const names = themes.map((t) => codeThemeOf(t).name);
    expect(new Set(names).size).toBe(themes.length);
  });
});
