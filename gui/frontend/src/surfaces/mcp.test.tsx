import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerView, McpStatusView } from "@/api/mcp";
import type { ThreadView } from "@/api/threads";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult: commands.run }));
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/api/mcp", async (orig) => ({ ...(await orig<typeof import("@/api/mcp")>()), getMcpStatus: api.get }));

const { SidePanel } = await import("@/components/panel/SidePanel");
const { getPanel, usePanelStore } = await import("@/stores/panel");
const { useReposStore } = await import("@/stores/repos");
const { useThreadsStore } = await import("@/stores/threads");
const { useThreadStore } = await import("@/stores/thread");
const { useUiStore } = await import("@/stores/ui");
const { mcpPanelCommand, showView, useViewsStore } = await import("@/stores/views");

const thread = (id: string, state = "connected") =>
  ({ id, name: `thread ${id}`, repoId: "web", worktreePath: "/src/web", workspaceId: "", pendingWorktreePath: "", state, status: "idle", linkedPullRequests: [], usage: [] }) as unknown as ThreadView;

function server(name: string, o: Partial<McpServerView> = {}): McpServerView {
  return { name, status: "connected", serverName: "", version: "", error: "", scope: "user", source: "user", transport: "stdio", tools: [], ...o };
}

const STATUS: McpStatusView = {
  checkedAtMs: Date.now() - 12_000,
  trigger: "turn",
  server: "",
  servers: [
    server("github", {
      version: "1.12.0",
      tools: [
        { name: "get_pull_request", description: "Get details of a pull request", readOnly: true, destructive: false, openWorld: false },
        { name: "merge_pull_request", description: "Merge a pull request", readOnly: false, destructive: true, openWorld: true },
      ],
    }),
    server("linear", { status: "needs-auth", transport: "http" }),
    server("playwright", { status: "failed", error: "spawn npx ENOENT", scope: "project" }),
    server("filesystem", { status: "pending", scope: "local" }),
    server("sentry", { status: "disabled", transport: "http" }),
  ],
};

function setMcp(id: string, mcp: McpStatusView | null): void {
  useThreadStore.setState((s) => ({ logs: { ...s.logs, [id]: { seq: 1, byId: {}, order: [], pending: [], mcp, commands: [], agents: [] } } }));
}

const cards = () => screen.getAllByTestId("mcp-card");
const card = (name: string) => cards().find((c) => c.getAttribute("data-server") === name) as HTMLElement;
const within = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);
const row = () => screen.queryByTestId("panel-empty")?.querySelector('[data-surface="mcp"]') ?? null;

