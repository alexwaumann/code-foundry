import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { IndexEntryView, InstallProgressView, PluginEnvironmentView, PluginPermissionsView, PluginView, RegistryView } from "@/api/plugin";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import type { ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
import { usePluginRegistryStore } from "@/stores/pluginRegistry";
import { usePluginSecretsStore } from "@/stores/pluginSecrets";
import { usePluginsStore } from "@/stores/plugins";
import { useThreadsStore } from "@/stores/threads";
import { resetUpdateRuns, useUpdateRunStore } from "@/stores/updateRun";

const m = vi.hoisted(() => ({
  envs: vi.fn(),
  logs: vi.fn(),
  dirs: vi.fn(),
  secrets: vi.fn(),
  runCommand: vi.fn(),
  runCommandForResult: vi.fn(),
  startCommandNamed: vi.fn(),
  update: vi.fn(),
  uninstall: vi.fn(),
  install: vi.fn(),
  load: vi.fn(),
  focusSetting: vi.fn(),
}));
vi.mock("@/api/plugin", async (orig) => ({
  ...(await orig<typeof import("@/api/plugin")>()),
  pluginEnvironments: m.envs,
  pluginLogs: m.logs,
  pluginDirs: m.dirs,
  listPluginSecrets: m.secrets,
}));
vi.mock("@/stores/commands", async (orig) => ({
  ...(await orig<typeof import("@/stores/commands")>()),
  runCommand: m.runCommand,
  runCommandForResult: m.runCommandForResult,
}));
vi.mock("@/keys/bindings", async (orig) => ({ ...(await orig<typeof import("@/keys/bindings")>()), startCommandNamed: m.startCommandNamed }));
vi.mock("@/stores/pluginRegistry", async (orig) => ({
  ...(await orig<typeof import("@/stores/pluginRegistry")>()),
  updatePlugin: m.update,
  uninstallPlugin: m.uninstall,
  installPlugin: m.install,
  loadBrowse: m.load,
}));

vi.mock("@/components/settings/focus", () => ({ focusSetting: m.focusSetting }));

const { PluginsPage } = await import("./PluginsPage");

const none: PluginPermissionsView = { commands: [], events: [], threadStatus: false, sessionEnv: false, secrets: false, threads: false, terminals: false, api: false };

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

const cmd = (name: string): CommandView => ({ name, title: name, description: "", category: "", args: [], keybindings: [], available: true });

const install = (source: string): PluginView["install"] => ({ kind: "registry", source, version: "", sha256: "", installedAtMs: null });

// The mock daemon's four (mock/plugins.ts seedPlugins).
const PLUGINS: PluginView[] = [
  plugin({
    name: "acme-data",
    displayName: "Acme Data",
    version: "1.2.0",
    state: "disabled",
    enabled: false,
    needsConsent: true,
    granted: null,
    permissions: { ...none, commands: ["thread.send"], sessionEnv: true, secrets: true },
    surfaces: [{ id: "access", title: "Data access", icon: "database", scope: "global", when: "", showCommand: "plugin.acme-data.show.access", kind: "plugin.acme-data.access" }],
    install: install("https://plugins.acme.dev/index.json"),
  }),
  plugin({ name: "crasher", displayName: "Crasher", version: "0.0.1", state: "crashed", lastError: "exited with status 1: crasher: cannot read config", restarts: 3 }),
  plugin({ name: "hello", displayName: "Hello", version: "0.1.0", dev: true, pid: 48213, permissions: { ...none, secrets: true } }),
  plugin({
    name: "test-watcher",
    displayName: "Test Watcher",
    version: "0.0.9",
    pid: 48344,
    install: install("https://github.com/alexwaumann/code-foundry-plugins"),
    updateAvailable: true,
    updateVersion: "0.1.0",
  }),
];

const HELLO_ENV: PluginEnvironmentView = { plugin: "hello", env: ["CF_HELLO"], pathPrepend: [], addDirs: [], projects: [], noProject: true, issues: [], updatedAtMs: null };

const page: SettingPageView = { id: "plugins", title: "Plugins", description: "", sections: [] };
const schema = { groups: [], pages: [], fields: [] } as unknown as SettingsSchemaView;

const installed = (name: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="plugin-row-settings"][data-plugin="${name}"]`);
  if (!el) throw new Error(`no installed row ${name}`);
  return el;
};

const perms = none;
const entry = (o: Partial<IndexEntryView>): IndexEntryView => ({
  name: "x",
  displayName: "X",
  description: "",
  repo: "",
  version: "1.0.0",
  permissions: perms,
  permissionLines: [],
  registry: "https://github.com/o/reg",
  available: true,
  installedVersion: null,
  relation: "not-installed",
  installedFrom: "",
  ...o,
});
const FIXTURE = "https://github.com/alexwaumann/code-foundry-plugins";
const registry = (o: Partial<RegistryView>): RegistryView => ({ url: FIXTURE, fetchedAtMs: null, cached: false, error: "", plugins: 2, issues: [], ...o });
const step = (phase: InstallProgressView["phase"], o: Partial<InstallProgressView> = {}): InstallProgressView => ({ ref: "gh-actions", name: "gh-actions", version: "0.1.0", phase, message: "", bytes: 0, ...o });

const ENTRIES = [
  entry({ name: "test-watcher", displayName: "Test Watcher", version: "0.1.0", installedVersion: "0.0.9", relation: "update", repo: "o/test-watcher" }),
  entry({ name: "acme-data", displayName: "Acme Data", version: "1.3.0", installedVersion: "1.2.0", relation: "other-source", installedFrom: "plugins.acme.dev/index.json" }),
  entry({ name: "hello", displayName: "Hello", installedVersion: "0.1.0", relation: "dev" }),
  entry({ name: "gh-actions", displayName: "GitHub Actions", version: "0.1.0", description: "Runs and jobs", repo: "o/gh-actions", permissionLines: ["run commands", "follow events"] }),
  entry({ name: "linear-board", displayName: "Linear Board", available: false }),
];

function setBrowse(o: { entries?: IndexEntryView[]; registries?: RegistryView[] }): void {
  act(() => {
    usePluginRegistryStore.setState((s) => ({ browse: { platform: "darwin/arm64", entries: o.entries ?? s.browse?.entries ?? [], registries: o.registries ?? s.browse?.registries ?? [] } }));
  });
}

const entryRow = (name: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="registry-entry"][data-plugin="${name}"]`);
  if (!el) throw new Error(`no entry ${name}`);
  return el;
};
const installedNames = () => screen.queryAllByTestId("plugin-row-settings").map((r) => r.dataset.plugin);
const entryNames = () => screen.queryAllByTestId("registry-entry").map((r) => r.dataset.plugin);
const groups = () => screen.queryAllByTestId("catalog-group").map((g) => g.dataset.group);
const count = (id: string) => within(document.querySelector<HTMLElement>(`[data-testid="catalog-group"][data-group="${id}"]`) as HTMLElement).getByTestId("catalog-group-count").textContent;
const type = (text: string) => {
  fireEvent.change(screen.getByTestId("plugin-search"), { target: { value: text } });
};
const details = (name: string) => {
  fireEvent.click(within(installed(name)).getByTestId("catalog-chevron"));
  return within(within(installed(name)).getByTestId("catalog-details"));
};
const pick = async (name: string, item: string) => {
  fireEvent.pointerDown(within(installed(name)).getByTestId("plugin-row-menu"), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(await screen.findByTestId(item));
};

function setPlugins(list: readonly PluginView[]): void {
  const byName = Object.fromEntries(list.map((p) => [p.name, p]));
  usePluginsStore.setState({ byName, order: Object.keys(byName).sort(), loaded: true });
}

function show(): void {
  render(<PluginsPage schema={schema} page={page} />);
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.envs.mockResolvedValue([HELLO_ENV]);
  m.dirs.mockResolvedValue({ pluginsDir: "/Users/dev/.code-foundry/plugins", dataDir: "/Users/dev/.code-foundry/plugin-data" });
  m.logs.mockResolvedValue({ lines: [{ seq: 1, timeMs: null, source: "log", level: "info", text: "hello is up" }], path: "/Users/dev/.code-foundry/logs/hello.log" });
  m.secrets.mockResolvedValue([]);
  m.runCommand.mockResolvedValue(true);
  m.runCommandForResult.mockResolvedValue({ message: "", resultJson: "" });
  usePluginsStore.setState({ dirs: null });
  setPlugins(PLUGINS);
  m.load.mockResolvedValue(undefined);
  m.update.mockResolvedValue(true);
  resetUpdateRuns();
  usePluginRegistryStore.setState({ browse: { platform: "darwin/arm64", registries: [registry({ fetchedAtMs: Date.now() - 5 * 60_000, plugins: 5 })], entries: ENTRIES }, loading: false, error: "", progress: {}, busy: {}, failures: {} });
  usePluginSecretsStore.setState({ byName: {} });
  useThreadsStore.setState({ byId: {}, owned: [] });
  useCommandsStore.setState({ commands: [] });
});

