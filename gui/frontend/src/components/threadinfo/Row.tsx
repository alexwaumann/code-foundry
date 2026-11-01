import { useRef, useState, type ComponentProps, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The thread info card's row (docs/sketches/thread-info v14, docs/notes/thread-info-row-menus.md):
 * an icon column, the text, the right-hand value, and the row's end.
 *
 * Two marks, one meaning each:
 * - **Chevron: the whole row is a disclosure.** It opens a menu (the row is the Radix
 *   trigger, `asChild`: it takes the trigger's props and ref) or a fold (`onActivate`
 *   toggles it, `aria-expanded`). "closed" points right; "open" points down, only while
 *   the menu is up or the fold is open. A menu trigger keeps its hover tint while its menu
 *   is up; an open fold shows only its chevron (a tinted fold read as selected).
 * - **Ellipsis: more options for a row with its own click.** The row's click (and Enter,
 *   Space) runs its primary thing; `RowMore`, passed as `trailing`, is its own focusable
 *   button that opens the menu, laid under the row at the row's width. The row keeps its
 *   hover tint while that menu is up.
 *
 * A row without a chevron reserves nothing: its value (or trailing button) ends at the
 * row's padding, the edge a chevron's box ends at, so every row's last mark shares one
 * right edge. Hover cards are the caller's Tip around the row.
 */
export function Row({
  icon,
  children,
  meta,
  chevron = "none",
  onActivate,
  hoverable = false,
  sub = false,
  tall = false,
  trailing,
  className,
  testId,
  ...rest
}: {
  icon?: ReactNode;
  children: ReactNode;
  meta?: ReactNode;
  /** "none": no disclosure, and no chevron column. */
  chevron?: "none" | "closed" | "open";
  /** The row's click (and Enter, Space). Not on a menu trigger row: its press opens the menu. */
  onActivate?: () => void;
  /** No action, but a hover card: the row shows its hover background. */
  hoverable?: boolean;
  /** A fold's sub-row: indented to the text column. */
  sub?: boolean;
  /** Two or three lines (a pull request, an action of another project). */
  tall?: boolean;
  /** A button after the value (Fix, Resolve, a stop square, a RowMore). */
  trailing?: ReactNode;
  className?: string;
  testId?: string;
} & Omit<ComponentProps<"div">, "children">) {
  const menu = rest["aria-haspopup"] !== undefined;
  const interactive = Boolean(onActivate) || menu;
  const hasMeta = meta !== undefined && meta !== null && meta !== false;
  const activates = Boolean(onActivate) && !menu;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      data-testid={testId}
      data-slot="ti-row"
      {...rest}
      className={cn(
        "group/row relative flex min-w-0 shrink-0 items-center gap-2 rounded-md pr-1 pl-2 text-caption text-cf-text outline-none",
        tall ? "py-1" : sub ? "h-6.5" : "h-7",
        sub && "pl-7.5",
        (interactive || hoverable) && "cursor-default hover:bg-cf-control-hover focus-visible:bg-cf-control-hover",
        menu && "aria-expanded:bg-cf-control-hover",
        interactive && "has-[[data-row-more][aria-expanded=true]]:bg-cf-control-hover",
        className,
      )}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (activates && (e.key === "Enter" || e.key === " ") && ownPress(e)) {
          e.preventDefault();
          onActivate?.();
          return;
        }
        rest.onKeyDown?.(e);
      }}
      onClick={(e: MouseEvent<HTMLDivElement>) => {
        rest.onClick?.(e);
        // A double click activates once: Push or Pull runs once, a fold does not open and close.
        if (e.detail > 1) return;
        if (activates && ownPress(e)) onActivate?.();
      }}
    >
      {icon !== undefined && <span className="flex size-3.5 shrink-0 items-center justify-center text-cf-text-muted [&_svg]:size-3.5">{icon}</span>}
      <span className={cn("min-w-0 flex-1", tall ? "flex flex-col" : "truncate")}>{children}</span>
      {hasMeta && (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-caption-sm tabular-nums [&_svg]:size-3.25" data-testid={testId && `${testId}-meta`}>
          {meta}
        </span>
      )}
      {trailing}
      {chevron !== "none" && (
        <span
          className="flex size-4 shrink-0 items-center justify-center text-cf-text-muted/70 [&_svg]:size-3.5"
          data-testid={testId && `${testId}-chevron`}
          data-open={chevron === "open" ? "" : undefined}
          aria-hidden
        >
          {chevron === "open" ? <ChevronDown /> : <ChevronRight />}
        </span>
      )}
    </div>
  );
}