beforeEach(() => {
  useReposStore.setState({ byId: {}, order: [] });
  useThreadsStore.setState({ byId: { "s-r": thread("s-r"), "s-off": thread("s-off", "disconnected") }, order: ["s-r", "s-off"] });
  usePanelStore.setState({ byKey: { "session:s-r": { open: true, tabs: [], activeTabId: null }, "session:s-off": { open: true, tabs: [], activeTabId: null }, "view:projects": { open: true, tabs: [], activeTabId: null } } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, selection: { kind: "thread", id: "s-r" }, palette: { ...useUiStore.getState().palette, open: false } });
  useThreadStore.setState({ logs: {} });
  setMcp("s-r", STATUS);
  api.get.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MCP surface", () => {
  it("is listed with M for a thread and hidden for a page", () => {
    render(<SidePanel />);
    expect(row()?.getAttribute("data-availability")).toBe("enabled");
    expect(row()?.textContent).toContain("MCP");
    act(() => {
      useUiStore.setState({ selection: { kind: "view", name: "projects" } });
    });
    expect(row()).toBeNull();
    expect(mcpPanelCommand()).toBe(false);
  });

  it("shows the header and one card per server in every state", () => {
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "m" });
    expect(getPanel("session:s-r").activeTabId).toBe("mcp");
    expect(screen.getByTestId("mcp-count").textContent).toBe("1 of 5 connected");
    expect(screen.getByTestId("mcp-checked").textContent).toBe("Checked 12s ago, at the start of the last turn");
    expect(cards().map((c) => [c.getAttribute("data-server"), c.getAttribute("data-status"), within(c, "mcp-pill")?.textContent])).toEqual([
      ["github", "connected", "Connected"],
      ["linear", "needs-auth", "Needs login"],
      ["playwright", "failed", "Failed"],
      ["filesystem", "pending", "Connecting…"],
      ["sentry", "disabled", "Disabled"],
    ]);
    expect(within(card("github"), "mcp-meta")?.textContent).toBe("user·stdio·2 tools");
    expect(within(card("github"), "mcp-version")?.textContent).toBe("v1.12.0");
    expect(within(card("playwright"), "mcp-error")?.textContent).toBe("spawn npx ENOENT");
    expect(within(card("linear"), "mcp-login-hint")?.textContent).toBe("Needs login · run claude in a shell and use /mcp, then reconnect");
    // Reconnect everywhere but connecting and disabled; amber on the ones that need you.
    expect(cards().map((c) => within(c, "mcp-reconnect") !== null)).toEqual([true, true, true, false, false]);
    expect(within(card("playwright"), "mcp-reconnect")?.className).toContain("border-warning/40");
    expect(within(card("github"), "mcp-reconnect")?.className).toContain("border-transparent");
    expect(card("playwright").className).toContain("border-destructive/35");
    expect(card("linear").className).toContain("border-warning/35");
  });

  it("expands a server's tools with their hint icons", () => {
    act(() => {
      showView("panel.mcp");
    });
    render(<SidePanel />);
    expect(screen.queryByTestId("mcp-tools")).toBeNull();
    const toggle = within(card("github"), "mcp-tools-toggle") as HTMLElement;
    expect(toggle.textContent).toBe("2 tools");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const tools = screen.getAllByTestId("mcp-tool");
    expect(tools.map((t) => t.getAttribute("data-tool"))).toEqual(["get_pull_request", "merge_pull_request"]);
    const hints = (t: Element) => [...t.querySelectorAll('[data-testid="mcp-hint"]')].map((h) => h.getAttribute("aria-label"));
    expect(hints(tools[0] as Element)).toEqual(["Read-only"]);
    expect(hints(tools[1] as Element)).toEqual(["Writes", "Destructive", "Open-world (reaches outside the server)"]);
  });

  it("Reconnect runs thread.mcp-reconnect; meanwhile the card says Connecting… with a spinner", async () => {
    let finish: (v: unknown) => void = () => undefined;
    commands.run.mockImplementation(() => new Promise((r) => (finish = r)));
    act(() => {
      showView("panel.mcp");
    });
    render(<SidePanel />);
    fireEvent.click(within(card("playwright"), "mcp-reconnect") as HTMLElement);
    expect(commands.run).toHaveBeenCalledWith("thread.mcp-reconnect", { id: "s-r", server: "playwright" }, expect.objectContaining({ quiet: true }));
    expect(card("playwright").getAttribute("data-status")).toBe("pending");
    expect(within(card("playwright"), "mcp-pill")?.textContent).toBe("Connecting…");
    expect((within(card("playwright"), "mcp-reconnect") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      setMcp("s-r", { ...STATUS, trigger: "reconnect", server: "playwright", servers: STATUS.servers.map((s) => (s.name === "playwright" ? { ...s, status: "connected", error: "" } : s)) });
      finish({ message: "reconnected playwright: connected", resultJson: "{}" });
      await Promise.resolve();
    });
    expect(card("playwright").getAttribute("data-status")).toBe("connected");
    expect(screen.getByTestId("mcp-checked").textContent).toBe("Checked 12s ago, after reconnecting playwright");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts Claude's refusal of a reconnect", async () => {
    commands.run.mockResolvedValue({ message: "reconnect linear failed", resultJson: JSON.stringify({ error: "needs a login" }) });
    act(() => {
      showView("panel.mcp");
    });
    render(<SidePanel />);
    await act(async () => {
      fireEvent.click(within(card("linear"), "mcp-reconnect") as HTMLElement);
      await Promise.resolve();
    });
    expect(toast.error).toHaveBeenCalledWith("Could not reconnect linear", { description: "needs a login" });
  });

  it("refresh runs thread.mcp --refresh", () => {
    commands.run.mockResolvedValue({ message: "", resultJson: "{}" });
    act(() => {
      showView("panel.mcp");
    });
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId("mcp-refresh"));
    expect(commands.run).toHaveBeenCalledWith("thread.mcp", { id: "s-r", refresh: "true" }, expect.objectContaining({ quiet: true }));
  });

  it("asks once for a thread never checked, running or not; the empty state never mentions running", () => {
    setMcp("s-r", null);
    act(() => {
      showView("panel.mcp");
    });
    render(<SidePanel />);
    expect(screen.getByTestId("mcp-empty").textContent).toBe("Checking MCP servers…");
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith("s-r");
    cleanup();

    useUiStore.setState({ selection: { kind: "thread", id: "s-off" } });
    setMcp("s-off", null);
    act(() => {
      showView("panel.mcp");
    });
    render(<SidePanel />);
    expect(screen.getByTestId("mcp-empty").textContent).toBe("No MCP status yet. Refresh to check.");
    expect(screen.getByTestId<HTMLButtonElement>("mcp-refresh").disabled).toBe(false);
    // McpStatus without refresh: the cached status, no start.
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenLastCalledWith("s-off");
  });

  it("a stopped thread keeps its last status, with Refresh and Reconnect enabled (the daemon starts Claude for them)", () => {
    commands.run.mockResolvedValue({ message: "", resultJson: "{}" });
    useUiStore.setState({ selection: { kind: "thread", id: "s-off" } });
    setMcp("s-off", STATUS);
    act(() => {
      showView("panel.mcp");
    });
    render(<SidePanel />);
    expect(screen.getByTestId<HTMLButtonElement>("mcp-refresh").disabled).toBe(false);
    const reconnect = within(card("linear"), "mcp-reconnect") as HTMLButtonElement;
    expect(reconnect.disabled).toBe(false);
    fireEvent.click(reconnect);
    expect(commands.run).toHaveBeenCalledWith("thread.mcp-reconnect", { id: "s-off", server: "linear" }, expect.objectContaining({ quiet: true }));
    fireEvent.click(screen.getByTestId("mcp-refresh"));
    expect(commands.run).toHaveBeenCalledWith("thread.mcp", { id: "s-off", refresh: "true" }, expect.objectContaining({ quiet: true }));
  });
});
