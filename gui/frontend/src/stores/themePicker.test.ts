import { beforeEach, describe, expect, it, vi } from "vitest";
import { setThemePreference, setThemeSlots } from "@/lib/theme";

const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("./commands", async (orig) => ({ ...(await orig<typeof import("./commands")>()), runCommandForResult }));

import {
  acceptPairHint,
  applyPreview,
  filterThemes,
  pairHintFor,
  previewTheme,
  previewedId,
  resetPreview,
  schemeNote,
  setPickerSlot,
  useThemePickerStore,
} from "./themePicker";
import { closeThemes, openThemes, setSettingsPage, showView, useViewsStore } from "./views";

// A fixed pair of slots (not the app defaults), so the pairing cases have a companion to find.
const SLOTS = { dark: "catppuccin-mocha", light: "catppuccin-latte" };

beforeEach(() => {
  runCommandForResult.mockReset();
  runCommandForResult.mockResolvedValue({ message: "", resultJson: "" });
  setThemePreference("dark");
  setThemeSlots(SLOTS);
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
});

describe("pairHintFor", () => {
  it.each([
    ["a theme whose companion is not the other slot", "gruvbox-dark", SLOTS, { slot: "light", themeId: "gruvbox-light", fromId: "gruvbox-dark" }],
    ["a light theme suggests for dark", "rose-pine-dawn", SLOTS, { slot: "dark", themeId: "rose-pine", fromId: "rose-pine-dawn" }],
    ["the companion already in the other slot", "catppuccin-mocha", SLOTS, null],
    ["a theme without a companion", "dracula", SLOTS, null],
    ["an unknown id", "sepia", SLOTS, null],
  ])("%s", (_, id, slots, want) => {
    expect(pairHintFor(id, slots)).toEqual(want);
  });
});

describe("filterThemes", () => {
  it.each([
    ["empty lists the scheme's themes", "dark", "", 15],
    ["every word must match, any case", "dark", "GRUV dark", 1],
    ["ids match too", "light", "rose-pine", 1],
    ["only the scheme's themes", "light", "dracula", 0],
  ] as const)("%s", (_, scheme, q, n) => {
    expect(filterThemes(scheme, q)).toHaveLength(n);
  });
});

describe("schemeNote", () => {
  it.each([
    ["system", "dark", "Follows macOS: dark now, showing Catppuccin Mocha"],
    ["dark", "dark", "Always dark, showing Catppuccin Mocha"],
    ["light", "light", "Always light, showing Catppuccin Mocha"],
  ] as const)("%s", (pref, scheme, want) => {
    expect(schemeNote(pref, scheme, "Catppuccin Mocha")).toBe(want);
  });
});

describe("the page state", () => {
  it("opens on the slot in use, or the one asked for; a second open only moves the slot", () => {
    openThemes();
    expect(useViewsStore.getState().themesOpen).toBe(true);
    expect(useThemePickerStore.getState().slot).toBe("dark");
    previewTheme("dracula");
    openThemes("light");
    expect(useThemePickerStore.getState()).toMatchObject({ slot: "light", preview: null });
  });

  it("previews only the editing slot's themes; the slot's own theme is no preview", () => {
    openThemes("dark");
    previewTheme("catppuccin-latte");
    expect(useThemePickerStore.getState().preview).toBeNull();
    previewTheme("nord");
    expect(previewedId(useThemePickerStore.getState(), SLOTS)).toBe("nord");
    previewTheme("catppuccin-mocha");
    expect(useThemePickerStore.getState().preview).toBeNull();
    previewTheme("nord");
    resetPreview();
    expect(previewedId(useThemePickerStore.getState(), SLOTS)).toBe("catppuccin-mocha");
    previewTheme("nord");
    setPickerSlot("light");
    expect(previewedId(useThemePickerStore.getState(), SLOTS)).toBe("catppuccin-latte");
  });

  it("Apply writes the slot through its command, then suggests the companion; accepting writes the other slot", async () => {
    openThemes("dark");
    expect(await applyPreview()).toBe(false); // nothing previewed
    previewTheme("gruvbox-dark");
    expect(await applyPreview()).toBe(true);
    expect(runCommandForResult).toHaveBeenCalledWith("theme.set-dark", { theme: "gruvbox-dark" }, { quiet: true });
    expect(useThemePickerStore.getState()).toMatchObject({ preview: null, hint: { slot: "light", themeId: "gruvbox-light" } });
    expect(await acceptPairHint()).toBe(true);
    expect(runCommandForResult).toHaveBeenLastCalledWith("theme.set-light", { theme: "gruvbox-light" }, { quiet: true });
    expect(useThemePickerStore.getState().hint).toBeNull();
  });

  it("a failed Apply keeps the preview and suggests nothing", async () => {
    runCommandForResult.mockResolvedValue(null);
    openThemes("dark");
    previewTheme("gruvbox-dark");
    expect(await applyPreview()).toBe(false);
    expect(useThemePickerStore.getState()).toMatchObject({ preview: "gruvbox-dark", hint: null, applying: false });
  });

  it("closing drops the preview and goes back to Settings when it came from there", () => {
    useViewsStore.setState({ settingsOpen: true });
    openThemes("light", "settings");
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: true, settingsOpen: false });
    previewTheme("nord"); // ignored: a dark theme on the light slot
    previewTheme("solarized-light");
    closeThemes();
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: false, settingsOpen: true });
    expect(useThemePickerStore.getState().preview).toBeNull();
    // Opened from anywhere else (the palette over a thread), closing does not open Settings.
    useViewsStore.setState({ settingsOpen: false });
    openThemes();
    closeThemes();
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: false, settingsOpen: false });
  });

  it("Settings opens on General; back from Themes it keeps the page Themes was opened from", () => {
    useViewsStore.setState({ settingsOpen: false, settingsPage: "keybindings" });
    showView("settings");
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "general" });
    setSettingsPage("appearance");
    openThemes(undefined, "settings");
    closeThemes();
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "appearance" });
  });

  it.each([
    ["themes", "dark"],
    ["themes.dark", "dark"],
    ["themes.light", "light"],
  ] as const)("ShowView %s opens it on %s", (name, slot) => {
    expect(showView(name)).toBe(true);
    expect(useViewsStore.getState().themesOpen).toBe(true);
    expect(useThemePickerStore.getState().slot).toBe(slot);
  });

  it("opening settings or usage closes it", () => {
    openThemes();
    showView("usage");
    expect(useViewsStore.getState()).toMatchObject({ themesOpen: false, usageOpen: true });
  });
});
