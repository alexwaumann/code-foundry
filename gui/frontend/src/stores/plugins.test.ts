import { describe, expect, it } from "vitest";
import type { PluginView } from "@/api/plugin";
import { allSurfaces, applyPluginEvent, surfaceManifestOf, type PluginsState } from "./plugins";

function plugin(name: string, surfaces: string[] = []): PluginView {
  return {
    name,
    displayName: name.toUpperCase(),
    version: "1.0.0",
    description: "",
    state: "running",
    enabled: true,
    disabledReason: "",
    dev: false,
    devPath: "",
    dir: "",
    lastError: "",
    issues: [],
    permissions: { commands: [], events: [], threadStatus: false, sessionEnv: false, secrets: false, threads: false, terminals: false, api: false },
    granted: null,
    consentedAtMs: null,
    needsConsent: false,
    consentText: "",
    pid: 1,
    startedAtMs: null,
    nextRestartAtMs: null,
    restarts: 0,
    commands: [],
    surfaces: surfaces.map((id) => ({ id, title: id, icon: "", scope: "thread", when: "", showCommand: `plugin.${name}.show.${id}`, kind: `plugin.${name}.${id}` })),
    logPath: "",
  };
}

const empty: PluginsState = { byName: {}, order: [], loaded: false, epoch: 0 };

describe("applyPluginEvent", () => {
  it("replaces everything on a snapshot, sorted by name", () => {
    const s = applyPluginEvent(empty, { kind: "snapshot", plugins: [plugin("zed"), plugin("acme")] });
    expect(s.order).toEqual(["acme", "zed"]);
    expect(s.loaded).toBe(true);
  });

  it("updates one plugin, keeping the order object when the set is the same", () => {
    const s = applyPluginEvent(empty, { kind: "snapshot", plugins: [plugin("a"), plugin("b")] });
    const u = applyPluginEvent(s, { kind: "updated", plugin: { ...plugin("a"), state: "crashed" } });
    expect(u.byName.a?.state).toBe("crashed");
    expect(u.order).toBe(s.order);
    const added = applyPluginEvent(u, { kind: "updated", plugin: plugin("0") });
    expect(added.order).toEqual(["0", "a", "b"]);
  });

  it("removes a plugin; an unknown one changes nothing", () => {
    const s = applyPluginEvent(empty, { kind: "snapshot", plugins: [plugin("a"), plugin("b")] });
    expect(applyPluginEvent(s, { kind: "removed", name: "a" }).order).toEqual(["b"]);
    expect(applyPluginEvent(s, { kind: "removed", name: "x" })).toBe(s);
  });

  it("records the availability epoch; the same one changes nothing", () => {
    const s = applyPluginEvent(empty, { kind: "availability", epoch: 3 });
    expect(s.epoch).toBe(3);
    expect(applyPluginEvent(s, { kind: "availability", epoch: 3 })).toBe(s);
  });
});

describe("surface lookups", () => {
  const s = applyPluginEvent(empty, { kind: "snapshot", plugins: [plugin("hello", ["demo", "pinned"]), plugin("acme", ["access"])] });

  it("finds a surface by its panel kind", () => {
    expect(surfaceManifestOf("plugin.hello.pinned", s)).toMatchObject({ id: "pinned", plugin: "hello", pluginDisplayName: "HELLO", showCommand: "plugin.hello.show.pinned" });
    expect(surfaceManifestOf("plugin.hello.nope", s)).toBeNull();
    expect(surfaceManifestOf("plugin.nope.demo", s)).toBeNull();
    expect(surfaceManifestOf("files", s)).toBeNull();
  });

  it("lists every surface in plugin name order", () => {
    expect(allSurfaces(s).map((m) => m.kind)).toEqual(["plugin.acme.access", "plugin.hello.demo", "plugin.hello.pinned"]);
  });
});
