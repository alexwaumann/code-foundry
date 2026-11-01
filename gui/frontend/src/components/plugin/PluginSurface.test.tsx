// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { PluginView } from "@/api/plugin";

// The watch is the store's (pluginSurfaces.test.ts); here only what PluginSurface opens it with.
const startSurfaceWatch = vi.hoisted(() => vi.fn(() => () => undefined));
vi.mock("@/stores/pluginSurfaces", async (orig) => ({ ...(await orig<typeof import("@/stores/pluginSurfaces")>()), startSurfaceWatch }));

const { PluginSurface } = await import("./PluginSurface");
const { useCommandsStore } = await import("@/stores/commands");
const { contextKey, getUiContext } = await import("@/stores/context");
const { makeTab } = await import("@/stores/panel");
const { applyPluginEvent, usePluginsStore } = await import("@/stores/plugins");
const { useUiStore } = await import("@/stores/ui");

const hello = {
  name: "hello",
  displayName: "Hello",
  surfaces: [{ id: "demo", title: "Hello Demo", icon: "sparkles", scope: "thread", when: "", showCommand: "plugin.hello.show.demo", kind: "plugin.hello.demo" }],
} as unknown as PluginView;
const show: CommandView = { name: "plugin.hello.show.demo", title: "Show Hello Demo", description: "", category: "Hello", args: [], keybindings: [], available: true };

beforeEach(() => {
  usePluginsStore.setState(applyPluginEvent({ byName: {}, order: [], loaded: false, epoch: 0, dirs: null }, { kind: "snapshot", plugins: [hello] }));
  const selection = { kind: "thread", id: "s-3" } as const;
  useUiStore.setState({ selection });
  useCommandsStore.setState({ commands: [show], contextKey: contextKey(getUiContext(selection)) });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// An act carries its watch's context (src/stores/pluginAct.test.ts), so a panel's button acts
// for the thread the panel shows ("Ask the main thread").
describe("PluginSurface", () => {
  it("watches its surface with the panel's context: the thread it shows", () => {
    render(<PluginSurface tab={makeTab("plugin.hello.demo", "Hello Demo")} />);
    expect(startSurfaceWatch).toHaveBeenCalledTimes(1);
    expect(startSurfaceWatch).toHaveBeenCalledWith(expect.any(String), { plugin: "hello", surface: "demo", context: expect.objectContaining({ activeThreadId: "s-3" }) });
  });
});
