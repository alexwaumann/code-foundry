/**
 * Kept apart from stores/threadInfo so the key bindings and views reach it without the
 * card's stores (and what those import).
 */
import { create } from "zustand";
import { runCommandForResult } from "./commands";
import { useLayoutStore } from "./layout";
import { useSettingsStore, useSettingValue } from "./settings";
import { useUiStore } from "./ui";

/** The setting for a thread whose card was never toggled (docs/notes/shell-model.md, "Thread info is per thread"). */
export const THREAD_INFO_KEY = "layout.thread_info";

/** The setting's value: shown unless it says "false". */
function infoDefault(v: string | undefined): boolean {
  return v !== "false";
}

/**
 * Whether a thread shows its info card: its own choice, kept in the layout with the thread
 * (thread.info), else the setting layout.thread_info (shown by default).
 */
export function useThreadInfoOpen(threadId: string | null): boolean {
  const own = useLayoutStore((s) => (threadId === null ? null : (s.threads[threadId]?.info ?? null)));
  const byDefault = infoDefault(useSettingValue(THREAD_INFO_KEY));
  return own ?? byDefault;
}

/** useThreadInfoOpen read now. */
export function threadInfoOpen(threadId: string): boolean {
  return useLayoutStore.getState().threads[threadId]?.info ?? infoDefault(useSettingsStore.getState().snapshot?.values[THREAD_INFO_KEY]);
}

/** Shows or hides one thread's card, kept with the thread (thread.info). */
function setThreadInfo(threadId: string, open: boolean): void {
  void runCommandForResult("thread.info", { id: threadId, [open ? "open" : "close"]: "true" }, { quiet: true });
}

/**
 * Where the card shows in this window (docs/notes/thread-info-overlay.md): whether the thread
 * body on screen has room for the inline card (lib/threadInfo cardFits, as ThreadPane
 * measures it), and while it has none, the thread whose card floats over its conversation
 * (`overlayFor`). The overlay is transient: never saved, and each thread's own choice
 * (useThreadInfoOpen) stays the preference for its inline card. `focusOverlay`: opened from the
 * keyboard, it takes focus.
 *
 * The window shell shows several thread panes at once, each as wide as its pane: `rooms` is each
 * thread body's own measure (a thread has one tab, so its id names its pane), and `room` the last
 * one reported, which a body that names no thread (and the classic window, with one) reads.
 */
export const useCardRoom = create<{ room: boolean; rooms: Readonly<Record<string, boolean>>; overlayFor: string | null; focusOverlay: boolean }>()(() => ({
  room: true,
  rooms: {},
  overlayFor: null,
  focusOverlay: false,
}));

/** Whether the body showing `threadId` has room for the inline card. */
export function roomFor(s: { room: boolean; rooms: Readonly<Record<string, boolean>> }, threadId: string | null): boolean {
  return (threadId === null ? undefined : s.rooms[threadId]) ?? s.room;
}

/** A thread body measured its room (`threadId`: whose; none for the window's one body). */
export function setCardRoom(room: boolean, threadId = ""): void {
  const st = useCardRoom.getState();
  if (st.room === room && (!threadId || st.rooms[threadId] === room)) return;
  const rooms = threadId ? { ...st.rooms, [threadId]: room } : st.rooms;
  // With room again the inline card (when on) takes that thread's overlay's place.
  const clears = room && (!threadId || st.overlayFor === threadId);
  useCardRoom.setState(clears ? { room, rooms, overlayFor: null } : { room, rooms });
}

/** A thread body went away: forget its measure. */
export function dropCardRoom(threadId: string): void {
  const st = useCardRoom.getState();
  if (!(threadId in st.rooms)) return;
  const { [threadId]: _gone, ...rooms } = st.rooms;
  useCardRoom.setState({ rooms });
}

/** Hides the overlay; the thread's own choice is left alone. */
export function hideThreadInfoOverlay(): void {
  if (useCardRoom.getState().overlayFor !== null) useCardRoom.setState({ overlayFor: null });
}

/**
 * Shows the thread's card: turns its inline card on and, while the pane has no room for it,
 * floats it over the conversation (the sidebar's linked PRs tag; view.thread-info when off).
 */
export function showThreadInfo(threadId: string, focus = false): void {
  if (!threadInfoOpen(threadId)) setThreadInfo(threadId, true);
  if (!roomFor(useCardRoom.getState(), threadId)) useCardRoom.setState({ overlayFor: threadId, focusOverlay: focus });
}

/**
 * view.thread-info, for the focused thread only: with room, toggles its inline card (thread.info,
 * kept with the thread); without, shows or hides its overlay, turning its inline card on when it
 * shows so the card is there when the pane widens. `focus` moves focus into a shown overlay.
 * Nothing without a focused thread.
 */
export function toggleThreadInfo(focus = false): void {
  const sel = useUiStore.getState().selection;
  const threadId = sel.kind === "thread" ? sel.id : null;
  if (threadId === null) return;
  const st = useCardRoom.getState();
  const { overlayFor } = st;
  if (roomFor(st, threadId)) {
    setThreadInfo(threadId, !threadInfoOpen(threadId));
  } else if (overlayFor === threadId) {
    hideThreadInfoOverlay();
  } else {
    showThreadInfo(threadId, focus);
  }
}
