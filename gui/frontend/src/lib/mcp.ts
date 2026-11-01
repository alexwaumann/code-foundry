/**
 * The MCP surface's pure helpers (docs/notes/mcp-panel.md, docs/sketches/mcp-panel variant
 * B): labels, the meta line, the "Checked … ago" line, and structural sharing so a new
 * check re-renders only the cards whose server changed.
 */
import type { McpServerStatusView, McpServerView, McpStatusView, McpToolView } from "@/api/mcp";

/** The status pill's words. */
export const MCP_STATUS_LABEL: Readonly<Record<McpServerStatusView, string>> = {
  connected: "Connected",
  failed: "Failed",
  "needs-auth": "Needs login",
  pending: "Connecting…",
  disabled: "Disabled",
  unknown: "Unknown",
};

/** The line under a needs-login card: Claude cannot log in headlessly. */
export const MCP_LOGIN_HINT = "Needs login · run claude in a shell and use /mcp, then reconnect";

/** Reconnect is offered for every server but a connecting or disabled one. */
export function canReconnect(status: McpServerStatusView): boolean {
  return status !== "pending" && status !== "disabled";
}

/** Failed and needs-login servers want the user: amber button, tinted border. */
export function needsAttention(status: McpServerStatusView): boolean {
  return status === "failed" || status === "needs-auth";
}

/** "1 tool", "24 tools". */
export function toolCount(n: number): string {
  return `${String(n)} ${n === 1 ? "tool" : "tools"}`;
}

/** A transport as shown: claude.ai's proxy reads "claude.ai". */
export function transportLabel(t: string): string {
  return t === "claudeai-proxy" ? "claude.ai" : t;
}

/** The card's meta line parts: scope · transport · N tools (tools only when connected). */
export function metaParts(s: Pick<McpServerView, "scope" | "transport" | "status" | "tools">): string[] {
  const parts = [s.scope, transportLabel(s.transport)];
  if (s.status === "connected") parts.push(toolCount(s.tools.length));
  return parts.filter((p) => p !== "");
}

/** "N of M connected". */
export function connectedSummary(servers: readonly Pick<McpServerView, "status">[]): string {
  const n = servers.filter((s) => s.status === "connected").length;
  return `${String(n)} of ${String(servers.length)} connected`;
}

/**
 * The panel's tabs (docs/notes/mcp-panel-tabs.md), always all three in this order:
 * Connected (connecting included), Failed (needs login and an unknown status included:
 * neither is up), Disabled.
 */
export type McpBucket = "connected" | "failed" | "disabled";

export const MCP_BUCKETS: readonly McpBucket[] = ["connected", "failed", "disabled"];

export const MCP_BUCKET_LABEL: Readonly<Record<McpBucket, string>> = { connected: "Connected", failed: "Failed", disabled: "Disabled" };

/** A tab's empty state. */
export const MCP_BUCKET_EMPTY: Readonly<Record<McpBucket, string>> = {
  connected: "No connected servers.",
  failed: "No failed servers. Nothing needs a login.",
  disabled: "No disabled servers.",
};

/** What settles the check: a server still connecting, a refresh or a reconnect in flight. */
export interface McpSettlingInput {
  /** Any server's status is pending (a freshly started Claude reports cached servers so first, binary-read-cap-and-mcp-settle §B). */
  pending: boolean;
  refreshing: boolean;
  reconnecting: boolean;
}

/** The line under an empty tab while the check still settles, in place of the tab's own. */
export const MCP_SETTLING_LINE = "Checking MCP servers…";

/**
 * An empty tab's line (MCP_BUCKET_EMPTY), or MCP_SETTLING_LINE while a check settles: a
 * refresh or reconnect on a stopped thread first reports every server as connecting, so
 * the Failed tab empties for a few seconds; saying nothing failed then would be false.
 */
export function bucketEmptyLine(bucket: McpBucket, s: McpSettlingInput): string {
  return s.pending || s.refreshing || s.reconnecting ? MCP_SETTLING_LINE : MCP_BUCKET_EMPTY[bucket];
}

/** The tab a server's status lists it under. */
export function mcpBucket(status: McpServerStatusView): McpBucket {
  switch (status) {
    case "connected":
    case "pending":
      return "connected";
    case "disabled":
      return "disabled";
    default:
      return "failed";
  }
}

/** How many servers each tab lists. */
export function bucketCounts(servers: readonly Pick<McpServerView, "status">[]): Record<McpBucket, number> {
  const out: Record<McpBucket, number> = { connected: 0, failed: 0, disabled: 0 };
  for (const s of servers) out[mcpBucket(s.status)]++;
  return out;
}

