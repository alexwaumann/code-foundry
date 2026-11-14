import { Plus } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { SearchNav } from "@/components/search/SearchNav";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

/**
 * New thread (thread.new) as the first row of the sidebar's menu, above search and drawn like
 * it: a muted plus, the row's text role, the rows' hover, and
 * the selected colour while the new-thread composer shows. Runs exactly what the palette
 * does (the project picker). docs/notes/sidebar-new-thread-row.md.
 */
export function SidebarNewThread() {
  const current = useUiStore((s) => s.selection.kind === "compose");
  return (
    <CommandButton
      command="thread.new"
      variant="ghost"
      whenUnavailable="disable"
      current={current}
      className={cn(
        "h-7 w-full shrink-0 justify-start gap-2 px-2 text-body-sm font-normal text-cf-sidebar-foreground hover:text-cf-sidebar-foreground has-[>svg]:px-2 [--wails-draggable:no-drag]",
        current
          ? "bg-cf-sidebar-row-selected hover:bg-cf-sidebar-row-selected dark:hover:bg-cf-sidebar-row-selected"
          : "hover:bg-cf-sidebar-row-hover dark:hover:bg-cf-sidebar-row-hover",
      )}
      data-testid="sidebar-new-thread"
    >
      <Plus aria-hidden className="size-4 shrink-0 text-cf-icon-muted" />
      <span className="min-w-0 flex-1 truncate text-left">New thread</span>
    </CommandButton>
  );
}

/**
 * The menu pane at the top of the sidebar: New thread and, while an agent search has something
 * to say, its row (Pull Requests and Projects are tabs, opened from a pane's "+" and the palette), in a small pane drawn like the content pane beside it (surface fill, divider border, pane
 * radius), so the app's pages read apart from the thread list below. It runs from the
 * body's left gutter to the sidebar's edge, a shell gap from the window and from the
 * content pane. The rows keep rounded-md: 4px inside a 12px corner wants 8, which the
 * radius scale does not have. 8px below it (mb-2) comes Ember's row when it shows, then the
 * thread list, whose 4px paddingStart sits above its first row. docs/notes/sidebar-menu-pane.md.
 */
export function SidebarMenu() {
  return (
    <div className="mb-2 flex shrink-0 flex-col rounded-pane border border-cf-divider bg-cf-surface p-1 [--wails-draggable:no-drag]" data-testid="sidebar-menu">
      <SidebarNewThread />
      <nav className="flex shrink-0 flex-col" aria-label="Pages">
        <SearchNav />
      </nav>
    </div>
  );
}
