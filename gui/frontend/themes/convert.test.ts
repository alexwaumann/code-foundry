// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { lightness } from "../src/themes/color.ts";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "../src/themes/defaults.ts";
import { parseThemeFile, resolveSlots, SLOT_NAMES, type ThemeFile } from "../src/themes/slots.ts";
import { buildCatalog, catalogJson, ghosttyBase, goCatalogJson, parseGhostty, PATHS, readInputs, type Inputs, type Override } from "./convert.ts";

const inputs = readInputs();

describe("generated files", () => {
  // `pnpm run themes` regenerates both; a hand edit or a changed input fails here.
  it("catalog.json and the daemon's catalog match the converter's output", () => {
    const catalog = buildCatalog(inputs);
    expect(fs.readFileSync(PATHS.catalog, "utf8")).toBe(catalogJson(catalog));
    expect(fs.readFileSync(PATHS.goCatalog, "utf8")).toBe(goCatalogJson(catalog));
  });

  it("the daemon's catalog is every theme file, as the GUI's catalog has it, and the defaults", () => {
    const catalog = buildCatalog(inputs);
    const go = JSON.parse(goCatalogJson(catalog)) as { defaults: Record<string, string>; themes: ThemeFile[] };
    expect(go.defaults).toEqual({ dark: DEFAULT_DARK, light: DEFAULT_LIGHT });
    expect(go.themes).toEqual(JSON.parse(catalogJson(catalog)));
    for (const [scheme, id] of Object.entries(go.defaults)) expect(go.themes.find((t) => t.id === id)?.scheme).toBe(scheme);
  });

  it("every entry is a theme file as parseThemeFile reads it, and resolves every slot", () => {
    for (const t of buildCatalog(inputs)) {
      expect(parseThemeFile(JSON.parse(JSON.stringify(t))), t.id).toEqual(t);
      expect(Object.keys(resolveSlots(t)), t.id).toEqual(SLOT_NAMES);
    }
  });

  // Overrides are for what the rules cannot say; a new one belongs in this list and in
  // docs/notes/theme-slots-1-engine.md with its reason.
  it("overrides stay few: only these themes and slots", () => {
    const got = Object.fromEntries(
      buildCatalog(inputs)
        .filter((t) => t.overrides)
        .map((t) => [t.id, Object.keys(t.overrides ?? {}).sort()]),
    );
    expect(got).toEqual({
      "catppuccin-mocha": ["--syn-kw", "--syn-num"],
      "catppuccin-latte": ["--syn-kw", "--syn-num"],
      "graphite-dark": ["--cf-accent-foreground", "--cf-focus", "--cf-sidebar-row-selected", "--terminal-selection-inactive"],
      "graphite-light": ["--cf-focus", "--cf-input", "--cf-sidebar-row-selected", "--cf-text-muted"],
    });
  });

  it("vendors every Ghostty file it converts, with the licence", () => {
    for (const o of Object.values(inputs.overrides)) if (o.ghostty) expect(fs.existsSync(path.join(PATHS.ghostty, o.ghostty)), o.ghostty).toBe(true);
    expect(fs.readFileSync(path.join(PATHS.ghostty, "LICENSE"), "utf8")).toMatch(/MIT License/);
  });

  it("pairs point both ways between a light and a dark theme", () => {
    const catalog = buildCatalog(inputs);
    const byId = new Map(catalog.map((t) => [t.id, t]));
    for (const t of catalog) {
      if (!t.pair) continue;
      const other = byId.get(t.pair);
      expect(other?.pair, t.id).toBe(t.id);
      expect(other?.scheme, t.id).not.toBe(t.scheme);
    }
  });

  it("refuses an override of a name that is not a slot", () => {
    const fake: Inputs = { overrides: { t: { name: "T", ghostty: "t", upstream: "test", why: "test", overrides: { "--card": "#ffffff" } } }, ghostty: () => ghosttyFile({ bg: "#ffffff", fg: "#111111" }) };
    expect(() => buildCatalog(fake)).toThrow(/--card is not a slot/);
  });
});

