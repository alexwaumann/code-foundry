import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { defaultFilter } from "cmdk";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  icon: LucideIcon;
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
  "data-testid"?: string;
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
  "data-testid": testId,
}: ComposerPickerProps) {
  const [open, setOpen] = useState(false);
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
    onChange(v);
    setOpen(false);
    // Now, not after the exit animation: an immediate Tab moves on from the trigger.
    triggerRef.current?.focus();
  };
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
              className={cn(o.wrap && "items-start")}
              onSelect={() => {
                pick(o.value);
              }}
            >
              <Check aria-hidden className={cn("size-3.5", o.wrap && "mt-0.5", o.value !== value && "invisible")} />
              {o.icon && <o.icon aria-hidden className="size-3.5" />}
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={cn("truncate", o.mono && "font-mono")}>{o.label}</span>
                  {o.tag && <span className="shrink-0 rounded-sm border border-cf-border px-1 text-caption-sm">{o.tag}</span>}
                </span>
                {o.detail && <span className={cn("text-caption", o.wrap ? "text-pretty" : "truncate")}>{o.detail}</span>}
              </span>
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
          className={cn("max-w-64 text-cf-text-muted hover:text-cf-text data-[state=open]:bg-cf-control-hover data-[state=open]:text-cf-text", className)}
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
          <ChevronDown aria-hidden className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        // Never taller than the room Radix found on its side (viewport px, so divided by the zoom).
        className={cn("flex max-h-[calc(var(--radix-popover-content-available-height)/var(--cf-zoom))] flex-col p-0", contentClassName)}
        data-testid={testId ? `${testId}-list` : undefined}
        onCloseAutoFocus={(e) => {
          // Back to the trigger unless something else took the keyboard (a click outside).
          // Radix's own return lands on the body after a reopen during the close animation.
          e.preventDefault();
          const el = document.activeElement;
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