afterEach(cleanup);

describe("Settings → Plugins: the default list", () => {
  it("groups the plugins with counts", () => {
    show();
    expect(groups()).toEqual(["needs", "running", "disabled"]);
    expect(installedNames()).toEqual(["crasher", "test-watcher", "hello", "acme-data"]);
    expect(count("needs")).toBe("2");
    expect(count("running")).toBe("1");
    expect(count("disabled")).toBe("1");
  });

  it("the search says how many it reaches", () => {
    show();
    expect(screen.getByTestId<HTMLInputElement>("plugin-search").placeholder).toBe("Search installed and the 5 in your registries");
  });

  it("a row says only what its group and switch do not: Crashed, dev", () => {
    show();
    expect(within(installed("crasher")).getByTestId("plugin-pill").textContent).toBe("Crashed");
    expect(within(installed("acme-data")).queryByTestId("plugin-pill")).toBeNull();
    expect(within(installed("hello")).queryByTestId("plugin-pill")).toBeNull();
    expect(within(installed("hello")).getByTestId("plugin-dev-pill").textContent).toBe("dev");
  });

  it("the details keep the process, source, environment and problems", async () => {
    show();
    const hello = details("hello");
    expect(hello.getByTestId("plugin-process").textContent).toBe("pid 48213");
    // Names only: the daemon never sends a value.
    const env = await hello.findByTestId("plugin-env");
    expect(env.textContent).toContain("CF_HELLO");
    expect(env.textContent).not.toContain("CF_HELLO=");
    expect(env.textContent).toContain("A running thread shows “Plugin environment changed” until you restart it.");
    expect(details("crasher").getByTestId("plugin-last-error").textContent).toBe("exited with status 1: crasher: cannot read config");
    expect(details("test-watcher").getByTestId("plugin-installed-from").textContent).toBe("from alexwaumann/code-foundry-plugins");
    expect(within(installed("test-watcher")).getByTestId("plugin-version").textContent).toBe("0.0.9, 0.1.0 available");
  });

  it("a disabled reason and a plugin's issues show in its details", () => {
    setPlugins([plugin({ name: "x", state: "disabled", enabled: false, needsConsent: true, disabledReason: "It asks for more than you allowed.", issues: ["bad manifest field"] })]);
    show();
    expect(groups()).toEqual(["needs"]);
    expect(within(installed("x")).getByTestId("plugin-pill").textContent).toBe("Needs consent");
    const d = details("x").getByText("It asks for more than you allowed.");
    expect(d).toBeTruthy();
    expect(screen.getByText("bad manifest field")).toBeTruthy();
  });

  it("an update offered: Update to X, which goes once updated", () => {
    show();
    const tw = () => within(installed("test-watcher"));
    expect(tw().getByTestId("plugin-update").textContent).toBe("Update to 0.1.0");
    fireEvent.click(tw().getByTestId("plugin-update"));
    expect(m.update).toHaveBeenCalledWith("test-watcher");
    act(() => {
      setPlugins(PLUGINS.map((p) => (p.name === "test-watcher" ? { ...p, version: "0.1.0", updateAvailable: false, updateVersion: "" } : p)));
    });
    expect(tw().queryByTestId("plugin-update")).toBeNull();
    expect(installedNames()).toEqual(["crasher", "hello", "test-watcher", "acme-data"]);
  });

  it("with no plugins it names the daemon's folder, or says “the plugins folder” until it is known", async () => {
    setPlugins([]);
    m.dirs.mockResolvedValue({ pluginsDir: "/Users/dev/.cf-integ/plugins", dataDir: "/Users/dev/.cf-integ/plugin-data" });
    m.dirs.mockReturnValueOnce(new Promise(() => undefined));
    show();
    expect(screen.getByTestId("plugins-none").textContent).toContain("put one in the plugins folder.");
    cleanup();
    show();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-none").textContent).toContain("put one in ~/.cf-integ/plugins.");
    });
  });

  it("a registry that could not be read says so on the page; the dialog says why", () => {
    usePluginRegistryStore.setState({ browse: { platform: "", entries: ENTRIES, registries: [registry({ error: "HTTP 404", cached: true })] } });
    show();
    expect(screen.getByTestId("registry-failed").textContent).toContain("A registry could not be read");
  });

  it("Browse itself failing is in words", () => {
    usePluginRegistryStore.setState({ error: "daemon gone" });
    show();
    expect(screen.getByTestId("registry-error").textContent).toBe("daemon gone");
  });
});

