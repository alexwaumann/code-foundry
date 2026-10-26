/**
 * The plugin registries in the mock daemon (docs/notes/plugins-7-registry.md): the
 * fixture registry listing gh-actions and test-watcher 0.1.0 (their entries in
 * github.com/alexwaumann/code-foundry-plugins pull requests #1 and #2), PluginService.Browse,
 * and plugin.browse / install / update / uninstall. plugins.registries is empty by
 * default, as in the daemon; the mock's settings configure the fixture registry
 * explicitly (mock/settings.ts), and clearing the setting shows Browse with no registry.
 * An install reports its steps as install_progress events a few hundred milliseconds
 * apart, like a real download.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { PluginIndexRelation, PluginInstallPhase, type BrowsePluginsResponseSchema, type PluginIndexEntrySchema } from "../src/gen/codefoundry/v1/plugin_pb";
import { CommandError } from "./errors";
import type { PluginCommand, PluginEventInit } from "./plugins";

type EntryInit = MessageInitShape<typeof PluginIndexEntrySchema>;
type BrowseInit = MessageInitShape<typeof BrowsePluginsResponseSchema>;

/** The registry the fixture lists, configured in the mock's settings (not a default). */
export const FIXTURE_REGISTRY = "https://github.com/alexwaumann/code-foundry-plugins";

/**
 * A second registry, on loopback, that nothing configures by default: it lists acme-data
 * 1.3.0 (installed 1.2.0 from Acme's own registry, so Browse says where it came from and
 * offers nothing) and a test-watcher 0.2.0 that the fixture registry shadows when it comes
 * first (docs/notes/plugins-browse-offer.md).
 */
export const LOOPBACK_REGISTRY = "http://127.0.0.1:8765/index.json";

/** The plugins.registries value as the daemon reads it: URLs separated by commas or spaces. */
export function parseRegistries(v: string): string[] {
  if (v.trim().toLowerCase() === "none") return [];
  return [...new Set(v.split(/[\s,]+/).filter(Boolean).map((u) => u.replace(/\/+$/, "")))];
}

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

/** An installed plugin as the registry half sees it: its version, dev link, and where `plugin install` got it. */
export interface InstalledInfo {
  version: string;
  dev: boolean;
  install?: { kind: string; source: string } | undefined;
}

export interface RegistryDeps {
  /** The plugins.registries setting's value. */
  registries: () => string;
  installed: (name: string) => InstalledInfo | null;
  install: (spec: InstallSpec) => void;
  uninstall: (name: string) => void;
  publish: (ev: PluginEventInit) => void;
  /** The registries changed: publish every plugin again, as the daemon does for those whose offer changed. */
  republish: () => void;
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
      registry: FIXTURE_REGISTRY,
    },
    {
      name: "test-watcher",
      displayName: "Test Watcher",
      version: "0.1.0",
      description: "Runs the project's tests in a thread's worktree whenever files change, shows failures and output in the side panel, flags the thread while tests fail, and sends failures to Claude.",
      repo: "alexwaumann/code-foundry-plugin-test-watcher",
      permissions: { commands: ["thread.send"], events: ["project", "threads"], threadStatus: true, sessionEnv: false, secrets: false },
      registry: FIXTURE_REGISTRY,
    },
  ];
}

function loopbackEntries(): Entry[] {
  return [
    {
      name: "acme-data",
      displayName: "Acme Data",
      version: "1.3.0",
      description: "Signs you in to Acme's data warehouse and gives new threads a read-only token.",
      repo: "acme-corp/code-foundry-plugin-acme-data",
      permissions: { commands: ["thread.send"], events: [], threadStatus: false, sessionEnv: true, secrets: true },
      registry: LOOPBACK_REGISTRY,
    },
    {
      name: "test-watcher",
      displayName: "Test Watcher",
      version: "0.2.0",
      description: "A fork of the test watcher.",
      repo: "someone/code-foundry-plugin-test-watcher",
      permissions: { commands: ["thread.send"], events: ["project", "threads"], threadStatus: true, sessionEnv: false, secrets: false },
      registry: LOOPBACK_REGISTRY,
    },
  ];
}

/** How an entry stands to the installed plugin of its name: the daemon's plugin.Relation (internal/store/plugin/updates.go). */
type Relation = "not_installed" | "installed" | "update" | "dev" | "other_source";

const relations: Record<Relation, PluginIndexRelation> = {
  not_installed: PluginIndexRelation.NOT_INSTALLED,
  installed: PluginIndexRelation.INSTALLED,
  update: PluginIndexRelation.UPDATE,
  dev: PluginIndexRelation.DEV,
  other_source: PluginIndexRelation.OTHER_SOURCE,
};

/** The daemon's sameSource: the registry it was installed from, or for a release an entry of that repository. */
function sameSource(inst: InstalledInfo, e: Entry): boolean {
  if (inst.install?.kind === "registry") return inst.install.source === e.registry;
  if (inst.install?.kind === "github") return e.repo !== "" && inst.install.source.toLowerCase() === e.repo.toLowerCase();
  return false;
}

