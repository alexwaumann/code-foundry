/**
 * The move picker (components/thread/MovePicker.tsx): a popover under a No project
 * thread's header crumb that moves the thread into a project or a workspace
 * (docs/notes/move-no-project-2-gui.md). This store says which thread's picker is open
 * and which moves this window has sent and not heard back from; Move invokes thread.move.
 * The palette reaches it through thread.move.open (keys/bindings.ts), the CLI's through
 * ShowView "thread.move" (stores/views.ts), the menus through openMovePicker.
 */
import { create } from "zustand";
import { toast } from "sonner";
import { canMove } from "@/lib/move";
import { runCommandForResult } from "./commands";
import { useProjectsStore } from "./projects";
import { getUiContext } from "./context";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";

export const MOVE_COMMAND = "thread.move";

interface MovePickerState {
  /** The thread whose picker is open under its crumb; null when none is. */
  open: string | null;
  /** Moves sent from this window and not answered yet: thread id → where it goes, by name (the crumb's "Moving to …" until the thread's pending_move arrives). */
  sending: Readonly<Record<string, string>>;
}

export const useMovePickerStore = create<MovePickerState>()(() => ({ open: null, sending: {} }));

/** Whether the picker may open for the thread now (lib/move canMove over the stores). */
export function canMoveThread(threadId: string): boolean {
  return canMove(useThreadsStore.getState().byId[threadId], useProjectsStore.getState());
}

/**
 * Opens the picker under the thread's crumb, selecting the thread first when the window
 * shows something else (its prompt does not take the keyboard: the picker's filter
 * does). Deferred two frames so a menu or the palette that asked finishes closing and
 * handing focus back before the popover takes it (a focus landing outside would close it).
 * False when the thread cannot move (canMove), so a command falls back to its default.
 */
export function openMovePicker(threadId: string): boolean {
  if (!canMoveThread(threadId)) return false;
  const ui = useUiStore.getState();
  if (ui.selection.kind !== "thread" || ui.selection.id !== threadId) ui.select({ kind: "thread", id: threadId });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (canMoveThread(threadId)) useMovePickerStore.setState({ open: threadId });
    });
  });
  return true;
}

export function closeMovePicker(threadId?: string): void {
  useMovePickerStore.setState((s) => (threadId === undefined || s.open === threadId ? { open: null } : s));
}

/**
 * Moves the thread: closes the picker, shows "Moving to <name>…" in the crumb until the
 * daemon answers (its pending_move takes over from there), then invokes thread.move with
 * `args` (lib/move moveArgs). A refusal is the usual failure toast with the daemon's words
 * and the thread stays where it was; the daemon's collision hints are toasted as
 * warnings, as after a new thread. Resolves whether the call succeeded.
 */
export async function moveThread(threadId: string, args: Record<string, string>, name: string): Promise<boolean> {
  useMovePickerStore.setState((s) => ({ open: s.open === threadId ? null : s.open, sending: { ...s.sending, [threadId]: name } }));
  try {
    const res = await runCommandForResult(MOVE_COMMAND, args, { ctx: getUiContext({ kind: "thread", id: threadId }), quiet: true });
    for (const w of res?.warnings ?? []) toast.warning(w);
    return res !== null;
  } finally {
    useMovePickerStore.setState((s) => {
      const { [threadId]: _done, ...rest } = s.sending;
      return { sending: rest };
    });
  }
}
