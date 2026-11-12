/**
 * The composer tab a send comes from, in the window shell: the focused tab when it is a composer
 * (the one being typed in). thread.new takes it as --compose, so the new thread's tab takes its
 * place in one commit (docs/notes/shell-6-lifecycle.md). "" outside the shell, and in a space with
 * no pane (its home composer has no tab: the thread then opens in a new pane).
 */
import { useLayoutStore } from "@/stores/layout";
import { shellDrawn } from "@/stores/shellView";

export function composerTabSentFrom(): string {
  if (!shellDrawn()) return "";
  const s = useLayoutStore.getState();
  const pane = s.panes[s.spaces[s.currentSpaceId]?.focus ?? ""];
  const tab = pane ? s.tabs[pane.active] : undefined;
  return tab?.kind === "compose" ? tab.id : "";
}
