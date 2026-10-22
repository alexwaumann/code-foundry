/**
 * A thread's MCP servers in the mock daemon (docs/notes/mcp-panel.md): the sketch's six
 * servers (docs/sketches/mcp-panel), covering every status, seeded on the scripted thread
 * (mock/thread.ts load) and the live default-world threads (seed). ThreadService.McpStatus / McpReconnect
 * and the thread.mcp, thread.mcp-reconnect and view.panel.mcp commands.
 *
 * Reconnect answers after MCP_RECONNECT_MS: a failed server connects (with tools), a
 * needs-login one stays so and the result carries Claude's refusal, a connected one is
 * checked again. Each answer is an `mcp` event on the thread's Watch, like the daemon's.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { McpCheckTrigger, McpServerStatus, type McpServerSchema, type ThreadMcpStatusSchema } from "../src/gen/codefoundry/v1/thread_pb";
import { panelThreadArgs, runPanelVerb } from "./panelVerbs";
import type { UiIntentInit } from "./world";
import { CommandError } from "./errors";
import type { InvokeOut } from "./gitops";

export type McpStatusInit = MessageInitShape<typeof ThreadMcpStatusSchema>;
type ServerInit = MessageInitShape<typeof McpServerSchema>;

/** How long a mock reconnect takes (long enough to see the spinner). */
export const MCP_RECONNECT_MS = 700;

const tool = (name: string, description: string, hints: string) => ({
  name,
  description,
  readOnly: hints.includes("r"),
  destructive: hints.includes("d"),
  openWorld: hints.includes("o"),
});

/** The sketch's servers: two connected, needs login, failed, connecting, disabled. */
export function mcpServers(): ServerInit[] {
  return [
    {
      name: "t3-code",
      status: McpServerStatus.CONNECTED,
      serverName: "t3-code",
      version: "0.4.2",
      scope: "project",
      source: "project",
      transport: "http",
      tools: [
        tool("link_pull_request", "Link a pull request to this thread", ""),
        tool("list_thread_pull_requests", "List the pull requests linked to this thread", "r"),
        tool("preview_open", "Open a URL in the preview browser", "o"),
        tool("preview_click", "Click an element in the preview", ""),
        tool("device_screenshot", "Screenshot a connected device", "r"),
      ],
    },
    {
      name: "github",
      status: McpServerStatus.CONNECTED,
      serverName: "github-mcp-server",
      version: "1.12.0",
      scope: "user",
      source: "user",
      transport: "stdio",
      tools: [
        tool("get_pull_request", "Get details of a pull request", "r"),
        tool("create_pull_request", "Create a pull request", "o"),
        tool("merge_pull_request", "Merge a pull request", "do"),
        tool("search_code", "Search code across repositories", "ro"),
        tool("push_files", "Push files to a branch in one commit", "d"),
      ],
    },
    { name: "linear", status: McpServerStatus.NEEDS_AUTH, scope: "user", source: "user", transport: "http", tools: [] },
    { name: "playwright", status: McpServerStatus.FAILED, error: "spawn npx ENOENT", scope: "project", source: "project", transport: "stdio", tools: [] },
    { name: "filesystem", status: McpServerStatus.PENDING, scope: "local", source: "local", transport: "stdio", tools: [] },
    { name: "sentry", status: McpServerStatus.DISABLED, scope: "user", source: "user", transport: "http", tools: [] },
  ];
}

/** The status the scripted thread starts with: checked 12 s ago, at the start of its last turn. */
export function mcpFixture(now = Date.now()): McpStatusInit {
  return { checkedAt: timestampFromDate(new Date(now - 12_000)), trigger: McpCheckTrigger.TURN_START, servers: mcpServers() };
}

