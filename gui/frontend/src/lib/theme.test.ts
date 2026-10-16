import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "@/themes";
import { activeTheme, setThemePreference, setThemeSlots, syncDocumentScheme, themeSlots } from "./theme";

const root = document.documentElement;
let stop: () => void = () => {};

afterEach(() => {
  stop();
  setThemePreference("system");
  setThemeSlots({ light: DEFAULT_LIGHT, dark: DEFAULT_DARK });
  root.removeAttribute("data-theme");
  root.className = "";
  root.removeAttribute("style");
});

describe("theme slots", () => {
  it("default to Catppuccin", () => {
    expect(themeSlots()).toEqual({ light: "catppuccin-latte", dark: "catppuccin-mocha" });
  });

  it.each([
    ["a known theme of the slot's scheme", { dark: "dracula" }, { light: DEFAULT_LIGHT, dark: "dracula" }],
    ["both slots", { light: "rose-pine-dawn", dark: "nord" }, { light: "rose-pine-dawn", dark: "nord" }],
    ["an unknown id", { dark: "nope" }, { light: DEFAULT_LIGHT, dark: DEFAULT_DARK }],
    ["a theme of the other scheme", { light: "dracula" }, { light: DEFAULT_LIGHT, dark: DEFAULT_DARK }],
    ["undefined", { dark: undefined }, { light: DEFAULT_LIGHT, dark: DEFAULT_DARK }],
  ])("set with %s", (_, next, want) => {
    setThemeSlots(next);
    expect(themeSlots()).toEqual(want);
  });

  it("a missing key keeps that slot", () => {
    setThemeSlots({ light: "github-light" });
    setThemeSlots({ dark: "nord" });
    expect(themeSlots()).toEqual({ light: "github-light", dark: "nord" });
  });

  it("the active theme is the effective scheme's slot", () => {
    setThemeSlots({ light: "solarized-light", dark: "gruvbox-dark" });
    setThemePreference("light");
    expect(activeTheme().id).toBe("solarized-light");
    setThemePreference("dark");
    expect(activeTheme().id).toBe("gruvbox-dark");
  });
});

describe("syncDocumentScheme", () => {
  it("sets data-theme, the dark class and color-scheme, and follows slot and preference changes", () => {
    stop = syncDocumentScheme();
    // jsdom has no matchMedia: the system scheme is dark.
    expect(root.dataset.theme).toBe("catppuccin-mocha");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");

    setThemePreference("light");
    expect(root.dataset.theme).toBe("catppuccin-latte");
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");

    setThemeSlots({ light: "github-light" });
    expect(root.dataset.theme).toBe("github-light");
  });

  it("follows the macOS appearance under the system preference", () => {
    const listeners = new Set<() => void>();
    let light = false;
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return light;
      },
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }));
    try {
      stop = syncDocumentScheme();
      expect(root.dataset.theme).toBe("catppuccin-mocha");
      light = true;
      for (const l of listeners) l();
      expect(root.dataset.theme).toBe("catppuccin-latte");
    } finally {
      stop();
      stop = () => {};
      vi.unstubAllGlobals();
    }
  });
});
