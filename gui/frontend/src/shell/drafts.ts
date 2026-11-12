/**
 * The sidebar's draft rows (docs/notes/shell-model.md, "The composer > Drafts"): a click focuses
 * the draft's tab, or opens it in its space's focused pane when its tab is closed
 * (composer.draft.open); the row's Discard ends it and closes its tab (composer.draft.discard).
 * Both are the PR 4 verbs (internal/command commands_composer_drafts.go), run quietly.
 * See docs/notes/shell-16-sidebar.md.
 */
import { requestPaneFocus } from "@/stores/shellView";
import { afterRev, runLayoutCommand } from "./commands";

/** Focuses or opens a draft's tab, with the keyboard following into its composer. */
export async function openDraft(id: string): Promise<void> {
  const res = await runLayoutCommand("composer.draft.open", { draft: id, focus: "true" });
  if (!res) return;
  await afterRev(res.rev);
  if (res.pane) requestPaneFocus(res.pane);
}

/** Ends a draft: it leaves the list and its tab, when open, closes. */
export async function discardDraft(id: string): Promise<void> {
  const res = await runLayoutCommand("composer.draft.discard", { draft: id });
  if (res) await afterRev(res.rev);
}
