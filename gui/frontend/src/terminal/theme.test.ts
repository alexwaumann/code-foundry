import { afterEach, describe, expect, it } from "vitest";
import { sameTheme, terminalTheme, watchTerminalTheme } from "./theme";

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

describe("watchTerminalTheme", () => {
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
