import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { PluginEventSchema, PluginSchema, PluginSecretSchema, PluginState, SurfacePhase, SurfaceUpdateSchema } from "@/gen/codefoundry/v1/plugin_pb";
import { demoJson, demoView } from "@/test/pluginFixtures";
import { HEARTBEAT } from "./stream";
import { childLists, consentLines, inlineSpans, inlineText, nodeKind, NODE_KINDS, parseView, withChildLists, toPluginEventView, toPluginView, toSecretView, toSurfaceUpdateView, type ViewNode } from "./plugin";

function allNodes(nodes: readonly ViewNode[]): ViewNode[] {
  return nodes.flatMap((n) => [n, ...childLists(n).flatMap((l) => allNodes(l))]);
}

describe("view model", () => {
  it("parses the demo's six views and knows every node kind in them", () => {
    const kinds = new Set<string>();
    for (const tab of ["overview", "form", "log", "assistant", "shell", "layout"] as const) {
      const v = demoView(tab);
      expect(v.tabs?.active).toBe(tab);
      for (const n of allNodes(v.nodes)) {
        const k = nodeKind(n);
        expect(k, n.key).not.toBeNull();
        kinds.add(k ?? "");
      }
    }
    // The demo exercises every v1 node kind (thread and terminal on the Assistant and Shell
    // tabs, columns and pane on Layout).
    expect([...kinds].sort()).toEqual([...NODE_KINDS].sort());
  });

  it("lists a container's nodes and replaces them in the same order", () => {
    const t = (key: string): ViewNode => ({ key, text: { content: key } });
    const cols: ViewNode = { key: "c", columns: { collapse: "first", items: [{ key: "a", weight: 2, children: [t("a1")] }, { key: "b", width: 200, children: [t("b1"), t("b2")] }] } };
    expect(childLists(cols).map((l) => l.map((n) => n.key))).toEqual([["a1"], ["b1", "b2"]]);
    expect(childLists({ key: "p", pane: { height: "fill", children: [t("p1")] } }).map((l) => l.map((n) => n.key))).toEqual([["p1"]]);
    expect(childLists({ key: "s", section: { children: [t("s1")] } }).map((l) => l.map((n) => n.key))).toEqual([["s1"]]);
    expect(childLists(t("x"))).toEqual([]);
    const swapped = withChildLists(cols, [[t("z")], [t("y")]]);
    expect(swapped.columns).toEqual({ collapse: "first", items: [{ key: "a", weight: 2, children: [t("z")] }, { key: "b", width: 200, children: [t("y")] }] });
    expect(withChildLists({ key: "p", pane: { height: 300, children: [] } }, [[t("q")]]).pane).toEqual({ height: 300, children: [t("q")] });
    expect(withChildLists(t("x"), [[t("q")]])).toEqual(t("x"));
  });

  it("lists a grid's items' nodes and a group's items, and replaces them", () => {
    const t = (key: string): ViewNode => ({ key, text: { content: key } });
    const grid: ViewNode = { key: "g", grid: { minWidth: 200, items: [{ key: "a", span: 2, children: [t("a1")] }, { key: "b", children: [t("b1"), t("b2")] }] } };
    expect(childLists(grid).map((l) => l.map((n) => n.key))).toEqual([["a1"], ["b1", "b2"]]);
    const group: ViewNode = { key: "l", group: { align: "between", items: [t("l1"), t("l2")] } };
    expect(childLists(group).map((l) => l.map((n) => n.key))).toEqual([["l1", "l2"]]);
    expect(childLists({ key: "d", divider: { label: "x" } })).toEqual([]);
    expect(childLists({ key: "s", spacer: { flex: true } })).toEqual([]);
    const swapped = withChildLists(grid, [grid.grid?.items[0]?.children ?? [], [t("y")]]);
    expect(swapped.grid).toEqual({ minWidth: 200, items: [{ key: "a", span: 2, children: [t("a1")] }, { key: "b", children: [t("y")] }] });
    // An item whose list did not change keeps its identity.
    expect(swapped.grid?.items[0]).toBe(grid.grid?.items[0]);
    expect(withChildLists(group, [[t("z")]]).group).toEqual({ align: "between", items: [t("z")] });
  });

  it("refuses what is not a view", () => {
    expect(parseView("{")).toBeNull();
    expect(parseView('{"header":{}}')).toBeNull();
    expect(parseView('{"nodes":[]}')).toEqual({ nodes: [] });
  });

  it.each([
    ["a bare string", "hi", [{ text: "hi" }], "hi"],
    ["an empty string", "", [], ""],
    ["text without spans", { text: "x" }, [{ text: "x" }], "x"],
    ["spans", { spans: [{ text: "a" }, { duration: { ms: 42_000 } }, { text: "b", url: "https://x.test" }] }, [{ text: "a" }, { duration: { ms: 42_000 } }, { text: "b", url: "https://x.test" }], "a42sb"],
  ])("inline: %s", (_name, v, spans, text) => {
    expect(inlineSpans(v)).toEqual(spans);
    expect(inlineText(v)).toBe(text);
  });

  it("splits the daemon's consent text into its lead and permissions", () => {
    const t = "Enable Hello 0.1.0? It runs bin/hello as you and may:\n  - run Code Foundry commands: thread.send\n  - keep secrets in your Keychain (its own, under code-foundry-plugin)";
    expect(consentLines(t)).toEqual({
      lead: "Enable Hello 0.1.0? It runs bin/hello as you and may:",
      items: ["run Code Foundry commands: thread.send", "keep secrets in your Keychain (its own, under code-foundry-plugin)"],
    });
    expect(consentLines("Enable X 1.0.0? It runs bin/x as you and asks for no permissions.").items).toEqual([]);
  });
});

