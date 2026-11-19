import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";
import type { LayoutTabView } from "@/api/layout";

// The bodies are markers: the row above them is the question here.
vi.mock("@/components/thread/ThreadPane", () => ({ ThreadPane: ({ threadId }: { threadId: string }) => <div data-testid="body" data-body={`thread:${threadId}`} /> }));
vi.mock("@/components/compose/Composer", () => ({ Composer: () => <div data-testid="body" data-body="compose" /> }));
vi.mock("@/components/diff/DiffView", () => ({ DiffView: () => <div data-testid="body" data-body="diff" /> }));
const kept: string[] = [];
vi.mock("@/shell/preview", async (orig) => ({
  ...(await orig<typeof import("@/shell/preview")>()),
  keepPreviewTab: (id: string) => {
    kept.push(id);
    return Promise.resolve();
  },
}));
vi.mock("@/shell/commands", () => ({
  focusPaneNow: () => Promise.resolve(true),
  focusTabNow: () => Promise.resolve(true),
  closeTabNow: () => Promise.resolve(null),
  runLayoutCommand: () => Promise.resolve(null),
}));

const { PaneView } = await import("./PaneView");
const { resetLayout } = await import("@/stores/layout");
const { resetShellView } = await import("@/stores/shellView");
const { useSettingsStore } = await import("@/stores/settings");
const { useThreadsStore } = await import("@/stores/threads");
const { useCommandsStore } = await import("@/stores/commands");

const RECT = { x: 0, y: 0, w: 900, h: 600, rail: false };

function mode(value: string): void {
  useSettingsStore.setState({ snapshot: { values: { "layout.threads_open_as": value } } as never });
}

async function showing(tabs: LayoutTabView[]): Promise<void> {
  await act(async () => {
    await seedLayout(layoutOf([space(row("s-r", [pane("p-1", tabs), pane("p-2", [tab("t-o", "prs")])]), "p-1")]));
  });
}

const header = () => screen.queryByTestId("thread-pane-header");
const strip = () => screen.queryByTestId("shell-tab-strip");
/** The row's buttons by name, in order. */
const buttons = () =>
  Array.from(screen.getByTestId("pane-actions").querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? b.textContent);

beforeEach(() => {
  kept.length = 0;
  useCommandsStore.setState({ commands: [{ name: "view.thread-info", title: "Thread info", available: true, args: [], keybindings: [] } as never] });
  resetLayout();
  resetShellView();
  useThreadsStore.setState({
    byId: { "s-1": { id: "s-1", name: "Refactor sidebar tree", status: "idle", statusReason: "", archivedAtMs: null, worktreePath: "/w/cf", branch: "main", projectIds: ["pj"], projectId: "pj" } } as never,
  });
});

afterEach(() => {
  cleanup();
  resetLayout();
  useSettingsStore.setState({ snapshot: null });
});

describe("a thread pane's header row", () => {
  it("under Tabs the pane keeps its strip", async () => {
    mode("tabs");
    await showing([tab("t-th", "thread", "s-1")]);
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    expect(strip()).not.toBeNull();
    expect(header()).toBeNull();
  });

  it.each(["panes", "single"])("under %s a pane of one thread draws one row: icon, name, then +, info, menu, collapse, full screen; no close", async (m) => {
    mode(m);
    await showing([tab("t-th", "thread", "s-1")]);
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    expect(strip()).toBeNull();
    const row = header();
    expect(row?.getAttribute("data-tab-id")).toBe("t-th");
    expect(screen.getByTestId("thread-pane-header-name").textContent).toBe("Refactor sidebar tree");
    expect(buttons()).toEqual(["Open", "Thread info", "Thread menu", "Collapse pane", "Full screen"]);
    expect(screen.queryByTestId("shell-tab-close")).toBeNull();
    // The pane is named by the thread's name, as its tab named it.
    expect(screen.getByTestId("shell-pane").getAttribute("aria-labelledby")).toBe(screen.getByTestId("thread-pane-header-name").id);
  });

  it("a composer's row names it and has no thread buttons", async () => {
    mode("panes");
    await showing([tab("t-c", "compose")]);
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    expect(screen.getByTestId("thread-pane-header-name").textContent).toBe("New thread");
    expect(buttons()).toEqual(["Open", "Collapse pane", "Full screen"]);
  });

  it("a pane of other tabs, or of more than one tab, keeps its strip", async () => {
    mode("panes");
    await showing([tab("t-th", "thread", "s-1"), tab("t-d", "diff", "s-1")]);
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    render(<PaneView paneId="p-2" rect={RECT} focused={false} />);
    expect(screen.getAllByTestId("shell-tab-strip")).toHaveLength(2);
    expect(header()).toBeNull();
  });

  it("a name being regenerated is muted and italic, as the tab's", async () => {
    mode("panes");
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-1": { ...s.byId["s-1"], nameProvisional: true } } as never }));
    await showing([tab("t-th", "thread", "s-1")]);
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    const name = screen.getByTestId("thread-pane-header-name");
    expect(name.hasAttribute("data-provisional")).toBe(true);
    expect(name.className).toContain("italic");
  });

  it("a preview is dashed and a double click keeps it", async () => {
    mode("panes");
    await showing([tab("t-th", "thread", "s-1", { preview: true })]);
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    const title = screen.getByTestId("thread-pane-header-title");
    expect(title.hasAttribute("data-preview")).toBe(true);
    fireEvent.doubleClick(title);
    expect(kept).toEqual(["t-th"]);
  });

  it("shows the thread's status dot on its icon", async () => {
    mode("panes");
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-1": { ...s.byId["s-1"], status: "busy" } } as never }));
    await showing([tab("t-th", "thread", "s-1")]);
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    expect(screen.getByTestId("shell-tab-status").getAttribute("data-kind")).toBe("working");
  });

  it("the thread draws no header of its own under the row (ShellPane.headed)", async () => {
    mode("panes");
    await showing([tab("t-th", "thread", "s-1")]);
    const { useShellPane } = await import("@/shell/paneContext");
    function Probe() {
      return <div data-testid="probe" data-headed={String(useShellPane()?.headed)} />;
    }
    const { shellSurfaceOf } = await import("@/shell/surfaces/registry");
    const spy = vi.spyOn(shellSurfaceOf("thread"), "render").mockImplementation(() => <Probe />);
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    expect(screen.getByTestId("probe").getAttribute("data-headed")).toBe("true");
    spy.mockRestore();
  });
});
