import { useUiStore } from "@/stores/ui";
import { EMBER_VIEW } from "@/surfaces/emberTarget";

/** Whether the selection shows Ember's chat (its thread, or the Ember view): Ember's row, and its flame on the sidebar's rail. */
export function useEmberSelected(threadId: string): boolean {
  return useUiStore((s) => (s.selection.kind === "thread" && s.selection.id === threadId) || (s.selection.kind === "view" && s.selection.name === EMBER_VIEW));
}