/** What MockThreadLogs offers the MCP commands. */
export interface McpThreads {
  /** The thread's MCP status; undefined when Claude never reported one. Throws for an unknown thread. */
  mcpOf(id: string): McpStatusInit | undefined;
  /** Replaces it and publishes the Watch's `mcp` event. */
  setMcp(id: string, status: McpStatusInit | undefined): void;
  calls: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-checks a thread's servers now (a refresh): same servers, new time. A thread with no
 * status yet gets the sketch's servers: the daemon starts Claude for a refresh, whether or
 * not it ran.
 */
export function refreshMcp(threads: McpThreads, id: string): McpStatusInit {
  const cur = threads.mcpOf(id) ?? mcpFixture();
  const next = { ...cur, checkedAt: timestampFromDate(new Date()), trigger: McpCheckTrigger.REFRESH, server: "" };
  threads.setMcp(id, next);
  return next;
}

/**
 * POST /__mock/thread/mcp-age: the thread's last check (the fixture's when it has none)
 * moved `agoSeconds` into the past, published like a new answer, so the GUI shows its
 * stale state (10 min and older) without waiting.
 */
export function ageMcp(threads: McpThreads, id: string, agoSeconds: number): void {
  const cur = threads.mcpOf(id) ?? mcpFixture();
  threads.setMcp(id, { ...cur, checkedAt: timestampFromDate(new Date(Date.now() - agoSeconds * 1000)) });
}

/** McpReconnect: the new status and Claude's refusal ("" when it went through). */
export async function reconnectMcp(threads: McpThreads, id: string, server: string): Promise<{ status: McpStatusInit; error: string }> {
  // The daemon starts Claude for a stopped thread; its last status outlives the process.
  const cur = threads.mcpOf(id) ?? mcpFixture();
  const servers = cur.servers ?? [];
  if (!servers.some((s) => s.name === server)) throw new CommandError("notfound", `thread ${id} has no MCP server "${server}"`);
  await sleep(MCP_RECONNECT_MS);
  let error = "";
  const next = servers.map((s): ServerInit => {
    if (s.name !== server) return s;
    if (s.status === McpServerStatus.FAILED) {
      return {
        name: s.name,
        scope: s.scope,
        source: s.source,
        transport: s.transport,
        status: McpServerStatus.CONNECTED,
        error: "",
        serverName: "playwright-mcp",
        version: "0.0.41",
        tools: [tool("browser_navigate", "Navigate to a URL", "o"), tool("browser_click", "Click an element on the page", ""), tool("browser_snapshot", "Capture the page's accessibility tree", "r")],
      };
    }
    if (s.status === McpServerStatus.NEEDS_AUTH) error = `${server} needs a login: run claude in a shell and use /mcp`;
    return s;
  });
  const status: McpStatusInit = { checkedAt: timestampFromDate(new Date()), trigger: McpCheckTrigger.RECONNECT, server, servers: next };
  threads.setMcp(id, status);
  return { status, error };
}

type Command = {
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; args: { name: string; type: ArgType; required: boolean; description: string }[] };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut>;
};

/** thread.mcp, thread.mcp-reconnect and view.panel.mcp, like the daemon's (any active thread). */
export function mcpCommands(threads: McpThreads, emit: (i: UiIntentInit) => number): Command[] {
  const when = (ctx: UiContext | undefined) => Boolean(ctx?.activeThreadId);
  const id = { name: "id", type: ArgType.STRING, required: false, description: "Thread id (default: the active thread)" };
  const sid = (ctx: UiContext | undefined, a: Record<string, string>) => a.id || ctx?.activeThreadId || "";
  return [
    {
      cmd: {
        name: "thread.mcp",
        title: "Show Thread MCP Servers",
        category: "Thread",
        description: "Print a thread's MCP servers as Claude last reported them.",
        keybindings: [],
        args: [id, { name: "refresh", type: ArgType.BOOL, required: false, description: "Ask Claude now" }, { name: "full", type: ArgType.BOOL, required: false, description: "List each server's tools" }],
      },
      when,
      run: (ctx, a) => {
        const t = sid(ctx, a);
        const refresh = a.refresh === "true";
        threads.calls.push(`mcp ${t}${refresh ? " refresh" : ""}`);
        const st = refresh ? refreshMcp(threads, t) : threads.mcpOf(t);
        const n = st?.servers?.length ?? 0;
        const on = st?.servers?.filter((s) => s.status === McpServerStatus.CONNECTED).length ?? 0;
        return Promise.resolve({ message: st ? `MCP servers: ${String(on)} of ${String(n)} connected` : "no MCP status", resultJson: JSON.stringify({ status: st ? { servers: n } : null }) });
      },
    },
    {
      cmd: {
        name: "thread.mcp-reconnect",
        title: "Reconnect Thread MCP Server",
        category: "Thread",
        description: "Reconnect one of a connected thread's MCP servers, then check them again.",
        keybindings: [],
        args: [id, { name: "server", type: ArgType.STRING, required: true, description: "The server's name" }],
      },
      when,
      run: async (ctx, a) => {
        const t = sid(ctx, a);
        const server = a.server ?? "";
        threads.calls.push(`mcp-reconnect ${t} ${server}`);
        const { status, error } = await reconnectMcp(threads, t, server);
        const s = status.servers?.find((x) => x.name === server);
        const word = s?.status === McpServerStatus.CONNECTED ? "connected" : s?.status === McpServerStatus.NEEDS_AUTH ? "needs login" : "unknown";
        return { message: error ? `reconnect ${server} failed: ${error} (${word})` : `reconnected ${server}: ${word}`, resultJson: JSON.stringify(error ? { error } : {}) };
      },
    },
    {
      cmd: {
        name: "view.panel.mcp",
        title: "Show MCP Servers",
        category: "View",
        description: "Open the MCP surface in the selected thread's side panel: its MCP servers with status, errors and tools, and Reconnect.",
        keybindings: [],
        args: panelThreadArgs,
      },
      when,
      run: (_ctx, args) => runPanelVerb(emit, "panel.mcp", args),
    },
  ];
}
