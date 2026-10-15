import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Clock, Eye, Globe, LoaderCircle, Pencil, Plug, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import type { McpServerStatusView, McpToolView } from "@/api/mcp";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import {
  canReconnect,
  checkedLine,
  MCP_LOGIN_HINT,
  MCP_STATUS_LABEL,
  metaParts,
  needsAttention,
  TOOL_HINT_LABEL,
  toolCount,
  toolHints,
  type ToolHint,
} from "@/lib/mcp";
import { cn } from "@/lib/utils";
import { ensureMcpStatus, reconnectMcp, refreshMcp, useMcpHeader, useMcpReconnecting, useMcpRefreshing, useMcpServer, useMcpServerNames, useMcpStatus } from "@/stores/mcp";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

/** The thread this panel belongs to: the selected session ("" otherwise). */
function useThreadId(): string {
  return useUiStore((s) => (s.selection.kind === "session" ? s.selection.id : ""));
}

const DOT: Record<McpServerStatusView, string> = {
  connected: "bg-success",
  failed: "bg-destructive",
  "needs-auth": "bg-warning",
  pending: "bg-muted-foreground/60",
  disabled: "border-[1.5px] border-muted-foreground/50",
  unknown: "bg-muted-foreground/40",
};

const PILL: Record<McpServerStatusView, string> = {
  connected: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  "needs-auth": "bg-warning/15 text-warning",
  pending: "bg-muted text-muted-foreground",
  disabled: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground",
};

const HINT_ICON: Record<ToolHint, LucideIcon> = { "read-only": Eye, writes: Pencil, destructive: TriangleAlert, "open-world": Globe };

/** "Checked 12s ago, at the start of the last turn": its own component, so the clock re-renders only this line. */
function CheckedText({ checkedAtMs, trigger, server }: { checkedAtMs: number | null; trigger: Parameters<typeof checkedLine>[0]["trigger"]; server: string }) {
  const now = useNow(1000);
  return (
    <span className="min-w-0 truncate" data-testid="mcp-checked">
      {checkedLine({ checkedAtMs, trigger, server }, now)}
    </span>
  );
}

function Header({ threadId }: { threadId: string }) {
  const h = useMcpHeader(threadId);
  const refreshing = useMcpRefreshing(threadId);
  const connected = useSessionsStore((s) => s.byId[threadId]?.state === "connected");
  return (
    <header className="flex min-w-0 flex-col gap-0.5 border-b border-pane-border px-4 pt-2 pb-2.5 @max-[340px]:px-3" data-testid="mcp-header">
      <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
        <Plug className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="min-w-0 truncate">MCP servers</span>
        {h && (
          <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground tabular-nums" data-testid="mcp-count">
            {h.connected} of {h.total} connected
          </span>
        )}
      </h2>
      <span className="flex min-h-6 min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0" aria-hidden />
        {h ? <CheckedText checkedAtMs={h.checkedAtMs} trigger={h.trigger} server={h.server} /> : <span className="min-w-0 truncate">Not checked yet</span>}
        {/* The span carries the tooltip while the button is disabled (no pointer events). */}
        <Tip label="Refresh">
          <span className="ml-auto inline-flex shrink-0">
            <button
              type="button"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-accent/50"
              aria-label="Refresh MCP servers"
              disabled={!connected || refreshing}
              onClick={() => void refreshMcp(threadId)}
              data-testid="mcp-refresh"
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
            </button>
          </span>
        </Tip>
      </span>
    </header>
  );
}

/** A tool's hint icon; the tooltip names the hint (the icon alone hides it). */
function HintIcon({ hint }: { hint: ToolHint }) {
  const Icon = HINT_ICON[hint];
  const label = TOOL_HINT_LABEL[hint];
  return (
    <Tip label={label} data-testid="mcp-hint-tooltip">
      <span role="img" aria-label={label} className={cn("inline-flex", hint === "destructive" && "text-destructive")} data-testid="mcp-hint" data-hint={hint}>
        <Icon className="size-3" aria-hidden />
      </span>
    </Tip>
  );
}

