import type { ThreadView } from "@/api/threads";
import { createdUnder, inSidebar } from "@/lib/inSidebar";
import { isSnoozed } from "@/lib/snooze";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";

/** The fields previewOnOpen reads of a thread. */
type PreviewFields = Pick<ThreadView, "id" | "createdBy" | "archivedAtMs" | "snoozedUntilMs" | "savedAtMs">;

/**
 * Whether the user's click opens a thread as its space's preview tab (docs/notes/shell-model.md,
 * "Preview tabs"): an archived or snoozed (or saved) thread, or a child, which another thread
 * created and its lead manages (lib/inSidebar: its creator still exists). `from` is the thread
 * the click is in: a thread that created it (its lead, further up) opens as a kept tab, as the
 * parent links do. An unknown thread (not listed yet) opens kept.
 */
export function previewOnOpen(byId: Readonly<Record<string, PreviewFields>>, threadId: string, from = ""): boolean {
  const t = byId[threadId];
  if (t === undefined) return false;
  if (t.archivedAtMs !== null || isSnoozed(t)) return true;
  if (inSidebar(t, byId)) return false;
  return !(from !== "" && createdUnder(byId, from, threadId));
}

/** How openThread opens a thread. */
export interface OpenThreadOptions {
  /** As the space's preview tab or not; absent: previewOnOpen decides from the thread. */
  preview?: boolean;
  /** The keyboard goes to its prompt (default true); false for an open that hands it to a find bar. */
  focusPrompt?: boolean;
  /** The thread the click is in (previewOnOpen's `from`). */
  from?: string;
}

/**
 * Opens a thread from the user's click in the window (a sidebar row, a lineage row, a search
 * hit, a Needs you card, a notification's link, a wake note): selects it (its tab focused or
 * opened in the focused pane; the selection bridge runs `thread.open --focus`, with `--preview`
 * when previewOnOpen says so) with the keyboard in its prompt. The one place that decides which
 * clicks open a preview; a thread that already has a kept tab is focused there either way.
 */
export function openThread(threadId: string, opts: OpenThreadOptions = {}): void {
  const preview = opts.preview ?? previewOnOpen(useThreadsStore.getState().byId, threadId, opts.from);
  const focusPrompt = opts.focusPrompt ?? true;
  useUiStore.getState().select({ kind: "thread", id: threadId }, preview ? { focusPrompt, preview: true } : { focusPrompt });
}
