import { afterEach, describe, expect, it } from "vitest";
import { contrast } from "@/themes/color";
import { themes } from "@/themes";
import { resolveSlots } from "@/themes/slots";
import { findColors, sameTheme, terminalFindColors, terminalTheme, watchTerminalTheme } from "./theme";

// A stand-in for src/index.css: the scheme is the `dark` class on <html>.
const css = `
:root { --cf-surface: #ffffff; --terminal-fg: #24292f; --terminal-ansi-1: #cf222e; }
.dark { --cf-surface: #080808; --terminal-fg: #d8dadf; --terminal-ansi-1: #e06c75; }
html[data-theme="catppuccin-mocha"] { --cf-surface: #1e1e2e; --terminal-fg: #cdd6f4; --terminal-ansi-1: #f38ba8; }
`;

function install(): () => void {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  return () => {
    style.remove();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("style");
    document.documentElement.removeAttribute("data-theme");
  };
}

let cleanup: () => void = () => {};
afterEach(() => {
  cleanup();
});

describe("terminalTheme", () => {
  it("reads the palette for the scheme on <html>, background from --cf-surface", () => {
    cleanup = install();
    expect(terminalTheme()).toEqual({ background: "#ffffff", foreground: "#24292f", red: "#cf222e" });
    document.documentElement.classList.add("dark");
    expect(terminalTheme()).toEqual({ background: "#080808", foreground: "#d8dadf", red: "#e06c75" });
  });

  it("leaves unset variables to xterm's defaults", () => {
    expect(terminalTheme()).toEqual({});
  });

  it("compares palettes by colour", () => {
    expect(sameTheme(undefined, {})).toBe(false);
    expect(sameTheme({ red: "#f00" }, { red: "#f00" })).toBe(true);
    expect(sameTheme({ red: "#f00" }, { red: "#e00" })).toBe(false);
  });
});

describe("findColors", () => {
  it.each(themes.map((t) => ({ id: t.id, slots: resolveSlots(t) })))("$id: the text reads on both tints, and the current match stands out", ({ slots }) => {
    const surface = slots["--cf-surface"] ?? "";
    const text = slots["--terminal-fg"] ?? "";
    const { match, active, border } = findColors(surface, slots["--cf-warning"] ?? "", text);
    for (const c of [match, active, border]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    const floor = Math.min(4.5, contrast(text, surface) * 0.8);
    expect(contrast(text, match)).toBeGreaterThanOrEqual(floor);
    expect(contrast(text, active)).toBeGreaterThanOrEqual(floor);
    expect(contrast(active, surface)).toBeGreaterThan(contrast(match, surface));
    expect(contrast(match, surface)).toBeGreaterThan(1.03);
    expect(contrast(border, surface)).toBeGreaterThanOrEqual(3);
  });

  it("flattens a translucent colour onto the surface", () => {
    expect(findColors("#000000", "#ffffff80", "#ffffff").border).toBe("#808080");
  });

  it("falls back for what is not a hex colour (jsdom has no theme)", () => {
    expect(terminalFindColors().active).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("watchTerminalTheme", () => {
  it("reports a warning colour that changed alone: the find's colours come from it", async () => {
    cleanup = install();
    const seen: string[] = [];
    const stop = watchTerminalTheme((t) => seen.push(t.background ?? ""));
    document.documentElement.style.setProperty("--cf-warning", "#112233");
    await Promise.resolve();
    expect(seen).toEqual(["#ffffff"]);
    stop();
  });

  it("reports a new palette when the scheme class flips, not on unrelated changes", async () => {
    cleanup = install();
    const seen: string[] = [];
    const stop = watchTerminalTheme((t) => seen.push(t.background ?? ""));
    document.documentElement.style.setProperty("--cf-zoom", "1.25");
    await Promise.resolve();
    expect(seen).toEqual([]);
    document.documentElement.classList.add("dark");
    await Promise.resolve();
    expect(seen).toEqual(["#080808"]);
    document.documentElement.classList.remove("dark");
    await Promise.resolve();
    expect(seen).toEqual(["#080808", "#ffffff"]);
    stop();
    document.documentElement.classList.add("dark");
    await Promise.resolve();
    expect(seen).toHaveLength(2);
  });

  it("reports a new palette when data-theme changes (lib/theme.ts switching themes)", async () => {
    cleanup = install();
    document.documentElement.classList.add("dark");
    const seen: string[] = [];
    const stop = watchTerminalTheme((t) => seen.push(`${t.background ?? ""} ${t.red ?? ""}`));
    document.documentElement.dataset.theme = "catppuccin-mocha";
    await Promise.resolve();
    expect(seen).toEqual(["#1e1e2e #f38ba8"]);
    document.documentElement.dataset.theme = "unknown";
    await Promise.resolve();
    expect(seen).toEqual(["#1e1e2e #f38ba8", "#080808 #e06c75"]);
    stop();
  });
});
