import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { PullRequestDetailView, PullRequestView } from "@/api/gh";
import type { LinkedPullRequestView, ThreadView } from "@/api/threads";
import { tooltipText } from "@/test/tooltip";

const startCommandNamed = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/keys/bindings", async (orig) => ({ ...(await orig<typeof import("@/keys/bindings")>()), startCommandNamed }));
const getPullRequestDetail = vi.hoisted(() => vi.fn());
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getPullRequestDetail }));
const openPullRequestInPanel = vi.hoisted(() => vi.fn(() => true));
const snoozeThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/threadActions", async (orig) => ({ ...(await orig<typeof import("@/stores/threadActions")>()), snoozeThread }));
const openSnoozeDialog = vi.hoisted(() => vi.fn());
vi.mock("@/stores/snoozeDialog", async (orig) => ({ ...(await orig<typeof import("@/stores/snoozeDialog")>()), openSnoozeDialog }));
vi.mock("@/stores/prPanel", async (orig) => ({ ...(await orig<typeof import("@/stores/prPanel")>()), openPullRequestInPanel }));

const { HeaderActions } = await import("./HeaderActions");
const { useCommandsStore } = await import("@/stores/commands");
const { pullRequestDetailResource } = await import("@/stores/gh");
const { useThreadsStore } = await import("@/stores/threads");
const { useProjectsStore } = await import("@/stores/projects");
const { useUiStore } = await import("@/stores/ui");
const { useWorkspacesStore } = await import("@/stores/workspaces");
const { useActionsStore } = await import("@/stores/actions");
const { useSettingsStore } = await import("@/stores/settings");

const cmd = (name: string, title = name): CommandView => ({ name, title, description: "", category: "", args: [], keybindings: [], available: true });
const link = (number: number): LinkedPullRequestView => ({ slug: "o/web", number, url: `https://github.com/o/web/pull/${String(number)}`, linkedAt: null });
const thread = (o: Partial<ThreadView>) => ({ id: "s-1", name: "t", projectId: "web", worktreePath: "/src/web", workspaceId: "", projectIds: ["web"], branch: "", pendingWorktreePath: "", state: "connected", linkedPullRequests: [], ...o }) as ThreadView;
const detail = (o: Partial<PullRequestView>): PullRequestDetailView => ({ pullRequest: { repoSlug: "o/web", number: 78, title: "x", state: "open", draft: false, ...o }, lastError: "" }) as PullRequestDetailView;

