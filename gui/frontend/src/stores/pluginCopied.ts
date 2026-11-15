/**
 * Plugin elements whose copy action just ran from a visible control (a button, a chip, a
 * row, a table row, a stat card, a bar), so the element shows a check in place for
 * COPIED_MS instead of a toast (docs/notes/toast-success-rule.md). A copy from a plugin's
 * menu is toasted instead: the menu closed as it ran (stores/pluginSurfaces.ts
 * copyElementText).
 */
import { create } from "zustand";
import { COPIED_MS } from "@/lib/useCopied";

interface PluginCopiedState {
  /** copiedKey(watchKey, element key) → the copy's stamp, while its check shows. */
  copied: Readonly<Record<string, number>>;
}

export const usePluginCopiedStore = create<PluginCopiedState>()(() => ({ copied: {} }));

const copiedKey = (watchKey: string, key: string): string => `${watchKey}\u0000${key}`;

let stamps = 0;

/** Shows element `key` of watch `watchKey` as copied for `ms`; a recopy meanwhile restarts the wait. */
export function markElementCopied(watchKey: string, key: string, ms = COPIED_MS): void {
  const k = copiedKey(watchKey, key);
  const stamp = ++stamps;
  usePluginCopiedStore.setState((s) => ({ copied: { ...s.copied, [k]: stamp } }));
  setTimeout(() => {
    usePluginCopiedStore.setState((s) => {
      if (s.copied[k] !== stamp) return s;
      const { [k]: _gone, ...rest } = s.copied;
      return { copied: rest };
    });
  }, ms);
}

/** Whether element `key` of watch `watchKey` shows its copied check now. */
export function useElementCopied(watchKey: string, key: string): boolean {
  return usePluginCopiedStore((s) => copiedKey(watchKey, key) in s.copied);
}
