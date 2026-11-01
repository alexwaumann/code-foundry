import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Settings } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * A menu item with a second target, a gear at its right end (docs/notes/thread-info-action-menu-gear.md):
 * the thread info card's Actions menu, where the item runs its action and the gear opens its
 * editor. It hovers as two blocks with a 2px seam, like the card's split rows (Row.tsx
 * SPLIT_ROW, docs/notes/thread-info-split-hover.md), with a 32px gear block:
 *
 * - The item's `before:` from its left edge to 34px short of its right, `rounded-l-md`; the
 *   gear's `after:` the item's last 32px at its full height, `rounded-r-md`. The gear's 16px
 *   box sits on the item's right padding, so the block is centred on the glyph. The item has
 *   no background of its own (shadcn's `focus:bg-accent` is cleared) and isolates, so both
 *   pseudos (z -1) paint under the text and the glyph.
 * - The gear shows on the highlighted item only (Radix's `data-highlighted`, pointer or
 *   keyboard) and while it has focus; elsewhere it is there but transparent, so nothing moves.
 * - The block under the pointer (or holding focus) is bright, the other half strength.
 *
 * Radix fires the item's select for any click inside it, the gear's too, and closes the menu
 * after it: the item notes whether the click came from the gear and `onSelect` picks between
 * `onRun` and `onGear` (so the menu closes the same way for both). Keys on the gear never
 * reach the item's own handling (Radix ignores keys whose target is not the item): Enter and
 * Space click the gear, ArrowLeft gives focus back to the item, ArrowUp and ArrowDown do too
 * and then move from it. ArrowRight on the item focuses its gear.
 */
export function GearMenuItem({
  children,
  onRun,
  onGear,
  gearLabel,
  className,
  ...rest
}: {
  children: ReactNode;
  onRun: () => void;
  onGear: () => void;
  gearLabel: string;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  const fromGear = useRef(false);
  return (
    <DropdownMenuItem
      {...rest}
      className={cn(GEAR_ITEM, className)}
      onClick={(e: MouseEvent<HTMLDivElement>) => {
        fromGear.current = onGearTarget(e.target);
      }}
      onSelect={() => {
        const gear = fromGear.current;
        fromGear.current = false;
        if (gear) onGear();
        else onRun();
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget || e.key !== "ArrowRight" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        e.preventDefault();
        e.currentTarget.querySelector<HTMLElement>("[data-action-gear]")?.focus();
      }}
    >
      {children}
      <button
        type="button"
        tabIndex={-1}
        aria-label={gearLabel}
        data-action-gear=""
        data-testid="ti-action-gear"
        className={GEAR_BUTTON}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const item = e.currentTarget.closest<HTMLElement>("[role=menuitem]");
          if (e.key === "Enter" || e.key === " ") {
            // Not the content's typeahead (Space), not the button's own activation (a second click).
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.click();
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            item?.focus();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            // As from the item: focus it, then let Radix's roving focus take the key there.
            e.preventDefault();
            e.stopPropagation();
            item?.focus();
            item?.dispatchEvent(new globalThis.KeyboardEvent("keydown", { key: e.key, bubbles: true, cancelable: true }));
          }
        }}
        onKeyUp={(e) => {
          // A button clicks itself on Space's keyup; the keydown already did.
          if (e.key === " ") e.preventDefault();
        }}
      >
        <Settings aria-hidden className="size-3.5 text-current" />
      </button>
    </DropdownMenuItem>
  );
}

function onGearTarget(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest("[data-action-gear]") !== null;
}

/**
 * The item: its left block is its `before:` (left edge to 34px short of the right: the 32px
 * gear block and the 2px seam), bright while highlighted, half strength while the gear is
 * hovered or focused (`:has()` outranks `[data-highlighted]`). No tint of its own.
 */
export const GEAR_ITEM =
  "group/gear isolate focus:bg-transparent before:pointer-events-none before:absolute before:inset-y-0 before:right-8.5 before:left-0 before:-z-1 before:rounded-l-md data-highlighted:before:bg-cf-control-hover has-[[data-action-gear]:hover]:before:bg-cf-control-hover/50 has-[[data-action-gear]:focus-visible]:before:bg-cf-control-hover/50";

/**
 * The gear: a 16px box at the item's right padding (the text's padding line). Its block is
 * its `after:`, the item's last 32px at its full height: the button is static, so the item
 * (`relative`) places it, and it is the gear's hit area. Half strength while its item is
 * highlighted, bright (and the glyph full colour) under the pointer or with focus. Hidden
 * (opacity, still focusable) unless its item is highlighted or it has focus.
 */
export const GEAR_BUTTON =
  "ml-auto flex size-4 shrink-0 items-center justify-center text-cf-text-muted opacity-0 outline-none after:absolute after:inset-y-0 after:right-0 after:-z-1 after:w-8 after:rounded-r-md group-data-highlighted/gear:opacity-100 group-data-highlighted/gear:after:bg-cf-control-hover/50 hover:text-cf-text hover:after:bg-cf-control-hover focus-visible:text-cf-text focus-visible:opacity-100 focus-visible:after:bg-cf-control-hover";
