/**
 * Snoozing a thread until an event (docs/notes/snooze-until-event.md): reading what the
 * thread can wait on (thread.snooze.events), snoozing until one (thread.snooze --until-pr /
 * --until-plugin), and which thread's More events picker is open. No user action of its own:
 * every pick is thread.snooze.
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { parseSnoozeEvents, type SnoozeEventsView } from "@/api/snoozeEvents";
import { snoozeEventArgs, type SnoozeEventPick } from "@/lib/snoozeEvents";
import { runCommand, runCommandForResult, type CommandSource } from "./commands";
import { THREAD_COMMANDS, threadContext } from "./threadActions";

/** The read the menus and the picker make. */
export const SNOOZE_EVENTS_COMMAND = "thread.snooze.events";

/** What thread id can be snoozed until now; null when the read failed (the menus then offer nothing). Quiet: a menu says nothing about it. */
export async function fetchSnoozeEvents(id: string): Promise<SnoozeEventsView | null> {
  const res = await runCommandForResult(SNOOZE_EVENTS_COMMAND, { id }, { ctx: threadContext(id), quiet: true, expected: () => true });
  return res ? parseSnoozeEvents(res.resultJson) : null;
}

/** fetchSnoozeEvents once per mount (a menu mounts as it opens): undefined while it loads. */
export function useSnoozeEvents(id: string): SnoozeEventsView | null | undefined {
  const [evs, setEvs] = useState<SnoozeEventsView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void fetchSnoozeEvents(id).then((v) => {
      if (live) setEvs(v);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return evs;
}

/** thread.snooze until the event picked; the row leaves for Snoozed, so a success toast only when it is not in view, as the time presets. */
export function snoozeThreadUntilEvent(id: string, pick: SnoozeEventPick, source: CommandSource = {}): Promise<boolean> {
  return runCommand(THREAD_COMMANDS.snooze, snoozeEventArgs(pick), threadContext(id), source);
}

interface SnoozeEventPickerState {
  open: boolean;
  threadId: string;
  /** Whether the thread's row is on screen (the menu's inView): no success toast then. */
  inView: boolean;
  /** Incremented on every open, so the picker's body starts fresh. */
  seq: number;
}

export const useSnoozeEventPickerStore = create<SnoozeEventPickerState>()(() => ({ open: false, threadId: "", inView: true, seq: 0 }));

/**
 * Opens More events for a thread. Deferred two frames, as the move picker is, so the menu that
 * picked it finishes closing and handing focus back before the dialog's filter takes it (a
 * menu's focus return landing after would leave the filter without the keyboard).
 */
export function openSnoozeEventPicker(threadId: string, inView = true): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      useSnoozeEventPickerStore.setState((s) => ({ open: true, threadId, inView, seq: s.seq + 1 }));
    });
  });
}

export function closeSnoozeEventPicker(): void {
  useSnoozeEventPickerStore.setState({ open: false });
}
