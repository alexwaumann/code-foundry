import { useState } from "react";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useNow } from "@/lib/clock";
import { addDays, compareDays, dayOf, formatDay, monthGrid, monthTitle, parseTimeValue, sameDay, shiftMonth, SNOOZE_HOUR, wallTime, type Day } from "@/lib/snooze";
import { cn } from "@/lib/utils";
import { snoozeThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { closeSnoozeDialog, useSnoozeDialogStore } from "@/stores/snoozeDialog";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const DEFAULT_TIME = `${String(SNOOZE_HOUR).padStart(2, "0")}:00`;

/**
 * The month calendar: prev / next month (not before this month), Sunday-first weeks with
 * the neighbouring months' days muted, today outlined, the selected day filled, past days
 * disabled. Picking a day of another month shows that month.
 */
function Calendar({ now, selected, onSelect }: { now: number; selected: Day; onSelect: (d: Day) => void }) {
  const today = dayOf(now);
  const [view, setView] = useState({ year: selected.year, month: selected.month });
  const atFirst = view.year === today.year && view.month === today.month;
  const nav = (by: 1 | -1) => {
    setView((v) => shiftMonth(v.year, v.month, by));
  };
  return (
    <div className="flex flex-col gap-2" data-testid="snooze-calendar">
      <div className="flex items-center">
        <span className="text-label" data-testid="snooze-month">
          {monthTitle(view.year, view.month)}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Previous month"
            disabled={atFirst}
            onClick={() => {
              nav(-1);
            }}
            data-testid="snooze-prev-month"
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Next month"
            onClick={() => {
              nav(1);
            }}
            data-testid="snooze-next-month"
          >
            <ChevronRight />
          </Button>
        </span>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center" role="grid" aria-label={monthTitle(view.year, view.month)}>
        {WEEKDAYS.map((w) => (
          <span key={w} className="py-1 text-caption-sm" role="columnheader">
            {w}
          </span>
        ))}
        {monthGrid(view.year, view.month)
          .flat()
          .map((d) => {
            const past = compareDays(d, today) < 0;
            const outside = d.month !== view.month;
            const isSelected = sameDay(d, selected);
            const isToday = sameDay(d, today);
            return (
              <button
                key={`${String(d.year)}-${String(d.month)}-${String(d.day)}`}
                type="button"
                role="gridcell"
                disabled={past}
                aria-selected={isSelected}
                aria-label={formatDay(d, now)}
                data-day={`${String(d.year)}-${String(d.month + 1).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`}
                data-today={isToday || undefined}
                className={cn(
                  "h-7 rounded-md border border-transparent text-body-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-35",
                  isSelected ? "bg-primary font-medium text-primary-foreground" : "hover:bg-accent",
                  isToday && !isSelected && "border-border",
                  outside && !isSelected && "text-muted-foreground",
                )}
                onClick={() => {
                  onSelect(d);
                  if (outside) setView({ year: d.year, month: d.month });
                }}
              >
                {d.day}
              </button>
            );
          })}
      </div>
    </div>
  );
}

/**
 * The dialog's body for one thread: the calendar (tomorrow selected), a time (9:00 AM),
 * the chosen day spelled out, Cancel and Snooze. Snooze is disabled while the chosen time
 * is not in the future; it invokes session.snooze with the absolute time (the daemon
 * confirms only mid-turn).
 */
function SnoozeBody({ threadId }: { threadId: string }) {
  const now = useNow(30_000);
  const [day, setDay] = useState<Day>(() => addDays(dayOf(Date.now()), 1));
  const [time, setTime] = useState(DEFAULT_TIME);
  const parsed = parseTimeValue(time);
  const untilMs = parsed ? wallTime(day, parsed.hour, parsed.minute) : null;
  const ready = untilMs !== null && untilMs > now;
  const submit = () => {
    if (!ready) return;
    closeSnoozeDialog();
    void snoozeThread(threadId, untilMs);
  };
  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Calendar now={now} selected={day} onSelect={setDay} />
      <div className="flex items-center gap-3">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Clock className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden />
          <Input
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
            }}
            aria-label="Time"
            className="pl-8 tabular-nums"
            data-testid="snooze-time"
          />
        </div>
        <span className={cn("shrink-0 text-caption tabular-nums", untilMs !== null && !ready ? "text-destructive" : "text-muted-foreground")} data-testid="snooze-summary">
          {untilMs !== null && !ready ? "In the past" : formatDay(day, now)}
        </span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={closeSnoozeDialog}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!ready} data-testid="snooze-submit">
          Snooze
        </Button>
      </div>
    </form>
  );
}

/** "Pick a date and time…" from the snooze menus (stores/snoozeDialog.ts). */
export function SnoozeDialog() {
  const open = useSnoozeDialogStore((s) => s.open);
  const threadId = useSnoozeDialogStore((s) => s.threadId);
  const seq = useSnoozeDialogStore((s) => s.seq);
  const name = useThreadsStore((s) => s.byId[threadId]?.name ?? "");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeSnoozeDialog();
      }}
    >
      <DialogContent className="max-w-[300px] p-4" data-testid="snooze-dialog" data-session={threadId}>
        <DialogTitle className="truncate">Snooze “{name || threadId}”</DialogTitle>
        <DialogDescription className="sr-only">Pick the day and time the thread comes back to the list.</DialogDescription>
        {open && <SnoozeBody key={seq} threadId={threadId} />}
      </DialogContent>
    </Dialog>
  );
}
