import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { PluginView } from "@/api/plugin";
import type { ThreadFlagView } from "@/api/threads";
import { useCommandsStore } from "./commands";
import { contextKey, getUiContext } from "./context";
import { flagSurfaceFor, flagSurfaces, openFlagSurface, shownFlag } from "./flagSurface";
import { getPanel } from "./panel";
import { applyPluginEvent, usePluginsStore } from "./plugins";
import { useUiStore, type Selection } from "./ui";

const surface = (plugin: string, id: string, scope: string) => ({ id, title: id, icon: "", scope, when: "", showCommand: `plugin.${plugin}.show.${id}`, kind: `plugin.${plugin}.${id}` });

const gh = { name: "gh-actions", displayName: "GitHub Actions", surfaces: [surface("gh-actions", "status", "global"), surface("gh-actions", "runs", "pr"), surface("gh-actions", "thread", "thread")] } as unknown as PluginView;
const tw = { name: "test-watcher", displayName: "Test Watcher", surfaces: [surface("test-watcher", "tests", "thread")] } as unknown as PluginView;
const bare = { name: "bare", displayName: "Bare", surfaces: [] } as unknown as PluginView;

const cmd = (name: string, available: boolean): CommandView => ({ name, title: name, description: "", category: "", args: [], keybindings: [], available });

const flag = (level: "attention" | "error", plugin = "gh-actions"): ThreadFlagView => ({ plugin, pluginName: plugin, level, reason: "r", setAtMs: 1, untilSeen: false });

const thread: Selection = { kind: "thread", id: "s-1" };

/** The commands store listed for a selection. */
function listed(sel: Selection, commands: CommandView[]): void {
  useCommandsStore.setState({ commands, contextKey: contextKey(getUiContext(sel)), loading: false });
}

beforeEach(() => {
  usePluginsStore.setState(applyPluginEvent({ byName: {}, order: [], loaded: false, epoch: 0, dirs: null }, { kind: "snapshot", plugins: [gh, tw, bare] }));
  useCommandsStore.setState({ commands: [], contextKey: null, loading: false });
  useUiStore.setState({ selection: thread });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shownFlag", () => {
  const base = { state: "connected" as const, statusReason: "", statusChangedAtMs: null };
  it.each([
    ["idle with an attention flag", { ...base, status: "idle" as const, flags: [flag("attention")] }, "attention"],
    ["busy with an error flag", { ...base, status: "busy" as const, flags: [flag("error")] }, "error"],
    ["Claude's prompt wins", { ...base, status: "attention" as const, statusReason: "permission: Bash", flags: [flag("attention")] }, null],
    ["no flags", { ...base, status: "idle" as const, flags: [] }, null],
  ])("%s", (_name, t, want) => {
    expect(shownFlag(t)?.level ?? null).toBe(want);
  });
  it("is null for an unknown thread", () => {
    expect(shownFlag(undefined)).toBeNull();
  });
});

describe("flagSurfaces", () => {
  it.each([
    ["gh-actions", ["plugin.gh-actions.runs", "plugin.gh-actions.thread"]],
    ["test-watcher", ["plugin.test-watcher.tests"]],
    ["bare", []],
    ["nope", []],
  ])("%s: thread and pr scopes only, manifest order", (plugin, kinds) => {
    expect(flagSurfaces(plugin).map((m) => m.kind)).toEqual(kinds);
  });
});

describe("flagSurfaceFor", () => {
  it("is unknown while the list is another context's", () => {
    useCommandsStore.setState({ commands: [cmd("plugin.gh-actions.show.runs", true)], contextKey: "other" });
    expect(flagSurfaceFor("gh-actions", thread)).toBe("unknown");
  });
  it("takes the first available surface", () => {
    listed(thread, [cmd("plugin.gh-actions.show.runs", false), cmd("plugin.gh-actions.show.thread", true)]);
    expect(flagSurfaceFor("gh-actions", thread)).toMatchObject({ kind: "plugin.gh-actions.thread" });
  });
  it("is null when none is available, and for a plugin without one", () => {
    listed(thread, [cmd("plugin.gh-actions.show.runs", false)]);
    expect(flagSurfaceFor("gh-actions", thread)).toBeNull();
    expect(flagSurfaceFor("bare", thread)).toBeNull();
  });
});

describe("openFlagSurface", () => {
  it("waits for the thread's list, then opens the available surface's tab in its panel", async () => {
    useCommandsStore.setState({ commands: [], contextKey: "previous selection", loading: true });
    const opened = openFlagSurface("s-1", "test-watcher");
    expect(getPanel("thread:s-1").tabs).toHaveLength(0);
    listed(thread, [cmd("plugin.test-watcher.show.tests", true)]);
    await expect(opened).resolves.toBe("plugin.test-watcher.tests");
    expect(getPanel("thread:s-1")).toMatchObject({ open: true, activeTabId: "plugin.test-watcher.tests" });
  });

  it("opens nothing when no surface is available for the thread", async () => {
    listed(thread, [cmd("plugin.test-watcher.show.tests", false)]);
    await expect(openFlagSurface("s-1", "test-watcher")).resolves.toBeNull();
    await expect(openFlagSurface("s-1", "bare")).resolves.toBeNull();
  });

  it("gives up when the selection moves on before the list arrives", async () => {
    useCommandsStore.setState({ commands: [], contextKey: "previous selection", loading: true });
    const opened = openFlagSurface("s-1", "test-watcher");
    useUiStore.setState({ selection: { kind: "thread", id: "s-2" } });
    useCommandsStore.setState({ loading: false });
    await expect(opened).resolves.toBeNull();
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    useCommandsStore.setState({ commands: [], contextKey: "previous selection", loading: true });
    const opened = openFlagSurface("s-1", "test-watcher", 1000);
    vi.advanceTimersByTime(1000);
    await expect(opened).resolves.toBeNull();
  });
});