function relate(inst: InstalledInfo | null, e: Entry): Relation {
  if (!inst) return "not_installed";
  if (inst.dev) return "dev";
  if (!sameSource(inst, e)) return "other_source";
  return newer(e.version, inst.version) ? "update" : "installed";
}

/** The daemon's SourceLabel. */
function sourceLabel(inst: InstalledInfo): string {
  if (!inst.install) return "the plugins folder";
  if (inst.install.kind === "registry") return inst.install.source.replace(/^https?:\/\//, "").replace(/^github\.com\//, "");
  return inst.install.source;
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
  /** RegistryChanged's epoch and the registries it was last published for. */
  private epoch = 0;
  private seen = "";

  constructor(private readonly deps: RegistryDeps) {}

  reset(): void {
    this.entries = seedEntries();
    this.error = "";
    this.seen = this.configured().join(" ");
    this.installError = "";
    this.fetchedAt = new Date(Date.now() - 12 * 60_000);
  }

  /** Settings changed: like the daemon, a new set of registries makes clients showing Browse read it again. */
  settingsChanged(): void {
    const now = this.configured().join(" ");
    if (now === this.seen) return;
    this.seen = now;
    this.epoch++;
    this.deps.publish({ event: { case: "registryEpoch", value: BigInt(this.epoch) } });
    this.deps.republish();
  }

  /** The configured registries (none by default). */
  private configured(): string[] {
    return parseRegistries(this.deps.registries());
  }

  /** A registry's own list (the fixture's, the loopback one's; any other lists none). */
  private listOf(url: string): Entry[] {
    if (url === FIXTURE_REGISTRY) return this.entries;
    if (url === LOOPBACK_REGISTRY) return loopbackEntries();
    return [];
  }

  /** What the configured registries list merged by name, the first registry listing a name winning (sorted by name, as the daemon's). */
  private listed(): Entry[] {
    const out = new Map<string, Entry>();
    for (const url of this.configured()) for (const e of this.listOf(url)) if (!out.has(e.name)) out.set(e.name, e);
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A later registry's duplicates of names an earlier one lists, as the daemon words them. */
  private issues(url: string): string[] {
    const regs = this.configured();
    const before = regs.slice(0, regs.indexOf(url));
    return this.listOf(url).flatMap((e) => {
      const first = before.find((u) => this.listOf(u).some((x) => x.name === e.name));
      return first ? [`${e.name}: already listed by ${first}, which comes first`] : [];
    });
  }

  private entry(name: string): Entry {
    const regs = this.configured();
    if (regs.length === 0)
      throw new CommandError("notfound", `no plugin registry is configured to look up "${name}" in (settings plugins.registries); a release installs as <owner>/<repo>, a folder by its path`);
    const e = this.listed().find((x) => x.name === name);
    if (!e) throw new CommandError("notfound", `no plugin "${name}" in the registries (${regs.join(", ")})`);
    return e;
  }

  /** The update fields of a Plugin message: an offer only from the source it was installed from (the daemon's offerFor). */
  offer(name: string): { updateAvailable?: boolean; updateVersion?: string; updateRegistry?: string } {
    const e = this.listed().find((x) => x.name === name);
    if (!e || relate(this.deps.installed(name), e) !== "update") return {};
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
        ...(inst ? { installed: { name: e.name, version: inst.version, dev: inst.dev } } : {}),
        relation: relations[relate(inst, e)],
        updateAvailable: relate(inst, e) === "update",
        installedFrom: inst && relate(inst, e) === "other_source" ? sourceLabel(inst) : "",
      };
    });
    return {
      entries,
      platform: "darwin/arm64",
      registries: this.configured().map((url) => ({
        url,
        fetchedAt: timestampFromDate(this.fetchedAt),
        cached: !refresh,
        error: url === FIXTURE_REGISTRY ? this.error : "",
        plugins: this.listOf(url).length,
        issues: this.issues(url),
      })),
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
        cmd: { name: "plugin.browse", noPalette: true, title: "Browse Plugins", category: "Plugin", description: "List the plugins the registries offer.", keybindings: [], args: [refresh] },
        when: always,
        run: (_c: UiContext | undefined, a) => {
          const b = this.browse(a.refresh === "true");
          if (b.registries?.length === 0) return "no plugin registry is configured; add one with: code-foundry settings set plugins.registries https://github.com/<owner>/<repo>";
          return b.entries?.map((e) => `${e.name ?? ""} ${e.version ?? ""}`).join("\n") ?? "";
        },
      },
      {
        cmd: {
          name: "plugin.install", noPalette: true,
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
          const names = a.name ? [a.name] : this.listed().map((e) => e.name);
          const lines: string[] = [];
          for (const n of names) {
            const e = this.listed().find((x) => x.name === n);
            const had = this.deps.installed(n);
            if (!e || !had) continue;
            if (relate(had, e) === "other_source" && newer(e.version, had.version)) {
              lines.push(`not offered: ${n} ${e.version} from ${e.registry} (installed from ${sourceLabel(had)})`);
              continue;
            }
            if (relate(had, e) !== "update") continue;
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
          name: "plugin.uninstall", noPalette: true,
          title: "Uninstall Plugin",
          category: "Plugin",
          description: "Disable a plugin, stop it, remove its threads and its package; --purge deletes its data, secrets and consent too.",
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
