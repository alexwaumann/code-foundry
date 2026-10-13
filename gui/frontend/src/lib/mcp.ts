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
export const MCP_LOGIN_HINT = "Needs login · run /mcp in a terminal thread, then reconnect";

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
