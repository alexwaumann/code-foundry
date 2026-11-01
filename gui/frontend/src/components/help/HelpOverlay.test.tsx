import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";

const listCommands = vi.hoisted(() => vi.fn<() => Promise<CommandView[]>>());
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), listCommands }));

const { HelpOverlay } = await import("./HelpOverlay");
const { guideToc } = await import("./guide");
const { openHelp, setHelpOpen, showView, toggleHelp, useViewsStore } = await import("@/stores/views");

beforeEach(() => {
  listCommands.mockResolvedValue([
    { name: "thread.new", title: "New Thread", description: "", category: "Thread", args: [], keybindings: ["cmd+n"], available: true },
  ]);
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, helpOpen: false, helpTab: "guide" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const tab = () => useViewsStore.getState().helpTab;

describe("help tab", () => {
  it.each([
    ["view.help (cmd+/) opens on the guide", () => { toggleHelp(); }, "guide"],
    ["a ShowView intent opens on the guide", () => showView("help"), "guide"],
    ["openHelp defaults to the guide", () => { openHelp(); }, "guide"],
    ["openHelp on a tab opens on it (the shortcuts)", () => { openHelp("shortcuts"); }, "shortcuts"],
  ])("%s", (_name, open, want) => {
    // Left on the other tab last time: opening resets it.
    useViewsStore.setState({ helpTab: want === "guide" ? "shortcuts" : "guide" });
    open();
    expect(useViewsStore.getState().helpOpen).toBe(true);
    expect(tab()).toBe(want);
  });

  it("view.help closes the overlay when it shows, and reopens on the guide", () => {
    openHelp("shortcuts");
    toggleHelp();
    expect(useViewsStore.getState().helpOpen).toBe(false);
    toggleHelp();
    expect(tab()).toBe("guide");
  });

  it("openHelp switches the tab of an open overlay", () => {
    openHelp("guide");
    openHelp("shortcuts");
    expect(useViewsStore.getState().helpOpen).toBe(true);
    expect(tab()).toBe("shortcuts");
  });
});

describe("HelpOverlay", () => {
  it("opens on the Guide tab with the guide and its contents", () => {
    act(() => {
      openHelp();
    });
    render(<HelpOverlay />);
    expect(screen.getByTestId("help-tab-guide").getAttribute("data-state")).toBe("active");
    const guide = screen.getByTestId("help-guide");
    expect(within(guide).getByRole("heading", { level: 2, name: "Getting started" })).toBeTruthy();
    expect(screen.queryByTestId("help-shortcuts")).toBeNull();
    expect(listCommands).not.toHaveBeenCalled();
  });

  it("lists exactly the headings the guide renders, and a contents entry scrolls to its heading", () => {
    act(() => {
      openHelp();
    });
    render(<HelpOverlay />);
    const headings = [...screen.getByTestId("help-guide").querySelectorAll("h2, h3")];
    expect(headings.map((h) => `${h.tagName}:${h.textContent}`)).toEqual(guideToc.map((e) => `H${String(e.level)}:${e.title}`));

    const scroll = vi.fn();
    const target = headings[3];
    if (!target) throw new Error("the guide has fewer than four headings");
    target.scrollIntoView = scroll;
    const entries = within(screen.getByTestId("help-toc")).getAllByRole("button");
    expect(entries.map((b) => b.textContent)).toEqual(guideToc.map((e) => e.title));
    const entry = entries[3];
    if (!entry) throw new Error("no fourth contents entry");
    fireEvent.click(entry);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
  });

  it("shows the shortcuts on the Keyboard shortcuts tab", async () => {
    act(() => {
      openHelp("shortcuts");
    });
    render(<HelpOverlay />);
    expect(screen.getByTestId("help-tab-shortcuts").getAttribute("data-state")).toBe("active");
    expect(screen.queryByTestId("help-guide")).toBeNull();
    expect(await screen.findByText("New Thread")).toBeTruthy();
    expect(listCommands).toHaveBeenCalledTimes(1);
  });

  it("the guide says a message always continues a thread, never that one disconnects or needs reconnecting", () => {
    act(() => {
      openHelp();
    });
    render(<HelpOverlay />);
    const guide = screen.getByTestId("help-guide").textContent;
    expect(guide).toContain("a thread keeps its history, and a message always continues it.");
    expect(guide).not.toMatch(/disconnected|Reconnect/);
  });

  it("the shortcuts: the app's own chords under App, then each command with its chord", async () => {
    act(() => {
      openHelp("shortcuts");
    });
    render(<HelpOverlay />);
    const row = await screen.findByText("New Thread");
    expect(row.closest("[data-help-command]")?.getAttribute("data-help-command")).toBe("thread.new");
    expect(row.closest("[data-help-command]")?.textContent).toContain("⌘N");
    const app = document.querySelector('[data-help-section="App"]');
    expect(app?.textContent).toContain("Command palette");
    expect(app?.textContent).toContain("⌘K");
  });

  it("switches tabs from the tab list", () => {
    act(() => {
      openHelp();
    });
    render(<HelpOverlay />);
    fireEvent.mouseDown(screen.getByTestId("help-tab-shortcuts"), { button: 0 });
    expect(tab()).toBe("shortcuts");
    expect(screen.getByTestId("help-shortcuts")).toBeTruthy();
  });

  it("the close button closes it", () => {
    act(() => {
      openHelp();
    });
    render(<HelpOverlay />);
    fireEvent.click(screen.getByTestId("help-close"));
    expect(useViewsStore.getState().helpOpen).toBe(false);
    act(() => {
      setHelpOpen(false);
    });
  });
});
