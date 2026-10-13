import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { PullRequestDetailView, PullRequestView } from "@/api/gh";
import type { LinkedPullRequestView, SessionView } from "@/api/session";

const startCommandNamed = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/keys/bindings", async (orig) => ({ ...(await orig<typeof import("@/keys/bindings")>()), startCommandNamed }));
const getPullRequestDetail = vi.hoisted(() => vi.fn());
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getPullRequestDetail }));
const openPullRequestInPanel = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/stores/prPanel", async (orig) => ({ ...(await orig<typeof import("@/stores/prPanel")>()), openPullRequestInPanel }));

const { HeaderActions } = await import("./HeaderActions");
const { useCommandsStore } = await import("@/stores/commands");
const { pullRequestDetailResource } = await import("@/stores/gh");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
const { useWorkspacesStore } = await import("@/stores/workspaces");

const cmd = (name: string, title = name): CommandView => ({ name, title, description: "", category: "", args: [], keybindings: [], available: true });
const link = (number: number): LinkedPullRequestView => ({ slug: "o/web", number, url: `https://github.com/o/web/pull/${String(number)}`, linkedAt: null });
const thread = (o: Partial<SessionView>) => ({ id: "s-1", name: "t", repoId: "web", worktreePath: "/src/web", workspaceId: "", pendingWorktreePath: "", state: "connected", linkedPullRequests: [], ...o }) as SessionView;
const detail = (o: Partial<PullRequestView>): PullRequestDetailView => ({ pullRequest: { repoSlug: "o/web", number: 78, title: "x", state: "open", draft: false, ...o }, lastError: "" }) as PullRequestDetailView;

beforeEach(() => {
  getPullRequestDetail.mockImplementation(() => new Promise(() => undefined));
  pullRequestDetailResource.store.setState({ entries: {} });
  useCommandsStore.setState({ commands: [cmd("session.close", "Close Thread"), cmd("view.panel.linked-prs", "Show Linked PRs in Side Panel"), cmd("view.panel.workspace", "Show Workspace in Side Panel"), cmd("view.bottom.toggle"), cmd("view.panel.toggle")] });
  useWorkspacesStore.setState({ byId: {} });
  useUiStore.setState({ selection: { kind: "session", id: "s-1" } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setThread(o: Partial<SessionView>): void {
  useSessionsStore.setState({ byId: { "s-1": thread(o) }, order: ["s-1"] });
}

/** The buttons' data-testid or command, in order. */
const order = () => [...screen.getByTestId("pane-actions").querySelectorAll("button")].map((b) => b.dataset.testid ?? b.dataset.commandButton);

describe("HeaderActions", () => {
  it("a thread without links or workspace: close, the bottom and panel toggles; no rename or fork", () => {
    useCommandsStore.setState({ commands: [...useCommandsStore.getState().commands, cmd("session.rename"), cmd("session.fork")] });
    setThread({});
    render(<HeaderActions sessionId="s-1" />);
    expect(order()).toEqual(["session.close", "bottom-toggle", "panel-toggle"]);
  });

  it("a workspace thread: the workspace chip by name first, opening view.panel.workspace", () => {
    useWorkspacesStore.setState({ byId: { w1: { name: "release-channels", members: [] } as never } });
    setThread({ workspaceId: "w1", linkedPullRequests: [link(1), link(2), link(3)] });
    render(<HeaderActions sessionId="s-1" />);
    expect(order()).toEqual(["pane-workspace", "pane-linked-prs", "session.close", "bottom-toggle", "panel-toggle"]);
    const ws = screen.getByTestId("pane-workspace");
    expect(ws.textContent).toBe("release-channels");
    expect(ws.getAttribute("title")).toBeNull();
    fireEvent.click(ws);
    expect(startCommandNamed).toHaveBeenCalledWith("view.panel.workspace");
  });

  it("two or more links: a muted count opening view.panel.linked-prs", () => {
    setThread({ linkedPullRequests: [link(1), link(2)] });
    render(<HeaderActions sessionId="s-1" />);
    const b = screen.getByTestId("pane-linked-prs");
    expect(b.textContent).toBe("2");
    expect(screen.queryByTestId("pane-linked-pr")).toBeNull();
    fireEvent.click(b);
    expect(startCommandNamed).toHaveBeenCalledWith("view.panel.linked-prs");
  });

  it.each([
    ["unknown until the detail loads", null, "unknown", "text-muted-foreground"],
    ["open", { state: "open" as const }, "open", "text-emerald-600"],
    ["draft", { state: "open" as const, draft: true }, "draft", "text-muted-foreground"],
    ["merged", { state: "merged" as const }, "merged", "text-violet-600"],
    ["closed", { state: "closed" as const }, "closed", "text-red-600"],
  ])("one link: its state icon and number (%s); a click opens it in the panel", (_name, pr, state, tone) => {
    setThread({ linkedPullRequests: [link(78)] });
    render(<HeaderActions sessionId="s-1" />);
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
});