describe("mapping", () => {
  const plugin = create(PluginSchema, {
    name: "hello",
    displayName: "",
    version: "0.1.0",
    state: PluginState.CRASHED,
    enabled: true,
    restarts: 2,
    permissions: { commands: ["thread.send"], secrets: true },
    nextRestartAt: timestampFromMs(5000),
    surfaces: [{ id: "demo", title: "Hello Demo", icon: "sparkles", scope: "thread", showCommand: "plugin.hello.show.demo", kind: "plugin.hello.demo" }],
  });

  it("maps a plugin, its display name falling back to the name", () => {
    const p = toPluginView(plugin);
    expect(p).toMatchObject({ name: "hello", displayName: "hello", state: "crashed", restarts: 2, granted: null, nextRestartAtMs: 5000, startedAtMs: null });
    expect(p.permissions).toEqual({ commands: ["thread.send"], events: [], threadStatus: false, sessionEnv: false, secrets: true, threads: false, terminals: false, api: false });
    expect(p.surfaces[0]).toEqual({ id: "demo", title: "Hello Demo", icon: "sparkles", scope: "thread", when: "", showCommand: "plugin.hello.show.demo", kind: "plugin.hello.demo" });
  });

  it("maps plugin events", () => {
    expect(toPluginEventView(create(PluginEventSchema, { event: { case: "snapshot", value: { plugins: [plugin] } } }))).toMatchObject({ kind: "snapshot", plugins: [{ name: "hello" }] });
    expect(toPluginEventView(create(PluginEventSchema, { event: { case: "removedName", value: "x" } }))).toEqual({ kind: "removed", name: "x" });
    expect(toPluginEventView(create(PluginEventSchema, { event: { case: "availabilityEpoch", value: 7n } }))).toEqual({ kind: "availability", epoch: 7 });
    expect(toPluginEventView(create(PluginEventSchema, {}))).toBeNull();
  });

  it("maps surface updates", () => {
    expect(toSurfaceUpdateView(create(SurfaceUpdateSchema, { update: { case: "state", value: { instance: "i", phase: SurfacePhase.PLUGIN_DOWN, message: "m", pluginState: PluginState.FAILED } } }))).toEqual({
      kind: "state",
      instance: "i",
      phase: "plugin-down",
      message: "m",
      pluginState: "failed",
    });
    const view = toSurfaceUpdateView(create(SurfaceUpdateSchema, { update: { case: "view", value: { instance: "i", version: 3n, viewJson: demoJson("log") } } }));
    expect(view).toMatchObject({ kind: "view", version: 3, hostRendered: false });
    expect(view !== HEARTBEAT && view?.kind === "view" && view.view?.tabs?.active).toBe("log");
    expect(toSurfaceUpdateView(create(SurfaceUpdateSchema, { update: { case: "append", value: { instance: "i", version: 3n, key: "k", lines: [{ text: "a", tone: "error" }, { text: "b" }] } } }))).toEqual({
      kind: "append",
      instance: "i",
      version: 3,
      key: "k",
      text: "",
      lines: [{ text: "a", tone: "error" }, { text: "b" }],
    });
    expect(toSurfaceUpdateView(create(SurfaceUpdateSchema, { update: { case: "toast", value: { instance: "i", level: "weird", text: "t" } } }))).toEqual({ kind: "toast", instance: "i", level: "info", text: "t" });
    expect(toSurfaceUpdateView(create(SurfaceUpdateSchema, { update: { case: "heartbeat", value: {} } }))).toBe(HEARTBEAT);
  });
});

describe("secrets", () => {
  it("maps a secret to its name and when it was set, never more", () => {
    expect(toSecretView(create(PluginSecretSchema, { key: "token", updatedAt: timestampFromMs(1_700_000_000_000) }))).toEqual({ key: "token", updatedAtMs: 1_700_000_000_000 });
    expect(toSecretView(create(PluginSecretSchema, { key: "word" }))).toEqual({ key: "word", updatedAtMs: null });
  });
});