describe("Settings → Plugins: the switch", () => {
  const sw = (name: string) => within(installed(name)).getByTestId<HTMLButtonElement>("plugin-switch");

  it("runs plugin.enable, whose consent is the daemon's confirm, and plugin.disable, with no confirm of the page's", async () => {
    show();
    fireEvent.click(sw("acme-data"));
    await waitFor(() => {
      expect(m.runCommandForResult).toHaveBeenCalledWith("plugin.enable", { name: "acme-data" }, expect.anything());
    });
    fireEvent.click(sw("hello"));
    await waitFor(() => {
      expect(m.runCommandForResult).toHaveBeenCalledWith("plugin.disable", { name: "hello" }, expect.anything());
    });
  });

  it.each([
    ["enable", "acme-data", "true"],
    ["disable", "hello", "false"],
  ] as const)("shows what %s asks for, busy, while it runs", (action, name, checked) => {
    usePluginRegistryStore.setState({ busy: { [name]: action } });
    show();
    expect(sw(name).getAttribute("aria-checked")).toBe(checked);
    expect(sw(name).disabled).toBe(true);
    expect(sw(name).dataset.busy).toBe("true");
  });

  it("while the row does something else it waits, without claiming to flip", () => {
    usePluginRegistryStore.setState({ busy: { hello: "restart" } });
    show();
    expect(sw("hello").disabled).toBe(true);
    expect(sw("hello").dataset.busy).toBeUndefined();
    expect(within(installed("hello")).getByTestId("catalog-working").textContent).toBe("Restarting…");
  });

  it("declining the consent or failing goes back to what is true, a failure in words under the row", async () => {
    m.runCommandForResult.mockImplementation((_n: string, _a: unknown, o: { onError?: (m: string) => void }) => {
      o.onError?.("it would not start");
      return Promise.resolve(null);
    });
    show();
    fireEvent.click(sw("hello"));
    expect(await within(installed("hello")).findByTestId("plugin-failure")).toBeTruthy();
    expect(sw("hello").getAttribute("aria-checked")).toBe("true");
    expect(sw("hello").disabled).toBe(false);
    fireEvent.click(within(installed("hello")).getByTestId("plugin-failure-dismiss"));
    expect(within(installed("hello")).queryByTestId("plugin-failure")).toBeNull();
  });
});