const BASE = ["#222222", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#cccccc"];
const palette = (over: Record<number, string> = {}) => Array.from({ length: 16 }, (_, i) => over[i] ?? BASE[i % 8] ?? "#000000");

function ghosttyFile(o: { bg: string; fg: string; selection?: string; palette?: Record<number, string> }): string {
  const lines = palette(o.palette).map((c, i) => `palette = ${String(i)}=${c}`);
  lines.push(`background = ${o.bg}`, `foreground = ${o.fg}`);
  if (o.selection) lines.push(`selection-background = ${o.selection}`);
  return lines.join("\n");
}

const override = (o: Partial<Override> = {}): Override => ({ name: "T", ghostty: "t", upstream: "test", why: "test", ...o });

describe("parseGhostty", () => {
  it("reads palette, background, foreground, cursor and selection", () => {
    const g = parseGhostty(ghosttyFile({ bg: "#1E1E2E", fg: "#cdd6f4", selection: "#585b70" }) + "\ncursor-color = #f5e0dc\n# comment\n");
    expect(g.background).toBe("#1e1e2e");
    expect(g.palette).toHaveLength(16);
    expect(g.cursor).toBe("#f5e0dc");
    expect(g.selection).toBe("#585b70");
  });

  it("rejects a file without 16 colours", () => {
    expect(() => parseGhostty("background = #000000\nforeground = #ffffff\npalette = 0=#000000")).toThrow(/16 palette/);
  });
});

describe("ghosttyBase", () => {
  it.each([
    ["#1e1e2e", "dark"],
    ["#282828", "dark"],
    ["#fdf6e3", "light"],
    ["#ffffff", "light"],
  ])("background %s is a %s theme", (bg, scheme) => {
    expect(ghosttyBase(parseGhostty(ghosttyFile({ bg, fg: scheme === "dark" ? "#eeeeee" : "#111111" })), override()).scheme).toBe(scheme);
  });

  it.each([
    ["dark", "#1e1e2e", -0.05],
    ["light", "#fdf6e3", -0.045],
  ])("the %s canvas is the background a step darker", (_, bg, d) => {
    const { base } = ghosttyBase(parseGhostty(ghosttyFile({ bg, fg: "#888888" })), override());
    expect(base.surface).toBe(bg);
    expect(lightness(base.canvas) - lightness(bg)).toBeCloseTo(d, 2);
  });

  it("dark themes take bright slots, falling back to the normal slot when the bright one is grey", () => {
    const { base } = ghosttyBase(parseGhostty(ghosttyFile({ bg: "#002b36", fg: "#eeeeee", palette: { 9: "#ff7777", 10: "#586e75" } })), override());
    expect(base.error).toBe("#ff7777");
    expect(base.success).toBe("#98c379");
  });

  it.each([
    ["light themes take normal slots", {}, "#e06c75"],
    ["slots: bright on a light theme", { slots: "bright" as const }, "#aa0000"],
    ["a status override by ANSI slot", { status: { error: 5 } }, "#c678dd"],
    ["a status override by hex", { status: { error: "#ABCDEF" } }, "#abcdef"],
  ])("%s", (_, o, error) => {
    const { base } = ghosttyBase(parseGhostty(ghosttyFile({ bg: "#ffffff", fg: "#111111", palette: { 9: "#aa0000" } })), override(o));
    expect(base.error).toBe(error);
  });

  it("the accent is the override's, else the foreground; the terminal keeps what the file has", () => {
    const g = parseGhostty(ghosttyFile({ bg: "#1e1e2e", fg: "#cdd6f4" }));
    expect(ghosttyBase(g, override({ accent: "#CBA6F7" })).base.accent).toBe("#cba6f7");
    const { base } = ghosttyBase(g, override());
    expect(base.accent).toBe("#cdd6f4");
    expect(base.text).toBe("#cdd6f4");
    expect(base.terminal).toEqual({ foreground: "#cdd6f4", ansi: g.palette });
  });
});
