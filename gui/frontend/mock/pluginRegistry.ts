/**
 * The plugin registries in the mock daemon (docs/notes/plugins-7-registry.md): the default
 * registry listing gh-actions and test-watcher 0.1.0 (their entries in
 * github.com/alexwaumann/code-foundry-plugins pull requests #1 and #2), PluginService.Browse,
 * and plugin.browse / install / update / uninstall. An install reports its steps as
 * install_progress events a few hundred milliseconds apart, like a real download.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { PluginInstallPhase, type BrowsePluginsResponseSchema, type PluginIndexEntrySchema } from "../src/gen/codefoundry/v1/plugin_pb";
import { CommandError } from "./errors";
import type { PluginCommand, PluginEventInit } from "./plugins";

type EntryInit = MessageInitShape<typeof PluginIndexEntrySchema>;
type BrowseInit = MessageInitShape<typeof BrowsePluginsResponseSchema>;

export const DEFAULT_REGISTRY = "https://github.com/alexwaumann/code-foundry-plugins";

interface Perms {
  commands: string[];
  events: string[];
  threadStatus: boolean;
  sessionEnv: boolean;
  secrets: boolean;
}

/** What an install puts in place. */
export interface InstallSpec {
  name: string;
  displayName: string;
  version: string;
  description: string;
  permissions: Perms;
  registry: string;
}

interface Entry extends InstallSpec {
  repo: string;
}

export interface RegistryDeps {
  /** The plugins.registries setting's value (comma-separated URLs; "" or "none" lists none). */
  registries: () => string;
  installed: (name: string) => { version: string; dev: boolean } | null;
  install: (spec: InstallSpec) => void;
  uninstall: (name: string) => void;
  publish: (ev: PluginEventInit) => void;
}

function seedEntries(): Entry[] {
  return [
    {
      name: "gh-actions",
      displayName: "GitHub Actions",
      version: "0.1.0",
      description: "GitHub Actions runs, jobs and failed-step logs for the selected thread's pull request: rerun, cancel, send a failure to Claude, and a thread flag when a run fails.",
      repo: "alexwaumann/code-foundry-plugin-gh-actions",
      permissions: { commands: ["pr.checks", "thread.send", "view.open.url"], events: ["gh", "threads"], threadStatus: true, sessionEnv: false, secrets: false },
      registry: DEFAULT_REGISTRY,
    },
    {
      name: "test-watcher",
      displayName: "Test Watcher",
      version: "0.1.0",
      description: "Runs the project's tests in a thread's worktree whenever files change, shows failures and output in the side panel, flags the thread while tests fail, and sends failures to Claude.",
      repo: "alexwaumann/code-foundry-plugin-test-watcher",
      permissions: { commands: ["thread.send"], events: ["project", "threads"], threadStatus: true, sessionEnv: false, secrets: false },
      registry: DEFAULT_REGISTRY,
    },
  ];
}

/** The daemon's Permissions.Describe. */
function describePerms(p: Perms): string[] {
  const out: string[] = [];
  if (p.commands.length > 0) out.push(`run Code Foundry commands: ${p.commands.join(", ")}`);
  if (p.events.length > 0) out.push(`read events: ${p.events.join(", ")}`);
  if (p.threadStatus) out.push("raise threads to needs-attention or error");
  if (p.sessionEnv) out.push("add environment variables, PATH entries and directories to new Claude sessions");
  if (p.secrets) out.push("keep secrets in your Keychain (its own, under code-foundry-plugin)");
  return out;
}

/** a > b by major.minor.patch (the fixtures have no pre-releases). */
function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

const STEP_MS = 250;

export class MockRegistry {
  private entries: Entry[] = seedEntries();
  private fetchedAt = new Date(Date.now() - 12 * 60_000);
  /** A failure Browse reports for the registry (POST /__mock/plugin/registry?error=…). */
  error = "";
  /** A failure every install reports after its first step, until cleared (POST /__mock/plugin/registry?installError=…). */
  installError = "";
  private epoch = 0;
  private lastRegistries = "";

  constructor(private readonly deps: RegistryDeps) {}

  reset(): void {
    this.entries = seedEntries();
    this.error = "";
    this.installError = "";
    this.fetchedAt = new Date(Date.now() - 12 * 60_000);
    this.lastRegistries = this.deps.registries();
  }

