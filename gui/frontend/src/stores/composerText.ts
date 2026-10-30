/**
 * Text for a thread's composer from elsewhere in the app, not sent: a page strip's "Ask
 * Claude" (components/files/PageErrors.tsx), and composer.stage from a page or the CLI
 * (UiIntent.StageComposer). It goes after what the draft already holds, and the thread's
 * prompt takes focus, so the user reads it, edits it and sends it themselves.
 */
import { getDraft, updateDraft } from "./compose";
import { threadDraftKey } from "./threadActions";
import { useUiStore } from "./ui";

/** Puts text in threadId's composer, after any draft, and focuses its prompt. */
export function putInThreadComposer(threadId: string, text: string): void {
  const key = threadDraftKey(threadId);
  const cur = getDraft(key).text.trimEnd();
  updateDraft(key, { text: cur ? `${cur}\n\n${text}` : text, error: null });
  const ui = useUiStore.getState();
  if (ui.selection.kind === "thread" && ui.selection.id === threadId) useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
  else ui.select({ kind: "thread", id: threadId }, { focusPrompt: true });
}

/**
 * composer.stage (UiIntent.StageComposer): puts text in threadId's composer when this
 * window shows the thread, replacing an empty draft, else on a new line after it, and
 * focuses its prompt. A window showing something else leaves the thread alone (the
 * daemon sends it only while some window shows the thread). False when it did nothing.
 */
export function stageInThreadComposer(threadId: string, text: string): boolean {
  const ui = useUiStore.getState();
  if (ui.selection.kind !== "thread" || ui.selection.id !== threadId) return false;
  const key = threadDraftKey(threadId);
  const cur = getDraft(key).text.trimEnd();
  updateDraft(key, { text: cur ? `${cur}\n${text}` : text, error: null });
  useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
  return true;
}
