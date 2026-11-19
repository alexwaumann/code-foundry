/**
 * The setting layout.threads_open_as in the GUI (docs/notes/shell-model.md, "Threads open as";
 * docs/notes/threads-open-as-2-gui.md). The daemon owns the rules (internal/layout modes.go):
 * this reads the setting and mirrors the little the window draws from it: which panes are
 * thread panes (one header row instead of the strip), and the target thread pane "Open beside"
 * names.
 */
import { spaceTabs } from "@/shell/linked";
import { spaceOfThread, useLayoutStore, type LayoutState } from "@/stores/layout";
import { useSettingValue } from "@/stores/settings";

/** The setting that says how a thread opens (internal/layout modes.go). */
export const THREADS_OPEN_AS_KEY = "layout.threads_open_as";

export type ThreadsOpenAs = "tabs" | "panes" | "single";

/** A setting value as a mode; anything else (unset, unknown) is Tabs, as the daemon reads it. */
export function threadsOpenAsOf(value: string | undefined): ThreadsOpenAs {
  return value === "panes" || value === "single" ? value : "tabs";
}

/** The mode now. */
export function useThreadsOpenAs(): ThreadsOpenAs {
  return threadsOpenAsOf(useSettingValue(THREADS_OPEN_AS_KEY));
}

/** A thread's own tab or a composer: what a thread pane holds (modes.go threadLike). */
export function threadLikeKind(kind: string | undefined): boolean {
  return kind === "thread" || kind === "compose";
}

type PaneView = Pick<LayoutState, "panes" | "tabs">;

/** Whether the pane holds a thread's tab or a composer. */
export function holdsThread(s: PaneView, paneId: string): boolean {
  return (s.panes[paneId]?.tabIds ?? []).some((id) => threadLikeKind(s.tabs[id]?.kind));
}

/**
 * The tab a pane's one header row stands for under Panes and Single: its only tab when that is
 * a thread's or a composer; "" for any other pane (and under Tabs), which keeps its strip.
 */
export function headedTab(s: PaneView, paneId: string, mode: ThreadsOpenAs): string {
  if (mode === "tabs") return "";
  const ids = s.panes[paneId]?.tabIds ?? [];
  const only = ids.length === 1 ? (ids[0] ?? "") : "";
  return only && threadLikeKind(s.tabs[only]?.kind) ? only : "";
}

/** headedTab for a pane, now. */
export function useHeadedTab(paneId: string): string {
  const mode = useThreadsOpenAs();
  return useLayoutStore((s) => headedTab(s, paneId, mode));
}

/**
 * The space's target thread pane (modes.go threadPane): the focused pane when it holds a thread
 * or a composer, else the one focused most recently (the space's MRU of tabs); "" when none does.
 */
export function targetThreadPane(s: Pick<LayoutState, "spaces" | "panes" | "tabs">, spaceId: string): string {
  const sp = s.spaces[spaceId];
  if (!sp) return "";
  if (sp.focus && holdsThread(s, sp.focus)) return sp.focus;
  for (const tabId of sp.mru) {
    const pane = s.tabs[tabId]?.paneId ?? "";
    if (pane && s.panes[pane]?.spaceId === spaceId && holdsThread(s, pane)) return pane;
  }
  return Object.values(s.panes).find((p) => p.spaceId === spaceId && holdsThread(s, p.id))?.id ?? "";
}

/**
 * The pane "Open beside" opens the thread on the right of: the target thread pane of the thread's
 * space (where a click would replace); "" when the space has none or the thread is already open
 * there (a click focuses it where it is).
 */
export function besidePane(s: Pick<LayoutState, "spaces" | "panes" | "tabs" | "threads" | "defaultSpaceId">, threadId: string): string {
  const space = spaceOfThread(s, threadId);
  if (spaceTabs(s, space).some((t) => t.kind === "thread" && t.thread === threadId)) return "";
  return targetThreadPane(s, space);
}
