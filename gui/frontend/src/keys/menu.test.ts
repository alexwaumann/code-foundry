import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";

const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo, error: vi.fn(), warning: vi.fn() } }));
const menu = vi.hoisted(() => ({ fn: null as ((name: string) => void) | null }));
vi.mock("@/api/app", async (orig) => ({
  ...(await orig<typeof import("@/api/app")>()),
  onRunCommandMenu: (fn: (name: string) => void) => {
    menu.fn = fn;
    return () => {
      menu.fn = null;
    };
  },
}));

const { runMenuCommand, startMenuCommands } = await import("./menu");
const { useCommandsStore } = await import("@/stores/commands");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");
const { useViewsStore } = await import("@/stores/views");

function cmd(over: Partial<CommandView>): CommandView {
  return { name: "c", title: "C", description: "", category: "X", args: [], keybindings: [], available: true, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCommandsStore.setState({
    commands: [cmd({ name: "ui.palette.open", title: "Open Command Palette" }), cmd({ name: "thread.rename", title: "Rename Thread", available: false })],
  });
  useThreadsStore.setState({ byId: {}, order: [] });
  useUiStore.setState({ selection: { kind: "view", name: "dashboard" } });
  useUiStore.getState().closePalette();
});

describe("runMenuCommand", () => {
  it("starts an available command the way the palette does (its presenter)", async () => {
    runMenuCommand("ui.palette.open");
    await vi.waitFor(() => {
      expect(useUiStore.getState().palette.open).toBe(true);
    });
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("says when the command is not available here, by its title", () => {
    runMenuCommand("thread.rename");
    expect(toastInfo).toHaveBeenCalledWith("Rename Thread is not available here");
  });

  it("falls back to the name for a command the daemon does not list", () => {
    runMenuCommand("no.such.command");
    expect(toastInfo).toHaveBeenCalledWith("no.such.command is not available here");
  });

  it("runs the attention jump, a GUI view action, by its menu name", () => {
    runMenuCommand("attention.next");
    expect(toastInfo).toHaveBeenCalledWith("No threads need attention");
  });

  it.each([
    ["help.guide", "guide"],
    ["help.shortcuts", "shortcuts"],
  ] as const)("%s opens the help overlay on its tab, and switches an open one", (name, tab) => {
    useViewsStore.setState({ helpOpen: true, helpTab: tab === "guide" ? "shortcuts" : "guide" });
    runMenuCommand(name);
    expect(useViewsStore.getState()).toMatchObject({ helpOpen: true, helpTab: tab });
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

describe("startMenuCommands", () => {
  it("runs the menu's event in this window until stopped", async () => {
    const stop = startMenuCommands();
    menu.fn?.("ui.palette.open");
    await vi.waitFor(() => {
      expect(useUiStore.getState().palette.open).toBe(true);
    });
    stop();
    expect(menu.fn).toBeNull();
  });
});
