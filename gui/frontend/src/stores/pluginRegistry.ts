/**
 * The plugin registries for Settings → Plugins → Browse (docs/notes/plugins-7-registry.md):
 * the merged index (PluginService.Browse, re-read when the daemon says it changed), the
 * install progress the daemon reports per plugin (PluginEvent.install_progress), and the
 * actions, which run the plugin.* commands so their errors and confirms flow the normal
 * way: install (then plugin.enable, whose consent dialog asks before anything runs),
 * update and uninstall (the Settings dialog's purge choice, confirmed there once).
 */
import { create } from "zustand";
import { browsePlugins, installOutcome, type BrowseView, type InstallProgressView } from "@/api/plugin";
import { errorMessage } from "@/api/stream";
import { requestConfirm, registerConfirmPresenter, type ConfirmRequest } from "./confirm";
import { runCommand, runCommandForResult } from "./commands";

export type RegistryAction = "install" | "update" | "uninstall";

export interface PluginRegistryState {
  browse: BrowseView | null;
  loading: boolean;
  /** Browse itself failed (the daemon, not a registry: those report in browse.registries). */
  error: string;
  /** The last registry epoch heard; Browse re-reads when it moves. */
  epoch: number;
  /** The latest install step per plugin name (or ref, before the name is known). */
  progress: Readonly<Record<string, InstallProgressView>>;
  /** What the GUI is doing to a plugin right now. */
  busy: Readonly<Record<string, RegistryAction>>;
}

export const usePluginRegistryStore = create<PluginRegistryState>()(() => ({ browse: null, loading: false, error: "", epoch: 0, progress: {}, busy: {} }));

let inflight: Promise<void> | null = null;

/** Reads Browse (refresh: every registry again instead of its cached index). */
export async function loadBrowse(refresh = false): Promise<void> {
  if (inflight && !refresh) return inflight;
  usePluginRegistryStore.setState({ loading: true });
  const run = browsePlugins(refresh)
    .then((browse) => {
      usePluginRegistryStore.setState({ browse, loading: false, error: "" });
    })
    .catch((err: unknown) => {
      usePluginRegistryStore.setState({ loading: false, error: errorMessage(err) });
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

/** The progress key of an install step: the plugin, else what was asked for. */
function progressKey(p: InstallProgressView): string {
  return p.name || p.ref;
}

/** The state after one install step. Pure. Done drops the entry; a failure stays until the next try. */
export function applyInstallProgress(s: Readonly<Record<string, InstallProgressView>>, p: InstallProgressView): Record<string, InstallProgressView> {
  const key = progressKey(p);
  const { [key]: _old, [p.ref]: _byRef, ...rest } = s;
  if (p.phase === "done") return rest;
  return { ...rest, [key]: p };
}

export function onInstallProgress(p: InstallProgressView): void {
  usePluginRegistryStore.setState((s) => ({ progress: applyInstallProgress(s.progress, p) }));
}

let reload: ReturnType<typeof setTimeout> | undefined;

/** The merged index changed: re-read Browse soon, when it has been read before. */
export function onRegistryEpoch(epoch: number): void {
  const s = usePluginRegistryStore.getState();
  if (epoch === s.epoch) return;
  usePluginRegistryStore.setState({ epoch });
  if (!s.browse) return;
  clearTimeout(reload);
  reload = setTimeout(() => void loadBrowse(), 100);
}

function setBusy(name: string, action: RegistryAction | null): void {
  usePluginRegistryStore.setState((s) => {
    const { [name]: _gone, ...busy } = s.busy;
    return { busy: action ? { ...busy, [name]: action } : busy };
  });
}

/** Installs a registry plugin, then enables it through plugin.enable (the consent dialog asks first). */
export async function installPlugin(name: string): Promise<void> {
  setBusy(name, "install");
  usePluginRegistryStore.setState((s) => ({ progress: applyInstallProgress(s.progress, { ref: name, name, version: "", phase: "resolving", message: "", bytes: 0 }) }));
  try {
    const res = await runCommandForResult("plugin.install", { ref: name }, { quiet: true });
    const out = res ? installOutcome(res.resultJson) : null;
    if (!res) {
      // Failed (toasted): leave the failure where the row shows it.
      usePluginRegistryStore.setState((s) => {
        const p = s.progress[name];
        return p && p.phase !== "failed" ? { progress: { ...s.progress, [name]: { ...p, phase: "failed", message: p.message || "the install failed" } } } : {};
      });
      return;
    }
    usePluginRegistryStore.setState((s) => ({ progress: applyInstallProgress(s.progress, { ref: name, name, version: out?.version ?? "", phase: "done", message: "", bytes: 0 }) }));
    void loadBrowse();
    if (out && !out.enabled) await runCommand("plugin.enable", { name: out.name || name });
  } catch (err) {
    usePluginRegistryStore.setState((s) => ({ progress: { ...s.progress, [name]: { ref: name, name, version: "", phase: "failed", message: errorMessage(err), bytes: 0 } } }));
  } finally {
    setBusy(name, null);
  }
}

/** Installs the newer version a registry lists (plugin.update <name>). */
export async function updatePlugin(name: string): Promise<void> {
  setBusy(name, "update");
  try {
    if (await runCommand("plugin.update", { name })) void loadBrowse();
  } finally {
    setBusy(name, null);
  }
}

/** Uninstalls a plugin the user already confirmed in the Settings dialog (purge as chosen there). */
export async function uninstallPlugin(name: string, purge: boolean): Promise<void> {
  setBusy(name, "uninstall");
  const args = { name, purge: purge ? "true" : "false" };
  preconfirmed.add(confirmKey(args));
  try {
    if (await runCommand("plugin.uninstall", args)) void loadBrowse();
  } finally {
    preconfirmed.delete(confirmKey(args));
    setBusy(name, null);
  }
}

// plugin.uninstall confirms in the daemon (Confirm, --yes on the CLI). From Settings the
// user has answered already, in the dialog with the purge choice: that call is not asked
// twice. From the palette it gets the generic confirm with the daemon's words.
const preconfirmed = new Set<string>();

function confirmKey(args: Readonly<Record<string, string>> | undefined): string {
  return `${args?.name ?? ""}\u0000${args?.purge === "true" ? "purge" : ""}`;
}

registerConfirmPresenter("plugin.uninstall", (req: ConfirmRequest) => (preconfirmed.has(confirmKey(req.args)) ? Promise.resolve(true) : requestConfirm(req)));
