import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Clock, Eye, Globe, LoaderCircle, Pencil, Plug, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";
import type { McpServerStatusView, McpToolView } from "@/api/mcp";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import {
  canReconnect,
  checkedLine,
  claudeRunning,
  MCP_LOGIN_HINT,
  MCP_STATUS_LABEL,
  metaParts,
  needsAttention,
  staleLine,
  TOOL_HINT_LABEL,
  toolCount,
  toolHints,
  type ToolHint,
} from "@/lib/mcp";
import { cn } from "@/lib/utils";
import { ensureMcpStatus, reconnectMcp, refreshMcp, useMcpHeader, useMcpReconnecting, useMcpRefreshing, useMcpServer, useMcpServerNames, useMcpStale, useMcpStatus } from "@/stores/mcp";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";

/** The thread this panel belongs to: the selected thread ("" otherwise). */
function useThreadId(): string {
  return useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : ""));
}

const DOT: Record<McpServerStatusView, string> = {
  connected: "bg-cf-success",
  failed: "bg-cf-error",
  "needs-auth": "bg-cf-warning",
  pending: "bg-cf-text-muted/60",
  disabled: "border-[1.5px] border-cf-text-muted/50",
  unknown: "bg-cf-text-muted/40",
};

const PILL: Record<McpServerStatusView, string> = {
  connected: "bg-cf-success-surface text-cf-success",
  failed: "bg-cf-error-surface text-cf-error",
  "needs-auth": "bg-cf-warning-surface text-cf-warning",
  pending: "bg-cf-surface-sunken text-cf-text-muted",
  disabled: "bg-cf-surface-sunken text-cf-text-muted",
  unknown: "bg-cf-surface-sunken text-cf-text-muted",
};

/** A stale card's pill: muted with a dashed outline, so no status reads as current. */
const STALE_PILL = "border border-dashed border-cf-text-muted/50 text-cf-text-muted";

const HINT_ICON: Record<ToolHint, LucideIcon> = { "read-only": Eye, writes: Pencil, destructive: TriangleAlert, "open-world": Globe };

/**
 * "Checked 12s ago, at the start of the last turn", or when stale "Last check 12 min ago ·
 * may be out of date": its own component, so the clock re-renders only this line.
 */
function CheckedText({ checkedAtMs, trigger, server, stale }: { checkedAtMs: number | null; trigger: Parameters<typeof checkedLine>[0]["trigger"]; server: string; stale: boolean }) {
  const now = useNow(1000);
  return (
    <span className="min-w-0 truncate" data-testid="mcp-checked">
      {stale ? staleLine(checkedAtMs, now) : checkedLine({ checkedAtMs, trigger, server }, now)}
    </span>
  );
}

const REFRESH_LABEL = "Refresh MCP servers";

/**
 * The header (docs/notes/mcp-panel.md). Stale (lib/mcp mcpStale, docs/notes/panel-polish.md):
 * the checked line turns amber and says the status may be out of date, and Refresh
 * becomes a labelled primary button, the one thing to do next.
 */
