import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Plug, RefreshCw } from "lucide-react";
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { mcpCounts } from "@/lib/threadInfo";
import { cn } from "@/lib/utils";
import { reconnectMcp, refreshMcp } from "@/stores/mcp";
import { openMcpSurface } from "@/stores/mcpPanel";
import { useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { Group, Row, RowMenu } from "./Row";

const SEP = "\u0000";

/**
 * The thread's MCP servers while its Claude runs: "N servers connected", or the connected
 * count with, in the value column, those needing a login (amber) and the failed ones (red).
 * A click opens the MCP tab; the value and the chevron (one zone) open the menu, which
 * refreshes the check or reconnects a failed server.
 */
export function McpGroup({ threadId }: { threadId: string }) {
  const connected = useThreadsStore((s) => s.byId[threadId]?.state === "connected");
  const servers = useThreadStore(useShallow((s) => (s.logs[threadId]?.mcp?.servers ?? []).map((x) => x.name + SEP + x.status)));
  const [open, setOpen] = useState(false);
  const counts = mcpCounts(servers.map((x) => x.split(SEP)[1] ?? ""));
  if (!connected || !counts) return null;
  const failed = servers.flatMap((x) => {
    const [name = "", status = ""] = x.split(SEP);
    return status === "failed" ? [name] : [];
  });
  const clean = counts.failed === 0 && counts.needsLogin === 0;
  return (
    <Group testId="ti-mcp-group">
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Row
            icon={<Plug className={cn(counts.failed > 0 ? "text-cf-error-text" : counts.needsLogin > 0 && "text-cf-warning-text")} />}
            chevron={open ? "open" : "closed"}
            onActivate={() => {
              openMcpSurface();
            }}
            menuOnChevron
            menuOnMeta
            meta={
              !clean && (
                <>
                  {counts.needsLogin > 0 && (
                    <span className="text-cf-warning-text" data-testid="ti-mcp-needs-login">
                      {counts.needsLogin} needs login
                    </span>
                  )}
                  {counts.failed > 0 && (
                    <span className="text-cf-error-text" data-testid="ti-mcp-failed">
                      {counts.failed} failed
                    </span>
                  )}
                </>
              )
            }
            testId="ti-mcp"
          >
            {clean ? (
              <>
                {counts.total} {counts.total === 1 ? "server" : "servers"} <span className="text-cf-text-muted">connected</span>
              </>
            ) : (
              <>
                {counts.connected} <span className="text-cf-text-muted">connected</span>
              </>
            )}
          </Row>
        </DropdownMenuTrigger>
        <RowMenu testId="ti-mcp-menu">
          <DropdownMenuItem onSelect={() => void refreshMcp(threadId)} data-testid="ti-mcp-refresh">
            <RefreshCw aria-hidden />
            Refresh
          </DropdownMenuItem>
          {failed.length > 0 && <DropdownMenuSeparator />}
          {failed.map((name) => (
            <DropdownMenuItem key={name} onSelect={() => void reconnectMcp(threadId, name)} data-testid="ti-mcp-reconnect" data-server={name}>
              Reconnect {name}
            </DropdownMenuItem>
          ))}
        </RowMenu>
      </DropdownMenu>
    </Group>
  );
}