describe("Settings → Plugins: a row's menu", () => {
  it("Logs opens the plugin's log tail", async () => {
    show();
    await pick("hello", "plugin-menu-logs");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-logs").textContent).toContain("hello is up");
    });
    expect(m.logs).toHaveBeenCalledWith("hello", 300, expect.anything());
  });

  it("Open <surface> runs its show command", async () => {
    useCommandsStore.setState({ commands: [cmd("plugin.acme-data.show.access")] });
    setPlugins(PLUGINS.map((p) => (p.name === "acme-data" ? { ...p, state: "running", enabled: true } : p)));
    show();
    await pick("acme-data", "plugin-menu-surface-access");
    await waitFor(() => {
      expect(m.startCommandNamed).toHaveBeenCalledWith("plugin.acme-data.show.access");
    });
  });

  it("Restart runs plugin.restart", async () => {
    show();
    await pick("hello", "plugin-menu-restart");
    await waitFor(() => {
      expect(m.runCommandForResult).toHaveBeenCalledWith("plugin.restart", { name: "hello" }, expect.anything());
    });
  });

  it("Reload rescans, from a dev plugin's menu only", async () => {
    show();
    await pick("hello", "plugin-menu-reload");
    await waitFor(() => {
      expect(m.runCommandForResult).toHaveBeenCalledWith("plugin.reload", {}, expect.anything());
    });
  });

  it("right-click opens the same menu", async () => {
    show();
    fireEvent.contextMenu(installed("crasher"));
    const menu = await screen.findByTestId("plugin-row-menu-context");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Restart", "Logs", "Uninstall"]);
  });
});

