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
const { useProjectsStore } = await import("@/stores/projects");
const { useThreadsStore } = await import("@/stores/threads");
const { useThreadStore } = await import("@/stores/thread");
const { useUiStore } = await import("@/stores/ui");
const { mcpPanelCommand, showView, useViewsStore } = await import("@/stores/views");

const thread = (id: string, state = "connected") =>
  ({ id, name: `thread ${id}`, projectId: "web", worktreePath: "/src/web", workspaceId: "", pendingWorktreePath: "", state, status: "idle", linkedPullRequests: [], usage: [], agentRuns: [] }) as unknown as ThreadView;

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

/** The check time beforeEach gives s-r (12 s before the test starts). */
let checkedAtMs = STATUS.checkedAtMs;

function setMcp(id: string, mcp: McpStatusView | null): void {
  useThreadStore.setState((s) => ({ logs: { ...s.logs, [id]: { seq: 1, byId: {}, order: [], pending: [], mcp, commands: [], agents: [] } } }));
}

const cards = () => screen.getAllByTestId("mcp-card");
const card = (name: string) => cards().find((c) => c.getAttribute("data-server") === name) as HTMLElement;
const within = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);
const row = () => screen.queryByTestId("panel-empty")?.querySelector('[data-surface="mcp"]') ?? null;

beforeEach(() => {
  useProjectsStore.setState({ byId: {}, order: [] });
  useThreadsStore.setState({ byId: { "s-r": thread("s-r"), "s-off": thread("s-off", "disconnected") }, order: ["s-r", "s-off"] });
  usePanelStore.setState({ byKey: { "thread:s-r": { open: true, groups: [{ tabs: [], activeTabId: null }] }, "thread:s-off": { open: true, groups: [{ tabs: [], activeTabId: null }] }, "view:projects": { open: true, groups: [{ tabs: [], activeTabId: null }] } } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, selection: { kind: "thread", id: "s-r" }, palette: { ...useUiStore.getState().palette, open: false } });
  useThreadStore.setState({ logs: {} });
  // Stamped per test: a check time taken when the module loaded drifts past 12s under load.
  checkedAtMs = Date.now() - 12_000;
  setMcp("s-r", { ...STATUS, checkedAtMs });
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
    expect(getPanel("thread:s-r").groups[0]?.activeTabId).toBe("mcp");
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
      setMcp("s-r", { ...STATUS, checkedAtMs, trigger: "reconnect", server: "playwright", servers: STATUS.servers.map((s) => (s.name === "playwright" ? { ...s, status: "connected", error: "" } : s)) });
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

describe("MCP surface staleness", () => {
  const header = () => screen.getByTestId("mcp-header");
  const pills = () => cards().map((c) => within(c, "mcp-pill") as HTMLElement);
  function open(id: string): void {
    useUiStore.setState({ selection: { kind: "thread", id } });
    act(() => {
      showView("panel.mcp");
    });
    render(<SidePanel />);
  }
  function expectStale(on: boolean): void {
    expect(header().getAttribute("data-stale")).toBe(on ? "true" : null);
    expect(screen.getByTestId("mcp-checked-line").className.includes("text-warning")).toBe(on);
    for (const p of pills()) {
      expect(p.getAttribute("data-stale")).toBe(on ? "true" : null);
      expect(p.className.includes("border-dashed")).toBe(on);
    }
    // Stale, Refresh is the labelled primary button; else the quiet icon button.
    const refresh = screen.getByTestId("mcp-refresh");
    expect(refresh.hasAttribute("data-cta")).toBe(on);
    expect(refresh.className.includes("bg-primary")).toBe(on);
    expect(refresh.textContent).toBe(on ? "Refresh" : "");
  }

  it.each<[string, string, number, boolean, string]>([
    ["running, checked 12s ago: current", "s-r", 12_000, false, "Checked 12s ago, at the start of the last turn"],
    ["running, checked 12 min ago: stale", "s-r", 12 * 60_000, true, "Last check 12 min ago · may be out of date"],
    ["Claude not running, checked 12s ago: stale", "s-off", 12_000, true, "Last check 12s ago · may be out of date"],
  ])("%s", (_name, id, ago, stale, line) => {
    setMcp(id, { ...STATUS, checkedAtMs: Date.now() - ago });
    open(id);
    expect(screen.getByTestId("mcp-checked").textContent).toBe(line);
    expectStale(stale);
  });

  it("goes stale on its own once the check turns 10 min old, and when Claude stops", () => {
    vi.useFakeTimers();
    try {
      setMcp("s-r", { ...STATUS, checkedAtMs: Date.now() - 9 * 60_000 - 50_000 });
      open("s-r");
      expectStale(false);
      act(() => {
        vi.advanceTimersByTime(15_000);
      });
      expectStale(true);
      expect(screen.getByTestId("mcp-checked").textContent).toBe("Last check 10 min ago · may be out of date");
      // A fresh check: current again; then Claude stops: stale at once.
      act(() => {
        setMcp("s-r", { ...STATUS, checkedAtMs: Date.now() });
      });
      expectStale(false);
      act(() => {
        useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-r": thread("s-r", "disconnected") } }));
      });
      expectStale(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("not stale while a refresh is in flight: the icon button spins", async () => {
    let finish: (v: unknown) => void = () => undefined;
    commands.run.mockReturnValue(new Promise((r) => (finish = r)));
    setMcp("s-off", STATUS);
    open("s-off");
    expectStale(true);
    fireEvent.click(screen.getByTestId("mcp-refresh"));
    expectStale(false);
    expect(screen.getByTestId<HTMLButtonElement>("mcp-refresh").disabled).toBe(true);
    expect(screen.getByTestId("mcp-refresh").querySelector(".animate-spin")).not.toBeNull();
    await act(async () => {
      finish({ message: "", resultJson: "{}" });
      await Promise.resolve();
    });
    // The answer did not bring a new check (the mock store keeps the old one): stale again.
    expectStale(true);
  });
});
