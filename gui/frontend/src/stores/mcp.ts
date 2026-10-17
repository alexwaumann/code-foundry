/**
 * A thread's MCP servers for the MCP surface (docs/notes/mcp-panel.md). The status
 * itself lives in the thread store's log (fed by the thread's ThreadService.WatchThread, which
 * is open whenever the thread is selected); this store holds what the GUI is doing to it:
 * reconnects and refreshes in flight. Both are registry commands (thread.mcp-reconnect,
 * thread.mcp --refresh) run with the thread's context; their answers reach the panel
 * through the Watch like any other check.
 */
import { toast } from "sonner";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { getMcpStatus, type McpServerView, type McpStatusView } from "@/api/mcp";
import { errorMessage } from "@/api/stream";
import { runCommandForResult } from "./commands";
import { sessionContext } from "./threadActions";
import { useThreadStore } from "./thread";

export const MCP_COMMANDS = { status: "thread.mcp", reconnect: "thread.mcp-reconnect" } as const;

interface McpState {
  /** Servers being reconnected, by thread and server name. */
  reconnecting: Readonly<Record<string, Readonly<Record<string, true>>>>;
  /** Threads whose servers are being re-checked (the header's refresh). */
  refreshing: Readonly<Record<string, true>>;
}

export const useMcpStore = create<McpState>()(() => ({ reconnecting: {}, refreshing: {} }));

const NO_NAMES: readonly string[] = [];

/** The thread's MCP status: undefined before its Watch's snapshot, null when it has none. */
export function useMcpStatus(sessionId: string): McpStatusView | null | undefined {
  return useThreadStore((s) => (s.logs[sessionId] ? s.logs[sessionId].mcp : undefined));
}

/** The servers' names in Claude's order (shallow-stable across checks that change nothing). */
export function useMcpServerNames(sessionId: string): readonly string[] {
  return useThreadStore(useShallow((s) => s.logs[sessionId]?.mcp?.servers.map((x) => x.name) ?? NO_NAMES));
}

/** One server (narrow: a check keeps unchanged servers by identity, lib/mcp shareMcp). */
export function useMcpServer(sessionId: string, name: string): McpServerView | undefined {
  return useThreadStore((s) => s.logs[sessionId]?.mcp?.servers.find((x) => x.name === name));
}

/** The header's figures: when and why checked, how many connected of how many. */
export function useMcpHeader(sessionId: string): { checkedAtMs: number | null; trigger: McpStatusView["trigger"]; server: string; connected: number; total: number } | null {
  return useThreadStore(
    useShallow((s) => {
      const m = s.logs[sessionId]?.mcp;
      if (!m) return null;
      return { checkedAtMs: m.checkedAtMs, trigger: m.trigger, server: m.server, connected: m.servers.filter((x) => x.status === "connected").length, total: m.servers.length };
    }),
  );
}

export function useMcpReconnecting(sessionId: string, name: string): boolean {
  return useMcpStore((s) => s.reconnecting[sessionId]?.[name] === true);
}

export function useMcpRefreshing(sessionId: string): boolean {
  return useMcpStore((s) => s.refreshing[sessionId] === true);
}

function setReconnecting(sessionId: string, name: string, on: boolean): void {
  useMcpStore.setState((s) => {
    const cur: Record<string, true> = Object.fromEntries(Object.entries(s.reconnecting[sessionId] ?? {}).filter(([k]) => k !== name));
    if (on) cur[name] = true;
    return { reconnecting: { ...s.reconnecting, [sessionId]: cur } };
  });
}

function setRefreshing(sessionId: string, on: boolean): void {
  useMcpStore.setState((s) => {
    const { [sessionId]: _was, ...rest } = s.refreshing;
    return { refreshing: on ? { ...rest, [sessionId]: true } : rest };
  });
}

/** The error of a thread.mcp-reconnect result (McpReconnectResponse.error), "" when it went through. */
export function reconnectError(resultJson: string): string {
  try {
    const v = JSON.parse(resultJson) as { error?: unknown };
    return typeof v.error === "string" ? v.error : "";
  } catch {
    return "";
  }
}

/**
 * Reconnects one server (thread.mcp-reconnect). While it runs the card says Connecting…
 * with a spinner on its button. A server that still fails is toasted with Claude's reason
 * (the card shows it too, from the check that follows). Resolves whether it connected.
 */
export async function reconnectMcp(sessionId: string, name: string): Promise<boolean> {
  if (useMcpStore.getState().reconnecting[sessionId]?.[name]) return false;
  setReconnecting(sessionId, name, true);
  try {
    const res = await runCommandForResult(MCP_COMMANDS.reconnect, { id: sessionId, server: name }, { ctx: sessionContext(sessionId), quiet: true });
    if (!res) return false;
    const err = reconnectError(res.resultJson);
    if (err) toast.error(`Could not reconnect ${name}`, { description: err });
    return err === "";
  } finally {
    setReconnecting(sessionId, name, false);
  }
}

/** Re-checks the thread's servers (thread.mcp --refresh, the header's button). */
export async function refreshMcp(sessionId: string): Promise<boolean> {
  if (useMcpStore.getState().refreshing[sessionId]) return false;
  setRefreshing(sessionId, true);
  try {
    return (await runCommandForResult(MCP_COMMANDS.status, { id: sessionId, refresh: "true" }, { ctx: sessionContext(sessionId), quiet: true })) !== null;
  } finally {
    setRefreshing(sessionId, false);
  }
}

/**
 * Asks a thread whose servers the Watch has no status for once (ThreadService.McpStatus
 * without refresh: a running Claude is asked, a stopped thread starts nothing); the answer
 * arrives through the Watch. The surface calls it from an effect keyed on the thread and
 * whether a status is there, so it does not repeat.
 */
export function ensureMcpStatus(sessionId: string): void {
  const log = useThreadStore.getState().logs[sessionId];
  if (!log || log.mcp !== null) return;
  getMcpStatus(sessionId).catch((err: unknown) => {
    console.warn("mcp status", errorMessage(err));
  });
}
