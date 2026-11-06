import { describe, expect, it } from "vitest";
import type { PluginView } from "@/api/plugin";
import type { OverflowItem } from "@/components/projects/OverflowMenu";
import { entryNames, groupedIds, hasUpdate, matchesEntry, NOT_AVAILABLE, pluginGroup, pluginMain, pluginMenu, registriesSummary, rowPill, searchedIds, updatablePlugins } from "./model";

const none = { commands: [], events: [], threadStatus: false, sessionEnv: false, secrets: false, threads: false, terminals: false, api: false };

function plugin(o: Partial<PluginView> & { name: string }): PluginView {
  return {
    displayName: o.name,
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
    permissions: none,
    granted: none,
    consentedAtMs: null,
    needsConsent: false,
    consentText: "",
    pid: 0,
    startedAtMs: null,
    nextRestartAtMs: null,
    restarts: 0,
    commands: [],
    surfaces: [],
    logPath: "",
    install: null,
    updateAvailable: false,
    updateVersion: "",
    updateRegistry: "",
    ...o,
  };
}

const surface = (id: string) => ({ id, title: id.toUpperCase(), icon: "", scope: "thread", when: "", showCommand: `plugin.p.show.${id}`, kind: `plugin.p.${id}` });

describe("the groups", () => {
  it.each([
    ["running", {}, "running"],
    ["starting", { state: "starting" as const }, "running"],
    ["an update", { updateAvailable: true, updateVersion: "2" }, "needs"],
    ["a dev link's update is not one", { updateAvailable: true, dev: true }, "running"],
    ["crashed", { state: "crashed" as const }, "needs"],
    ["failed", { state: "failed" as const }, "needs"],
    ["disabled", { state: "disabled" as const, enabled: false }, "disabled"],
    ["new, never enabled", { state: "disabled" as const, enabled: false, needsConsent: true }, "disabled"],
    ["consent it lost", { state: "disabled" as const, enabled: false, needsConsent: true, disabledReason: "It asks for more." }, "needs"],
  ])("%s", (_name, o, want) => {
    expect(pluginGroup(plugin({ name: "x", ...o }), {})).toBe(want);
  });

  it("a row a run finished stays in Needs you", () => {
    expect(pluginGroup(plugin({ name: "x" }), { x: "2.0.0" })).toBe("needs");
  });

  it("groupedIds orders the groups and leaves empty ones out", () => {
    expect(groupedIds([plugin({ name: "a" }), plugin({ name: "b", state: "crashed" }), plugin({ name: "c", state: "disabled", enabled: false })], {})).toEqual(["#needs", "b", "#running", "a", "#disabled", "c"]);
    expect(groupedIds([plugin({ name: "a" })], {})).toEqual(["#running", "a"]);
  });
});

describe("the search", () => {
  const list = [plugin({ name: "linear-sync", displayName: "Linear Sync" }), plugin({ name: "x", displayName: "Other", description: "mirrors linear issues" }), plugin({ name: "z", displayName: "Zed" })];
  const entry = (name: string, o: { displayName?: string; description?: string; repo?: string } = {}) => ({ name, displayName: name, description: "", repo: "", ...o });

  it("matches a plugin by name, display name or description, and one an entry found", () => {
    expect(searchedIds(list, [], ["linear"])).toEqual(["#installed", "linear-sync", "x"]);
    expect(searchedIds(list, ["z"], ["acme/repo"])).toEqual(["#installed", "z"]);
    expect(searchedIds(list, [], ["nope"])).toEqual([]);
  });

  it("matches an entry by name, description or repository, leaving out what is shown above", () => {
    expect(matchesEntry(entry("a", { repo: "acme/board" }), ["board"])).toBe(true);
    expect(entryNames([entry("linear-sync"), entry("linear-board")], ["linear"], new Set(["linear-sync"]))).toEqual(["linear-board"]);
    expect(entryNames([entry("a"), entry("b")], [], new Set())).toEqual(["a", "b"]);
  });
});