function Header({ threadId, stale }: { threadId: string; stale: boolean }) {
  const h = useMcpHeader(threadId);
  const refreshing = useMcpRefreshing(threadId);
  return (
    <header className="flex min-w-0 flex-col gap-0.5 border-b border-cf-divider px-4 pt-2 pb-2.5 @max-[340px]:px-3" data-testid="mcp-header" data-stale={stale || undefined}>
      <h2 className="flex min-w-0 items-center gap-1.5 text-heading">
        <Plug className="size-4 shrink-0 text-cf-warning" aria-hidden />
        <span className="min-w-0 truncate">MCP servers</span>
        {h && (
          <span className="ml-auto shrink-0 text-caption tabular-nums" data-testid="mcp-count">
            {h.connected} of {h.total} connected
          </span>
        )}
      </h2>
      <span className={cn("flex min-h-6 min-w-0 items-center gap-1.5 text-caption", stale && "text-cf-warning")} data-testid="mcp-checked-line">
        <Clock className="size-3.5 shrink-0" aria-hidden />
        {h ? <CheckedText checkedAtMs={h.checkedAtMs} trigger={h.trigger} server={h.server} stale={stale} /> : <span className="min-w-0 truncate">Not checked yet</span>}
        {stale ? (
          // Never stale while a refresh runs, so this one is never disabled; its word is its label.
          <Button size="xs" className="ml-auto" aria-label={REFRESH_LABEL} onClick={() => void refreshMcp(threadId)} data-testid="mcp-refresh" data-cta="">
            <RefreshCw aria-hidden />
            Refresh
          </Button>
        ) : (
          // The span carries the tooltip while the button is disabled (no pointer events).
          <Tip label="Refresh">
            <span className="ml-auto inline-flex shrink-0">
              <button
                type="button"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-cf-control-hover/50"
                aria-label={REFRESH_LABEL}
                disabled={refreshing}
                onClick={() => void refreshMcp(threadId)}
                data-testid="mcp-refresh"
              >
                <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
              </button>
            </span>
          </Tip>
        )}
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
      <span role="img" aria-label={label} className={cn("inline-flex", hint === "destructive" && "text-cf-error")} data-testid="mcp-hint" data-hint={hint}>
        <Icon className="size-3" aria-hidden />
      </span>
    </Tip>
  );
}

