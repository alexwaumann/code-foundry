import { useRef } from "react";
import { Ellipsis } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";

/** One item of a row's overflow menu; "separator" draws a line. */
export type OverflowItem =
  | {
      label: string;
      icon: React.ComponentType<{ className?: string }>;
      onSelect: () => void;
      destructive?: boolean;
      testId: string;
      /** Shown at the item's right, e.g. how many things it acts on. */
      badge?: number;
      disabled?: boolean;
    }
  | "separator";

/**
 * The "More" (…) action of a Projects page row or header: a dropdown of the row's less
 * frequent and destructive actions. The trigger is a row action (mouse; the palette
 * reaches the same commands by keyboard). Keys inside the menu stay in it (the list's
 * arrow keys must not move its cursor meanwhile). Closing it gives the keyboard back to
 * the page's list, and only then runs the picked item: a menu still animating out takes
 * the focus back when the pointer leaves its items, which would pull it out of a dialog
 * or the palette the item opened (and their focus scopes select the input on return, so
 * the next keystroke replaced what was typed).
 */
export function OverflowMenu({ label, items, testId }: { label: string; items: readonly OverflowItem[]; testId: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const picked = useRef<(() => void) | null>(null);
  return (
    <DropdownMenu modal={false}>
      <Tip label={label}>
        <DropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            tabIndex={-1}
            aria-label={label}
            data-testid={testId}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-cf-text-muted hover:bg-cf-control-hover hover:text-cf-text aria-expanded:bg-cf-control-hover aria-expanded:text-cf-text [&_svg]:size-3.5"
            onClick={(e) => {
              e.stopPropagation();
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
            }}
          >
            <Ellipsis />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="end"
        className="min-w-[200px]"
        data-testid={`${testId}-menu`}
        onKeyDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          // Portal events still bubble through React: not to the row (cursor, activation).
          e.stopPropagation();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const active = document.activeElement;
          if (!active || active === document.body || active === triggerRef.current) {
            triggerRef.current?.closest<HTMLElement>("[data-focus-root]")?.focus({ preventScroll: true });
          }
          const run = picked.current;
          picked.current = null;
          run?.();
        }}
      >
        {items.map((it, i) =>
          it === "separator" ? (
            <DropdownMenuSeparator key={`sep-${String(i)}`} />
          ) : (
            <DropdownMenuItem
              key={it.testId}
              variant={it.destructive ? "destructive" : "default"}
              data-testid={it.testId}
              disabled={it.disabled}
              onSelect={() => {
                picked.current = it.onSelect;
              }}
            >
              <it.icon className={it.destructive ? "text-cf-error" : undefined} />
              {it.label}
              {it.badge !== undefined && (
                <span className="ml-auto pl-4 text-caption tabular-nums" data-testid={`${it.testId}-count`}>
                  {it.badge}
                </span>
              )}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
