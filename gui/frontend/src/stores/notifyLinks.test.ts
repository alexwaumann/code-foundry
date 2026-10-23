import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyLinkAction, showingPage } from "./notifyLinks";
import { useViewsStore } from "./views";

const theme = vi.hoisted(() => ({ edit: vi.fn<(id: string) => Promise<boolean>>(), undo: vi.fn<(target: string) => void>() }));
vi.mock("./themeCards", () => ({ editSavedTheme: theme.edit, undoFromLink: theme.undo }));

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

  it("theme-edit:<id> edits the theme; theme-undo:<…> is the card's Undo", () => {
    theme.edit.mockResolvedValue(true);
    notifyLinkAction("theme-edit:ocean-dusk")?.();
    expect(theme.edit).toHaveBeenCalledWith("ocean-dusk");
    notifyLinkAction("theme-undo:dark:ocean-dusk:catppuccin-mocha")?.();
    expect(theme.undo).toHaveBeenCalledWith("dark:ocean-dusk:catppuccin-mocha");
    // The old link kind is gone.
    expect(notifyLinkAction("theme-set:dark:nord")).toBeNull();
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