describe("Settings → Plugins: searching and Browse all", () => {
  it("typing shows the installed rows that match, then the registries'", () => {
    show();
    type("hub");
    setBrowse({ entries: [...ENTRIES, entry({ name: "github-x", displayName: "GitHub X" })] });
    type("github");
    expect(groups()).toEqual(["market"]);
    expect(entryNames()).toEqual(["gh-actions", "github-x"]);
    type("watcher");
    expect(groups()).toEqual(["installed"]);
    expect(installedNames()).toEqual(["test-watcher"]);
  });

  it("an entry's repository finds the installed row, and the hit is not listed twice", () => {
    setPlugins([plugin({ name: "test-watcher", displayName: "Tester" })]);
    show();
    type("o/test-watcher");
    expect(installedNames()).toEqual(["test-watcher"]);
    expect(entryNames()).toEqual([]);
    expect(screen.queryByTestId("plugin-results-none")).toBeNull();
  });

  it("nothing anywhere is one line", () => {
    show();
    type("kubectl");
    expect(screen.getByTestId("plugin-results-none").textContent).toBe("Nothing installed or in your registries matches “kubectl”.");
    expect(groups()).toEqual([]);
  });

  it("Browse all is the registries alone, and searches only them", () => {
    show();
    fireEvent.click(screen.getByTestId("plugin-browse-all"));
    expect(groups()).toEqual(["market"]);
    expect(installedNames()).toEqual([]);
    expect(entryNames()).toEqual(["test-watcher", "acme-data", "hello", "gh-actions", "linear-board"]);
    expect(count("market")).toBe("5");
    expect(screen.getByTestId<HTMLInputElement>("plugin-search").placeholder).toBe("Search the registries");
    type("watcher");
    expect(entryNames()).toEqual(["test-watcher"]);
  });

  it("an entry offers Install, Update to X, or says how it stands to what is installed", () => {
    show();
    fireEvent.click(screen.getByTestId("plugin-browse-all"));
    fireEvent.click(within(entryRow("gh-actions")).getByTestId("registry-install"));
    expect(m.install).toHaveBeenCalledWith("gh-actions");
    const update = within(entryRow("test-watcher")).getByTestId("registry-update");
    expect(update.textContent).toBe("Update to 0.1.0");
    fireEvent.click(update);
    expect(m.update).toHaveBeenCalledWith("test-watcher");
    expect(entryRow("acme-data").textContent).toContain("Installed from plugins.acme.dev/index.json");
    expect(within(entryRow("acme-data")).queryByTestId("registry-install")).toBeNull();
    expect(entryRow("hello").textContent).toContain("Dev 0.1.0");
    expect(entryRow("linear-board").textContent).toContain("No build for this Mac");
    expect(within(entryRow("linear-board")).getByTestId<HTMLButtonElement>("registry-install").disabled).toBe(true);
  });

  it("an installed entry with nothing to do says so", () => {
    usePluginRegistryStore.setState({ browse: { platform: "", registries: [], entries: [entry({ name: "a", displayName: "A", installedVersion: "1.0.0", relation: "installed" })] } });
    show();
    fireEvent.click(screen.getByTestId("plugin-browse-all"));
    expect(within(entryRow("a")).getByTestId("registry-installed-mark").textContent).toBe("Installed");
  });

  it("an entry opens to what it asks for and where it comes from", () => {
    show();
    fireEvent.click(screen.getByTestId("plugin-browse-all"));
    const r = within(entryRow("gh-actions"));
    fireEvent.click(r.getByTestId("catalog-chevron"));
    expect(r.getByTestId("registry-permissions").textContent).toBe("May run commands; follow events.");
    expect(r.getByTestId("catalog-details").textContent).toContain("0.1.0 · o/gh-actions · from o/reg");
    fireEvent.click(within(entryRow("hello")).getByTestId("catalog-chevron"));
    expect(within(entryRow("hello")).getByTestId("registry-permissions").textContent).toBe("Asks for no permissions.");
  });

  it("an install's steps and its failure show under the row", () => {
    show();
    fireEvent.click(screen.getByTestId("plugin-browse-all"));
    act(() => {
      usePluginRegistryStore.setState({ progress: { "gh-actions": step("downloading", { bytes: 2 * 1024 * 1024 }) } });
    });
    expect(within(entryRow("gh-actions")).getByTestId("registry-progress").textContent).toBe("Downloading… 2.0 MB");
    act(() => {
      usePluginRegistryStore.setState({ progress: { "gh-actions": step("failed", { message: "the checksum did not match" }) } });
    });
    const failed = within(entryRow("gh-actions")).getByTestId("registry-progress");
    expect(failed.textContent).toContain("the checksum did not match");
    fireEvent.click(within(failed).getByTestId("registry-progress-dismiss"));
    expect(within(entryRow("gh-actions")).queryByTestId("registry-progress")).toBeNull();
  });

  it("no registry points at Registries, which opens with the caret in the setting", async () => {
    usePluginRegistryStore.setState({ browse: { platform: "", entries: [], registries: [] } });
    show();
    fireEvent.click(screen.getByTestId("plugin-browse-all"));
    expect(screen.getByTestId("registry-none").textContent).toContain("No registry configured.");
    fireEvent.click(screen.getByTestId("registry-none-link"));
    expect(await screen.findByTestId("plugin-registries")).toBeTruthy();
    await waitFor(() => {
      expect(m.focusSetting).toHaveBeenCalledWith("plugins.registries");
    });
  });

  it("Browse failing is not read as an empty registry, nor as still reading", () => {
    usePluginRegistryStore.setState({ browse: { platform: "", entries: [], registries: [registry({ plugins: 0 })] }, error: "daemon gone" });
    show();
    fireEvent.click(screen.getByTestId("plugin-browse-all"));
    expect(screen.getByTestId("registry-error").textContent).toBe("daemon gone");
    expect(screen.queryByTestId("registry-empty")).toBeNull();
    cleanup();
    usePluginRegistryStore.setState({ browse: null, error: "daemon gone" });
    show();
    fireEvent.click(screen.getByTestId("plugin-browse-all"));
    expect(screen.queryByText("Reading the registries…")).toBeNull();
  });

  it("a registry with nothing listed says so", () => {
    usePluginRegistryStore.setState({ browse: { platform: "", entries: [], registries: [registry({ plugins: 0 })] } });
    show();
    fireEvent.click(screen.getByTestId("plugin-browse-all"));
    expect(screen.getByTestId("registry-empty").textContent).toBe("No plugins listed yet.");
  });
});

