import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}

export interface PickerGroup {
  heading?: string;
  /** A rule above the group. */
  separated?: boolean;
  options: readonly PickerOption[];
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
  /** Adds a filter box (long lists such as refs). */
  filterPlaceholder?: string;
  /** Shown in place of the options (loading, errors). */
  status?: ReactNode;
  /** A muted line under the options (not an option). */
  footer?: ReactNode;
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
  disabled,
  className,
  contentClassName,
  listClassName,
  "data-testid": testId,
}: ComposerPickerProps) {
  const [open, setOpen] = useState(false);
  // Controlled so every opening starts unfiltered (the content can outlive a close).
  const [search, setSearch] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasOptions = groups.some((g) => g.options.length > 0);
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
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setSearch("");
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
          className={cn("max-w-64 text-muted-foreground hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground", className)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setSearch("");
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
        <Command ref={rootRef} loop defaultValue={value} label={label} className="min-h-0 rounded-lg outline-hidden">
          {filterPlaceholder && <CommandInput ref={inputRef} placeholder={filterPlaceholder} value={search} onValueChange={setSearch} />}
          <CommandList className={cn("max-h-72 min-h-0", listClassName)}>
            {status ? (
              <div className="px-3 py-3 text-xs text-muted-foreground" role="status">
                {status}
              </div>
            ) : (
              <CommandEmpty>{hasOptions ? "No matches." : "Nothing to pick."}</CommandEmpty>
            )}
            {!status &&
              groups.map((g, i) =>
                g.options.length === 0 ? null : (
                  <Fragment key={g.heading ?? String(i)}>
                    {g.separated && <CommandSeparator className="mx-2" />}
                    <CommandGroup heading={g.heading}>
                      {g.options.map((o) => (
                        <CommandItem
                          key={o.value}
                          value={o.value}
                          keywords={[o.label, o.tag ?? "", o.detail ?? ""]}
                          className={cn(o.wrap && "items-start")}
                          onSelect={() => {
                            onChange(o.value);
                            setOpen(false);
                            // Now, not after the exit animation: an immediate Tab moves on from the trigger.
                            triggerRef.current?.focus();
                          }}
                        >
                          <Check aria-hidden className={cn("size-3.5", o.wrap && "mt-0.5", o.value !== value && "invisible")} />
                          <span className="flex min-w-0 flex-col">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate">{o.label}</span>
                              {o.tag && <span className="shrink-0 rounded border border-border px-1 text-[11px] leading-4 text-muted-foreground">{o.tag}</span>}
                            </span>
                            {o.detail && <span className={cn("text-xs text-muted-foreground", o.wrap ? "text-pretty" : "truncate")}>{o.detail}</span>}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </Fragment>
                ),
              )}
          </CommandList>
          {footer && !status && (
            <div className="mx-2 border-t border-border px-1 py-2 text-xs text-muted-foreground" data-slot="picker-footer">
              {footer}
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
