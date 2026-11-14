/**
 * How the shell runs the layout verbs (internal/command commands_tab.go, commands_pane.go,
 * commands_thread_open.go): every user action in the pane grid is one of them, invoked with the
 * window's context, as a key or the palette would. They answer Go's LayoutResult JSON; `rev` is
 * what the optimistic focus of stores/layout.ts waits for.
 * See docs/notes/shell-11-pane-grid.md.
 */
import { runCommandForResult } from "@/stores/commands";
import { focusPane, focusTab, useLayoutStore } from "@/stores/layout";

/** A layout verb's result: the commit's rev and what the op said. */
export interface LayoutCommandResult {
  rev: number;
  changed: boolean;
  space?: string;
  pane?: string;
  tab?: string;
  existing?: boolean;
  rule?: string;
}

/** The result in a command's JSON; null when it has none (an older daemon, a refusal). */
export function layoutResultOf(json: string): LayoutCommandResult | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<LayoutCommandResult> | null;
    return v && typeof v.rev === "number" ? (v as LayoutCommandResult) : null;
  } catch {
    return null;
  }
}

/**
 * Runs a layout verb quietly (the window shows the change; a failure is toasted). Resolves its
 * result, or null when it failed or was declined.
 */
export async function runLayoutCommand(name: string, args: Record<string, string> = {}): Promise<LayoutCommandResult | null> {
  const res = await runCommandForResult(name, args, { quiet: true });
  return res ? (layoutResultOf(res.resultJson) ?? { rev: 0, changed: false }) : null;
}

/** Focuses a pane now (optimistic) through pane.focus. */
export function focusPaneNow(paneId: string): Promise<boolean> {
  return focusPane(paneId, async () => (await runLayoutCommand("pane.focus", { pane: paneId, focus: "true" }))?.rev ?? null);
}

/** Focuses a tab now (optimistic) through tab.focus. */
export function focusTabNow(tabId: string): Promise<boolean> {
  return focusTab(tabId, async () => (await runLayoutCommand("tab.focus", { tab: tabId, focus: "true" }))?.rev ?? null);
}

/** Closes a tab (a thread's closes the thread from its space): tab.close. */
export function closeTabNow(tabId: string): Promise<LayoutCommandResult | null> {
  return runLayoutCommand("tab.close", { tab: tabId });
}

/**
 * Resolves once the layout slice holds the commit at `rev` (its event arrived), or after
 * `timeoutMs` when it does not (a dropped stream resyncs on its own).
 */
export function afterRev(rev: number, timeoutMs = 2000): Promise<void> {
  if (useLayoutStore.getState().rev >= rev) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsub();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const unsub = useLayoutStore.subscribe((s) => {
      if (s.rev >= rev) done();
    });
  });
}