describe("Settings → Plugins: the page menu", () => {
  const openMenu = () => {
    fireEvent.pointerDown(screen.getByTestId("plugin-menu"), { button: 0, ctrlKey: false, pointerType: "mouse" });
  };

  it("says when the registries were read and what they hold", async () => {
    show();
    openMenu();
    expect((await screen.findByTestId("registry-refresh-hint")).textContent).toBe("Read 5 min ago");
    expect(screen.getByTestId("registry-open-hint").textContent).toBe("alexwaumann/code-foundry-plugins · 5 plugins");
  });

  it("Refresh registries reads them again", async () => {
    show();
    openMenu();
    fireEvent.click(await screen.findByTestId("registry-refresh"));
    await waitFor(() => {
      expect(m.load).toHaveBeenCalledWith(true);
    });
  });

  it("Registries lists each one, its failure in words, and the page's settings", async () => {
    usePluginRegistryStore.setState({ browse: { platform: "", entries: [], registries: [registry({ error: "HTTP 404", cached: true, issues: ["skipped one"] })] } });
    const withField = {
      groups: [],
      pages: [{ id: "plugins", title: "Plugins", description: "", sections: [{ id: "registries", title: "Registries", description: "" }] }],
      fields: [{ key: "plugins.registries", title: "Plugin registries", description: "", kind: "string", page: "plugins", section: "registries", dependsOn: "", defaultValue: "" }],
    } as unknown as SettingsSchemaView;
    render(<PluginsPage schema={withField} page={{ id: "plugins", title: "Plugins", description: "", sections: [] }} />);
    openMenu();
    fireEvent.click(await screen.findByTestId("registry-open"));
    const dialog = await screen.findByTestId("plugin-registries");
    const status = within(dialog).getByTestId("registry-status");
    expect(status.dataset.error).toBe("true");
    expect(status.textContent).toContain("Not found, or your gh login cannot read it. Showing what it listed last time.");
    expect(status.textContent).toContain("skipped one");
  });
});

