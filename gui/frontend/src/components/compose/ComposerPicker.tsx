import { Fragment, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Check, ChevronDown, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { Button } from "@/components/ui/button";
import { defaultFilter } from "cmdk";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface PickerOption {
  value: string;
  label: string;
  /** Second, muted line (or trailing text). */
  detail?: string;
  /** A small muted tag after the label ("new worktree", a branch). */
  tag?: string;
  /** The detail wraps instead of being cut to one line (a sentence, not a path). */
  wrap?: boolean;
  /** An icon before the label (a branch's). */
  icon?: LucideIcon;
  /** The label is a name in monospace (a branch). */
  mono?: boolean;
  /**
   * Shown greyed and not picked (a branch the daemon would refuse, thread.placement.check),
   * with `unavailable` as its tooltip: the reason, before anything is sent.
   */
  unavailable?: string;
}

export interface PickerGroup {
  heading?: string;
  /** A rule above the group. */
  separated?: boolean;
  options: readonly PickerOption[];
  /**
   * Above the filter box and never filtered (Work in's two choices above its branch
   * search). The filter box follows the last fixed group; without one it is on top.
   */
  fixed?: boolean;
  /** A muted row after the group's options (loading, errors), in place of what is not there yet. */
  status?: string;
}

interface ComposerPickerProps {
  /** What is being picked ("Model"); the trigger's accessible name is "<label>: <text>". */
  label: string;
  /** A lucide icon or any svg component sized by className (the Claude mark). */
  icon: LucideIcon | ComponentType<SVGProps<SVGSVGElement>>;
  /** Trigger text for the current value. */
  text: string;
  value: string;
  groups: readonly PickerGroup[];
  onChange: (value: string) => void;
  /** Adds a filter box (long lists such as branches). */
  filterPlaceholder?: string;
  /** Shown in place of the options (loading, errors). */
  status?: ReactNode;
  /** A muted line under the options (not an option). */
  footer?: ReactNode;
  /** Each time the list opens (a lazy load of what it lists). */
  onOpen?: () => void;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  /** Overrides the list's height cap (max-h-72). */
  listClassName?: string;
  /**
   * A warning about the current value (Work in's collision): an amber icon after the
   * text, an amber tint, and this as the trigger's tooltip. null: a picker that can warn
   * and does not now; absent: one that never warns.
   */
  warning?: ReactNode;
  /**
   * A multi-select (Add project): a pick calls onChange and keeps the list open, so several
   * rows can be toggled; the rows in `selected` are checked (`value` is not).
   */
  multi?: boolean;
  selected?: readonly string[];
  /**
   * Where focus goes after a pick or a dismissal (Esc, a click away): the composer's
   * prompt. Without it, the trigger.
   */
  focusAfter?: () => void;
  "data-testid"?: string;
  /**
   * Opened from elsewhere (a menu item) instead of a trigger: the list is anchored to this
   * element, and open/onOpenChange control it.
   */
  anchor?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * An unavailable option's body under its reason as a tooltip, beside the list; the bare
 * body otherwise. The tooltip's trigger is a span filling the row: cmdk's item sets its own
 * pointer handlers over a trigger's.
 */
function UnavailableTip({ reason, wrap, children }: { reason?: string; wrap?: boolean; children: ReactElement }) {
  if (!reason) return children;
  return (
    <Tip label={reason} side="right" data-testid="picker-unavailable-tip">
      <span className={cn("flex min-w-0 flex-1 gap-2 self-stretch", wrap ? "items-start" : "items-center")}>{children}</span>
    </Tip>
  );
}

/** The warning's tooltip around a picker that can warn; the bare trigger for one that cannot. */
function WarningTip({ warning, testId, children }: { warning: ReactNode; testId?: string; children: ReactElement }) {
  if (warning === undefined) return children;
  return (
    <Tip label={warning} data-testid={testId ? `${testId}-warning-tip` : undefined}>
      {children}
    </Tip>
  );
}

/**
 * A composer pill that opens a small listbox: a shadcn popover around the cmdk list the
 * palette uses. Keyboard: Enter/Space/↑/↓ on the trigger opens it, ↑↓ move, Enter picks,
 * Esc closes and returns focus to the trigger.
 *
 * Fixed groups sit above the filter box inside the list (cmdk moves only through the
 * list's items), so ↑↓ walk from them into the filtered rows and back.
 */
export function ComposerPicker({
  label,
  icon: Icon,
  text,
  value,
  groups,
  onChange,
  filterPlaceholder,
  status,
  footer,
  onOpen,
  disabled,
  className,
  contentClassName,
  listClassName,
  warning,
  multi = false,
  selected,
  focusAfter,
  "data-testid": testId,
  anchor,
  open: openProp,
  onOpenChange,
}: ComposerPickerProps) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };
  // Controlled so every opening starts unfiltered (the content can outlive a close).
  const [search, setSearch] = useState("");
  // The highlighted row, controlled so a search does not land on a fixed row (below).
  const [active, setActive] = useState(value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Every opening: unfiltered, on the current value, and what the list shows (re)loading. */
  const opening = () => {
    setSearch("");
    setActive(value);
    onOpen?.();
  };
  const fixed = groups.filter((g) => g.fixed);
  const filtered = groups.filter((g) => !g.fixed);
  const hasOptions = filtered.some((g) => g.options.length > 0);
  const filteredStatus = filtered.some((g) => Boolean(g.status));
  // Reopened while its close animation runs, the popover keeps its content and Radix does
  // not autofocus it again: the keyboard stayed on the trigger and the arrows did nothing.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const target = inputRef.current ?? rootRef.current;
      if (target && !target.contains(document.activeElement)) target.focus();
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [open]);
  // cmdk highlights the first row after each search; with fixed rows on top that is one of
  // them, so Enter would not pick the first match. The best match among the filtered rows
  // instead (cmdk's own scoring), and cmdk's first-row pick that follows is turned away.
  const searchPick = useRef<string | null>(null);
  const searchChanged = (s: string) => {
    setSearch(s);
    if (fixed.length === 0 || !s) return;
    let best: string | null = null;
    let top = 0;
    for (const g of filtered) {
      for (const o of g.options) {
        const score = defaultFilter(o.value, s, [o.label, o.tag ?? "", o.detail ?? ""]);
        if (score > top) {
          top = score;
          best = o.value;
        }
      }
    }
    if (best === null) return;
    searchPick.current = best;
    setActive(best);
  };
  const highlight = (v: string) => {
    const keep = searchPick.current;
    searchPick.current = null;
    if (keep !== null && fixed.some((g) => g.options.some((o) => o.value === v))) {
      // cmdk has taken its pick already and syncs a controlled value only when the prop
      // changes: a trailing space (cmdk trims it) makes the same pick a new prop.
      setActive((a) => (a === keep ? `${keep} ` : keep));
      return;
    }
    setActive(v);
  };
  const pick = (v: string) => {
    if (groups.some((g) => g.options.some((o) => o.value === v && o.unavailable))) return;
    onChange(v);
    if (multi) return;
    setOpen(false);
    // Now, not after the exit animation: an immediate Tab moves on from the trigger.
    (focusAfter ?? (() => triggerRef.current?.focus()))();
  };
  const isChecked = (v: string) => (multi ? (selected ?? []).includes(v) : v === value);
  const renderGroup = (g: PickerGroup, i: number, force: boolean) =>
    g.options.length === 0 && !g.status ? null : (
      <Fragment key={g.heading ?? `${force ? "fixed" : "group"}-${String(i)}`}>
        {g.separated && <CommandSeparator className="mx-2" />}
        <CommandGroup heading={g.heading} forceMount={force || undefined}>
          {g.options.map((o) => (
            <CommandItem
              key={o.value}
              value={o.value}
              keywords={[o.label, o.tag ?? "", o.detail ?? ""]}
              forceMount={force || undefined}
              data-fixed={force ? "" : undefined}
              // Not cmdk's disabled: that drops pointer events, and the tooltip says why.
              className={cn(o.wrap && "items-start", o.unavailable && "opacity-50")}
              data-unavailable={o.unavailable ? "" : undefined}
              data-checked={isChecked(o.value) || undefined}
              onSelect={() => {
                pick(o.value);
              }}
            >
              <UnavailableTip reason={o.unavailable} wrap={o.wrap}>
                <>
                  <Check aria-hidden className={cn("size-3.5", o.wrap && "mt-0.5", !isChecked(o.value) && "invisible")} />
                  {o.icon && <o.icon aria-hidden className="size-3.5" />}
                  <span className="flex min-w-0 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className={cn("truncate", o.mono && "font-mono")}>{o.label}</span>
                      {o.tag && <span className="shrink-0 rounded-sm border border-cf-border px-1 text-caption-sm">{o.tag}</span>}
                    </span>
                    {o.detail && <span className={cn("text-caption", o.wrap ? "text-pretty" : "truncate")}>{o.detail}</span>}
                  </span>
                </>
              </UnavailableTip>
            </CommandItem>
          ))}
          {g.status && (
            <div className="px-2 py-1.5 text-caption" role="status" data-slot="picker-group-status">
              {g.status}
            </div>
          )}
        </CommandGroup>
      </Fragment>
    );
  const input = filterPlaceholder ? (
    <CommandInput
      ref={inputRef}
      placeholder={filterPlaceholder}
      value={search}
      onValueChange={searchChanged}
    />
  ) : null;
  const inList = fixed.length > 0 && input !== null;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) opening();
        setOpen(o);
      }}
    >
      {/*
        A picker that can warn (warning passed, null while clear) has a Tip outside the
        popover trigger, there whether it warns or not so the trigger never remounts. Its
        data-state wins on the button, so the open look keys on aria-expanded.
      */}
      {anchor ? (
        <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      ) : (
      <WarningTip warning={warning} testId={testId}>
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            aria-label={`${label}: ${text}`}
            data-compose-stop
            data-testid={testId}
            data-warning={warning ? "" : undefined}
            className={cn(
              "max-w-64 text-cf-text-muted hover:text-cf-text aria-expanded:bg-cf-control-hover aria-expanded:text-cf-text",
              warning && "bg-cf-warning/10 text-cf-text hover:bg-cf-warning/15 aria-expanded:bg-cf-warning/15",
              className,
            )}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!open) opening();
                setOpen(true);
              }
            }}
          >
            <Icon aria-hidden />
            <span className="truncate">{text}</span>
            {warning ? <TriangleAlert aria-hidden className="text-cf-warning-text" data-testid={testId ? `${testId}-warning` : undefined} /> : null}
            <ChevronDown aria-hidden className="opacity-60" />
          </Button>
        </PopoverTrigger>
      </WarningTip>
      )}
      <PopoverContent
        // Never taller than the room Radix found on its side (viewport px, so divided by the zoom).
        className={cn("flex max-h-[calc(var(--radix-popover-content-available-height)/var(--cf-zoom))] flex-col p-0", contentClassName)}
        data-testid={testId ? `${testId}-list` : undefined}
        onCloseAutoFocus={(e) => {
          // Back to the trigger unless something else took the keyboard (a click outside).
          // Radix's own return lands on the body after a reopen during the close animation.
          e.preventDefault();
          const el = document.activeElement;
          if (focusAfter) {
            // The prompt, unless the click away landed on another control (another pill).
            if (!el || el === document.body || el === triggerRef.current || rootRef.current?.contains(el)) focusAfter();
            return;
          }
          if (!el || el === document.body || rootRef.current?.contains(el)) triggerRef.current?.focus();
        }}
        onOpenAutoFocus={(e) => {
          // cmdk handles keys on its root (or its input): focus that, not the popover.
          e.preventDefault();
          (inputRef.current ?? rootRef.current)?.focus();
        }}
      >
        <Command ref={rootRef} loop value={active} onValueChange={highlight} label={label} className="min-h-0 rounded-lg outline-hidden">
          {!inList && input}
          <CommandList className={cn("max-h-72 min-h-0", listClassName)}>
            {status ? (
              <div className="px-3 py-3 text-caption" role="status">
                {status}
              </div>
            ) : (
              <>
                {fixed.map((g, i) => renderGroup(g, i, true))}
                {inList && (
                  // The rules above and below set the filter box apart from both lists; sticky
                  // so it stays in reach while the filtered rows scroll.
                  <div className="sticky top-0 z-10 border-t border-cf-border bg-cf-surface-overlay" data-slot="picker-filter">
                    {input}
                  </div>
                )}
                {!filteredStatus && <CommandEmpty>{hasOptions ? "No matches." : "Nothing to pick."}</CommandEmpty>}
              </>
            )}
            {!status && filtered.map((g, i) => renderGroup(g, i, false))}
          </CommandList>
          {footer && !status && (
            <div className="mx-2 border-t border-cf-border px-1 py-2 text-caption" data-slot="picker-footer">
              {footer}
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
