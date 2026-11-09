import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tip } from "@/components/ui/tooltip";
import { useNowSelect } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { addMonths, clampDate, formatDay, formatDayLong, inMonth, inRange, isIsoDate, monthGrid, monthTitle, moveFocus, parseIso, quickPicks, toIso, todayIso, weekdayNames, weekdayShort, weekStartOf } from "./date";

export interface DateControlProps {
  id: string;
  /** An ISO date, or "" for none. */
  value: string;
  min?: string;
  max?: string;
  placeholder?: string;
  disabled: boolean;
  invalid: boolean;
  required?: boolean;
  name: string;
  /** The user picked a day ("" is Clear). */
  onPick: (iso: string) => void;
  /** The browser's locale when absent (tests pin one). */
  locale?: string;
}

/**
 * A date field (pluginsdk/ui InputDate): a trigger showing the day short with a calendar
 * icon over a popover month calendar in the snooze calendar's look (today outlined, the
 * picked day filled, the neighbouring months' days muted, days outside min..max disabled),
 * the week starting where the locale starts it, and quick picks Today, Tomorrow, next
 * Monday and Clear. In the grid the arrows move a day or a week, Page Up and Page Down a
 * month, Home and End to the week's ends, Enter or Space picks; a pick closes the popover
 * and Escape closes it, both back to the trigger.
 */
