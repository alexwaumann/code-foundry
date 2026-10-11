import { toast } from "sonner";
import type { UiIntentView } from "@/api/ui";
import { isShellLabels } from "@/lib/termlabel";
import { clearRevealOnArrival, revealShell } from "./bottomActions";
import { PENDING_FOCUS_MS } from "./bottomPanel";
import { sessionOfTerminal, useSessionsStore } from "./sessions";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";
import { showView } from "./views";
import { showWorktreeOnProjectsPage } from "./worktreePanel";

/**
 * A focusTerminal intent whose terminal, or the thread it belongs to, the stores did not
 * know yet: retried on terminal and session events (retryFocusTerminal), dropped after
 * PENDING_FOCUS_MS (with a toast when the terminal never showed up), by the next intent
 * that moves the window, and by any change of selection.
 */
let pendingTerminal: { id: string; at: number } | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;

/** Forgets every pending focusTerminal (this module's and revealShell's). Exported for tests too. */
export function clearPendingFocus(): void {
  pendingTerminal = null;
  clearTimeout(expiry);
  expiry = undefined;
  clearRevealOnArrival();
}

// A selection change (the user's, or a resolved reveal's) ends the wait.
useUiStore.subscribe((s, prev) => {
  if (s.selection !== prev.selection && pendingTerminal !== null) clearPendingFocus();
});

/**
 * Selects the thread whose Claude terminal this is; false when none is known. Never for a
 * shell: revealShell shows those in the bottom panel, and selecting the thread here would
 * pull the keyboard into its Claude terminal.
 */
function selectThreadOf(id: string): boolean {
  const t = useTerminalsStore.getState().byId[id];
  if (t && isShellLabels(t.labels)) return false;
  const session = sessionOfTerminal(useSessionsStore.getState(), t ?? { id, labels: {} });
  if (!session) return false;
  useUiStore.getState().select({ kind: "session", id: session.id }, { focusTerminal: true });
  return true;
}

/**
 * Shows a terminal: a shell in its owner's bottom panel (revealShell: a thread's, or the
 * Projects page's), a thread's Claude terminal by selecting the thread. One that has not
 * arrived yet is shown when it does, within PENDING_FOCUS_MS. A known terminal with
 * neither owner (a raw TerminalService.Create) has nowhere to show: a toast says so.
 */
function focusTerminal(id: string): void {
  clearPendingFocus();
  if (revealShell(id) || selectThreadOf(id)) return;
  const t = useTerminalsStore.getState().byId[id];
  if (t !== undefined && !t.labels.session) {
    toast.info(`Terminal ${id} belongs to no thread or project`, { description: "Terminals show in a thread's or the Projects page's bottom panel." });
    return;
  }
  pendingTerminal = { id, at: Date.now() };
  expiry = setTimeout(() => {
    if (pendingTerminal?.id !== id) return;
    clearPendingFocus();
    if (!(id in useTerminalsStore.getState().byId)) toast.error(`Terminal ${id} not found`);
  }, PENDING_FOCUS_MS);
}

/**
 * Selects the thread of a pending focusTerminal once its terminal and thread are known. A
 * pending terminal that arrives as a shell is revealShell's (bottomActions onNewTerminal).
 */
export function retryFocusTerminal(now = Date.now()): void {
  if (pendingTerminal === null) return;
  const { id, at } = pendingTerminal;
  if (now - at > PENDING_FOCUS_MS) {
    clearPendingFocus();
    return;
  }
  const t = useTerminalsStore.getState().byId[id];
  if ((t && isShellLabels(t.labels)) || selectThreadOf(id)) {
    pendingTerminal = null;
    clearTimeout(expiry);
  }
}

/** Applies one UI intent (delivered on the shared events stream) to the GUI. */
export function applyIntent(intent: UiIntentView): void {
  const ui = useUiStore.getState();
  switch (intent.kind) {
    case "focusTerminal":
      focusTerminal(intent.terminalId);
      break;
    case "focusSession":
      clearPendingFocus();
      ui.select({ kind: "session", id: intent.sessionId }, { focusTerminal: true });
      break;
    case "focusRepo":
      // The Projects page with the worktree (default: the project's main one) in its panel.
      showWorktreeOnProjectsPage(intent.repoId, intent.worktreePath);
      break;
    case "openPalette":
      ui.openPalette(intent.query);
      break;
    case "notify": {
      const opts = intent.body ? { description: intent.body } : undefined;
      const title = intent.title || intent.body;
      if (intent.level === "error") toast.error(title, opts);
      else if (intent.level === "warning") toast.warning(title, opts);
      else toast.info(title, opts);
      break;
    }
    case "showView":
      clearPendingFocus();
      showView(intent.name);
      break;
  }
}