describe("Settings → Plugins: Update all", () => {
  const two = PLUGINS.map((p) => (p.name === "hello" ? { ...p, dev: false, updateAvailable: true, updateVersion: "0.2.0" } : p));

  it("shows only with more than one update; a dev link's does not count", () => {
    show();
    expect(screen.queryByTestId("plugin-update-all")).toBeNull();
    cleanup();
    setPlugins(two);
    show();
    expect(screen.getByTestId("plugin-update-all").textContent).toBe("Update all 2");
  });

  it("runs the rows' own updates one at a time, quietly, and says how far it is", async () => {
    setPlugins(two);
    const finish: ((ok: boolean) => void)[] = [];
    m.update.mockImplementation(() => new Promise((r) => finish.push(r)));
    show();
    fireEvent.click(screen.getByTestId("plugin-update-all"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-update-all").textContent).toBe("Updating 1 of 2…");
    });
    expect(m.update).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish[0]?.(false);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("plugin-update-all").textContent).toBe("Updating 2 of 2…");
    });
    expect(m.update).toHaveBeenLastCalledWith(expect.any(String), { quiet: true });
    await act(async () => {
      finish[1]?.(true);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(useUpdateRunStore.getState().plugins.running).toBe(false);
    });
    expect(Object.keys(useUpdateRunStore.getState().plugins.updated)).toHaveLength(1);
  });

  it("a finished row stays in Needs you reading Updated to X; a failed one offers Retry update", () => {
    setPlugins(PLUGINS.map((p) => (p.name === "test-watcher" ? { ...p, updateAvailable: false, updateVersion: "" } : p.name === "hello" ? { ...p, dev: false, updateAvailable: true, updateVersion: "0.2.0" } : p)));
    usePluginRegistryStore.setState({ failures: { hello: { action: "update", message: "could not reach it" } } });
    show();
    act(() => {
      useUpdateRunStore.setState({ plugins: { running: false, at: 2, total: 2, updated: { "test-watcher": "0.1.0" } } });
    });
    expect(within(installed("test-watcher")).getByTestId("plugin-updated").textContent).toBe("Updated to 0.1.0");
    expect(count("needs")).toBe("3");
    expect(within(installed("hello")).getByTestId("plugin-update").textContent).toBe("Retry update");
    expect(within(installed("hello")).getByTestId("plugin-failure").textContent).toContain("could not reach it");
  });

  it("a row updating says so", () => {
    usePluginRegistryStore.setState({ busy: { "test-watcher": "update" } });
    show();
    const b = within(installed("test-watcher")).getByTestId<HTMLButtonElement>("plugin-update");
    expect(b.textContent).toBe("Updating…");
    expect(b.disabled).toBe(true);
  });
});

