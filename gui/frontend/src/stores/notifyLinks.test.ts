import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyLinkAction, showingPage } from "./notifyLinks";
import { useViewsStore } from "./views";

const theme = vi.hoisted(() => ({ edit: vi.fn<(id: string) => Promise<boolean>>(), undo: vi.fn<(scheme: string, id: string) => Promise<boolean>>() }));
vi.mock("./themeCards", () => ({ editSavedTheme: theme.edit, undoTheme: theme.undo }));

describe("notifyLinkAction", () => {
  beforeEach(() => {
    useViewsStore.setState({ settingsOpen: false, settingsPage: "general", usageOpen: false, themesOpen: true, helpOpen: true });
  });

  it("settings:<page> opens that Settings page over the others", () => {
    notifyLinkAction("settings:memory")?.();
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "memory", themesOpen: false, helpOpen: false });
  });

  it.each(["", "settings", "settings:", ":memory", "elsewhere:memory"])("%j is not a link", (link) => {
    expect(notifyLinkAction(link)).toBeNull();
  });

  it("theme-edit:<id> edits the theme; theme-set:<scheme>:<id> puts the slot back", () => {
    theme.edit.mockResolvedValue(true);
    theme.undo.mockResolvedValue(true);
    notifyLinkAction("theme-edit:ocean-dusk")?.();
    expect(theme.edit).toHaveBeenCalledWith("ocean-dusk");
    notifyLinkAction("theme-set:dark:catppuccin-mocha")?.();
    expect(theme.undo).toHaveBeenCalledWith("dark", "catppuccin-mocha");
    theme.undo.mockClear();
    notifyLinkAction("theme-set:sepia:nord")?.();
    notifyLinkAction("theme-set:dark")?.();
    expect(theme.undo).not.toHaveBeenCalled();
  });
});

describe("showingPage", () => {
  it("knows the Themes page; any other page never shows", () => {
    useViewsStore.setState({ themesOpen: true });
    expect(showingPage("themes")).toBe(true);
    useViewsStore.setState({ themesOpen: false });
    expect(showingPage("themes")).toBe(false);
    expect(showingPage("elsewhere")).toBe(false);
  });
});
