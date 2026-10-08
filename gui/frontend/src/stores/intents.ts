import { create } from "zustand";
import { toast } from "sonner";
import { invalidateOnTransportError } from "@/api/endpoint";
import { runStream, type StreamStatus } from "@/api/stream";
import { watchIntents, type UiIntentView } from "@/api/ui";
import { useUiStore } from "./ui";

interface IntentsState {
  stream: StreamStatus;
  streamError: string | null;
}

export const useIntentsStore = create<IntentsState>()(() => ({ stream: "connecting", streamError: null }));

/** Applies one UiService intent to the GUI. */
export function applyIntent(intent: UiIntentView): void {
  const ui = useUiStore.getState();
  switch (intent.kind) {
    case "focusTerminal":
      ui.select({ kind: "terminal", id: intent.terminalId }, { focusTerminal: true });
      break;
    case "focusRepo":
      if (intent.worktreePath) ui.select({ kind: "worktree", repoId: intent.repoId, path: intent.worktreePath });
      else ui.select({ kind: "repo", repoId: intent.repoId });
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
  }
}

export function startIntentWatch(): () => void {
  return runStream({
    open: (signal) => watchIntents(signal),
    onEvent: applyIntent,
    onStatus: (stream, err) => {
      useIntentsStore.setState({ stream, streamError: err ?? null });
    },
    onError: invalidateOnTransportError,
  });
}