/** "just now", "12s ago", "3 min ago", "2 h ago", "4 d ago"; "" for an unknown time. */
export function checkedAgo(ms: number | null, now: number): string {
  if (ms === null) return "";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)} h ago`;
  return `${String(Math.floor(h / 24))} d ago`;
}

/**
 * The header's second line: when the servers were checked and why. "Checked 12s ago, at
 * the start of the last turn", "Checked just now, after reconnecting github", "Checked
 * 3 min ago".
 */
export function checkedLine(s: Pick<McpStatusView, "checkedAtMs" | "trigger" | "server">, now: number): string {
  const ago = checkedAgo(s.checkedAtMs, now);
  const head = ago ? `Checked ${ago}` : "Checked";
  switch (s.trigger) {
    case "turn":
      return `${head}, at the start of the last turn`;
    case "reconnect":
      return s.server ? `${head}, after reconnecting ${s.server}` : head;
    default:
      return head;
  }
}

/** A check older than this may be out of date even while Claude runs (a server can drop between turns). */
export const MCP_STALE_AFTER_MS = 10 * 60_000;

/** What the stale state reads: the last check's time, whether Claude runs for the thread, a refresh in flight. */
export interface McpStaleInput {
  checkedAtMs: number | null;
  /** The thread's state is connected or starting (claudeRunning). */
  running: boolean;
  refreshing: boolean;
}

/** Claude runs for the thread (or is starting): only then does it check its servers, every turn. */
export function claudeRunning(state: string | undefined): boolean {
  return state === "connected" || state === "starting";
}

/**
 * Whether the shown status may be out of date (docs/notes/panel-polish.md): Claude is not
 * running for the thread (nothing checks until a refresh or the next turn starts it), or
 * the last check is MCP_STALE_AFTER_MS old or more. Never while a refresh is in flight:
 * its answer is on its way. An unknown check time is stale only when Claude is not running.
 */
export function mcpStale(s: McpStaleInput, now: number): boolean {
  if (s.refreshing) return false;
  if (!s.running) return true;
  return s.checkedAtMs !== null && now - s.checkedAtMs >= MCP_STALE_AFTER_MS;
}

/** The stale header's line: "Last check 12 min ago · may be out of date". */
export function staleLine(checkedAtMs: number | null, now: number): string {
  const ago = checkedAgo(checkedAtMs, now);
  return ago ? `Last check ${ago} · may be out of date` : "May be out of date";
}

/** The tool's hint icons, left to right, with their tooltips. */
export type ToolHint = "read-only" | "writes" | "destructive" | "open-world";

export const TOOL_HINT_LABEL: Readonly<Record<ToolHint, string>> = {
  "read-only": "Read-only",
  writes: "Writes",
  destructive: "Destructive",
  "open-world": "Open-world (reaches outside the server)",
};

/** A tool's hints: read-only (eye) or writes (pencil), then destructive and open-world. */
export function toolHints(t: Pick<McpToolView, "readOnly" | "destructive" | "openWorld">): ToolHint[] {
  const out: ToolHint[] = [t.readOnly ? "read-only" : "writes"];
  if (t.destructive) out.push("destructive");
  if (t.openWorld) out.push("open-world");
  return out;
}

function sameTool(a: McpToolView, b: McpToolView): boolean {
  return a.name === b.name && a.description === b.description && a.readOnly === b.readOnly && a.destructive === b.destructive && a.openWorld === b.openWorld;
}

/** Structural equality of two servers (every field, tools by value). */
export function sameServer(a: McpServerView, b: McpServerView): boolean {
  if (a === b) return true;
  return (
    a.name === b.name &&
    a.status === b.status &&
    a.serverName === b.serverName &&
    a.version === b.version &&
    a.error === b.error &&
    a.scope === b.scope &&
    a.source === b.source &&
    a.transport === b.transport &&
    a.tools.length === b.tools.length &&
    a.tools.every((t, i) => sameTool(t, b.tools[i] as McpToolView))
  );
}

/**
 * `next` with the servers that did not change kept from `prev` by identity (a check
 * every turn mostly finds nothing new), and `prev` itself when nothing changed at all.
 */
export function shareMcp(prev: McpStatusView | null, next: McpStatusView | null): McpStatusView | null {
  if (!prev || !next) return next;
  const byName = new Map(prev.servers.map((s) => [s.name, s]));
  const servers = next.servers.map((s) => {
    const old = byName.get(s.name);
    return old && sameServer(old, s) ? old : s;
  });
  const sameList = servers.length === prev.servers.length && servers.every((s, i) => s === prev.servers[i]);
  if (sameList && prev.checkedAtMs === next.checkedAtMs && prev.trigger === next.trigger && prev.server === next.server) return prev;
  return { ...next, servers: sameList ? prev.servers : servers };
}
