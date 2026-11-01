import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { PluginEnvironmentView, PluginPermissionsView, PluginView } from "@/api/plugin";
import type { SettingPageView, SettingsSchemaView } from "@/api/settings";
import type { ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
import { usePluginRegistryStore } from "@/stores/pluginRegistry";
import { usePluginSecretsStore } from "@/stores/pluginSecrets";
import { usePluginsStore } from "@/stores/plugins";
import { useThreadsStore } from "@/stores/threads";

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
  loadBrowse: vi.fn(() => Promise.resolve()),
  updatePlugin: m.update,
  uninstallPlugin: m.uninstall,
}));

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

const page: SettingPageView = { id: "plugins", title: "Plugins", description: "", sections: [] } as unknown as SettingPageView;
const schema = { groups: [], pages: [], fields: [] } as unknown as SettingsSchemaView;

const installed = (name: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="plugin-row-settings"][data-plugin="${name}"]`);
  if (!el) throw new Error(`no installed row ${name}`);
  return el;
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
  usePluginRegistryStore.setState({ browse: { platform: "darwin/arm64", registries: [], entries: [] }, loading: false, error: "", progress: {}, busy: {} });
  usePluginSecretsStore.setState({ byName: {} });
  useThreadsStore.setState({ byId: {}, owned: [] });
  useCommandsStore.setState({ commands: [] });
});

afterEach(cleanup);

describe("Settings → Plugins: the Installed rows", () => {
  it("list every plugin with its state, process, environment and last error", async () => {
    show();
    const rows = screen.getAllByTestId("plugin-row-settings");
    expect(rows.map((r) => r.dataset.plugin)).toEqual(["acme-data", "crasher", "hello", "test-watcher"]);
    expect(rows.map((r) => within(r).getByTestId("plugin-pill").textContent)).toEqual(["Disabled", "Crashed", "Running", "Running"]);

    const hello = within(installed("hello"));
    expect(hello.getByTestId("plugin-process").textContent).toBe("pid 48213");
    // Names only: the daemon never sends a value.
    const env = await hello.findByTestId("plugin-env");
    expect(env.textContent).toContain("CF_HELLO");
    expect(env.textContent).not.toContain("CF_HELLO=");
    expect(env.textContent).toContain("A running thread shows “Plugin environment changed” until you restart it.");
    expect(within(installed("crasher")).getByTestId("plugin-last-error").textContent).toBe("exited with status 1: crasher: cannot read config");
  });

  it("Logs opens the plugin's log tail", async () => {
    show();
    fireEvent.click(within(installed("hello")).getByTestId("plugin-logs-open"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-logs").textContent).toContain("hello is up");
    });
    expect(m.logs).toHaveBeenCalledWith("hello", 300, expect.anything());
  });

  it("Enable runs plugin.enable (its consent is the daemon's confirm); the row follows the plugin's state", () => {
    show();
    const acme = () => within(installed("acme-data"));
    fireEvent.click(acme().getByTestId("plugin-enable"));
    expect(m.runCommand).toHaveBeenCalledWith("plugin.enable", { name: "acme-data" });
    expect(acme().getByTestId("plugin-pill").textContent).toBe("Disabled");
    act(() => {
      setPlugins(PLUGINS.map((p) => (p.name === "acme-data" ? { ...p, state: "running", enabled: true, needsConsent: false } : p)));
    });
    expect(acme().getByTestId("plugin-pill").textContent).toBe("Running");
    expect(acme().queryByTestId("plugin-enable")).toBeNull();
  });

  it("a surface's button runs its show command", () => {
    useCommandsStore.setState({ commands: [cmd("plugin.acme-data.show.access")] });
    setPlugins(PLUGINS.map((p) => (p.name === "acme-data" ? { ...p, state: "running", enabled: true } : p)));
    show();
    const open = within(installed("acme-data")).getByTestId("plugin-open-surface");
    expect(open.dataset.surface).toBe("plugin.acme-data.access");
    expect(open.textContent).toBe("Open Data access");
    fireEvent.click(open);
    expect(m.startCommandNamed).toHaveBeenCalledWith("plugin.acme-data.show.access");
  });

  it("an update offered by the install source: the version, where it came from, Update; once updated, neither", () => {
    show();
    const tw = () => within(installed("test-watcher"));
    expect(tw().getByTestId("plugin-update-available").textContent).toBe("0.1.0 is available.");
    expect(tw().getByTestId("plugin-installed-from").textContent).toBe("from alexwaumann/code-foundry-plugins");
    fireEvent.click(tw().getByTestId("plugin-update"));
    expect(m.update).toHaveBeenCalledWith("test-watcher");

    act(() => {
      setPlugins(PLUGINS.map((p) => (p.name === "test-watcher" ? { ...p, version: "0.1.0", updateAvailable: false, updateVersion: "" } : p)));
    });
    expect(installed("test-watcher").textContent).toContain("0.1.0");
    expect(tw().queryByTestId("plugin-update")).toBeNull();
    expect(tw().queryByTestId("plugin-update-available")).toBeNull();
    expect(tw().getByTestId("plugin-pill").textContent).toBe("Running");
  });

  it("another source's install offers no Update and says where it came from", () => {
    show();
    const acme = within(installed("acme-data"));
    expect(acme.queryByTestId("plugin-update")).toBeNull();
    expect(acme.getByTestId("plugin-installed-from").textContent).toBe("from plugins.acme.dev/index.json");
  });

  it("name the daemon's plugin folder, or say “the plugins folder” until it is known", async () => {
    m.dirs.mockResolvedValue({ pluginsDir: "/Users/dev/.cf-integ/plugins", dataDir: "/Users/dev/.cf-integ/plugin-data" });
    m.dirs.mockReturnValueOnce(new Promise(() => undefined));
    show();
    const section = () => document.querySelector<HTMLElement>('[data-testid="settings-section"][data-section="installed"]')?.textContent ?? "";
    expect(section()).toContain("Plugins in the plugins folder.");
    cleanup();
    show();
    await waitFor(() => {
      expect(section()).toContain("Plugins in ~/.cf-integ/plugins.");
    });
  });
});

describe("Settings → Plugins: a plugin's secrets", () => {
  it("only a plugin that keeps secrets has the toggle; it lists them by name and when they were set", async () => {
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
    expect(within(installed("crasher")).queryByTestId("plugin-secrets-toggle")).toBeNull();
    const acme = within(installed("acme-data"));
    const toggle = acme.getByTestId("plugin-secrets-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(acme.queryByTestId("plugin-secrets")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
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
    const hello = within(installed("hello"));
    fireEvent.click(hello.getByTestId("plugin-secrets-toggle"));
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

  it("says how many of the plugin's own threads go with it", () => {
    useThreadsStore.setState({ byId: { "s-hello-assistant": owned("s-hello-assistant", "plugin:hello"), "s-x": owned("s-x", "plugin:other") }, owned: ["s-hello-assistant", "s-x"] });
    show();
    fireEvent.click(within(installed("hello")).getByTestId("plugin-uninstall"));
    expect(screen.getByTestId("uninstall-dialog").textContent).toContain("It removes its 1 thread.");
    fireEvent.click(dialog().getByTestId("uninstall-cancel"));
    expect(screen.queryByTestId("uninstall-dialog")).toBeNull();
    expect(m.uninstall).not.toHaveBeenCalled();
  });

  it("names what stays, drops that line with purge, and uninstalls with the choice", async () => {
    show();
    await waitFor(() => {
      expect(usePluginsStore.getState().dirs).not.toBeNull();
    });
    fireEvent.click(within(installed("test-watcher")).getByTestId("plugin-uninstall"));
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

  it("names the daemon's own plugin folders", async () => {
    m.dirs.mockResolvedValue({ pluginsDir: "/Users/dev/.cf-integ/plugins", dataDir: "/Users/dev/.cf-integ/plugin-data" });
    show();
    await waitFor(() => {
      expect(usePluginsStore.getState().dirs?.pluginsDir).toBe("/Users/dev/.cf-integ/plugins");
    });
    fireEvent.click(within(installed("test-watcher")).getByTestId("plugin-uninstall"));
    const text = screen.getByTestId("uninstall-dialog").textContent;
    expect(text).toContain("It stops and its package goes from ~/.cf-integ/plugins.");
    expect(text).toContain("Its data (~/.cf-integ/plugin-data/test-watcher), secrets and the consent you gave stay for a reinstall.");
    expect(text).not.toContain(".code-foundry");
  });

  it("an uninstalled plugin's row goes", () => {
    show();
    act(() => {
      setPlugins(PLUGINS.filter((p) => p.name !== "test-watcher"));
    });
    expect(document.querySelector('[data-plugin="test-watcher"][data-testid="plugin-row-settings"]')).toBeNull();
  });
});
