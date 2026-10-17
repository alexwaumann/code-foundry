/**
 * A thread's MCP servers (docs/notes/mcp-panel.md) mapped to view models.
 * Generated types stay in src/api. The daemon checks the servers at the start of every
 * turn (and after a reconnect); ThreadService.WatchThread carries each check (the snapshot's
 * `mcp`, then `mcp` events), so the panel reads them from the thread store.
 */
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { McpCheckTrigger, McpServerStatus, ThreadService, type McpServer, type ThreadMcpStatus } from "@/gen/codefoundry/v1/thread_pb";
import { daemon, type DaemonConnection } from "./endpoint";

export type McpServerStatusView = "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "unknown";
/** What made the daemon check: a turn's start, a refresh, or a reconnect of `server`. */
export type McpTriggerView = "turn" | "refresh" | "reconnect" | "unknown";

/** One tool. The hints are the ones the server set; not read-only means it may write. */
export interface McpToolView {
  name: string;
  /** "" when Claude sends none (claude.ai connectors). */
  description: string;
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
}

export interface McpServerView {
  /** The config key ("github", "claude.ai Gmail"). */
  name: string;
  status: McpServerStatusView;
  /** A connected server's own name and version ("" otherwise). */
  serverName: string;
  version: string;
  /** Why it failed. */
  error: string;
  /** user, project, local, dynamic, claudeai, … */
  scope: string;
  source: string;
  /** stdio, sse, http, sdk or claudeai-proxy; "" when only system/init listed it. */
  transport: string;
  tools: readonly McpToolView[];
}

export interface McpStatusView {
  /** When the daemon asked Claude; null when unknown. */
  checkedAtMs: number | null;
  trigger: McpTriggerView;
  /** The server reconnected (trigger "reconnect"). */
  server: string;
  servers: readonly McpServerView[];
}

const statuses: Record<McpServerStatus, McpServerStatusView> = {
  [McpServerStatus.UNSPECIFIED]: "unknown",
  [McpServerStatus.CONNECTED]: "connected",
  [McpServerStatus.FAILED]: "failed",
  [McpServerStatus.NEEDS_AUTH]: "needs-auth",
  [McpServerStatus.PENDING]: "pending",
  [McpServerStatus.DISABLED]: "disabled",
};

const triggers: Record<McpCheckTrigger, McpTriggerView> = {
  [McpCheckTrigger.UNSPECIFIED]: "unknown",
  [McpCheckTrigger.TURN_START]: "turn",
  [McpCheckTrigger.REFRESH]: "refresh",
  [McpCheckTrigger.RECONNECT]: "reconnect",
};

function toServerView(s: McpServer): McpServerView {
  return {
    name: s.name,
    status: s.status in statuses ? statuses[s.status] : "unknown", // a newer daemon's value: unknown
    serverName: s.serverName,
    version: s.version,
    error: s.error,
    scope: s.scope,
    source: s.source,
    transport: s.transport,
    tools: s.tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly, destructive: t.destructive, openWorld: t.openWorld })),
  };
}

/** The status as a view; null when unset (the thread is not running, or not checked). */
export function toMcpStatusView(s: ThreadMcpStatus | undefined): McpStatusView | null {
  if (!s) return null;
  return {
    checkedAtMs: s.checkedAt ? timestampMs(s.checkedAt) : null,
    trigger: s.trigger in triggers ? triggers[s.trigger] : "unknown",
    server: s.server,
    servers: s.servers.map(toServerView),
  };
}

/**
 * ThreadService.McpStatus without a refresh: the last check, or (for a connected thread
 * never checked) a first one, which also reaches the Watch as an `mcp` event. A read, not
 * a user action: the refresh button and Reconnect go through thread.mcp and
 * thread.mcp-reconnect.
 */
export async function getMcpStatus(threadId: string, conn: DaemonConnection = daemon): Promise<McpStatusView | null> {
  const c = await conn.client(ThreadService);
  const res = await c.mcpStatus({ threadId: threadId });
  return toMcpStatusView(res.status);
}
