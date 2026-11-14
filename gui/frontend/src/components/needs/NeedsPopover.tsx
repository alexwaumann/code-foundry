import { ShieldAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tip } from "@/components/ui/tooltip";
import { NeedsLines, NeedsScopeToggle } from "@/components/sidebar/shell/ShellRows";
import { cn } from "@/lib/utils";
import { goToNeedsThread, openNeedsPopup, setNeedsPopover, useNeedsStore } from "@/stores/needs";
import { useNeedsList } from "@/stores/shellList";
import { useUiStore } from "@/stores/ui";
import { NeedsHoverCard } from "./NeedsCard";

/**
 * A row of the popover: the sidebar's Needs you row (the place and the ask, then the title). The
 * title opens the popup, anywhere else goes to the thread; hovering or focusing it shows the card.
 */
function PopoverRow({ id }: { id: string }) {
  const anchor = `popover:${id}`;
  return (
    <NeedsHoverCard threadId={id} anchor={anchor}>
      <div
        role="button"
        tabIndex={0}
        className="flex cursor-default flex-col rounded-md px-2 py-1 text-body-sm text-cf-text outline-none select-none hover:bg-cf-control-hover focus-visible:ring-1 focus-visible:ring-cf-focus focus-visible:ring-inset"
        data-testid="needs-popover-row"
        data-thread-id={id}
        // The title's own click opens the popup and stops there (NeedsLines).
        onClick={() => {
          goToNeedsThread(id);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          openNeedsPopup(id, anchor);
        }}
      >
        <NeedsLines id={id} anchor={anchor} />
      </div>
    </NeedsHoverCard>
  );
}

/**
 * The top bar's Needs you control (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-17-needs-you.md):
 * while the sidebar is collapsed and some thread waits on the user, a small button with the
 * Needs you count (in the section's scope, all spaces or this one) that opens the same list as a
 * popover, with the same hover card and popup. A space tab's count stays that space's own.
 */
export function NeedsPopover() {
  const hidden = useUiStore((s) => !s.sidebarVisible);
  return hidden ? <NeedsControl /> : null;
}

function NeedsControl() {
  const { ids, any } = useNeedsList();
  // The popup and Go to thread close it (stores/needs.ts).
  const open = useNeedsStore((s) => s.popover);
  if (!any) return null;
  const count = ids.length;
  const label = count === 1 ? "1 thread needs you" : `${String(count)} threads need you`;
  return (
    <Popover open={open} onOpenChange={setNeedsPopover}>
      <Tip label={label} side="bottom">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-label font-medium tabular-nums outline-none [--wails-draggable:no-drag] hover:bg-cf-control-hover focus-visible:ring-1 focus-visible:ring-cf-focus",
              count > 0 ? "text-cf-warning-text" : "text-cf-text-muted",
            )}
            data-testid="needs-control"
            data-count={count}
          >
            <ShieldAlert className="size-4 shrink-0" aria-hidden />
            {count > 0 && <span data-testid="needs-control-count">{count}</span>}
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        align="start"
        className="flex w-[300px] flex-col p-1.5"
        data-testid="needs-popover"
        // The list itself takes the focus: a row focused at once would open its card under a click.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
        }}
      >
        <div className="flex h-7 items-center gap-2 px-1.5">
          <span className="text-caption font-medium text-cf-text-muted">
            Needs you{" "}
            <span className="tabular-nums opacity-70" data-testid="needs-popover-count">
              {count}
            </span>
          </span>
          <span className="ml-auto flex shrink-0">
            <NeedsScopeToggle />
          </span>
        </div>
        <div className="flex max-h-[min(480px,calc(100vh/var(--cf-zoom)-120px))] flex-col gap-0.5 overflow-y-auto">
          {ids.length === 0 ? (
            <p className="px-2 py-3 text-body-sm text-cf-text-muted" data-testid="needs-popover-empty">
              Nothing in this space needs you.
            </p>
          ) : (
            ids.map((id) => (
              <PopoverRow key={id} id={id} />
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
