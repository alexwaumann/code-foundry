/**
 * The quick terminal (docs/notes/shell-model.md, "Terminals"): one per thread, drawn inside the
 * thread's pane under the conversation and composer (components/shell/QuickTerminal.tsx). Here:
 * where it sits (push or overlay), its height, which terminal it is, what cmd+j does, and the
 * handle the key uses to put the keyboard in it.
 * See docs/notes/shell-13-terminals.md.
 */
import type { TerminalView } from "@/api/terminal";

/** How much conversation must stay visible above the composer for the quick terminal to push (plan: CHAT_MIN). */
export const CHAT_MIN = 120;
/** Its height before the user has dragged one, and the least it may be dragged to (layout px). */
export const QUICK_DEFAULT = 260;
export const QUICK_MIN = 96;
/** What it always leaves of the pane above it, so the thread's header stays reachable. */
export const QUICK_TOP_ROOM = 44;

/** The height it is drawn at: the stored one (0: the default), kept inside the pane. */
export function quickHeight(stored: number, paneHeight: number): number {
  const want = stored > 0 ? stored : QUICK_DEFAULT;
  const max = Math.max(QUICK_MIN, paneHeight - QUICK_TOP_ROOM);
  return Math.round(Math.min(Math.max(want, QUICK_MIN), max));
}

/**
 * Push or overlay: it pushes the content up while the thread's chrome (header and composer) and
 * CHAT_MIN of conversation still fit above it, and overlays the bottom of the pane when they do
 * not. Before the chrome is measured (0) it pushes.
 */
export function quickMode(paneHeight: number, height: number, chrome: number): "push" | "overlay" {
  return paneHeight - height >= chrome + CHAT_MIN ? "push" : "overlay";
}

/** A thread's quick terminal: its running shell labelled slot=quick (internal/termlabel QuickShell). */
export function quickTerminalOf(terminals: Readonly<Record<string, TerminalView>>, order: readonly string[], threadId: string): TerminalView | null {
  for (const id of order) {
    const t = terminals[id];
    if (t && t.state === "running" && t.labels.thread === threadId && t.labels.slot === "quick") return t;
  }
  return null;
}

/** What cmd+j does (the spec's key table). */
export type QuickKeyAction = "open" | "focus" | "close" | "goto" | "none";

/**
 * cmd+j on the focused tab: on a thread's tab, open the quick terminal and focus it, focus it
 * when it is open but the keyboard is elsewhere, close it when it has the keyboard. On a linked
 * surface: go to its thread and open it there. On a tab of no thread, nothing.
 */
export function quickKeyAction(tab: { kind: string; thread: string } | null, open: boolean, focused: boolean): QuickKeyAction {
  if (!tab?.thread) return "none";
  if (tab.kind !== "thread") return "goto";
  if (!open) return "open";
  return focused ? "close" : "focus";
}

// ---- The keyboard ----

const hosts = new Map<string, () => void>();
let pending: string | null = null;

/** A mounted quick terminal's focus, by its thread. A focus asked for before it mounted is taken now. */
export function registerQuickHost(threadId: string, focus: () => void): () => void {
  hosts.set(threadId, focus);
  if (pending === threadId) {
    pending = null;
    focus();
  }
  return () => {
    if (hosts.get(threadId) === focus) hosts.delete(threadId);
  };
}

/** Puts the keyboard in a thread's quick terminal, now or as soon as it mounts. */
export function focusQuick(threadId: string): void {
  const focus = hosts.get(threadId);
  if (focus) {
    pending = null;
    focus();
  } else pending = threadId;
}

/** Whether the keyboard is in a thread's quick terminal. */
export function quickHasFocus(threadId: string): boolean {
  const el = document.activeElement;
  return el instanceof Element && el.closest(`[data-quick-terminal="${CSS.escape(threadId)}"]`) !== null;
}

/** Tests: forget every host. */
export function resetQuickHosts(): void {
  hosts.clear();
  pending = null;
}
