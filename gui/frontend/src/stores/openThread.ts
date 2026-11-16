import { useUiStore } from "./ui";

/**
 * Opens a thread from a sidebar row, a Needs you card or popup, or a notification's thread link:
 * selects it (its tab focused or opened in the focused pane; the selection bridge runs
 * `thread.open --focus`) with the keyboard in its prompt. `preview` (an Archived or Snoozed
 * thread) opens it as the space's preview tab (docs/notes/shell-model.md, "Preview tabs").
 */
export function openThread(threadId: string, opts: { preview?: boolean } = {}): void {
  useUiStore.getState().select({ kind: "thread", id: threadId }, opts.preview ? { focusPrompt: true, preview: true } : { focusPrompt: true });
}