function ToolRow({ tool }: { tool: McpToolView }) {
  return (
    <li className="flex h-6 min-w-0 items-center gap-2 pl-1 text-xs" data-testid="mcp-tool" data-tool={tool.name}>
      {/* The description gives way first; a name wider than the row truncates on its own. */}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Tip label={tool.name} whenTruncated>
          <span className="max-w-full shrink-0 truncate font-mono text-[11.5px]" data-testid="mcp-tool-name">
            {tool.name}
          </span>
        </Tip>
        {tool.description && (
          <Tip label={tool.description} whenTruncated>
            <span className="min-w-0 truncate text-muted-foreground">{tool.description}</span>
          </Tip>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        {toolHints(tool).map((h) => (
          <HintIcon key={h} hint={h} />
        ))}
      </span>
    </li>
  );
}

function ServerCard({ threadId, name }: { threadId: string; name: string }) {
  const server = useMcpServer(threadId, name);
  const reconnecting = useMcpReconnecting(threadId, name);
  const live = useSessionsStore((s) => s.byId[threadId]?.state === "connected");
  const [open, setOpen] = useState(false);
  if (!server) return null;
  // While a reconnect runs the card reads like a server still connecting.
  const shown: McpServerStatusView = reconnecting ? "pending" : server.status;
  const attention = needsAttention(server.status);
  const meta = metaParts(server);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-border px-3 pt-2.5 pb-2",
        shown === "failed" && "border-destructive/35",
        shown === "needs-auth" && "border-warning/35",
        shown === "disabled" && "opacity-65",
      )}
      data-testid="mcp-card"
      data-server={server.name}
      data-status={shown}
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        {shown === "pending" ? <LoaderCircle className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden /> : <span className={cn("size-2 shrink-0 rounded-full", DOT[shown])} aria-hidden />}
        {/* The pill always shows: the version gives way first, then the name truncates. */}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Tip label={server.name} whenTruncated>
            <span className="max-w-full shrink-0 truncate font-semibold" data-testid="mcp-name">
              {server.name}
            </span>
          </Tip>
          {server.version && (
            <Tip label={`v${server.version}`} whenTruncated>
              <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground" data-testid="mcp-version">
                v{server.version}
              </span>
            </Tip>
          )}
        </span>
        <span className={cn("shrink-0 rounded-full px-1.5 text-[10.5px] leading-4 font-medium whitespace-nowrap", PILL[shown])} data-testid="mcp-pill">
          {MCP_STATUS_LABEL[shown]}
        </span>
      </div>
      {meta.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground" data-testid="mcp-meta">
          {meta.map((p, i) => (
            <span key={p} className="contents">
              {i > 0 && <span className="opacity-50">·</span>}
              <span>{p}</span>
            </span>
          ))}
        </div>
      )}
      {server.error ? (
        <div className="font-mono text-[11.5px] leading-4 break-words text-destructive" data-testid="mcp-error">
          {server.error}
        </div>
      ) : server.status === "needs-auth" ? (
        <div className="text-xs leading-4 text-warning" data-testid="mcp-login-hint">
          {MCP_LOGIN_HINT}
        </div>
      ) : null}
      {(canReconnect(server.status) || server.tools.length > 0) && (
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          {canReconnect(server.status) && (
            <button
              type="button"
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60",
                attention
                  ? "border-warning/40 text-warning hover:bg-warning/10"
                  : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground dark:hover:bg-accent/50",
              )}
              disabled={reconnecting || !live}
              onClick={() => void reconnectMcp(threadId, server.name)}
              data-testid="mcp-reconnect"
            >
              {reconnecting ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
              Reconnect
            </button>
          )}
          {server.tools.length > 0 && (
            <button
              type="button"
              className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:hover:bg-accent/50"
              aria-expanded={open}
              onClick={() => {
                setOpen((o) => !o);
              }}
              data-testid="mcp-tools-toggle"
            >
              {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
              {toolCount(server.tools.length)}
            </button>
          )}
        </div>
      )}
      {open && server.tools.length > 0 && (
        <ul className="mt-1 flex min-w-0 flex-col border-t border-border pt-1.5" data-testid="mcp-tools">
          {server.tools.map((t) => (
            <ToolRow key={t.name} tool={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Message({ testId, children }: { testId: string; children: string }) {
  return (
    <p className="px-4 py-3 text-sm text-muted-foreground @max-[340px]:px-3" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * The side panel's MCP surface (docs/sketches/mcp-panel variant B, docs/notes/mcp-panel.md):
 * the selected thread's MCP servers as Claude last reported them, one card each
 * (name, version, status pill; scope · transport · tools; the error or the login hint;
 * Reconnect and the tools disclosure), under a header with the connected count, when the
 * servers were checked, and a refresh button.
 */
export function McpSurface() {
  const threadId = useThreadId();
  const known = useSessionsStore((s) => threadId !== "" && threadId in s.byId);
  const connected = useSessionsStore((s) => s.byId[threadId]?.state === "connected");
  const status = useMcpStatus(threadId);
  const names = useMcpServerNames(threadId);
  const missing = status === null;
  useEffect(() => {
    if (known && connected && missing) ensureMcpStatus(threadId);
  }, [threadId, known, connected, missing]);

  if (!known) return <Message testId="mcp-missing">Select a thread to see its MCP servers.</Message>;
  return (
    // @container: tightens the padding when the panel is narrow (down to 280px).
    <div className="@container flex min-w-0 flex-col" data-testid="mcp-surface" data-thread={threadId}>
      <Header threadId={threadId} />
      {status === undefined ? (
        <Message testId="mcp-loading">Loading…</Message>
      ) : status === null ? (
        <Message testId="mcp-empty">{connected ? "Checking MCP servers…" : "The thread is not running. Reconnect it to see its MCP servers."}</Message>
      ) : names.length === 0 ? (
        <Message testId="mcp-none">Claude has no MCP servers in this thread.</Message>
      ) : (
        <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5 @max-[340px]:px-2" data-testid="mcp-cards">
          {names.map((n) => (
            <ServerCard key={n} threadId={threadId} name={n} />
          ))}
        </div>
      )}
    </div>
  );
}
