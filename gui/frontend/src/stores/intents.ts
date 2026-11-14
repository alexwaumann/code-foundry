import { toast } from "sonner";
import { playAlertSound } from "@/api/app";
import type { UiIntentView } from "@/api/ui";
import { threadFocus } from "@/lib/inSidebar";
import { stageInThreadComposer } from "./composerText";
import { runCommandForResult } from "./commands";
import { getUiContext } from "./context";
import { notifyLinkAction, showingPage } from "./notifyLinks";
import { usePluginsStore } from "./plugins";
import { showAgentRun } from "./subagentView";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";
import { showView } from "./views";
import { showProjectOnProjectsPage } from "./projectsPage";
import { followFocusTerminal } from "@/shell/terminalActions";

/** How long a focusThread intent waits for its thread to arrive. */
export const PENDING_FOCUS_MS = 10_000;

/**
 * A focusThread intent whose thread the list did not have yet (the intent and the list
 * event arrive separately): decided once the thread arrives (threadFocus), within
 * PENDING_FOCUS_MS. Dropped by the next intent that moves the window and by any change of
 * selection.
 */
let pendingThread: { id: string; stop: () => void } | null = null;

/** Forgets a pending focusThread. Exported for tests too. */
export function clearPendingFocus(): void {
  pendingThread?.stop();
  pendingThread = null;
}

// A selection change (the user's, or a resolved reveal's) ends the wait.
useUiStore.subscribe((s, prev) => {
  if (s.selection !== prev.selection && pendingThread !== null) clearPendingFocus();
});

/**
 * Shows a thread the daemon asked to focus (thread.new, thread.fork, pr.*, thread.focus),
 * unless a non-explicit intent names a thread hidden from the sidebar (lib/inSidebar.ts
 * threadFocus): an agent creating its children must not take the user's view. An
 * `explicit` one (thread.focus, a view.panel.* verb's --focus) selects it anyway. One not
 * in the list yet is decided when it arrives.
 */
function focusThread(id: string, explicit: boolean): void {
  clearPendingFocus();
  const decide = (): boolean => {
    const byId = useThreadsStore.getState().byId;
    const d = threadFocus(byId[id], byId, explicit);
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
      // The layout shows the terminal (ui.focus.terminal's tab, with the focus); the keyboard follows it.
      followFocusTerminal(intent.terminalId);
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
      // The item verbs (view.open.*) send none: their tab in the layout is the whole effect
      // (docs/notes/shell-22-retire-verbs.md).
      clearPendingFocus();
      showView(intent.name, intent.params);
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