  /** The configured registry URLs, like registry.ParseList: none for "" or "none". */
  private urls(): string[] {
    const v = this.deps.registries().trim();
    if (v === "" || v === "none") return [];
    return v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }

  /** The entries the configured registries list (only the default registry lists any). */
  private listed(): Entry[] {
    const urls = this.urls();
    return this.entries.filter((e) => urls.includes(e.registry));
  }

  /** The settings changed: a new plugins.registries value moves the registry epoch, so Browse reads again (the daemon's SetRegistries). */
  settingsChanged(): void {
    const v = this.deps.registries();
    if (v === this.lastRegistries) return;
    this.lastRegistries = v;
    this.deps.publish({ event: { case: "registryEpoch", value: BigInt(++this.epoch) } });
  }

  private entry(name: string): Entry {
    const e = this.listed().find((x) => x.name === name);
    if (!e) throw new CommandError("notfound", `no plugin "${name}" in the registries (${DEFAULT_REGISTRY})`);
    return e;
  }

  /** The update fields of a Plugin message. */
  offer(name: string, version: string, dev: boolean): { updateAvailable?: boolean; updateVersion?: string; updateRegistry?: string } {
    const e = this.entries.find((x) => x.name === name);
    if (!e || dev || !newer(e.version, version)) return {};
    return { updateAvailable: true, updateVersion: e.version, updateRegistry: e.registry };
  }

  browse(refresh: boolean): BrowseInit {
    if (refresh) this.fetchedAt = new Date();
    const entries: EntryInit[] = this.listed().map((e) => {
      const inst = this.deps.installed(e.name);
      return {
        name: e.name,
        displayName: e.displayName,
        description: e.description,
        repo: e.repo,
        version: e.version,
        protocol: 1,
        permissions: { ...e.permissions },
        permissionLines: describePerms(e.permissions),
        artifacts: ["darwin/arm64", "darwin/amd64"].map((platform) => ({
          platform,
          url: `https://github.com/${e.repo}/releases/download/v${e.version}/${e.name}-${e.version}-${platform.replace("/", "-")}.tar.gz`,
          sha256: "0".repeat(64),
        })),
        registry: e.registry,
        available: true,
        ...(inst ? { installed: { name: e.name, version: inst.version, dev: inst.dev }, updateAvailable: !inst.dev && newer(e.version, inst.version) } : {}),
      };
    });
    return {
      entries,
      platform: "darwin/arm64",
      registries: this.urls().map((url) =>
        url === DEFAULT_REGISTRY
          ? { url, fetchedAt: timestampFromDate(this.fetchedAt), cached: !refresh, error: this.error, plugins: entries.length, issues: [] }
          : // Another registry answers with an empty index.
            { url, fetchedAt: timestampFromDate(this.fetchedAt), cached: !refresh, error: "", plugins: 0, issues: [] },
      ),
    };
  }

  private progress(ref: string, e: Entry, phase: PluginInstallPhase, message: string, bytes = 0): void {
    this.deps.publish({ event: { case: "installProgress", value: { ref, name: e.name, version: e.version, phase, message, bytes: BigInt(bytes) } } });
  }

  /** The install's steps, STEP_MS apart, then the package in place. */
  private async install(ref: string, e: Entry): Promise<void> {
    const wait = () => new Promise((r) => setTimeout(r, STEP_MS));
    const url = `https://github.com/${e.repo}/releases/download/v${e.version}/${e.name}-${e.version}-darwin-arm64.tar.gz`;
    this.progress(ref, e, PluginInstallPhase.RESOLVING, `resolving ${ref}`);
    await wait();
    if (this.installError) throw new CommandError("unavailable", this.installError);
    this.progress(ref, e, PluginInstallPhase.DOWNLOADING, `downloading ${url}`);
    await wait();
    this.progress(ref, e, PluginInstallPhase.DOWNLOADING, `downloading ${url}`, 2_621_440);
    await wait();
    this.progress(ref, e, PluginInstallPhase.VERIFYING, "checking the SHA-256");
    await wait();
    this.progress(ref, e, PluginInstallPhase.EXTRACTING, "unpacking");
    await wait();
    this.progress(ref, e, PluginInstallPhase.INSTALLING, `installing into /Users/dev/.code-foundry/plugins/${e.name}`);
    await wait();
    this.deps.install(e);
    this.progress(ref, e, PluginInstallPhase.DONE, `installed ${e.name} ${e.version}`);
  }

