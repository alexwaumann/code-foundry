import { useEffect, useMemo, useRef } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { eventRowMatches, moreEventRows, type EventRow } from "@/lib/snoozeEvents";
import { closeSnoozeEventPicker, snoozeThreadUntilEvent, useSnoozeEventPickerStore, useSnoozeEvents } from "@/stores/snoozeEvents";
import { useThreadsStore } from "@/stores/threads";
import { SnoozeEventIcon } from "./SnoozeEventIcon";

/** The filter's placeholder. */
export const EVENT_FILTER = "Snooze until…";

/** Rows by group, in order. */
function groupsOf(rows: readonly EventRow[]): [string, EventRow[]][] {
  const out = new Map<string, EventRow[]>();
  for (const r of rows) out.set(r.group, [...(out.get(r.group) ?? []), r]);
  return [...out];
}

/**
 * The list: every event the thread can wait on now (lib/snoozeEvents.ts moreEventRows), grouped
 * by pull request then Plugins, checked in Settings or not. Typing filters on the words of each
 * row ("812 merged", "deploy"); Enter or a click snoozes until it (thread.snooze).
 */
function EventList({ threadId, inView }: { threadId: string; inView: boolean }) {
  const evs = useSnoozeEvents(threadId);
  const rows = useMemo(() => (evs ? moreEventRows(evs) : []), [evs]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <Command
      loop
      label="Snooze until an event"
      className="rounded-lg"
      data-testid="snooze-event-picker"
      filter={(value, search) => {
        const row = byKey.get(value);
        return row && eventRowMatches(row, search) ? 1 : 0;
      }}
    >
      <CommandInput ref={input} placeholder={EVENT_FILTER} data-testid="snooze-event-filter" />
      <CommandList className="max-h-80 p-1">
        <CommandEmpty>{evs === undefined ? "Loading…" : "No event matches."}</CommandEmpty>
        {groupsOf(rows).map(([group, items]) => (
          <CommandGroup key={group} heading={group}>
            {items.map((r) => (
              <CommandItem
                key={r.key}
                value={r.key}
                data-testid="snooze-event-row"
                data-event={r.key}
                className="gap-2"
                onSelect={() => {
                  closeSnoozeEventPicker();
                  void snoozeThreadUntilEvent(threadId, r.pick, { inView });
                }}
              >
                <SnoozeEventIcon kind={r.pick.kind} className="size-3.5 shrink-0 text-cf-text-muted" />
                <span className="truncate">{r.label}</span>
                {r.hint && <span className="ml-auto shrink-0 pl-3 text-caption text-cf-text-muted">{r.hint}</span>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}

/** More events… from the Until event menu (stores/snoozeEvents.ts). */
export function SnoozeEventPicker() {
  const open = useSnoozeEventPickerStore((s) => s.open);
  const threadId = useSnoozeEventPickerStore((s) => s.threadId);
  const inView = useSnoozeEventPickerStore((s) => s.inView);
  const seq = useSnoozeEventPickerStore((s) => s.seq);
  const name = useThreadsStore((s) => s.byId[threadId]?.name ?? "");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeSnoozeEventPicker();
      }}
    >
      <DialogContent className="max-w-[420px] gap-2 p-0" data-testid="snooze-event-dialog" data-thread={threadId}>
        <DialogTitle className="truncate px-4 pt-4">{`Snooze “${name || threadId}” until…`}</DialogTitle>
        <DialogDescription className="sr-only">Pick the event that brings the thread back to the list.</DialogDescription>
        {open && <EventList key={seq} threadId={threadId} inView={inView} />}
      </DialogContent>
    </Dialog>
  );
}
