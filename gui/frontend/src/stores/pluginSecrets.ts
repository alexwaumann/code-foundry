/**
 * Plugins' secrets for Settings → Plugins (docs/notes/plugins-11-gui-gaps.md): each
 * plugin's secret names and when they were set (PluginService.ListSecrets, read when its
 * row opens them), never a value. Deleting runs plugin.secrets.delete, whose confirm the
 * daemon asks for (the generic confirm dialog); the list is read again after it, since no
 * event says a secret changed.
 */
import { create } from "zustand";
import { listPluginSecrets, type PluginSecretView } from "@/api/plugin";
import { errorMessage } from "@/api/stream";
import { runCommandForResult } from "./commands";

export interface SecretsEntry {
  /** null until the first read answers. */
  list: readonly PluginSecretView[] | null;
  /** The last read's failure ("" when it worked). */
  error: string;
}

export interface PluginSecretsState {
  byName: Readonly<Record<string, SecretsEntry>>;
}

export const usePluginSecretsStore = create<PluginSecretsState>()(() => ({ byName: {} }));

const inflight = new Map<string, AbortController>();

/** Reads a plugin's secrets again (a newer read aborts an older one for the same plugin). */
export async function loadPluginSecrets(name: string): Promise<void> {
  inflight.get(name)?.abort();
  const ctl = new AbortController();
  inflight.set(name, ctl);
  const set = (e: Partial<SecretsEntry>) => {
    usePluginSecretsStore.setState((s) => ({ byName: { ...s.byName, [name]: { list: s.byName[name]?.list ?? null, error: "", ...e } } }));
  };
  try {
    const list = await listPluginSecrets(name, ctl.signal);
    if (inflight.get(name) === ctl) set({ list, error: "" });
  } catch (err) {
    if (inflight.get(name) === ctl && !ctl.signal.aborted) set({ error: errorMessage(err) });
  } finally {
    if (inflight.get(name) === ctl) inflight.delete(name);
  }
}

/** Deletes one secret through plugin.secrets.delete (the daemon's confirm asks first), then reads the list again. */
export async function deletePluginSecret(name: string, key: string): Promise<boolean> {
  const res = await runCommandForResult("plugin.secrets.delete", { name, key }, { quiet: true });
  await loadPluginSecrets(name);
  return res !== null;
}

/** A plugin's secrets entry (undefined before its first read). */
export function usePluginSecrets(name: string): SecretsEntry | undefined {
  return usePluginSecretsStore((s) => s.byName[name]);
}
