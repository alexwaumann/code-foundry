import { toast } from "sonner";
import { playAlertSound } from "@/api/app";
import type { UiIntentView } from "@/api/ui";
import { threadFocus } from "@/lib/inSidebar";
import { clearRevealOnArrival, revealShell } from "./bottomActions";
import { stageInThreadComposer } from "./composerText";
import { runCommandForResult } from "./commands";
import { getUiContext } from "./context";
import { notifyLinkAction, showingPage } from "./notifyLinks";
import { usePluginsStore } from "./plugins";
import { PENDING_FOCUS_MS } from "./bottomPanel";
import { showAgentRun } from "./subagentView";
import { useTerminalsStore } from "./terminals";
import { showThreadView } from "./threadPanelIntent";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";
import { showView } from "./views";
import { showProjectOnProjectsPage } from "./projectsPage";

/**
 * A focusTerminal intent whose terminal the stores did not know yet. revealShell shows it
 * when it arrives as a shell (bottomActions revealOnArrival); this only ends the wait
 * after PENDING_FOCUS_MS, with a toast when the terminal never showed up. Dropped by the
 * next intent that moves the window and by any change of selection.
 */
let pendingTerminal: string | null = null;
let expiry: ReturnType<typeof setTimeout> | undefined;

/**
 * A focusThread intent whose thread the list did not have yet (the intent and the list
 * event arrive separately): decided once the thread arrives (threadFocus), within
 * PENDING_FOCUS_MS. Dropped like pendingTerminal.
 */
let pendingThread: { id: string; stop: () => void } | null = null;

/** Forgets every pending focusTerminal (this module's and revealShell's) and focusThread. Exported for tests too. */
export function clearPendingFocus(): void {
  pendingTerminal = null;
  clearTimeout(expiry);
  expiry = undefined;
  clearRevealOnArrival();
  pendingThread?.stop();
  pendingThread = null;
}

// A selection change (the user's, or a resolved reveal's) ends the wait.
useUiStore.subscribe((s, prev) => {
  if (s.selection !== prev.selection && (pendingTerminal !== null || pendingThread !== null)) clearPendingFocus();
});

/**
 * Shows a thread the daemon asked to focus (thread.new, thread.fork, pr.*, thread.focus),
 * unless it is a thread just created that is hidden from the sidebar (lib/inSidebar.ts
 * threadFocus): an agent creating its children must not take the user's view. An
 * `explicit` one (a view.panel.* verb's --focus, which the user asked for) selects it
 * anyway. One not in the list yet is decided when it arrives.
 */
function focusThread(id: string, explicit: boolean): void {
  clearPendingFocus();
  const decide = (): boolean => {
    const byId = useThreadsStore.getState().byId;
    const t = byId[id];
    const d = explicit && t !== undefined ? "select" : threadFocus(t, byId, Date.now());
    if (d === "select") useUiStore.getState().select({ kind: "thread", id }, { focusPrompt: true });
    return d !== "wait";
  };
  if (decide()) return;
  const stopWatch = useThreadsStore.subscribe((s) => {
    if (!(id in s.byId)) return;
    clearPendingFocus();
    decide();
  });
  const timer = setTimeout(clearPendingFocus, PENDING_FOCUS_MS);
  pendingThread = {
    id,
    stop: () => {
      stopWatch();
      clearTimeout(timer);
    },
  };
}

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

/** Who asked, in words: a plugin's display name ("plugin:hello" → "Hello"), else as given. */
function callerName(caller: string): string {
  const m = /^plugin:(.+)$/.exec(caller);
  if (!m?.[1]) return caller;
  return usePluginsStore.getState().byName[m[1]]?.displayName ?? m[1];
}

/** Applies one UI intent (delivered on the shared events stream) to the GUI. */
export function applyIntent(intent: UiIntentView): void {
  const ui = useUiStore.getState();
  switch (intent.kind) {
    case "focusTerminal":
      focusTerminal(intent.terminalId);
      break;
    case "focusThread":
      focusThread(intent.threadId, intent.explicit ?? false);
      break;
    case "focusProject":
      // The Projects page, its cursor on the project (or the worktree's) row.
      showProjectOnProjectsPage(intent.projectId, intent.worktreePath);
      break;
    case "openPalette":
      ui.openPalette(intent.query);
      break;
    case "notify": {
      // A page showing the change already (the Themes page for a theme a thread applied): no toast.
      if (intent.unlessShowing && showingPage(intent.unlessShowing)) break;
      // A link it carries ("settings:memory") is a button on the toast; a second one goes before it.
      const open = intent.link ? notifyLinkAction(intent.link) : null;
      const second = intent.secondaryLink ? notifyLinkAction(intent.secondaryLink) : null;
      const opts =
        intent.body || open || second
          ? {
              ...(intent.body ? { description: intent.body } : {}),
              ...(open ? { action: { label: intent.linkLabel ?? "Open", onClick: open } } : {}),
              ...(second ? { cancel: { label: intent.secondaryLinkLabel ?? "Open", onClick: second } } : {}),
            }
          : undefined;
      const title = intent.title || intent.body;
      if (intent.level === "error") toast.error(title, opts);
      else if (intent.level === "warning") toast.warning(title, opts);
      else toast.info(title, opts);
      break;
    }
    case "showView":
      if (intent.threadId) {
        // A panel action scoped to one thread (a view.panel.* verb run inside it): the
        // window does not move, so a pending focus stays pending too.
        showThreadView(intent.name, intent.threadId, intent.params);
        break;
      }
      clearPendingFocus();
      showView(intent.name);
      break;
    case "playAlertSound":
      // notifications.test: a preview, whatever the focus, cooldown and sound toggle.
      void playAlertSound(intent.volume);
      break;
    case "invokeCommand":
      // A plugin asked (host/invoke, confirm "ask"): the normal flow, the daemon's confirm text included.
      void runCommandForResult(intent.name, intent.args, { ctx: intent.context ?? getUiContext(), caller: callerName(intent.caller) });
      break;
    case "showAgentRun":
      // thread.agent.open: the thread selected, one of its runs shown read-only.
      clearPendingFocus();
      showAgentRun(intent.threadId, intent.runId);
      break;
    case "stageComposer":
      // composer.stage: text in the thread's composer, not sent, where the window shows it.
      stageInThreadComposer(intent.threadId, intent.text);
      break;
  }
}
