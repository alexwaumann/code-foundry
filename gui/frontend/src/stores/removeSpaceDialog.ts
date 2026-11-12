/**
 * The remove space dialog (components/shell/RemoveSpaceDialog.tsx, docs/notes/shell-model.md
 * "Structure"): which space it removes. The dialog runs space.remove itself; it adds no user
 * action of its own. See docs/notes/shell-15-spaces.md.
 */
import { create } from "zustand";

interface RemoveSpaceDialogState {
  /** The space asked about; "" when the dialog is closed. */
  spaceId: string;
  /** Incremented on every open, so the dialog's choices start fresh. */
  seq: number;
}

export const useRemoveSpaceDialogStore = create<RemoveSpaceDialogState>()(() => ({ spaceId: "", seq: 0 }));

/** Opens the dialog for a space, after the menu that asked has closed and handed back the focus. */
export function openRemoveSpaceDialog(spaceId: string): void {
  queueMicrotask(() => {
    useRemoveSpaceDialogStore.setState((s) => ({ spaceId, seq: s.seq + 1 }));
  });
}

export function closeRemoveSpaceDialog(): void {
  useRemoveSpaceDialogStore.setState({ spaceId: "" });
}
