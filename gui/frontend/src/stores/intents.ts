import { toast } from "sonner";
import type { UiIntentView } from "@/api/ui";
import { sessionOfTerminal, useSessionsStore } from "./sessions";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";
import { showView } from "./views";
import { showWorktreeOnProjectsPage } from "./worktreePanel";

/** Applies one UI intent (delivered on the shared events stream) to the GUI. */
export function applyIntent(intent: UiIntentView): void {
  const ui = useUiStore.getState();
  switch (intent.kind) {
    case "focusTerminal": {
      // A session's terminal is shown through its session row.
      const t = useTerminalsStore.getState().byId[intent.terminalId];
      const session = sessionOfTerminal(useSessionsStore.getState(), t ?? { id: intent.terminalId, labels: {} });
      if (session) ui.select({ kind: "session", id: session.id }, { focusTerminal: true });
      else ui.select({ kind: "terminal", id: intent.terminalId }, { focusTerminal: true });
      break;
    }
    case "focusSession":
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
      showView(intent.name);
      break;
  }
}
