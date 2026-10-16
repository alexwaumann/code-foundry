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
  it("default to GitHub", () => {
    expect(themeSlots()).toEqual({ light: "github-light", dark: "github-dark" });
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
    setThemeSlots({ light: "atom-one-light" });
    setThemeSlots({ dark: "nord" });
    expect(themeSlots()).toEqual({ light: "atom-one-light", dark: "nord" });
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
    expect(root.dataset.theme).toBe("github-dark");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");

    setThemePreference("light");
    expect(root.dataset.theme).toBe("github-light");
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");

    setThemeSlots({ light: "rose-pine-dawn" });
    expect(root.dataset.theme).toBe("rose-pine-dawn");
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
      expect(root.dataset.theme).toBe("github-dark");
      light = true;
      for (const l of listeners) l();
      expect(root.dataset.theme).toBe("github-light");
    } finally {
      stop();
      stop = () => {};
      vi.unstubAllGlobals();
    }
  });
});

describe("the stored theme", () => {
  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("is written on every change", async () => {
    const { setThemePreference: pref, setThemeSlots: slots, THEME_STORAGE_KEY } = await import("./theme");
    slots({ dark: "dracula" });
    pref("light");
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? "")).toEqual({ scheme: "light", light: DEFAULT_LIGHT, dark: "dracula" });
  });

  it.each([
    ["a stored theme", { scheme: "light", dark: "nord", light: "rose-pine-dawn" }, "light", { light: "rose-pine-dawn", dark: "nord" }],
    ["unknown and wrong-scheme ids", { scheme: "dark", dark: "gone", light: "dracula" }, "dark", { light: DEFAULT_LIGHT, dark: DEFAULT_DARK }],
    ["a bad scheme", { scheme: "sepia" }, "system", { light: DEFAULT_LIGHT, dark: DEFAULT_DARK }],
  ])("seeds a fresh load from %s", async (_, stored, pref, want) => {
    localStorage.setItem("cf.theme", JSON.stringify(stored));
    vi.resetModules();
    const fresh = await import("./theme");
    expect(fresh.themePreference()).toBe(pref);
    expect(fresh.themeSlots()).toEqual(want);
  });
});
