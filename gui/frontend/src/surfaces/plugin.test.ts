import { beforeEach, describe, expect, it } from "vitest";
import type { CommandView } from "@/api/command";
import type { PluginView } from "@/api/plugin";
import { useCommandsStore } from "@/stores/commands";
import { contextKey, getUiContext } from "@/stores/context";
import { parsePluginView } from "@/stores/pluginPanel";
import { applyPluginEvent, usePluginsStore } from "@/stores/plugins";
import { useUiStore } from "@/stores/ui";
import { surfaceOf } from "./registry";

const hello = {
  name: "hello",
  displayName: "Hello",
  surfaces: [{ id: "demo", title: "Hello Demo", icon: "sparkles", scope: "thread", when: "", showCommand: "plugin.hello.show.demo", kind: "plugin.hello.demo" }],
} as unknown as PluginView;

const show = (available: boolean): CommandView => ({ name: "plugin.hello.show.demo", title: "Show Hello Demo", description: "", category: "Hello", args: [], keybindings: [], available });

beforeEach(() => {
  usePluginsStore.setState(applyPluginEvent({ byName: {}, order: [], loaded: false, epoch: 0 }, { kind: "snapshot", plugins: [hello] }));
  useUiStore.setState({ selection: { kind: "none" } });
});

describe("plugin surfaces in the registry", () => {
  it("falls through to a plugin surface spec for plugin kinds: manifest title and icon, no hotkey", () => {
    const spec = surfaceOf("plugin.hello.demo");
    expect(spec?.title).toBe("Hello Demo");
    expect(spec?.hotkey).toBeUndefined();
    expect(surfaceOf("plugin.hello.demo")).toBe(spec);
    expect(surfaceOf("nope")).toBeUndefined();
  });

  it("is available exactly when its show command is, in the list for this context", () => {
    const sel = useUiStore.getState().selection;
    const ctx = { selection: sel, panelKey: "k" };
    const spec = surfaceOf("plugin.hello.demo");
    useCommandsStore.setState({ commands: [show(true)], contextKey: contextKey(getUiContext(sel)) });
    expect(spec?.available(ctx)).toBe("enabled");
    expect(spec?.openDefault(ctx)).toMatchObject({ id: "plugin.hello.demo", kind: "plugin.hello.demo", title: "Hello Demo" });
    useCommandsStore.setState({ commands: [show(false)] });
    expect(spec?.available(ctx)).toBe("hidden");
    expect(spec?.openDefault(ctx)).toBeNull();
    // A list for another context does not count.
    useCommandsStore.setState({ commands: [show(true)], contextKey: "other" });
    expect(spec?.available(ctx)).toBe("hidden");
  });

  it.each([
    ["panel.plugin.hello.demo?thread=s-1", "plugin.hello.demo", "thread=s-1"],
    ["panel.plugin.acme-data.access", "plugin.acme-data.access", ""],
    ["panel.plugin.hello", null, ""],
    ["panel.mcp", null, ""],
  ])("parses ShowView %s", (name, kind, query) => {
    const p = parsePluginView(name);
    expect(p?.kind ?? null).toBe(kind);
    if (p) expect(p.params.toString()).toBe(query);
  });
});
