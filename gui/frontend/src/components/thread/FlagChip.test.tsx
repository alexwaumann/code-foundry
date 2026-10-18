import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { PluginView } from "@/api/plugin";
import type { ThreadFlagView, ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { applyPluginEvent, usePluginsStore } from "@/stores/plugins";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";

const run = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult: run }));

const { FlagChip } = await import("./FlagChip");

const flag = (o: Partial<ThreadFlagView>): ThreadFlagView => ({ plugin: "test-watcher", pluginName: "Test Watcher", level: "error", reason: "3 tests failed", setAtMs: 1, untilSeen: false, ...o });
const tw = { name: "test-watcher", displayName: "Test Watcher", surfaces: [{ id: "tests", title: "Tests", icon: "", scope: "thread", when: "", showCommand: "plugin.test-watcher.show.tests", kind: "plugin.test-watcher.tests" }] } as unknown as PluginView;
const show = (available: boolean): CommandView => ({ name: "plugin.test-watcher.show.tests", title: "", description: "", category: "", args: [], keybindings: [], available });

function renderChip(flags: ThreadFlagView[], available = false): void {
  useThreadsStore.setState({ byId: { "s-1": { id: "s-1", projectId: "", worktreePath: "/Users/dev", workspaceId: "", flags } as unknown as ThreadView }, order: ["s-1"] });
  useCommandsStore.setState({ commands: [show(available)], contextKey: contextKey(getUiContext({ kind: "thread", id: "s-1" })), loading: false });
  render(<FlagChip id="s-1" />);
}

beforeEach(() => {
  run.mockReset().mockResolvedValue({ message: "" });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
  usePluginsStore.setState(applyPluginEvent({ byName: {}, order: [], loaded: false, epoch: 0, dirs: null }, { kind: "snapshot", plugins: [tw] }));
});

afterEach(cleanup);

describe("FlagChip", () => {
  it("is nothing without a flag", () => {
    renderChip([]);
    expect(screen.queryByTestId("thread-flag")).toBeNull();
  });

  it.each([
    ["error", "text-destructive"],
    ["attention", "text-warning"],
  ] as const)("shows the plugin and reason of an %s flag in its colour, text only", (level, tone) => {
    renderChip([flag({ level })]);
    const chip = screen.getByTestId("thread-flag");
    expect(chip.textContent).toBe("Test Watcher: 3 tests failed");
    expect(chip.className).toContain(tone);
    expect(chip.className).not.toMatch(/\bbg-/);
  });

  it("opens the plugin's surface when one is available for the thread, else is plain text", () => {
    renderChip([flag({})], false);
    expect(screen.queryByTestId("thread-flag-open")).toBeNull();
    cleanup();
    renderChip([flag({})], true);
    expect(screen.getByTestId("thread-flag-open").getAttribute("data-surface")).toBe("plugin.test-watcher.tests");
  });

  it("the × clears that plugin's flag on the thread", () => {
    renderChip([flag({})]);
    fireEvent.click(screen.getByTestId("thread-flag-clear"));
    expect(run).toHaveBeenCalledWith("thread.flag.clear", { id: "s-1", plugin: "test-watcher" }, { quiet: true });
  });
});
