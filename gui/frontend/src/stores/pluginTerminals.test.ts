import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalView } from "@/api/terminal";

const invokeConfirmed = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("./commands", async (orig) => ({ ...(await orig<typeof import("./commands")>()), invokeConfirmed, refreshCommands: () => Promise.resolve() }));

const { bottomTabIds, bottomTabTitle, getBottom, useBottomStore } = await import("./bottomPanel");
const { closeBottomTerminal } = await import("./bottomActions");
const { hidePluginTerminalTab, showPluginTerminal } = await import("./pluginTerminals");
const { useTerminalsStore } = await import("./terminals");
const { useUiStore } = await import("./ui");

function term(id: string, labels: Record<string, string>): TerminalView {
  return { id, argv: ["sh"], cwd: "/h", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: 1, exitedAtMs: null, altScreen: false, labels };
}

const shell = term("t-shell", { kind: "shell", project: "r1", worktree: "/w", thread: "s-1" });
const clock = term("t-clock", { kind: "plugin", plugin: "hello", title: "Clock" });

// docs/notes/plugins-6-thread-terminal.md: a plugin's terminal joins a bottom panel's strip
// only where the user opened it, and its tab's × takes it off the strip without closing it.
describe("plugin terminals in the bottom panel", () => {
  beforeEach(() => {
    useTerminalsStore.setState({ byId: { [shell.id]: shell, [clock.id]: clock }, order: [shell.id, clock.id], shownIn: {}, loaded: true });
    useBottomStore.setState({ byKey: {}, pendingFocus: null, pendingFocusId: null, starting: {} });
    useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
    invokeConfirmed.mockClear();
  });

  it("is no tab until opened, then a tab of the current thread's panel, titled by the plugin", () => {
    expect(bottomTabIds(useTerminalsStore.getState(), "thread:s-1")).toEqual(["t-shell"]);
    expect(showPluginTerminal("t-clock")).toBe(true);
    expect(bottomTabIds(useTerminalsStore.getState(), "thread:s-1")).toEqual(["t-shell", "t-clock"]);
    expect(bottomTabIds(useTerminalsStore.getState(), "thread:s-2")).toEqual([]);
    expect(getBottom("thread:s-1")).toMatchObject({ open: true, activeTerminalId: "t-clock" });
    expect(bottomTabTitle(clock, "thread:s-1")).toBe("Clock");
  });

  it("closing its tab hides it and leaves the terminal running; a shell's tab still runs terminal.close", async () => {
    showPluginTerminal("t-clock");
    await closeBottomTerminal("t-clock");
    expect(invokeConfirmed).not.toHaveBeenCalled();
    expect(bottomTabIds(useTerminalsStore.getState(), "thread:s-1")).toEqual(["t-shell"]);
    expect("t-clock" in useTerminalsStore.getState().byId).toBe(true);
    expect(hidePluginTerminalTab("t-shell")).toBe(false);
    await closeBottomTerminal("t-shell");
    expect(invokeConfirmed).toHaveBeenCalledWith("terminal.close", { id: "t-shell" }, expect.anything());
  });

  it("needs a selection with a bottom panel", () => {
    useUiStore.setState({ selection: { kind: "none" } });
    expect(showPluginTerminal("t-clock")).toBe(false);
    expect(useTerminalsStore.getState().shownIn).toEqual({});
  });
});