/**
 * A press on the row itself: not on its RowMore button, and not in that button's menu,
 * whose events reach the row through React's portal bubbling though the menu is not in
 * the row's DOM.
 */
function ownPress(e: { target: EventTarget; currentTarget: Element }): boolean {
  const t = e.target;
  return t instanceof Element && e.currentTarget.contains(t) && t.closest("[data-row-more]") === null;
}

/**
 * The ellipsis "more options" button: the chevron's 16px box, so the two glyphs share the
 * row's right edge, with a hit area as tall as a row. Muted; tinted on hover and while its
 * menu is up. Use it as a Radix trigger's child (RowMore does).
 */
export function RowMoreButton({ label, className, ...rest }: { label: string } & Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      type="button"
      aria-label={label}
      data-row-more=""
      {...rest}
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center rounded-sm text-cf-text-muted outline-none after:absolute after:-inset-x-1 after:-inset-y-1.5 hover:bg-cf-text/10 focus-visible:bg-cf-text/10 aria-expanded:bg-cf-text/10 [&_svg]:size-3.5",
        className,
      )}
    >
      <Ellipsis aria-hidden />
    </button>
  );
}

/** Where a RowMore's menu goes: under its row, at the row's width (measured as the menu opens). */
interface RowPlace {
  width: number;
  alignOffset: number;
  sideOffset: number;
}

function rowPlace(button: HTMLElement | null): RowPlace | null {
  const row = button?.closest("[data-slot=ti-row]");
  if (!button || !row) return null;
  const b = button.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  // Radix anchors the menu to its trigger, the button: shift it to the row's left edge and
  // below the row's bottom. The button is centred in its row, so a flip above fits too.
  return { width: r.width, alignOffset: r.left - b.left, sideOffset: r.bottom - b.bottom + 4 };
}

/**
 * A row's "more options": the ellipsis button and its menu, which sits under the row at the
 * row's own width like a chevron row's menu. Pass it as the row's `trailing`; the row's
 * click stays the row's (presses on the button and in its menu are not the row's click).
 */
export function RowMore({ label, testId, menuTestId, children }: { label: string; testId: string; menuTestId: string; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<RowPlace | null>(null);
  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(o) => {
        if (o) setPlace(rowPlace(ref.current));
        setOpen(o);
      }}
    >
      <DropdownMenuTrigger asChild>
        <RowMoreButton ref={ref} label={label} data-testid={testId} />
      </DropdownMenuTrigger>
      <RowMenu
        testId={menuTestId}
        alignOffset={place?.alignOffset ?? 0}
        sideOffset={place?.sideOffset ?? 4}
        className={place ? "w-(--ti-row-width)" : "min-w-52"}
        style={place ? ({ "--ti-row-width": `${String(place.width)}px` } as CSSProperties) : undefined}
      >
        {children}
      </RowMenu>
    </DropdownMenu>
  );
}

/** A row's second (or third) line: small and muted. */
export function SubLine({ children, className, testId }: { children: ReactNode; className?: string; testId?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 truncate text-caption-sm [&_svg]:size-3", className)} data-testid={testId}>
      {children}
    </span>
  );
}

/** A group of rows; the card draws a divider between groups (ThreadInfoCard). Empty groups render nothing. */
export function Group({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="flex flex-col px-1.5 py-1 not-first:border-t not-first:border-cf-divider" data-testid={testId}>
      {children}
    </div>
  );
}

/** A row's menu: the card's full width less 6px each side (the row's own width), under its trigger row (RowMore anchors it to its row the same way). */
export function RowMenu({ children, testId, className, ...rest }: { children: ReactNode; testId: string } & ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      align="start"
      sideOffset={4}
      className={cn(
        "w-(--radix-dropdown-menu-trigger-width) min-w-0 [&_[data-slot=dropdown-menu-item]]:text-caption [&_[data-slot=dropdown-menu-item]]:text-cf-text",
        className,
      )}
      data-testid={testId}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
      }}
      {...rest}
    >
      {children}
    </DropdownMenuContent>
  );
}

/** A hover card's body: at most 260px, lines of small text. */
export const HOVER_CARD = "max-w-65 text-caption-sm text-cf-text";

/** Added and deleted line counts: "+42 −9" in the diff colours (a zero deletion left out). */
export function DiffCounts({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="inline-flex gap-1">
      <span className="text-cf-diff-addition">+{added}</span>
      {deleted > 0 && <span className="text-cf-diff-deletion">−{deleted}</span>}
    </span>
  );
}
