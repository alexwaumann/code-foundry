import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView, UsageBucketView } from "@/api/threads";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { SidePanel } = await import("@/components/panel/SidePanel");
const { getPanel, usePanelStore } = await import("@/stores/panel");
const { useReposStore } = await import("@/stores/repos");
const { useSessionsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");
const { showView, usagePanelCommand, useViewsStore } = await import("@/stores/views");

function bucket(model: string, o: Partial<UsageBucketView> = {}): UsageBucketView {
  return {
    model,
    tier: "",
    speed: "",
    day: "2026-10-10",
    requests: 1,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    costUsd: 0,
    unpriced: false,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWrite5mCostUsd: 0,
    cacheWrite1hCostUsd: 0,
    cacheSavingsUsd: 0,
    ...o,
  };
}

// s-1: opus over two days ($101.60), fable ($39.60) and an unpriced claude-opus-5.
const OPUS_A = bucket("claude-opus-5-5", { requests: 200, input: 6800, output: 500_000, cacheRead: 180_000_000, cacheWrite5m: 800_000, cacheWrite1h: 5_000_000, costUsd: 70, inputCostUsd: 0.1, outputCostUsd: 10, cacheReadCostUsd: 36, cacheWrite5mCostUsd: 3.9, cacheWrite1hCostUsd: 20 });
const OPUS_B = bucket("claude-opus-5-5", { day: "2026-10-11", requests: 90, input: 3000, output: 220_000, cacheRead: 72_000_000, cacheWrite5m: 300_000, cacheWrite1h: 2_400_000, costUsd: 31.6, inputCostUsd: 0.05, outputCostUsd: 5, cacheReadCostUsd: 14.4, cacheWrite5mCostUsd: 0.15, cacheWrite1hCostUsd: 12 });
const FABLE = bucket("claude-fable-5-1", { requests: 122, input: 3100, output: 260_000, cacheRead: 97_000_000, cacheWrite5m: 400_000, cacheWrite1h: 3_300_000, costUsd: 39.6, inputCostUsd: 0.06, outputCostUsd: 5.07, cacheReadCostUsd: 21, cacheWrite5mCostUsd: 0.57, cacheWrite1hCostUsd: 12.9 });
const OLD = bucket("claude-opus-5", { requests: 14, cacheRead: 28_400_000, unpriced: true });

const thread = (id: string, usage: UsageBucketView[]) =>
  ({ id, name: `thread ${id}`, repoId: "web", worktreePath: "/src/web", workspaceId: "", pendingWorktreePath: "", terminalId: "", state: "connected", status: "idle", linkedPullRequests: [], usage, costUsd: 0, unpriced: false }) as unknown as SessionView;

function select(id: string): void {
  useUiStore.setState({ selection: { kind: "session", id } });
}

const all = (id: string) => screen.getAllByTestId(id).map((e) => e.textContent);
const row = () => screen.queryByTestId("panel-empty")?.querySelector('[data-surface="usage"]') ?? null;
const pressU = () => fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "u" });