beforeEach(() => {
  getPullRequestDetail.mockImplementation(() => new Promise(() => undefined));
  pullRequestDetailResource.store.setState({ entries: {} });
  useCommandsStore.setState({ commands: [cmd("thread.snooze", "Snooze or Unsnooze Thread"), cmd("thread.archive", "Archive or Unarchive Thread"), cmd("view.panel.linked-prs", "Show Linked PRs in Side Panel"), cmd("view.panel.workspace", "Show Workspace in Side Panel"), cmd("view.bottom.toggle"), cmd("view.panel.toggle")] });
  useWorkspacesStore.setState({ byId: {} });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
  // A project the thread runs in, so it has one (its More menu shows).
  useProjectsStore.setState({ byId: { web: { id: "web", name: "web", git: true, worktrees: [{ path: "/src/web", branch: "main", head: "a", isMain: true }] } as never }, order: ["web"] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setThread(o: Partial<ThreadView>): void {
  useThreadsStore.setState({ byId: { "s-1": thread(o) }, order: ["s-1"] });
}

/** The buttons' data-testid or command, in order. */
const order = () => [...screen.getByTestId("pane-actions").querySelectorAll("button")].map((b) => b.dataset.testid ?? b.dataset.commandButton);

describe("HeaderActions", () => {
  it("a thread without links or workspace: snooze, archive, the bottom and panel toggles; no close, rename or fork", () => {
    useCommandsStore.setState({ commands: [...useCommandsStore.getState().commands, cmd("thread.rename"), cmd("thread.fork"), cmd("thread.close")] });
    setThread({});
    render(<HeaderActions threadId="s-1" />);
    expect(order()).toEqual(["pane-snooze", "thread.archive", "pane-thread-menu", "bottom-toggle", "panel-toggle"]);
  });

  it("a workspace thread: the workspace chip by name first, opening view.panel.workspace", () => {
    useWorkspacesStore.setState({ byId: { w1: { name: "release-channels", members: [] } as never } });
    setThread({ workspaceId: "w1", linkedPullRequests: [link(1), link(2), link(3)] });
    render(<HeaderActions threadId="s-1" />);
    expect(order()).toEqual(["pane-workspace", "pane-linked-prs", "pane-snooze", "thread.archive", "pane-thread-menu", "bottom-toggle", "panel-toggle"]);
    const ws = screen.getByTestId("pane-workspace");
    expect(ws.textContent).toBe("release-channels");
    expect(ws.getAttribute("title")).toBeNull();
    fireEvent.click(ws);
    expect(startCommandNamed).toHaveBeenCalledWith("view.panel.workspace");
  });

  it.each([
    ["not archived", null, "Archive Thread"],
    ["archived", 1234, "Unarchive Thread"],
  ])("%s: the archive button says what it does and runs thread.archive (a toggle)", (_name, archivedAtMs, title) => {
    setThread({ archivedAtMs });
    render(<HeaderActions threadId="s-1" />);
    const b = screen.getByRole("button", { name: title });
    expect(b.dataset.commandButton).toBe("thread.archive");
    fireEvent.click(b);
    expect(startCommandNamed).toHaveBeenCalledWith("thread.archive");
  });

  it("the snooze button opens the presets with their times; a preset snoozes until that time", () => {
    setThread({});
    render(<HeaderActions threadId="s-1" />);
    const b = screen.getByRole("button", { name: "Snooze Thread" });
    expect(tooltipText(b)).toBe("Snooze Thread");
    fireEvent.keyDown(b, { key: "Enter" });
    const items = screen.getAllByTestId("snooze-preset");
    expect(items.map((i) => i.dataset.preset)).toEqual(["1h", "3h", "tomorrow", "next-week"]);
    const times = screen.getAllByTestId("snooze-preset-time").map((t) => t.textContent);
    expect(items.map((i, n) => i.textContent.slice(0, -(times[n] ?? "").length))).toEqual(["1 hour", "3 hours", "Tomorrow", "Next week"]);
    expect(times.every((t) => /\d:\d\d [AP]M$/.test(t))).toBe(true);
    const before = Date.now();
    fireEvent.click(items[0] as HTMLElement);
    expect(snoozeThread).toHaveBeenCalledTimes(1);
    const [id, until] = snoozeThread.mock.calls[0] as unknown as [string, number];
    expect(id).toBe("s-1");
    expect(until - before).toBeGreaterThan(3_600_000 - 5_000);
    expect(until - before).toBeLessThanOrEqual(3_600_000);
  });

  it("Pick a date and time… opens the custom dialog for the thread", () => {
    setThread({});
    render(<HeaderActions threadId="s-1" />);
    fireEvent.keyDown(screen.getByTestId("pane-snooze"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("snooze-pick"));
    expect(openSnoozeDialog).toHaveBeenCalledWith("s-1");
    expect(snoozeThread).not.toHaveBeenCalled();
  });

  it("a snoozed thread: Unsnooze Thread, which unsnoozes on click", () => {
    setThread({ state: "disconnected", snoozedUntilMs: Date.now() + 3_600_000 });
    render(<HeaderActions threadId="s-1" />);
    expect(screen.queryByTestId("pane-snooze")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unsnooze Thread" }));
    expect(snoozeThread).toHaveBeenCalledWith("s-1", null);
  });

  it("no snooze button when the daemon does not list thread.snooze", () => {
    useCommandsStore.setState({ commands: useCommandsStore.getState().commands.filter((c) => c.name !== "thread.snooze") });
    setThread({});
    render(<HeaderActions threadId="s-1" />);
    expect(order()).toEqual(["thread.archive", "pane-thread-menu", "bottom-toggle", "panel-toggle"]);
  });

  it.each([
    ["a project thread with action.run listed: the Play menu, left of the bottom toggle", "web", true, true],
    ["a thread without a project: none", "", true, false],
    ["action.run not listed: none", "web", false, false],
  ])("%s", (_name, projectId, listed, shown) => {
    if (listed) useCommandsStore.setState({ commands: [...useCommandsStore.getState().commands, cmd("action.run", "Run Action")] });
    // A thread without a project runs in the home directory, in no project's worktree.
    setThread(projectId ? { projectId } : { projectId, worktreePath: "/Users/dev", projectIds: [] });
    render(<HeaderActions threadId="s-1" />);
    // The More menu (ThreadMenu) is there for every thread with a project.
    const more = projectId ? ["pane-thread-menu"] : [];
    const want = shown
      ? ["pane-snooze", "thread.archive", "pane-actions-menu", ...more, "bottom-toggle", "panel-toggle"]
      : ["pane-snooze", "thread.archive", ...more, "bottom-toggle", "panel-toggle"];
    expect(order()).toEqual(want);
  });

  it("the Play menu lists the project's actions, or says it has none", () => {
    useCommandsStore.setState({ commands: [...useCommandsStore.getState().commands, cmd("action.run", "Run Action")] });
    useActionsStore.setState({
      byId: { "a-1": { id: "a-1", projectId: "web", name: "Test", command: "go test", icon: "test", inTerminal: true, onWorktreeCreate: false, position: 0 } },
      byProject: { web: ["a-1"] },
      runs: {},
    });
    setThread({});
    const { unmount } = render(<HeaderActions threadId="s-1" />);
    fireEvent.keyDown(screen.getByTestId("pane-actions-menu"), { key: "Enter" });
    expect(screen.getAllByTestId("action-item").map((i) => i.textContent)).toEqual(["Test"]);
    expect(screen.getByTestId("action-edit").getAttribute("aria-label")).toBe("Edit Test");
    expect(screen.getByTestId("action-new").textContent).toBe("New action…");
    unmount();
    useActionsStore.setState({ byId: {}, byProject: {}, runs: {} });
    render(<HeaderActions threadId="s-1" />);
    fireEvent.keyDown(screen.getByTestId("pane-actions-menu"), { key: "Enter" });
    expect(screen.getByTestId("actions-empty").textContent).toBe("No actions for web yet");
  });

  it("two or more links: a muted count opening view.panel.linked-prs", () => {
    setThread({ linkedPullRequests: [link(1), link(2)] });
    render(<HeaderActions threadId="s-1" />);
    const b = screen.getByTestId("pane-linked-prs");
    expect(b.textContent).toBe("2");
    expect(screen.queryByTestId("pane-linked-pr")).toBeNull();
    fireEvent.click(b);
    expect(startCommandNamed).toHaveBeenCalledWith("view.panel.linked-prs");
  });

  it.each([
    ["unknown until the detail loads", null, "unknown", "text-cf-text-muted"],
    ["open", { state: "open" as const }, "open", "text-cf-success-text"],
    ["draft", { state: "open" as const, draft: true }, "draft", "text-cf-text-muted"],
    ["merged", { state: "merged" as const }, "merged", "text-cf-highlight-text"],
    ["closed", { state: "closed" as const }, "closed", "text-cf-error-text"],
  ])("one link: its state icon and number (%s); a click opens it in the panel", (_name, pr, state, tone) => {
    setThread({ linkedPullRequests: [link(78)] });
    render(<HeaderActions threadId="s-1" />);
    // The header watches the PR's cached detail, like a Linked PRs row.
    expect(pullRequestDetailResource.watched()).toContain("o/web#78");
    if (pr)
      act(() => {
        pullRequestDetailResource.set("o/web#78", { data: detail(pr) });
      });
    const b = screen.getByTestId("pane-linked-pr");
    expect(screen.queryByTestId("pane-linked-prs")).toBeNull();
    expect(b.textContent).toBe("#78");
    expect(b.dataset.state).toBe(state);
    expect(b.className).toContain(tone);
    fireEvent.click(b);
    expect(openPullRequestInPanel).toHaveBeenCalledWith({ slug: "o/web", number: 78 });
  });

  // Hidden child threads (docs/notes/hidden-children-2-gui.md): thread.sidebar beside Archive.
  it.each<[string, Partial<ThreadView>, boolean, string, string]>([
    ["hidden by the setting", { createdBy: "s-0", inSidebar: null }, false, "Show in sidebar", "lucide-eye"],
    ["shown by the setting", { createdBy: "s-0", inSidebar: null }, true, "Hide from sidebar", "lucide-eye-off"],
    ["shown by its override", { createdBy: "s-0", inSidebar: true }, false, "Hide from sidebar", "lucide-eye-off"],
    ["hidden by its override", { createdBy: "s-0", inSidebar: false }, true, "Show in sidebar", "lucide-eye"],
  ])("a thread another thread created, %s: %s, next to Archive, runs thread.sidebar", (_name, o, showCreated, title, icon) => {
    useCommandsStore.setState({ commands: [...useCommandsStore.getState().commands, cmd("thread.sidebar", "Show or Hide Thread in Sidebar")] });
    useSettingsStore.setState({ snapshot: { values: { "threads.show_created_threads": String(showCreated) }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
    setThread(o);
    render(<HeaderActions threadId="s-1" />);
    expect(order()).toEqual(["pane-snooze", "pane-sidebar", "thread.archive", "pane-thread-menu", "bottom-toggle", "panel-toggle"]);
    const b = screen.getByRole("button", { name: title });
    expect(tooltipText(b)).toBe(title);
    expect(b.querySelector("svg")?.getAttribute("class")).toContain(icon);
    fireEvent.click(b);
    expect(startCommandNamed).toHaveBeenCalledWith("thread.sidebar");
    useSettingsStore.setState({ snapshot: null });
  });

  it("the user's own thread has no sidebar button, even with thread.sidebar listed", () => {
    useCommandsStore.setState({ commands: [...useCommandsStore.getState().commands, cmd("thread.sidebar")] });
    setThread({ createdBy: "", inSidebar: null });
    render(<HeaderActions threadId="s-1" />);
    expect(screen.queryByTestId("pane-sidebar")).toBeNull();
  });
});
