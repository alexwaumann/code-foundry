/**
 * Kept apart from stores/threadInfo so the key bindings and views reach it without the
 * card's stores (and what those import).
 */
import { create } from "zustand";
import { useUiStore } from "./ui";

/**
 * Where the card shows in this window (docs/notes/thread-info-overlay.md): whether the thread
 * body on screen has room for the inline card (lib/threadInfo cardFits, as ThreadPane
 * measures it), and while it has none, the thread whose card floats over its conversation
 * (`overlayFor`). The overlay is transient: never saved, and threadInfoOpen stays the
 * preference for the inline card. `focusOverlay`: opened from the keyboard, it takes focus.
 */
export const useCardRoom = create<{ room: boolean; overlayFor: string | null; focusOverlay: boolean }>()(() => ({
  room: true,
  overlayFor: null,
  focusOverlay: false,
}));

export function setCardRoom(room: boolean): void {
  if (useCardRoom.getState().room === room) return;
  // With room again the inline card (when on) takes the overlay's place.
  useCardRoom.setState(room ? { room, overlayFor: null } : { room });
}

/** Hides the overlay; threadInfoOpen is left alone. */
export function hideThreadInfoOverlay(): void {
  if (useCardRoom.getState().overlayFor !== null) useCardRoom.setState({ overlayFor: null });
}

/**
 * Shows the thread's card: turns the inline card on and, while the pane has no room for it,
 * floats it over the conversation (the sidebar's linked PRs tag; view.thread-info when off).
 */
export function showThreadInfo(threadId: string, focus = false): void {
  if (!useUiStore.getState().threadInfoOpen) useUiStore.setState({ threadInfoOpen: true });
  if (!useCardRoom.getState().room) useCardRoom.setState({ overlayFor: threadId, focusOverlay: focus });
}

/**
 * view.thread-info: with room, toggles the inline card (threadInfoOpen); without, shows or
 * hides the selected thread's overlay, turning the inline card on when it shows so the card
 * is there when the pane widens. `focus` moves focus into a shown overlay.
 */
export function toggleThreadInfo(focus = false): void {
  const sel = useUiStore.getState().selection;
  const threadId = sel.kind === "thread" ? sel.id : null;
  const { room, overlayFor } = useCardRoom.getState();
  if (room || threadId === null) {
    useUiStore.getState().toggleThreadInfo();
  } else if (overlayFor === threadId) {
    hideThreadInfoOverlay();
  } else {
    showThreadInfo(threadId, focus);
  }
}
