import { useRef } from "react";
import { Ellipsis } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** One item of a row's overflow menu; "separator" draws a line. */
export type OverflowItem =
  | { label: string; icon: React.ComponentType<{ className?: string }>; onSelect: () => void; destructive?: boolean; testId: string }
  | "separator";

/**
 * The "More" (…) action of a Projects page row or header: a dropdown of the row's less
 * frequent and destructive actions. The trigger is a row action (mouse; the palette
 * reaches the same commands by keyboard). Keys inside the menu stay in it (the list's
 * arrow keys must not move its cursor meanwhile), and closing it gives the keyboard back
 * to the page's list unless an item moved the focus somewhere else (a dialog, the
 * palette).
 */
export function OverflowMenu({ label, items, testId }: { label: string; items: readonly OverflowItem[]; testId: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          tabIndex={-1}
          aria-label={label}
          title={label}
          data-testid={testId}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground [&_svg]:size-3.5"
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
          if (active && active !== document.body && active !== triggerRef.current) return;
          triggerRef.current?.closest<HTMLElement>("[data-focus-root]")?.focus({ preventScroll: true });
        }}
      >
        {items.map((it, i) =>
          it === "separator" ? (
            <DropdownMenuSeparator key={`sep-${String(i)}`} />
          ) : (
            <DropdownMenuItem key={it.testId} variant={it.destructive ? "destructive" : "default"} data-testid={it.testId} onSelect={it.onSelect}>
              <it.icon className={it.destructive ? "text-destructive" : undefined} />
              {it.label}
            </DropdownMenuItem>
          ),
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
