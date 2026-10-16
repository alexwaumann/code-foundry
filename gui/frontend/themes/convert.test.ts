// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrast } from "./color.ts";
import { buildCatalog, catalogJson, indexVarNames, parseGhostty, PATHS, readInputs, SYNTAX_VARS, themesCss, type Inputs, type Override } from "./convert.ts";

const inputs = readInputs();

describe("generated files", () => {
  // `pnpm run themes` regenerates both; a hand edit or a changed input fails here.
  it("catalog.json and themes.css match the converter's output", () => {
    const catalog = buildCatalog(inputs);
    expect(fs.readFileSync(PATHS.catalog, "utf8")).toBe(catalogJson(catalog));
    expect(fs.readFileSync(PATHS.css, "utf8")).toBe(themesCss(catalog));
  });

  it("every theme has every index.css colour variable and the syntax colours, nothing else", () => {
    const names = [...indexVarNames(inputs.indexCss), ...SYNTAX_VARS];
    expect(names).toContain("--terminal-ansi-15");
    for (const t of buildCatalog(inputs)) expect(Object.keys(t.vars)).toEqual(names);
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
});

const BASE = ["#222222", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#cccccc"];
const palette = (over: Record<number, string> = {}) => Array.from({ length: 16 }, (_, i) => over[i] ?? BASE[i % 8] ?? "#000000");

function ghosttyFile(o: { bg: string; fg: string; selection?: string; palette?: Record<number, string> }): string {
  const lines = palette(o.palette).map((c, i) => `palette = ${String(i)}=${c}`);
  lines.push(`background = ${o.bg}`, `foreground = ${o.fg}`);
  if (o.selection) lines.push(`selection-background = ${o.selection}`);
  return lines.join("\n");
}

/** One synthetic theme through the real pipeline (index.css names, the guards). */
function convert(file: string, override: Partial<Override> = {}) {
  const fake: Inputs = {
    indexCss: inputs.indexCss,
    overrides: { t: { name: "T", ghostty: "t", upstream: "test", why: "test", ...override } },
    ghostty: () => file,
  };
  const t = buildCatalog(fake)[0];
  if (!t) throw new Error("no theme");
  return t;
}

const v = (t: { vars: Record<string, string> }, k: string) => t.vars[k] ?? "";

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

describe("derivation and guards", () => {
  it.each([
    ["#1e1e2e", "dark"],
    ["#282828", "dark"],
    ["#fdf6e3", "light"],
    ["#ffffff", "light"],
  ])("background %s is a %s theme", (bg, scheme) => {
    expect(convert(ghosttyFile({ bg, fg: scheme === "dark" ? "#eeeeee" : "#111111" })).scheme).toBe(scheme);
  });

  it("dark themes take bright slots, falling back to the normal slot when the bright one is grey", () => {
    const t = convert(ghosttyFile({ bg: "#002b36", fg: "#eeeeee", palette: { 9: "#ff7777", 10: "#586e75" } }));
    expect(t.vars["--destructive"]).toBe("#ff7777");
    expect(t.vars["--success"]).toBe("#98c379");
  });

  it("a status override takes another slot or a hex, and is still guarded", () => {
    const t = convert(ghosttyFile({ bg: "#ffffff", fg: "#111111" }), { status: { info: 6, warning: "#ffee00" } });
    expect(contrast(v(t, "--warning"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(t.vars["--link"]).toBe(t.vars["--info"]);
  });

  it("lifts a low-contrast foreground to 7:1 and keeps the terminal's own", () => {
    const t = convert(ghosttyFile({ bg: "#002b36", fg: "#657b83" }));
    expect(contrast(v(t, "--foreground"), "#002b36")).toBeGreaterThanOrEqual(7);
    expect(t.vars["--terminal-fg"]).toBe("#657b83");
  });

  it("replaces a selection that is the foreground", () => {
    const t = convert(ghosttyFile({ bg: "#ffffff", fg: "#1f2328", selection: "#1f2328" }));
    expect(t.vars["--terminal-selection"]).not.toBe("#1f2328");
    expect(contrast(v(t, "--terminal-selection"), "#1f2328")).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ["under 3:1", "#2a2a2a"],
    ["as strong as the text", "#000000"],
  ])("a comment colour %s becomes muted-foreground", (_, ansi8) => {
    const bg = ansi8 === "#000000" ? "#f9f9f9" : "#1e1e1e";
    const t = convert(ghosttyFile({ bg, fg: ansi8 === "#000000" ? "#2a2c33" : "#dddddd", palette: { 8: ansi8 } }));
    expect(t.vars["--syn-com"]).toBe(t.vars["--muted-foreground"]);
  });

  it("an accent becomes the primary with readable text, preferring dark text", () => {
    const t = convert(ghosttyFile({ bg: "#1e1e2e", fg: "#cdd6f4" }), { accent: "#cba6f7" });
    expect(t.vars["--primary"]).toBe("#cba6f7");
    expect(t.vars["--primary-foreground"]).toBe("#1e1e2e");
    expect(t.vars["--sidebar-primary"]).toBe("#cba6f7");
  });

  it("nudges an accent that neither text colour can sit on", () => {
    const t = convert(ghosttyFile({ bg: "#002b36", fg: "#93a1a1" }), { accent: "#268bd2" });
    expect(contrast(v(t, "--primary-foreground"), v(t, "--primary"))).toBeGreaterThanOrEqual(4.5);
    expect(t.vars["--primary"]).not.toBe("#268bd2");
  });
});