describe("Settings → Plugins: a plugin's secrets", () => {
  it("only a plugin that keeps secrets has the item; it opens the row on them, by name and when they were set", async () => {
    const now = Date.now();
    m.secrets.mockImplementation((name: string) =>
      Promise.resolve(
        name === "acme-data"
          ? [
              { key: "refresh-token", updatedAtMs: now - 3 * 86_400_000 },
              { key: "token", updatedAtMs: now - 3 * 86_400_000 },
            ]
          : [{ key: "word", updatedAtMs: now - 2 * 3_600_000 }],
      ),
    );
    show();
    const acme = within(installed("acme-data"));
    expect(acme.queryByTestId("plugin-secrets")).toBeNull();
    await pick("acme-data", "plugin-menu-secrets");
    await waitFor(() => {
      expect(acme.getAllByTestId("plugin-secret")).toHaveLength(2);
    });
    expect(m.secrets).toHaveBeenCalledWith("acme-data", expect.anything());
    const token = acme.getAllByTestId("plugin-secret").find((s) => s.dataset.key === "token");
    expect(token?.textContent).toContain("set 3 d ago");
  });

  it("delete runs plugin.secrets.delete (the daemon confirms) and reads the list again", async () => {
    let list = [{ key: "word", updatedAtMs: null }];
    m.secrets.mockImplementation(() => Promise.resolve(list));
    m.runCommandForResult.mockImplementation(() => {
      list = [];
      return Promise.resolve({ message: "deleted", resultJson: "" });
    });
    show();
    await pick("hello", "plugin-menu-secrets");
    const hello = within(installed("hello"));
    const word = await hello.findByTestId("plugin-secret");
    expect(word.textContent).toContain("word");
    fireEvent.click(within(word).getByTestId("plugin-secret-delete"));
    expect(m.runCommandForResult).toHaveBeenCalledWith("plugin.secrets.delete", { name: "hello", key: "word" }, { quiet: true });
    await waitFor(() => {
      expect(hello.getByTestId("plugin-secrets-none").textContent).toBe("No secrets in the Keychain.");
    });
  });
});

describe("Settings → Plugins: the uninstall dialog", () => {
  const dialog = () => within(screen.getByTestId("uninstall-dialog"));
  const owned = (id: string, owner: string) => ({ id, owner }) as unknown as ThreadView;

  it("says how many of the plugin's own threads go with it", async () => {
    useThreadsStore.setState({ byId: { "s-hello-assistant": owned("s-hello-assistant", "plugin:hello"), "s-x": owned("s-x", "plugin:other") }, owned: ["s-hello-assistant", "s-x"] });
    show();
    await pick("hello", "plugin-menu-uninstall");
    expect((await screen.findByTestId("uninstall-dialog")).textContent).toContain("It removes its 1 thread.");
    fireEvent.click(dialog().getByTestId("uninstall-cancel"));
    expect(screen.queryByTestId("uninstall-dialog")).toBeNull();
    expect(m.uninstall).not.toHaveBeenCalled();
  });

  it("names what stays, drops that line with purge, and uninstalls with the choice", async () => {
    show();
    await waitFor(() => {
      expect(usePluginsStore.getState().dirs).not.toBeNull();
    });
    await pick("test-watcher", "plugin-menu-uninstall");
    await screen.findByTestId("uninstall-dialog");
    const text = () => screen.getByTestId("uninstall-dialog").textContent;
    expect(text()).toContain("Uninstall Test Watcher?");
    expect(text()).not.toContain("thread");
    expect(text()).toContain("It stops and its package goes from ~/.code-foundry/plugins.");
    expect(text()).toContain("Its data (~/.code-foundry/plugin-data/test-watcher), secrets and the consent you gave stay for a reinstall.");
    fireEvent.click(dialog().getByTestId("uninstall-purge"));
    expect(text()).not.toContain("stay for a reinstall");
    fireEvent.click(dialog().getByTestId("uninstall-confirm"));
    expect(m.uninstall).toHaveBeenCalledWith("test-watcher", true);
    expect(screen.queryByTestId("uninstall-dialog")).toBeNull();
  });

  it("an uninstalled plugin's row goes", () => {
    show();
    act(() => {
      setPlugins(PLUGINS.filter((p) => p.name !== "test-watcher"));
    });
    expect(document.querySelector('[data-plugin="test-watcher"][data-testid="plugin-row-settings"]')).toBeNull();
  });
});