describe("a row", () => {
  it.each([
    ["running says nothing", { state: "running" as const }, null],
    ["disabled says nothing", { state: "disabled" as const, enabled: false }, null],
    ["crashed", { state: "crashed" as const }, "Crashed"],
    ["failed", { state: "failed" as const }, "Failed"],
    ["starting", { state: "starting" as const }, "Starting"],
    ["consent it lost", { state: "disabled" as const, enabled: false, needsConsent: true, disabledReason: "why" }, "Needs consent"],
  ])("pill: %s", (_name, o, want) => {
    expect(rowPill(plugin({ name: "x", ...o }))?.label ?? null).toBe(want);
  });

  const offered = { updateAvailable: true, updateVersion: "2.0.0" };
  it.each([
    ["nothing", {}, null, null, undefined, null],
    ["an update", offered, null, null, undefined, { kind: "update", version: "2.0.0", retry: false }],
    ["an update that failed", offered, null, { action: "update", message: "no" }, undefined, { kind: "update", version: "2.0.0", retry: true }],
    ["another action's failure", offered, null, { action: "restart", message: "no" }, undefined, { kind: "update", version: "2.0.0", retry: false }],
    ["updating", offered, "update", null, undefined, { kind: "updating" }],
    ["finished", {}, null, null, "2.0.0", { kind: "updated", version: "2.0.0" }],
    ["restarting", {}, "restart", null, undefined, { kind: "working", words: "Restarting…" }],
    ["reloading", {}, "reload", null, undefined, { kind: "working", words: "Reloading…" }],
    ["uninstalling", offered, "uninstall", null, undefined, { kind: "working", words: "Uninstalling…" }],
    ["a flip shows on the switch alone", {}, "disable", null, undefined, null],
  ] as const)("main: %s", (_name, o, busy, failure, updated, want) => {
    expect(pluginMain(plugin({ name: "x", ...o }), busy, failure, updated)).toEqual(want);
  });

  it("updatablePlugins and hasUpdate leave a dev link out", () => {
    const list = [plugin({ name: "a", updateAvailable: true }), plugin({ name: "b", updateAvailable: true, dev: true }), plugin({ name: "c" })];
    expect(updatablePlugins(list).map((p) => p.name)).toEqual(["a"]);
    expect(hasUpdate(list[1] as PluginView)).toBe(false);
  });
});

describe("the row's menu", () => {
  const noop = () => undefined;
  const menu = (p: PluginView, o: { available?: string[]; busy?: boolean } = {}): OverflowItem[] =>
    pluginMenu(p, { available: new Set(o.available ?? []), busy: o.busy ?? false, onSurface: noop, onRestart: noop, onLogs: noop, onSecrets: noop, onReload: noop, onUninstall: noop });
  const labels = (items: readonly OverflowItem[]) => items.map((i) => (i === "separator" ? "---" : i.label));

  it.each([
    ["a running plugin", plugin({ name: "p" }), ["Restart", "Logs", "---", "Uninstall"]],
    ["a disabled one", plugin({ name: "p", enabled: false, surfaces: [surface("a")] }), ["Logs", "---", "Uninstall"]],
    ["with surfaces", plugin({ name: "p", surfaces: [surface("a"), surface("b")] }), ["Open A", "Open B", "Restart", "Logs", "---", "Uninstall"]],
    ["asking for secrets", plugin({ name: "p", permissions: { ...none, secrets: true } }), ["Restart", "Logs", "Secrets", "---", "Uninstall"]],
    ["once granted secrets", plugin({ name: "p", granted: { ...none, secrets: true } }), ["Restart", "Logs", "Secrets", "---", "Uninstall"]],
    ["a dev plugin", plugin({ name: "p", dev: true }), ["Restart", "Logs", "Reload", "---", "Uninstall"]],
  ])("%s", (_name, p, want) => {
    expect(labels(menu(p))).toEqual(want);
  });

  it("a surface unavailable for the selection says so", () => {
    const p = plugin({ name: "p", surfaces: [surface("a"), surface("b")] });
    const items = menu(p, { available: ["plugin.p.show.a"] });
    expect(items[0]).toMatchObject({ disabled: false });
    expect(items[1]).toMatchObject({ disabled: true, hint: NOT_AVAILABLE });
  });

  it("a busy row starts nothing more; Logs still opens", () => {
    const disabled = menu(plugin({ name: "p", dev: true }), { busy: true }).flatMap((i) => (i !== "separator" && i.disabled ? [i.label] : []));
    expect(disabled).toEqual(["Restart", "Reload", "Uninstall"]);
  });
});

describe("the page menu", () => {
  it("registriesSummary names one and counts several", () => {
    expect(registriesSummary([{ url: "https://github.com/o/reg", plugins: 18 }])).toBe("o/reg · 18 plugins");
    expect(registriesSummary([{ url: "https://a.dev/index.json", plugins: 1 }, { url: "https://b.dev/i.json", plugins: 0 }])).toBe("2 registries · 1 plugin");
    expect(registriesSummary([])).toBe("None configured");
    expect(registriesSummary(undefined)).toBe("None configured");
  });
});
