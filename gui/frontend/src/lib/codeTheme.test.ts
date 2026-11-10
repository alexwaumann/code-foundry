import { describe, expect, it, vi } from "vitest";
import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs";
import { themes } from "@/themes";
import { codeThemeName, codeThemeOf, ensureCodeTheme } from "./codeTheme";

vi.mock("@pierre/diffs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pierre/diffs")>()),
  registerCustomTheme: vi.fn(),
}));

const HEX = /^#[0-9a-f]{6}$/i;
const COLOUR = /^(#[0-9a-f]{6}([0-9a-f]{2})?|rgba?\(.*\)|transparent)$/i;

describe("codeThemeOf", () => {
  it.each(themes.map((t) => [t.id, t] as const))("%s is a complete Shiki theme", (_, theme) => {
    const t = codeThemeOf(theme);
    expect(t.name).toBe(codeThemeName(theme.id));
    expect(t.type).toBe(theme.scheme);
    expect(t.colors?.["editor.background"]).toBe(theme.slots["--cf-surface"]);
    expect(t.colors?.["editor.foreground"]).toBe(theme.vars["--syn-fg"]);
    for (const v of Object.values(t.colors ?? {})) expect(v).toMatch(COLOUR);
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

  it.each(themes.map((t) => [t.id, t] as const))("%s gives the editor its own colours: no box around the active line", (_, theme) => {
    const c = codeThemeOf(theme).colors;
    expect(c?.["editor.lineHighlightBorder"]).toBe("transparent");
    expect(c?.["editor.lineHighlightBackground"]).toBeTruthy();
    expect(c?.["editorCursor.foreground"]).toBe(theme.vars["--syn-fg"]);
    expect(c?.["editor.selectionBackground"]).toBe(theme.slots["--cf-selection"]);
    expect(c?.["editor.findMatchHighlightBackground"]).toBe(theme.slots["--cf-accent-surface"]);
  });

  it("names every theme distinctly", () => {
    const names = themes.map((t) => codeThemeOf(t).name);
    expect(new Set(names).size).toBe(themes.length);
  });
});

describe("ensureCodeTheme", () => {
  const loaded = async (name: string): Promise<ThemeRegistration | undefined> => {
    const call = vi.mocked(registerCustomTheme).mock.calls.find(([n]) => n === name);
    return (await call?.[1]()) as ThemeRegistration | undefined;
  };
  const kw = (t: ThemeRegistration | undefined) => t?.tokenColors?.find((r) => Array.isArray(r.scope) && r.scope.includes("keyword"))?.settings.foreground;

  it("registers a theme once, and again under a new name when its colours change", async () => {
    const base = themes[0];
    if (!base) throw new Error("no themes");
    const first = ensureCodeTheme(base);
    expect(ensureCodeTheme(base)).toBe(first);
    expect(vi.mocked(registerCustomTheme).mock.calls.filter(([n]) => n === first)).toHaveLength(1);

    const saved = { ...base, slots: { ...base.slots, "--syn-kw": "#123456" } };
    const second = ensureCodeTheme(saved);
    expect(second).not.toBe(first);
    expect((await loaded(second))?.name).toBe(second);
    expect(kw(await loaded(second))).toBe("#123456");

    // The same colours in a new object keep the name; going back reuses the first one.
    expect(ensureCodeTheme({ ...saved })).toBe(second);
    expect(ensureCodeTheme({ ...base })).toBe(first);
  });
});
