import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { HeaderActions } from "./HeaderActions";
import { ThreadCrumb } from "./ThreadParts";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");

const thread = (id: string, o: Partial<ThreadView> = {}) =>
  ({ id, name: `Thread ${id}`, projectId: "web", worktreePath: "/src/web", workspaceId: "", projectIds: ["web"], pendingWorktreePath: "", createdBy: "", createdByName: "", parentId: "", checkoutPaths: [], flags: [], ...o }) as ThreadView;
const PROJECT = (id: string) => ({ id, name: id, git: true, githubSlug: "", remotes: [], worktrees: [{ path: `/src/${id}`, branch: "main", head: "a", isMain: true }] });

function show(o: Partial<ThreadView>, others: ThreadView[] = []): void {
  const all = [thread("s-1", o), ...others];
  useThreadsStore.setState({ byId: Object.fromEntries(all.map((t) => [t.id, t])), order: all.map((t) => t.id) });
  render(<ThreadCrumb id="s-1" />);
}

const crumb = () => screen.getByTestId("thread-crumb");

beforeEach(() => {
  useProjectsStore.setState({ byId: { web: PROJECT("web"), api: PROJECT("api") } as never, order: ["web", "api"] });
  useWorkspacesStore.setState({ byId: { "w-1": { id: "w-1", name: "platform", members: [] } } as never, order: ["w-1"] });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
  resetDaemon();
});

afterEach(cleanup);

// The crumb heads a subagent run's view (SubagentPane); a thread's own header is ThreadHeader's.
describe("the crumb", () => {
  it.each<[string, Partial<ThreadView>, string, string, Record<string, string> | null]>([
    ["one project: its page", {}, "folder", "web", { project: "web" }],
    ["a named workspace: its page", { workspaceId: "w-1", projectIds: ["web", "api"] }, "layers", "platform", { workspace: "w-1" }],
    ["a workspace thread in the workspace's folder: its page", { workspaceId: "w-1", projectId: "", worktreePath: "/ws/platform", projectIds: ["web", "api"] }, "layers", "platform", { workspace: "w-1" }],
    ["an unnamed set: the primary project's page", { projectId: "api", worktreePath: "/src/api", projectIds: ["web", "api"] }, "folders", "api +1", { project: "api" }],
    ["no project: plain text", { projectId: "", projectIds: [], worktreePath: "/Users/me" }, "house", "No project", null],
    ["a removed project: plain text", { projectId: "gone", worktreePath: "/src/gone", projectIds: ["gone"] }, "folder", "gone", null],
  ])("%s", async (_n, o, icon, label, args) => {
    show(o);
    expect(crumb().dataset.icon).toBe(icon);
    expect(screen.getByTestId("thread-crumb-place").textContent).toBe(label);
    expect(screen.queryByTestId("thread-crumb-parent")).toBeNull();
    const link = screen.queryByTestId("thread-crumb-place-link");
    if (args === null) {
      // Plain text: no button in the crumb.
      expect(crumb().querySelector("button")).toBeNull();
      return;
    }
    expect(link?.textContent).toBe(label);
    fireEvent.click(link as HTMLElement);
    await act(async () => {
      await Promise.resolve();
    });
    expect(invocationsOf("view.projects").map((i) => i.args)).toEqual([args]);
  });

  it("a child: the place, then its parent, which opens on a click", () => {
    show({ createdBy: "s-0" }, [thread("s-0", { name: "Auth rollout plan" })]);
    const parent = screen.getByTestId("thread-crumb-parent");
    expect(parent.textContent).toBe("Auth rollout plan");
    fireEvent.click(parent);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-0" });
  });

  it("a child's crumb reads place, then creator; the user's own thread has no parent segment", () => {
    show({ createdBy: "s-0" }, [thread("s-0", { name: "Fix login redirect" })]);
    const [place, parent] = ["thread-crumb-place", "thread-crumb-parent"].map((id) => screen.getByTestId(id));
    expect(place?.compareDocumentPosition(parent as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    fireEvent.click(parent as HTMLElement);
    cleanup();
    show({}, [thread("s-0")]);
    expect(screen.queryByTestId("thread-crumb-parent")).toBeNull();
  });

  it("a removed creator's segment says Thread removed on hover, and a click on it goes nowhere", () => {
    show({ createdBy: "s-gone", createdByName: "Add retry to login redirect (old)" });
    const removed = screen.getByTestId("thread-crumb-parent");
    vi.useFakeTimers();
    try {
      fireEvent.pointerMove(removed, { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(600);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByRole("tooltip").textContent).toBe("Thread removed");
    fireEvent.click(removed);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
  });

  it("the parent follows a rename, and a removed creator is plain text", () => {
    show({ createdBy: "s-0", createdByName: "At creation" }, [thread("s-0", { name: "Plan" })]);
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-0": thread("s-0", { name: "Plan v2" }) } }));
    });
    expect(screen.getByTestId("thread-crumb-parent").textContent).toBe("Plan v2");
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { "s-1": s.byId["s-1"] as ThreadView }, order: ["s-1"] }));
    });
    const removed = screen.getByTestId("thread-crumb-parent");
    expect(removed.textContent).toBe("At creation");
    expect(removed.tagName).toBe("SPAN");
    expect(removed.dataset.removed).toBe("true");
  });
});

describe("a subagent run's header's right side", () => {
  it("is the thread info toggle only", () => {
    const cmd = (name: string) => ({ name, title: name, description: "", category: "", args: [], keybindings: [], available: true });
    useCommandsStore.setState({ commands: ["view.thread-info", "view.bottom.toggle", "view.panel.toggle", "thread.snooze", "thread.archive"].map(cmd) });
    useThreadsStore.setState({ byId: { "s-1": thread("s-1") }, order: ["s-1"] });
    render(<HeaderActions />);
    expect([...screen.getByTestId("pane-actions").querySelectorAll("button")].map((b) => b.dataset.testid)).toEqual(["thread-info-toggle"]);
  });
});