export function DateControl({ id, value, min, max, placeholder, disabled, invalid, required, name, onPick, locale }: DateControlProps) {
  const [open, setOpen] = useState(false);
  const shown = isIsoDate(value) ? value : "";
  // Today moves at midnight while the panel is open.
  const today = useNowSelect(60_000, (now) => todayIso(new Date(now)));
  const label = shown ? formatDay(shown, today, locale) : placeholder || "No date";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          className={cn(
            "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-cf-input bg-transparent px-2.5 py-1 text-body-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-cf-focus focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-cf-error aria-invalid:ring-cf-error/20 dark:bg-cf-input/30 dark:hover:bg-cf-input/50 dark:aria-invalid:ring-cf-error/40",
            !shown && "text-cf-text-muted",
          )}
          data-testid="plugin-date"
          data-name={name}
          data-value={shown || undefined}
        >
          <CalendarDays className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-cf-text-muted opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-64 p-2"
        onOpenAutoFocus={(e) => {
          // The grid focuses its day itself.
          e.preventDefault();
        }}
        data-testid="plugin-date-popover"
      >
        {open && (
          <Calendar
            value={shown}
            today={today}
            min={min}
            max={max}
            locale={locale}
            onPick={(iso) => {
              setOpen(false);
              if (iso !== shown) onPick(iso);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function Calendar({ value, today, min, max, locale, onPick }: { value: string; today: string; min?: string; max?: string; locale?: string; onPick: (iso: string) => void }) {
  const weekStart = useMemo(() => weekStartOf(locale), [locale]);
  const names = useMemo(() => weekdayNames(weekStart, locale), [weekStart, locale]);
  const lo = min && isIsoDate(min) ? min : undefined;
  const hi = max && isIsoDate(max) ? max : undefined;
  // The focused day: the value, else today, inside the bounds; the month shown follows it.
  const [focus, setFocus] = useState(() => clampDate(value || today, lo, hi));
  const [month, setMonth] = useState(() => parseIso(focus) ?? { y: 2000, m: 1, d: 1 });
  const grid = useRef<HTMLDivElement>(null);
  // Whether the focused day should take the keyboard focus once drawn: on opening, and after a key moved it.
  const pull = useRef(true);
  useEffect(() => {
    if (!pull.current) return;
    pull.current = false;
    grid.current?.querySelector<HTMLElement>(`[data-day="${focus}"]`)?.focus();
  }, [focus, month]);
  const focusDay = (iso: string) => {
    const day = clampDate(iso, lo, hi);
    pull.current = true;
    setFocus(day);
    const p = parseIso(day);
    if (p) setMonth(p);
  };
  const nav = (by: number) => {
    const p = parseIso(addMonths(toIso({ y: month.y, m: month.m, d: 1 }), by));
    if (p) setMonth(p);
    // The focused day follows into the month shown, so Tab lands in it.
    setFocus(clampDate(addMonths(focus, by), lo, hi));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = moveFocus(e.key, focus, weekStart);
    if (next === null) return;
    e.preventDefault();
    focusDay(next);
  };
  const first = toIso({ y: month.y, m: month.m, d: 1 });
  const atMin = lo !== undefined && first <= lo;
  const atMax = hi !== undefined && addMonths(first, 1) > hi;
  const picks = quickPicks(today);
  const pick = (label: string, iso: string, hint: string | null, testid: string) => {
    const button = (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="bg-cf-surface-sunken text-cf-text-muted hover:text-cf-text"
        disabled={iso === "" ? value === "" : !inRange(iso, lo, hi)}
        onClick={() => {
          onPick(iso);
        }}
        data-testid={testid}
        data-day={iso || undefined}
      >
        {label}
      </Button>
    );
    // The day a pick lands on is not on screen: its tooltip says it.
    return hint ? (
      <Tip key={testid} label={hint}>
        <span className="inline-flex">{button}</span>
      </Tip>
    ) : (
      <span key={testid} className="inline-flex">
        {button}
      </span>
    );
  };
  return (
    <div className="flex flex-col gap-2" data-testid="plugin-date-calendar">
      <div className="flex items-center">
        <span className="text-label" data-testid="plugin-date-month">
          {monthTitle(month.y, month.m, locale)}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous month" disabled={atMin} onClick={() => {
              nav(-1);
            }} data-testid="plugin-date-prev">
            <ChevronLeft />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Next month" disabled={atMax} onClick={() => {
              nav(1);
            }} data-testid="plugin-date-next">
            <ChevronRight />
          </Button>
        </span>
      </div>
      <div ref={grid} className="grid grid-cols-7 gap-0.5 text-center" role="grid" aria-label={monthTitle(month.y, month.m, locale)} onKeyDown={onKey}>
        {names.map((n) => (
          <span key={n.long} className="py-1 text-caption-sm" role="columnheader" aria-label={n.long}>
            {n.narrow}
          </span>
        ))}
        {monthGrid(month.y, month.m, weekStart)
          .flat()
          .map((d) => {
            const outside = !inMonth(d, month.y, month.m);
            const selected = d === value;
            const isToday = d === today;
            return (
              <button
                key={d}
                type="button"
                role="gridcell"
                tabIndex={d === focus ? 0 : -1}
                disabled={!inRange(d, lo, hi)}
                aria-selected={selected}
                aria-current={isToday ? "date" : undefined}
                aria-label={formatDayLong(d, locale)}
                data-day={d}
                data-today={isToday || undefined}
                className={cn(
                  "h-7 rounded-md border border-transparent text-body-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-cf-focus/50 disabled:pointer-events-none disabled:opacity-35",
                  selected ? "bg-cf-accent font-medium text-cf-accent-foreground" : "hover:bg-cf-control-hover",
                  isToday && !selected && "border-cf-border",
                  outside && !selected && "text-cf-text-muted",
                )}
                onFocus={() => {
                  if (d !== focus) setFocus(d);
                }}
                onClick={() => {
                  onPick(d);
                }}
              >
                {Number(d.slice(8))}
              </button>
            );
          })}
      </div>
      <div className="flex flex-wrap items-center gap-1" data-testid="plugin-date-picks">
        {pick("Today", picks.today, null, "plugin-date-today")}
        {pick("Tomorrow", picks.tomorrow, formatDay(picks.tomorrow, today, locale), "plugin-date-tomorrow")}
        {pick(weekdayShort(picks.nextMonday, locale), picks.nextMonday, formatDay(picks.nextMonday, today, locale), "plugin-date-monday")}
        {pick("Clear", "", null, "plugin-date-clear")}
      </div>
    </div>
  );
}
