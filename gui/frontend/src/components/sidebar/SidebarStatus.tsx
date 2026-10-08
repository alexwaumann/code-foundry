import { DaemonStatus } from "@/components/status/DaemonStatus";
import { UpdateIndicator } from "@/components/update/UpdateIndicator";

/**
 * The bottom of the sidebar, on the sheet: a pending update (when there is one) above
 * the daemon's status. Hidden with the sidebar.
 */
export function SidebarStatus() {
  return (
    <div className="flex shrink-0 flex-col gap-0.5 px-3 pt-1 pb-1.5 text-[11px] text-muted-foreground" data-testid="sidebar-status">
      <UpdateIndicator />
      <div className="flex h-6 min-w-0 items-center gap-2">
        <DaemonStatus />
      </div>
    </div>
  );
}
