import type { ComponentProps, KeyboardEvent, PointerEvent, ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The thread info card's row (docs/sketches/thread-info v14): an icon column, the text,
 * the right-hand value, and a chevron column that every row reserves so values line up.
 * A row may act on click, carry a menu or fold (its chevron), and a hover card (the
 * caller's Tip around it). `chevron`: "none" leaves the column empty; "closed" points
 * right; "open" points down, only while the row's menu is up or its fold is open. A menu
 * trigger keeps its hover tint while its menu is up; an open fold shows only its chevron
 * (a tinted fold read as selected).
 *
 * As a menu trigger (Radix `asChild`) the row takes the trigger's props and ref. A row
 * with both a click action and a menu (`onClick` and `menuOnChevron`) opens the menu only
 * from its chevron: a press elsewhere on it is its click.
 */
export function Row({
  icon,
  children,
  meta,
  chevron = "none",
  onActivate,
  menuOnChevron = false,
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
  chevron?: "none" | "closed" | "open";
  /** The row's click (and Enter, Space). */
  onActivate?: () => void;
  /** With a menu trigger's props: only the chevron opens it, the rest of the row clicks. */
  menuOnChevron?: boolean;
  /** No action, but a hover card: the row shows its hover background. */
  hoverable?: boolean;
  /** A fold's sub-row: indented to the text column. */
  sub?: boolean;
  /** Two or three lines (a pull request, an action of another project). */
  tall?: boolean;
  /** A button after the value (Fix, Resolve, a stop square). */
  trailing?: ReactNode;
  className?: string;
  testId?: string;
} & Omit<ComponentProps<"div">, "children">) {
  const menu = rest["aria-haspopup"] !== undefined;
  const interactive = Boolean(onActivate) || menu;
  const fromChevron = (e: { target: EventTarget }) => e.target instanceof Element && e.target.closest("[data-row-chevron]") !== null;
  // A press that opens the menu (a menu-only row, or the chevron of a split one) is not a click.
  const clicks = (e: { target: EventTarget }) => Boolean(onActivate) && !(menu && (!menuOnChevron || fromChevron(e)));
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      data-testid={testId}
      {...rest}
      className={cn(
        "group/row relative flex min-w-0 shrink-0 items-center gap-2 rounded-md pr-1 pl-2 text-caption text-cf-text outline-none",
        tall ? "py-1" : sub ? "h-6.5" : "h-7",
        sub && "pl-7.5",
        (interactive || hoverable) && "cursor-default hover:bg-cf-control-hover focus-visible:bg-cf-control-hover",
        menu && "aria-expanded:bg-cf-control-hover",
        className,
      )}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        // The menu opens from the chevron only; a press elsewhere is the row's click.
        if (menuOnChevron && !fromChevron(e)) return;
        rest.onPointerDown?.(e);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        // Enter and Space click a row that clicks (ArrowDown still opens a split row's menu).
        if (onActivate && (e.key === "Enter" || e.key === " ") && (!menu || menuOnChevron)) {
          e.preventDefault();
          onActivate();
          return;
        }
        rest.onKeyDown?.(e);
      }}
      onClick={(e) => {
        rest.onClick?.(e);
        // A double click activates once: Push or Pull runs once, a fold does not open and close.
        if (e.detail > 1) return;
        if (clicks(e)) onActivate?.();
      }}
    >
      {icon !== undefined && <span className="flex size-3.5 shrink-0 items-center justify-center text-cf-text-muted [&_svg]:size-3.5">{icon}</span>}
      <span className={cn("min-w-0 flex-1", tall ? "flex flex-col" : "truncate")}>{children}</span>
      {meta !== undefined && meta !== null && meta !== false && (
        <span
          className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-caption-sm tabular-nums [&_svg]:size-3.25"
          data-testid={testId && `${testId}-meta`}
        >
          {meta}
        </span>
      )}
      {trailing}
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-sm text-cf-text-muted/70 [&_svg]:size-3.5",
          menuOnChevron && "hover:bg-cf-text/10 hover:text-cf-text",
        )}
        data-row-chevron={chevron === "none" ? undefined : ""}
        data-testid={testId && chevron !== "none" ? `${testId}-chevron` : undefined}
        data-open={chevron === "open" ? "" : undefined}
        aria-hidden
      >
        {chevron === "open" ? <ChevronDown /> : chevron === "closed" ? <ChevronRight /> : null}
      </span>
    </div>
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

/** A row's menu: the card's full width less 6px each side (the row's own width), under the row. */
export function RowMenu({ children, testId, ...rest }: { children: ReactNode; testId: string } & ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      align="start"
      sideOffset={4}
      className="w-(--radix-dropdown-menu-trigger-width) min-w-0 [&_[data-slot=dropdown-menu-item]]:text-caption [&_[data-slot=dropdown-menu-item]]:text-cf-text"
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
