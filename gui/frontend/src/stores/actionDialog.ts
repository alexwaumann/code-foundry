/**
 * The action editor (components/actions/ActionDialog.tsx) and the failed setup run's
 * output (components/actions/ActionRunDialog.tsx): which one is open and for what. The
 * dialogs save and delete through the action.add / action.edit / action.remove registry
 * commands (stores/actionActions.ts); they add no user action of their own.
 */
import { create } from "zustand";

export type ActionEditorTarget =
  /** A new action for project `projectId`; `from` words the description (a thread's header or the Projects page). */
  | { mode: "new"; projectId: string; from: "thread" | "projects" }
  /** An existing action. */
  | { mode: "edit"; actionId: string; projectId: string; from: "thread" | "projects" };

interface ActionDialogState {
  editor: ActionEditorTarget | null;
  /** The failed setup run whose output is showing (a toast's Open), by run id, and its action's name. */
  runId: string | null;
  runName: string;
  /** Incremented on every open, so a dialog's body starts fresh. */
  seq: number;
}

export const useActionDialogStore = create<ActionDialogState>()(() => ({ editor: null, runId: null, runName: "", seq: 0 }));

/**
 * Opens the editor. Deferred, so the menu that picked "New action…" or a pencil finishes
 * closing (and handing focus back) before the dialog takes it.
 */
export function openActionEditor(target: ActionEditorTarget): void {
  queueMicrotask(() => {
    useActionDialogStore.setState((s) => ({ editor: target, seq: s.seq + 1 }));
  });
}

export function closeActionEditor(): void {
  useActionDialogStore.setState({ editor: null });
}

export function openActionRunOutput(runId: string, runName: string): void {
  useActionDialogStore.setState((s) => ({ runId, runName, seq: s.seq + 1 }));
}

export function closeActionRunOutput(): void {
  useActionDialogStore.setState({ runId: null });
}
