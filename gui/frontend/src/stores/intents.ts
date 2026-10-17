import { toast } from "sonner";
import { playAlertSound } from "@/api/app";
import type { UiIntentView } from "@/api/ui";
import { clearRevealOnArrival, revealShell } from "./bottomActions";
import { PENDING_FOCUS_MS } from "./bottomPanel";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";
import { showView } from "./views";
import { showWorktreeOnProjectsPage } from "./worktreePanel";

/**
 * A focusTerminal intent whose terminal the stores did not know yet. revealShell shows it
 * when it arrives as a shell (bottomActions revealOnArrival); this only ends the wait
 * after PENDING_FOCUS_MS, with a toast when the terminal never showed up. Dropped by the
 * next intent that moves the window and by any change of selection.
 */
let pendingTerminal: string | null = null;
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
 * Shows a terminal: a shell in its owner's bottom panel (revealShell: a thread's, or the
 * Projects page's). One that has not arrived yet is shown when it does, within
 * PENDING_FOCUS_MS. A known terminal that is no owned shell (a raw TerminalService.Create)
 * has nowhere to show: a toast says so. Threads have no terminal of their own.
 */
function focusTerminal(id: string): void {
  clearPendingFocus();
  if (revealShell(id)) return;
  if (id in useTerminalsStore.getState().byId) {
    toast.info(`Terminal ${id} belongs to no thread or project`, { description: "Terminals show in a thread's or the Projects page's bottom panel." });
    return;
  }
  pendingTerminal = id;
  expiry = setTimeout(() => {
    if (pendingTerminal !== id) return;
    clearPendingFocus();
    if (!(id in useTerminalsStore.getState().byId)) toast.error(`Terminal ${id} not found`);
  }, PENDING_FOCUS_MS);
}

/** Applies one UI intent (delivered on the shared events stream) to the GUI. */
export function applyIntent(intent: UiIntentView): void {
  const ui = useUiStore.getState();
  switch (intent.kind) {
    case "focusTerminal":
      focusTerminal(intent.terminalId);
      break;
    case "focusThread":
      clearPendingFocus();
      ui.select({ kind: "thread", id: intent.threadId }, { focusPrompt: true });
      break;
    case "focusProject":
      // The Projects page with the worktree (default: the project's main one) in its panel.
      showWorktreeOnProjectsPage(intent.projectId, intent.worktreePath);
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
    case "playAlertSound":
      // notifications.test: a preview, whatever the focus, cooldown and sound toggle.
      void playAlertSound(intent.volume);
      break;
  }
}