  commands(): PluginCommand[] {
    const always = () => true;
    const refresh = { name: "refresh", type: ArgType.BOOL, required: false, description: "Read the registries again" };
    const nameArg = { name: "name", type: ArgType.STRING, required: true, description: "Plugin name" };
    return [
      {
        cmd: { name: "plugin.browse", title: "Browse Plugins", category: "Plugin", description: "List the plugins the registries offer.", keybindings: [], args: [refresh] },
        when: always,
        run: (_c: UiContext | undefined, a) => this.browse(a.refresh === "true").entries?.map((e) => `${e.name ?? ""} ${e.version ?? ""}`).join("\n") ?? "",
      },
      {
        cmd: {
          name: "plugin.install",
          title: "Install Plugin",
          category: "Plugin",
          description: "Install a plugin from the registries, a GitHub release or a folder.",
          keybindings: [],
          args: [
            { name: "ref", type: ArgType.STRING, required: true, description: "name[@version], owner/repo[@vX.Y.Z], or /absolute/folder" },
            { name: "enable", type: ArgType.BOOL, required: false, description: "Enable it afterwards" },
            { name: "force", type: ArgType.BOOL, required: false, description: "Reinstall" },
            refresh,
          ],
        },
        when: always,
        run: async (_c, a) => {
          const ref = a.ref ?? "";
          const e = this.entry(ref.split("@")[0] ?? "");
          if (this.error) throw new CommandError("notfound", this.error);
          const had = this.deps.installed(e.name);
          if (had && had.version === e.version && a.force !== "true") {
            return { message: `${e.name} ${e.version} is installed already (--force reinstalls it)`, resultJson: JSON.stringify({ plugin: { name: e.name, version: e.version, enabled: true }, version: e.version }) };
          }
          await this.install(ref, e);
          const now = this.deps.installed(e.name);
          return {
            message: `installed ${e.name} ${e.version} from ${e.registry}`,
            resultJson: JSON.stringify({
              plugin: { name: e.name, version: e.version, enabled: had !== null && now !== null, needsConsent: had === null },
              kind: "registry",
              source: e.registry,
              version: e.version,
              changed: true,
              ...(had ? { previousVersion: had.version } : {}),
            }),
          };
        },
      },
      {
        cmd: {
          name: "plugin.update",
          title: "Update Plugins",
          category: "Plugin",
          description: "Install the newer versions the registries list.",
          keybindings: [],
          args: [
            { name: "name", type: ArgType.STRING, required: false, description: "Plugin name" },
            { name: "check", type: ArgType.BOOL, required: false, description: "Only list the updates" },
            refresh,
          ],
        },
        when: always,
        run: async (_c, a) => {
          const names = a.name ? [a.name] : this.entries.map((e) => e.name);
          const lines: string[] = [];
          for (const n of names) {
            const e = this.entries.find((x) => x.name === n);
            const had = this.deps.installed(n);
            if (!e || !had || had.dev || !newer(e.version, had.version)) continue;
            if (a.check === "true") {
              lines.push(`${n} ${had.version} → ${e.version}`);
              continue;
            }
            await this.install(n, e);
            lines.push(`updated ${n} ${had.version} → ${e.version}`);
          }
          return { message: lines.join("\n") || "every plugin is up to date", resultJson: "{}" };
        },
      },
      {
        cmd: {
          name: "plugin.uninstall",
          title: "Uninstall Plugin",
          category: "Plugin",
          description: "Disable a plugin, stop it and remove its package; --purge deletes its data, secrets and consent too.",
          keybindings: [],
          args: [nameArg, { name: "purge", type: ArgType.BOOL, required: false, description: "Also delete its data, secrets, logs and consent" }],
          confirm: (_c, a) =>
            a.purge === "true"
              ? `Uninstall plugin ${a.name ?? ""} and delete its data, its secrets in the Keychain, its logs and the consent given?`
              : `Uninstall plugin ${a.name ?? ""}? Its data, secrets and consent stay (--purge deletes them).`,
        },
        when: always,
        run: (_c, a) => {
          this.deps.uninstall(a.name ?? "");
          return `uninstalled ${a.name ?? ""}${a.purge === "true" ? "\ndeleted its data, its logs, its consent and settings" : ""}`;
        },
      },
    ];
  }
}