beforeEach(() => {
  useReposStore.setState({ byId: {}, order: [] });
  useSessionsStore.setState({ byId: { "s-1": thread("s-1", [OPUS_A, FABLE, OPUS_B]), "s-0": thread("s-0", []), "s-x": thread("s-x", [OLD]) }, order: ["s-1", "s-0", "s-x"] });
  usePanelStore.setState({ byKey: { "session:s-1": { open: true, tabs: [], activeTabId: null }, "session:s-0": { open: true, tabs: [], activeTabId: null }, "session:s-x": { open: true, tabs: [], activeTabId: null } } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, palette: { ...useUiStore.getState().palette, open: false } });
  select("s-1");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Usage surface", () => {
  it("is listed with U for any thread, with or without usage, and hidden for a page", () => {
    render(<SidePanel />);
    expect(row()?.getAttribute("data-availability")).toBe("enabled");
    expect(row()?.textContent).toContain("Usage");
    expect(row()?.textContent).toContain("U");
    act(() => {
      select("s-0");
    });
    expect(row()?.getAttribute("data-availability")).toBe("enabled");
    act(() => {
      useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } });
    });
    expect(row()).toBeNull();
  });

  it("U opens the tab: hero cost, summary, models by cost with share, token kinds", () => {
    render(<SidePanel />);
    pressU();
    expect(getPanel("session:s-1").activeTabId).toBe("usage");
    expect(screen.getByTestId("usage-cost").textContent).toBe("$141.20");
    expect(screen.getByTestId("usage-summary").textContent).toBe("362M tokens · 412 requests");
    expect(screen.getAllByTestId("usage-model").map((m) => m.getAttribute("data-model"))).toEqual(["claude-opus-5-5", "claude-fable-5-1"]);
    expect(all("usage-model-meta")).toEqual(["261M tokens · 290 requests", "101M tokens · 122 requests"]);
    expect(all("usage-model-cost")).toEqual(["$101.60", "$39.60"]);
    expect(all("usage-model-share")).toEqual(["72.0%", "28.0%"]);
    expect(screen.queryByTestId("usage-unpriced")).toBeNull();
    // Swatches carry the model's slot colours.
    const sw = screen.getAllByTestId("usage-swatch")[0] as HTMLElement;
    expect(sw.style.getPropertyValue("--sw-d")).toBe("#3987e5");
    // Token kinds in display order, tokens and cost.
    expect(screen.getAllByTestId("usage-kind").map((k) => k.getAttribute("data-kind"))).toEqual(["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"]);
    expect(all("usage-kind-tokens")).toEqual(["12.9K", "980K", "349M", "1.5M", "10.7M"]);
    expect(all("usage-kind-cost")).toEqual(["$0.21", "$20.07", "$71.40", "$4.62", "$44.90"]);
  });

  it("tags an unpriced model and shows a dash for its cost and share", () => {
    act(() => {
      useSessionsStore.setState((s) => ({ byId: { ...s.byId, "s-1": thread("s-1", [OPUS_A, OLD]) } }));
    });
    render(<SidePanel />);
    pressU();
    expect(screen.getAllByTestId("usage-model").map((m) => m.getAttribute("data-model"))).toEqual(["claude-opus-5-5", "claude-opus-5"]);
    expect(screen.getAllByTestId("usage-unpriced")).toHaveLength(1);
    expect(screen.getAllByTestId("usage-model")[1]?.textContent).toContain("unpriced");
    expect(all("usage-model-cost")).toEqual(["$70.00", "—"]);
    expect(all("usage-model-share")).toEqual(["100.0%", "—"]);
    // The priced part is still the hero.
    expect(screen.getByTestId("usage-cost").textContent).toBe("$70.00");
  });

  it("shows dashes for every cost when nothing is priced", () => {
    select("s-x");
    render(<SidePanel />);
    pressU();
    expect(screen.getByTestId("usage-cost").textContent).toBe("—");
    expect(screen.getByTestId("usage-summary").textContent).toBe("28.4M tokens · 14 requests");
    expect(all("usage-kind-cost")).toEqual(["—", "—", "—", "—", "—"]);
  });

  it("says No usage yet for a thread without usage, and fills in when usage arrives", () => {
    select("s-0");
    render(<SidePanel />);
    pressU();
    expect(screen.getByTestId("usage-empty").textContent).toContain("No usage yet");
    expect(screen.queryByTestId("usage-cost")).toBeNull();
    act(() => {
      useSessionsStore.setState((s) => ({ byId: { ...s.byId, "s-0": thread("s-0", [FABLE]) } }));
    });
    expect(screen.queryByTestId("usage-empty")).toBeNull();
    expect(screen.getByTestId("usage-cost").textContent).toBe("$39.60");
    expect(screen.getByTestId("usage-summary").textContent).toBe("101M tokens · 122 requests");
  });

});

describe("usagePanelCommand (view.panel.usage)", () => {
  it("opens the tab and shows a hidden panel for a thread, with or without usage", () => {
    usePanelStore.setState({ byKey: {} });
    expect(usagePanelCommand()).toBe(true);
    expect(getPanel("session:s-1")).toMatchObject({ open: true, activeTabId: "usage" });
    select("s-0");
    expect(showView("panel.usage")).toBe(true);
    expect(getPanel("session:s-0")).toMatchObject({ open: true, activeTabId: "usage" });
    expect(toast).not.toHaveBeenCalled();
  });

  it("does nothing without a thread or under settings", () => {
    usePanelStore.setState({ byKey: {} });
    useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } });
    expect(usagePanelCommand()).toBe(false);
    select("s-1");
    useViewsStore.setState({ settingsOpen: true });
    expect(usagePanelCommand()).toBe(false);
    expect(getPanel("session:s-1").open).toBe(false);
  });

  it("from the palette, sends the palette's focus back to the panel", () => {
    useUiStore.setState((s) => ({ palette: { ...s.palette, open: true, returnTo: "content" } }));
    expect(usagePanelCommand()).toBe(true);
    expect(useUiStore.getState().palette.returnTo).toBe("panel");
  });
});
