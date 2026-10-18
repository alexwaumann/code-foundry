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
import { useNowSelect } from "@/lib/clock";
import { claudeRunning, mcpStale } from "@/lib/mcp";
import { runCommandForResult } from "./commands";
import { threadContext } from "./threadActions";
import { useThreadStore } from "./thread";
import { useThreadsStore } from "./threads";

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
export function useMcpStatus(threadId: string): McpStatusView | null | undefined {
  return useThreadStore((s) => (s.logs[threadId] ? s.logs[threadId].mcp : undefined));
}

/** The servers' names in Claude's order (shallow-stable across checks that change nothing). */
export function useMcpServerNames(threadId: string): readonly string[] {
  return useThreadStore(useShallow((s) => s.logs[threadId]?.mcp?.servers.map((x) => x.name) ?? NO_NAMES));
}

/** One server (narrow: a check keeps unchanged servers by identity, lib/mcp shareMcp). */
export function useMcpServer(threadId: string, name: string): McpServerView | undefined {
  return useThreadStore((s) => s.logs[threadId]?.mcp?.servers.find((x) => x.name === name));
}

/** The header's figures: when and why checked, how many connected of how many. */
export function useMcpHeader(threadId: string): { checkedAtMs: number | null; trigger: McpStatusView["trigger"]; server: string; connected: number; total: number } | null {
  return useThreadStore(
    useShallow((s) => {
      const m = s.logs[threadId]?.mcp;
      if (!m) return null;
      return { checkedAtMs: m.checkedAtMs, trigger: m.trigger, server: m.server, connected: m.servers.filter((x) => x.status === "connected").length, total: m.servers.length };
    }),
  );
}

export function useMcpReconnecting(threadId: string, name: string): boolean {
  return useMcpStore((s) => s.reconnecting[threadId]?.[name] === true);
}

export function useMcpRefreshing(threadId: string): boolean {
  return useMcpStore((s) => s.refreshing[threadId] === true);
}

/** How often the stale state re-reads the clock: it flips at most this late after the check turns 10 min old. */
const STALE_TICK_MS = 5000;

/**
 * Whether the thread's MCP status may be out of date (lib/mcp mcpStale: Claude not
 * running, or the check 10 min old; never while a refresh runs). False without a status
 * (the empty state speaks then). Re-renders only when the answer flips, the clock included.
 */
export function useMcpStale(threadId: string): boolean {
  const has = useThreadStore((s) => (s.logs[threadId]?.mcp ?? null) !== null);
  const checkedAtMs = useThreadStore((s) => s.logs[threadId]?.mcp?.checkedAtMs ?? null);
  const running = useThreadsStore((s) => claudeRunning(s.byId[threadId]?.state));
  const refreshing = useMcpRefreshing(threadId);
  return useNowSelect(STALE_TICK_MS, (now) => has && mcpStale({ checkedAtMs, running, refreshing }, now));
}

function setReconnecting(threadId: string, name: string, on: boolean): void {
  useMcpStore.setState((s) => {
    const cur: Record<string, true> = Object.fromEntries(Object.entries(s.reconnecting[threadId] ?? {}).filter(([k]) => k !== name));
    if (on) cur[name] = true;
    return { reconnecting: { ...s.reconnecting, [threadId]: cur } };
  });
}

function setRefreshing(threadId: string, on: boolean): void {
  useMcpStore.setState((s) => {
    const { [threadId]: _was, ...rest } = s.refreshing;
    return { refreshing: on ? { ...rest, [threadId]: true } : rest };
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
export async function reconnectMcp(threadId: string, name: string): Promise<boolean> {
  if (useMcpStore.getState().reconnecting[threadId]?.[name]) return false;
  setReconnecting(threadId, name, true);
  try {
    const res = await runCommandForResult(MCP_COMMANDS.reconnect, { id: threadId, server: name }, { ctx: threadContext(threadId), quiet: true });
    if (!res) return false;
    const err = reconnectError(res.resultJson);
    if (err) toast.error(`Could not reconnect ${name}`, { description: err });
    return err === "";
  } finally {
    setReconnecting(threadId, name, false);
  }
}

/** Re-checks the thread's servers (thread.mcp --refresh, the header's button). */
export async function refreshMcp(threadId: string): Promise<boolean> {
  if (useMcpStore.getState().refreshing[threadId]) return false;
  setRefreshing(threadId, true);
  try {
    return (await runCommandForResult(MCP_COMMANDS.status, { id: threadId, refresh: "true" }, { ctx: threadContext(threadId), quiet: true })) !== null;
  } finally {
    setRefreshing(threadId, false);
  }
}

/**
 * Asks a thread whose servers the Watch has no status for once (ThreadService.McpStatus
 * without refresh: a running Claude is asked, a stopped thread starts nothing); the answer
 * arrives through the Watch. The surface calls it from an effect keyed on the thread and
 * whether a status is there, so it does not repeat.
 */
export function ensureMcpStatus(threadId: string): void {
  const log = useThreadStore.getState().logs[threadId];
  if (!log || log.mcp !== null) return;
  getMcpStatus(threadId).catch((err: unknown) => {
    console.warn("mcp status", errorMessage(err));
  });
}