function ToolRow({ tool }: { tool: McpToolView }) {
  return (
    <li className="flex h-6 min-w-0 items-center gap-2 pl-1 text-body-sm" data-testid="mcp-tool" data-tool={tool.name}>
      {/* The description gives way first; a name wider than the row truncates on its own. */}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Tip label={tool.name} whenTruncated>
          <span className="max-w-full shrink-0 truncate text-code" data-testid="mcp-tool-name">
            {tool.name}
          </span>
        </Tip>
        {tool.description && (
          <Tip label={tool.description} whenTruncated>
            <span className="min-w-0 truncate text-cf-text-muted">{tool.description}</span>
          </Tip>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1 text-cf-text-muted">
        {toolHints(tool).map((h) => (
          <HintIcon key={h} hint={h} />
        ))}
      </span>
    </li>
  );
}

/** One server. Stale (the header says why), its pill is muted and dashed: the status is the last one seen, not a current one. */
function ServerCard({ threadId, name, stale }: { threadId: string; name: string; stale: boolean }) {
  const server = useMcpServer(threadId, name);
  const reconnecting = useMcpReconnecting(threadId, name);
  const [open, setOpen] = useState(false);
  if (!server) return null;
  // While a reconnect runs the card reads like a server still connecting.
  const shown: McpServerStatusView = reconnecting ? "pending" : server.status;
  const attention = needsAttention(server.status);
  const meta = metaParts(server);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-lg border border-cf-border px-3 pt-2.5 pb-2",
        shown === "failed" && "border-cf-error/35",
        shown === "needs-auth" && "border-cf-warning/35",
        shown === "disabled" && "opacity-65",
      )}
      data-testid="mcp-card"
      data-server={server.name}
      data-status={shown}
    >
      <div className="flex min-w-0 items-center gap-2 text-body-sm">
        {shown === "pending" ? <LoaderCircle className="size-3 shrink-0 animate-spin text-cf-text-muted" aria-hidden /> : <span className={cn("size-2 shrink-0 rounded-full", DOT[shown])} aria-hidden />}
        {/* The pill always shows: the version gives way first, then the name truncates. */}
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Tip label={server.name} whenTruncated>
            <span className="max-w-full shrink-0 truncate text-subheading" data-testid="mcp-name">
              {server.name}
            </span>
          </Tip>
          {server.version && (
            <Tip label={`v${server.version}`} whenTruncated>
              <span className="min-w-0 truncate text-code text-cf-text-muted" data-testid="mcp-version">
                v{server.version}
              </span>
            </Tip>
          )}
        </span>
        <span className={cn("shrink-0 rounded-full px-1.5 text-caption-sm font-medium whitespace-nowrap", stale ? STALE_PILL : PILL[shown])} data-testid="mcp-pill" data-stale={stale || undefined}>
          {MCP_STATUS_LABEL[shown]}
        </span>
      </div>
      {meta.length > 0 && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-caption" data-testid="mcp-meta">
          {meta.map((p, i) => (
            <span key={p} className="contents">
              {i > 0 && <span className="opacity-50">·</span>}
              <span>{p}</span>
            </span>
          ))}
        </div>
      )}
      {server.error ? (
        <div className="text-caption-sm font-mono break-words text-cf-error" data-testid="mcp-error">
          {server.error}
        </div>
      ) : server.status === "needs-auth" ? (
        <div className="text-caption text-cf-warning" data-testid="mcp-login-hint">
          {MCP_LOGIN_HINT}
        </div>
      ) : null}
      {(canReconnect(server.status) || server.tools.length > 0) && (
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          {canReconnect(server.status) && (
            <button
              type="button"
              className={cn(
                "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-body-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 disabled:pointer-events-none disabled:opacity-60",
                attention
                  ? "border-cf-warning/40 text-cf-warning hover:bg-cf-warning-surface"
                  : "border-transparent text-cf-text-muted hover:bg-cf-control-hover hover:text-cf-text dark:hover:bg-cf-control-hover/50",
              )}
              disabled={reconnecting}
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
              className="ml-auto inline-flex h-6 items-center gap-1 rounded-md px-2 text-body-sm font-medium text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-[3px] focus-visible:ring-cf-focus/50 dark:hover:bg-cf-control-hover/50"
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
        <ul className="mt-1 flex min-w-0 flex-col border-t border-cf-border pt-1.5" data-testid="mcp-tools">
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
    <p className="px-4 py-3 text-body text-cf-text-muted @max-[340px]:px-3" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * The side panel's MCP surface (docs/sketches/mcp-panel variant B, docs/notes/mcp-panel.md):
 * the selected thread's MCP servers as Claude last reported them, one card each
 * (name, version, status pill; scope · transport · tools; the error or the login hint;
 * Reconnect and the tools disclosure), under a header with the connected count, when the
 * servers were checked, and a refresh button; stale (Claude not running, or the check
 * 10 min old) the header turns amber, the pills go muted and dashed, and Refresh is the
 * primary button. Refresh and Reconnect work whether or not
 * Claude runs for the thread (the daemon starts it for them); its last status outlives
 * the process.
 */
export function McpSurface() {
  const threadId = useThreadId();
  const known = useThreadsStore((s) => threadId !== "" && threadId in s.byId);
  // Internal only: a running Claude answers the status ask below, so the empty state says
  // a check is on its way; a stopped one has nothing new to say until a refresh.
  const asking = useThreadsStore((s) => claudeRunning(s.byId[threadId]?.state));
  const refreshing = useMcpRefreshing(threadId);
  const stale = useMcpStale(threadId);
  const status = useMcpStatus(threadId);
  const names = useMcpServerNames(threadId);
  const missing = status === null;
  useEffect(() => {
    if (known && missing) ensureMcpStatus(threadId);
  }, [threadId, known, missing]);

  if (!known) return <Message testId="mcp-missing">Select a thread to see its MCP servers.</Message>;
  return (
    // @container: tightens the padding when the panel is narrow (down to 280px).
    <div className="@container flex min-w-0 flex-col" data-testid="mcp-surface" data-thread={threadId}>
      <Header threadId={threadId} stale={stale} />
      {status === undefined ? (
        <Message testId="mcp-loading">Loading…</Message>
      ) : status === null ? (
        <Message testId="mcp-empty">{asking || refreshing ? "Checking MCP servers…" : "No MCP status yet. Refresh to check."}</Message>
      ) : names.length === 0 ? (
        <Message testId="mcp-none">Claude has no MCP servers in this thread.</Message>
      ) : (
        <div className="flex min-w-0 flex-col gap-2 px-3 py-2.5 @max-[340px]:px-2" data-testid="mcp-cards">
          {names.map((n) => (
            <ServerCard key={n} threadId={threadId} name={n} stale={stale} />
          ))}
        </div>
      )}
    </div>
  );
}
