import { describe, expect, it } from "vitest";
import { contrast, flatten, lightness, mix, over, parseHex, shiftL } from "./color";
import { COMPONENT_ALIASES, componentValues, parseThemeFile, resolveSlots, schemeProblem, SLOT_GROUPS, SLOT_NAMES, SLOTS, textOn, type ThemeBase, type ThemeScheme } from "./slots";

// The derivation rules (docs/notes/theme-slots-1-engine.md has the table), on synthetic
// bases so each rule's branch is visible. contrast.test.ts checks the curated themes.

const ANSI = ["#222222", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#cccccc", "#5c6370", "#ef8189", "#a9d38a", "#f0d08f", "#7cc0f7", "#d68ff0", "#6fcbd6", "#f2f3f5"];

const DARK: ThemeBase = {
  canvas: "#131222",
  surface: "#1e1e2e",
  text: "#cdd6f4",
  accent: "#cba6f7",
  success: "#a6e3a1",
  warning: "#f9e2af",
  error: "#f38ba8",
  info: "#89b4fa",
  highlight: "#f5c2e7",
  terminal: { foreground: "#cdd6f4", ansi: ANSI },
};

const LIGHT: ThemeBase = {
  canvas: "#f0f0f0",
  surface: "#ffffff",
  text: "#1f2328",
  accent: "#0969da",
  success: "#1a7f37",
  warning: "#9a6700",
  error: "#cf222e",
  info: "#0969da",
  highlight: "#8250df",
  terminal: { foreground: "#1f2328", ansi: ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"] },
};

type Patch = Partial<Omit<ThemeBase, "terminal">> & { terminal?: Partial<ThemeBase["terminal"]> };

function resolve(scheme: ThemeScheme, patch: Patch = {}, overrides?: Record<string, string>) {
  const b = scheme === "dark" ? DARK : LIGHT;
  const base: ThemeBase = { ...b, ...patch, terminal: { ...b.terminal, ...patch.terminal } };
  const s = resolveSlots({ scheme, base, ...(overrides ? { overrides } : {}) });
  return (k: string) => {
    const v = s[k];
    if (v === undefined) throw new Error(`no ${k}`);
    return v;
  };
}

const alphaOf = (hex: string) => parseHex(hex).alpha;

describe("the slot set", () => {
  it("every slot resolves, in SLOTS order, once each", () => {
    for (const scheme of ["dark", "light"] as const) expect(Object.keys(resolveSlots({ scheme, base: scheme === "dark" ? DARK : LIGHT }))).toEqual(SLOT_NAMES);
    expect(new Set(SLOT_NAMES).size).toBe(SLOT_NAMES.length);
  });

  it("names are --cf-<slot>, or the terminal and syntax palettes' own", () => {
    for (const n of SLOT_NAMES) expect(n).toMatch(/^--(?:cf-[a-z]+(?:-[a-z0-9]+)*|terminal-[a-z0-9-]+|syn-[a-z]+|sh-[a-z]+)$/);
  });

  it("has 72 semantic slots, the 21 terminal colours and the 10 syntax colours, each in a known group", () => {
    expect(SLOT_NAMES.filter((n) => n.startsWith("--cf-"))).toHaveLength(72);
    expect(SLOT_NAMES.filter((n) => n.startsWith("--terminal-"))).toHaveLength(21);
    expect(SLOT_NAMES.filter((n) => /^--(syn|sh)-/.test(n))).toHaveLength(10);
    for (const s of SLOTS) expect(SLOT_GROUPS, s.name).toContain(s.group);
    for (const g of SLOT_GROUPS) expect(SLOTS.some((s) => s.group === g), g).toBe(true);
  });

  it("every component name aliases a slot, and componentValues resolves them", () => {
    for (const slot of Object.values(COMPONENT_ALIASES)) expect(SLOT_NAMES).toContain(slot);
    const s = resolveSlots({ scheme: "dark", base: DARK });
    const c = componentValues(s);
    expect(c["--card"]).toBe(s["--cf-surface-raised"]);
    expect(c["--accent"]).toBe(s["--cf-control-hover"]);
    expect(c["--sidebar-accent"]).toBe(s["--cf-sidebar-row-selected"]);
  });
});

describe("rules", () => {
  it.each(["dark", "light"] as const)("%s: canvas, surface and the surfaces derived from them", (scheme) => {
    const v = resolve(scheme);
    const b = scheme === "dark" ? DARK : LIGHT;
    const dark = scheme === "dark";
    expect(v("--cf-canvas")).toBe(b.canvas);
    expect(v("--cf-surface")).toBe(b.surface);
    expect(v("--cf-chrome")).toBe(b.canvas);
    expect(v("--cf-surface-raised")).toBe(b.surface);
    expect(v("--cf-surface-overlay")).toBe(shiftL(b.surface, dark ? 0.03 : 0.02));
    expect(v("--cf-surface-sunken")).toBe(mix(b.surface, v("--cf-text"), dark ? 0.08 : 0.04));
    expect(v("--cf-border")).toBe(over(v("--cf-text"), dark ? 0.11 : 0.1, b.surface));
    expect(v("--cf-border-strong")).toBe(over(v("--cf-text"), dark ? 0.18 : 0.16, b.surface));
    expect(v("--cf-divider")).toBe(over(v("--cf-text"), dark ? 0.11 : 0.08, b.surface));
    expect(v("--cf-input")).toBe(over(v("--cf-text"), dark ? 0.15 : 0.13, b.surface));
  });

  it.each([
    ["a readable dark text is kept", "dark", "#cdd6f4", "same"],
    ["a faint dark text is lifted to 7:1", "dark", "#6c7086", "lifted"],
    ["a readable light text is kept", "light", "#1f2328", "same"],
    ["a faint light text is darkened to 7:1", "light", "#8c959f", "lifted"],
  ] as const)("text: %s", (_, scheme, text, want) => {
    const v = resolve(scheme, { text });
    if (want === "same") expect(v("--cf-text")).toBe(text);
    else {
      expect(v("--cf-text")).not.toBe(text);
      expect(contrast(v("--cf-text"), v("--cf-surface"))).toBeGreaterThanOrEqual(7);
    }
  });

  it.each(["dark", "light"] as const)("%s: muted text clears 4.5:1 on surface, canvas, a well and a hovered row; secondary sits between it and the text", (scheme) => {
    const v = resolve(scheme);
    for (const bg of ["--cf-surface", "--cf-canvas", "--cf-surface-sunken", "--cf-control-hover"]) expect(contrast(v("--cf-text-muted"), v(bg)), bg).toBeGreaterThanOrEqual(4.5);
    const c = (k: string) => contrast(v(k), v("--cf-surface"));
    expect(c("--cf-text-secondary")).toBeLessThan(c("--cf-text"));
    expect(c("--cf-text-secondary")).toBeGreaterThan(c("--cf-text-muted"));
    expect(v("--cf-placeholder")).toBe(v("--cf-text-muted"));
    expect(v("--cf-icon")).toBe(v("--cf-text"));
    expect(v("--cf-icon-muted")).toBe(v("--cf-text-muted"));
  });

  it("muted text on a low-contrast theme is pulled toward the text until it reads", () => {
    const v = resolve("light", { surface: "#fdf6e3", canvas: "#f2ead6", text: "#586e75" });
    expect(contrast(v("--cf-text-muted"), "#f2ead6")).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["a readable red is kept as the fill (its text steps for the tint on the grey sheet)", "light", { error: "#cf222e" }, "error", "#cf222e"],
    ["a pale yellow fill is darkened to 3:1, its text further", "light", { warning: "#e5c07b" }, "warning", null],
    ["a yellow at 3:1 stays a bright fill on light", "light", { warning: "#a87800" }, "warning", "#a87800"],
    ["a dark red is lifted on dark, its text further", "dark", { error: "#7f2a33", surface: "#2e3440", canvas: "#242933" }, "error", null],
  ] as const)("status: %s", (_, scheme, patch, tone, fill) => {
    const v = resolve(scheme, patch);
    const k = `--cf-${tone}`;
    if (fill) expect(v(k)).toBe(fill);
    else expect(v(k)).not.toBe((patch as Record<string, string>)[tone]);
    for (const bg of ["--cf-surface", "--cf-canvas"]) {
      expect(contrast(v(k), v(bg)), `fill on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(v(`${k}-text`), v(bg)), `text on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v(`${k}-text`), flatten(v(`${k}-surface`), v(bg))), `text on the tint over ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    // The text steps from the fill in the same direction, never back toward the surface.
    const away = (x: string) => Math.abs(lightness(x) - lightness(v("--cf-surface")));
    expect(away(v(`${k}-text`))).toBeGreaterThanOrEqual(away(v(k)));
  });

  it("status sets: the foreground reads on the fill, the surface is a 10% tint of it; update is info's", () => {
    const v = resolve("dark");
    for (const tone of ["success", "warning", "error", "info", "highlight"]) {
      expect(contrast(v(`--cf-${tone}-foreground`), v(`--cf-${tone}`))).toBeGreaterThanOrEqual(4.5);
      expect(v(`--cf-${tone}-surface`).slice(0, 7)).toBe(v(`--cf-${tone}`));
      expect(alphaOf(v(`--cf-${tone}-surface`))).toBeCloseTo(0.1, 2);
    }
    expect([v("--cf-update"), v("--cf-update-foreground"), v("--cf-update-surface"), v("--cf-update-text")]).toEqual([v("--cf-info"), v("--cf-info-foreground"), v("--cf-info-surface"), v("--cf-info-text")]);
  });

  it.each([
    ["the darker theme colour when it reads", "#cba6f7", "#1e1e2e", "#cdd6f4", "#1e1e2e"],
    ["the lighter one when only it reads", "#0969da", "#ffffff", "#1f2328", "#ffffff"],
    ["black when neither reads and black is better", "#b77100", "#eff1f5", "#4c4f69", "#000000"],
    ["white when neither reads and white is better", "#7a3fb0", "#9a9aa0", "#6a6a70", "#ffffff"],
  ] as const)("textOn: %s", (_, fill, a, b, want) => {
    expect(textOn(fill, a, b)).toBe(want);
    expect(contrast(textOn(fill, a, b), fill)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["absent: info's text", {}, "info"],
    ["present: its own, guarded", { link: "#ffd866" }, "own"],
  ] as const)("link %s", (_, patch, want) => {
    const v = resolve("light", patch);
    if (want === "info") expect(v("--cf-link")).toBe(v("--cf-info-text"));
    else {
      expect(v("--cf-link")).not.toBe(v("--cf-info-text"));
      expect(contrast(v("--cf-link"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ["a light accent on dark takes dark text", "dark", "#cba6f7", "#cba6f7", "#1e1e2e"],
    ["a dark accent on light takes light text", "light", "#0969da", "#0969da", "#ffffff"],
  ] as const)("accent: %s", (_, scheme, accent, want, fg) => {
    const v = resolve(scheme, { accent });
    expect(v("--cf-accent")).toBe(want);
    expect(v("--cf-accent-foreground")).toBe(fg);
  });

  it("accent: one neither text can sit on is nudged until one reads", () => {
    const v = resolve("dark", { surface: "#002b36", canvas: "#001f27", text: "#93a1a1", accent: "#268bd2" });
    expect(v("--cf-accent")).not.toBe("#268bd2");
    expect(contrast(v("--cf-accent-foreground"), v("--cf-accent"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["dark", "light"] as const)("%s: accent tints and the focus ring", (scheme) => {
    const v = resolve(scheme);
    expect(alphaOf(v("--cf-accent-surface"))).toBeCloseTo(0.1, 2);
    expect(alphaOf(v("--cf-selection"))).toBeCloseTo(0.25, 2);
    expect(alphaOf(v("--cf-message-surface"))).toBeCloseTo(scheme === "dark" ? 0.145 : 0.08, 2);
    expect(contrast(v("--cf-accent-surface-foreground"), flatten(v("--cf-accent-surface"), v("--cf-surface")))).toBeGreaterThanOrEqual(4.5);
    const start = mix(v("--cf-accent"), v("--cf-surface"), 0.35);
    for (const bg of ["--cf-surface", "--cf-canvas"]) expect(contrast(v("--cf-focus"), v(bg)), bg).toBeGreaterThanOrEqual(3);
    if (contrast(start, v("--cf-surface")) >= 3 && contrast(start, v("--cf-canvas")) >= 3) expect(v("--cf-focus")).toBe(start);
    else expect(v("--cf-focus")).not.toBe(start);
  });

  it.each(["dark", "light"] as const)("%s: wells, controls and sidebar rows are distinct steps toward the text", (scheme) => {
    const v = resolve(scheme);
    const d = (k: string, from: string) => Math.abs(lightness(v(k)) - lightness(v(from)));
    const steps = ["--cf-surface-sunken", "--cf-control", "--cf-control-hover", "--cf-control-active"].map((k) => d(k, "--cf-surface"));
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(new Set(steps).size).toBe(4);
    expect(d("--cf-sidebar-row-hover", "--cf-sidebar")).toBeLessThan(d("--cf-sidebar-row-selected", "--cf-sidebar"));
    expect(contrast(v("--cf-sidebar-row-selected"), v("--cf-sidebar"))).toBeGreaterThanOrEqual(1.25);
    expect([v("--cf-sidebar"), v("--cf-sidebar-border")]).toEqual([v("--cf-canvas"), v("--cf-canvas")]);
  });

  it.each([
    ["a deep dark base steps its selected row past 10%", "dark", { canvas: "#040a1c", surface: "#0a1532", text: "#b8c6ee" }],
    ["a light base", "light", {}],
  ] as const)("sidebar: %s; the muted text reads on the selected and hovered rows", (_, scheme, patch) => {
    const v = resolve(scheme, patch);
    expect(contrast(v("--cf-sidebar-row-selected"), v("--cf-sidebar"))).toBeGreaterThanOrEqual(1.25);
    for (const bg of ["--cf-sidebar", "--cf-sidebar-row-selected", "--cf-sidebar-row-hover"]) expect(contrast(v("--cf-sidebar-muted-foreground"), v(bg)), bg).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["dark", "#cdd6f4", 0.05],
    ["light", null, 1],
  ] as const)("%s: code background", (scheme, alphaOfText, alpha) => {
    const v = resolve(scheme);
    if (alphaOfText) expect(v("--cf-code-background").slice(0, 7)).toBe(alphaOfText);
    else expect(v("--cf-code-background")).toBe(v("--cf-surface-sunken"));
    expect(alphaOf(v("--cf-code-background"))).toBeCloseTo(alpha, 2);
    expect(v("--cf-code-foreground")).toBe(v("--syn-fg"));
    expect(v("--cf-quote-border")).toBe(v("--cf-border"));
  });

  it.each([
    ["dark", 0.2],
    ["light", 0.12],
  ] as const)("%s: diff colours are the status text, line backgrounds the surface mixed %d toward them (opaque)", (scheme, t) => {
    const v = resolve(scheme);
    expect([v("--cf-diff-addition"), v("--cf-diff-deletion"), v("--cf-diff-modified")]).toEqual([v("--cf-success-text"), v("--cf-error-text"), v("--cf-warning-text")]);
    expect(v("--cf-diff-addition-surface")).toBe(mix(v("--cf-surface"), v("--cf-diff-addition"), t));
    expect(v("--cf-diff-deletion-surface")).toBe(mix(v("--cf-surface"), v("--cf-diff-deletion"), t));
  });

  it.each([
    ["cyan when it is not info's hue", {}, "cyan"],
    ["the accent when cyan is info's hue", { info: "#56b6c2" }, "accent"],
  ] as const)("chart-6: %s", (_, patch, want) => {
    const v = resolve("dark", patch);
    expect(v("--cf-chart-6")).toBe(want === "cyan" ? ANSI[6] : v("--cf-accent"));
    expect([1, 2, 3, 4, 5].map((i) => v(`--cf-chart-${String(i)}`))).toEqual(["--cf-info", "--cf-highlight", "--cf-success", "--cf-warning", "--cf-error"].map(v));
  });

  it.each([
    ["no cursor: the terminal foreground", {}, "#cdd6f4", null],
    ["a readable cursor text is kept", { cursor: "#f5e0dc", cursorText: "#1e1e2e" }, "#f5e0dc", "#1e1e2e"],
    ["an unreadable cursor text is replaced", { cursor: "#2f81f7", cursorText: "#6fc1ff" }, "#2f81f7", "replaced"],
  ] as const)("terminal cursor: %s", (_, terminal, cursor, accent) => {
    const v = resolve("dark", { terminal });
    expect(v("--terminal-cursor")).toBe(cursor);
    if (accent === "replaced") expect(contrast(v("--terminal-cursor-accent"), cursor)).toBeGreaterThanOrEqual(3);
    else if (accent) expect(v("--terminal-cursor-accent")).toBe(accent);
  });

  it.each([
    ["absent: the foreground at 20%", {}, mix("#1e1e2e", "#cdd6f4", 0.2)],
    ["readable: kept", { selection: "#585b70" }, "#585b70"],
    ["the foreground itself (inverted): the foreground at 25%", { selection: "#cdd6f4" }, mix("#1e1e2e", "#cdd6f4", 0.25)],
  ] as const)("terminal selection %s", (_, terminal, want) => {
    const v = resolve("dark", { terminal });
    expect(v("--terminal-selection")).toBe(want);
    expect(v("--terminal-selection-inactive")).toBe(mix(want, "#1e1e2e", 0.5));
  });

  it("the terminal palette and foreground are the base's, unguarded", () => {
    const v = resolve("dark", { text: "#6c7086", terminal: { foreground: "#6c7086" } });
    expect(v("--terminal-fg")).toBe("#6c7086");
    for (let i = 0; i < 16; i++) expect(v(`--terminal-ansi-${String(i)}`)).toBe(ANSI[i]);
  });

  it.each([
    ["dark", "--syn-kw", 5],
    ["dark", "--syn-fn", 4],
    ["dark", "--syn-type", 3],
    ["dark", "--syn-str", 2],
    ["dark", "--syn-num", 6],
    ["dark", "--sh-cmd", 4],
    ["dark", "--sh-flag", 6],
    ["light", "--syn-kw", 1],
    ["light", "--syn-fn", 5],
    ["light", "--syn-type", 4],
    ["light", "--syn-str", 2],
  ] as const)("%s %s starts from ANSI %i and reads on the pane and code blocks", (scheme, k, n) => {
    const v = resolve(scheme);
    const b = scheme === "dark" ? DARK : LIGHT;
    const start = b.terminal.ansi[n] ?? "";
    for (const bg of [v("--cf-surface"), v("--cf-surface-sunken")]) expect(contrast(v(k), bg)).toBeGreaterThanOrEqual(4.5);
    if (contrast(start, v("--cf-surface")) >= 4.5 && contrast(start, v("--cf-surface-sunken")) >= 4.5) expect(v(k)).toBe(start);
  });

  it.each([
    ["kept when it reads", "dark", { 8: "#7f849c" }, "#7f849c"],
    ["muted under 3:1", "dark", { 8: "#2a2a2a" }, "muted"],
    ["muted when as strong as the text", "light", { 7: "#000000" }, "muted"],
    ["muted when it reads on the pane but not on a code block", "dark", { 8: "#5f6378" }, "muted"],
  ] as const)("comment: %s", (_, scheme, pal, want) => {
    const b = scheme === "dark" ? DARK : LIGHT;
    const ansi = b.terminal.ansi.map((c, i) => (pal as Record<number, string>)[i] ?? c);
    const v = resolve(scheme, { terminal: { ansi } });
    expect(v("--syn-com")).toBe(want === "muted" ? v("--cf-text-muted") : want);
  });
});

describe("overrides", () => {
  it("replace a slot as given, without a guard", () => {
    const v = resolve("light", {}, { "--cf-text-muted": "#dddddd", "--cf-success-surface": "#00ff0033" });
    expect(v("--cf-text-muted")).toBe("#dddddd");
    expect(v("--cf-success-surface")).toBe("#00ff0033");
  });

  it("flow into the slots derived from them", () => {
    const v = resolve("dark", {}, { "--cf-surface": "#000000", "--cf-text-muted": "#888888" });
    expect(v("--cf-surface-raised")).toBe("#000000");
    expect(v("--cf-surface-sunken")).toBe(mix("#000000", v("--cf-text"), 0.08));
    expect(v("--cf-placeholder")).toBe("#888888");
    expect(v("--cf-icon-muted")).toBe("#888888");
  });
});

describe("parseThemeFile", () => {
  const file = { id: "x", name: "X", scheme: "dark", source: "test", base: DARK };

  it("normalises hex and keeps optional fields only when present", () => {
    const t = parseThemeFile({ ...file, pair: "y", base: { ...DARK, accent: "#CBA6F7" }, overrides: { "--cf-focus": "#AABBCC80" } });
    expect(t.base.accent).toBe("#cba6f7");
    expect(t.overrides).toEqual({ "--cf-focus": "#aabbcc80" });
    expect(t.pair).toBe("y");
    expect(parseThemeFile(file)).not.toHaveProperty("overrides");
    expect(parseThemeFile(file).base).not.toHaveProperty("link");
  });

  it.each([
    ["not an object", [], /not an object/],
    ["no id", { ...file, id: "" }, /no id/],
    ["a bad scheme", { ...file, scheme: "sepia" }, /scheme must be light or dark/],
    ["no base", { ...file, base: undefined }, /no base/],
    ["a missing base colour", { ...file, base: { ...DARK, accent: undefined } }, /base.accent: not a colour/],
    ["an alpha base colour", { ...file, base: { ...DARK, surface: "#1e1e2e80" } }, /base.surface: .* is not #rrggbb/],
    ["15 ANSI colours", { ...file, base: { ...DARK, terminal: { foreground: "#ffffff", ansi: ANSI.slice(1) } } }, /16 colours/],
    ["a bad ANSI colour", { ...file, base: { ...DARK, terminal: { foreground: "#ffffff", ansi: [...ANSI.slice(1), "red"] } } }, /ansi\[15\]/],
    ["an override of a component name", { ...file, overrides: { "--card": "#ffffff" } }, /--card is not a slot/],
    ["an override that is not hex", { ...file, overrides: { "--cf-text": "oklch(0.5 0 0)" } }, /--cf-text is not #rrggbb or #rrggbbaa/],
    ["an override of a retired slot", { ...file, overrides: { "--cf-sidebar-row-active": "#ffffff" } }, /--cf-sidebar-row-active is not a slot/],
    ["an id with capitals and a space", { ...file, id: "Warm Paper" }, /theme id "Warm Paper": use lowercase letters, digits and dashes/],
    ["an id with an underscore", { ...file, id: "warm_paper" }, /theme id "warm_paper"/],
    ["an id starting with a dash", { ...file, id: "-x" }, /theme id "-x"/],
    ["a 65-character id", { ...file, id: "a".repeat(65) }, /theme id/],
    ["dark on a light surface", { ...file, base: LIGHT }, /scheme is "dark" but base.surface #ffffff has OKLab lightness 1.00, a light surface .*set "scheme": "light"/],
    ["light on a dark surface", { ...file, scheme: "light" }, /scheme is "light" but base.surface #1e1e2e .*a dark surface .*set "scheme": "dark"/],
    ["dark on a mid grey", { ...file, base: { ...DARK, surface: "#8a8a8a" } }, /too light for a dark scheme .* and too dark for a light one/],
  ])("refuses %s", (_, json, err) => {
    expect(() => parseThemeFile(json)).toThrow(err);
  });

  it("takes a 64-character id of letters, digits and dashes", () => {
    expect(parseThemeFile({ ...file, id: `a1-${"b".repeat(61)}` }).id).toHaveLength(64);
  });

  it.each([
    ["dark", "#0a1532", null],
    ["dark", "#5a5a5a", "too light for a dark scheme"],
    ["light", "#f5ecd9", null],
    ["light", "#9a9a9a", "too dark for a light scheme"],
  ] as const)("schemeProblem(%s, %s)", (scheme, surface, want) => {
    const got = schemeProblem(scheme, surface);
    if (want === null) expect(got).toBeNull();
    else expect(got).toContain(want);
  });
});
