import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

const { ContextMenu, ContextMenuTrigger } = await import("@/components/ui/context-menu");
const { RowMenu } = await import("./RowMenu");
const { SidebarRow } = await import("./SidebarRow");
const { RunInPicker } = await import("@/components/palette/RunInPicker");
const { useCommandsStore } = await import("@/stores/commands");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");
const { daemon, lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { addThreads, addWorkspace, addWorktrees, CF, GP, seedWorld, thread, worktree } = await import("@/test/projectsWorld");

/**
 * Run in (thread.run-in) for a workspace thread, over the mock's world: a workspace "login"
 * over code-foundry and ghostty-playground with a thread "driver" running in
 * ghostty-playground. The row menu's members, the palette's picker, the args and context
 * they send, and the row's queued move. Queuing until the thread is idle, and the worktree
 * the move lands in, are the daemon's (internal/store/thread runin_test.go).
 */

const LOGIN = `${CF.replace("/src/code-foundry", "")}/.code-foundry/worktrees/alexwaumann/code-foundry/cf-login`;
let ws = "";

function cmd(name: string): CommandView {
  return { name, title: name, description: "", category: "Thread", args: [], keybindings: [], available: true };
}

beforeEach(() => {
  resetDaemon();
  seedWorld();
  ws = addWorkspace("login", ["repo-cf", "repo-gp"]).id;
  act(() => {
    addThreads(
      thread("s-drv", { name: "driver", projectId: "repo-gp", worktreePath: GP, workspaceId: ws, projectIds: ["repo-cf", "repo-gp"], branch: "cf/login", flags: [], linkedPullRequests: [] }),
      thread("s-one", { name: "solo", flags: [], linkedPullRequests: [] }),
    );
  });
  useCommandsStore.setState({ commands: [cmd("thread.pin"), cmd("thread.archive"), cmd("thread.snooze"), cmd("thread.run-in")] });
  daemon.commands = [...useCommandsStore.getState().commands];
  useUiStore.setState({ selection: { kind: "thread", id: "s-drv" } });
});
afterEach(cleanup);

function openRowMenu(id: string): HTMLElement {
  render(
    <ContextMenu>
      <ContextMenuTrigger data-testid="row">row</ContextMenuTrigger>
      <RowMenu id={id} />
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId("row"));
  return screen.getByTestId("row-menu");
}

describe("Run in", () => {
  it("the row menu's Run in ▸ lists the workspace folder and the projects, the current one disabled; a pick runs thread.run-in", async () => {
    const menu = openRowMenu("s-drv");
    fireEvent.pointerMove(within(menu).getByTestId("menu-run-in"), { pointerType: "mouse" });
    fireEvent.keyDown(within(menu).getByTestId("menu-run-in"), { key: "ArrowRight" });
    const members = await screen.findByTestId("menu-run-in-members");
    expect([...members.querySelectorAll("[data-member]")].map((m) => m.getAttribute("data-member"))).toEqual(["workspace", "repo-cf", "repo-gp"]);
    expect(members.querySelector('[data-member="workspace"]')?.textContent).toContain("Workspace");
    const here = members.querySelector('[data-member="repo-gp"]');
    expect(here?.textContent).toContain("runs here");
    expect(here?.hasAttribute("data-disabled")).toBe(true);
    fireEvent.click(members.querySelector('[data-member="repo-cf"]') as HTMLElement);
    await vi.waitFor(() => {
      expect(lastInvocation("thread.run-in")).toBeDefined();
    });
    expect(lastInvocation("thread.run-in")).toMatchObject({ args: { project: "repo-cf" }, context: { activeThreadId: "s-drv", activeWorkspaceId: ws, activeView: "thread" } });
  });

  it("a one-project thread's row menu has no Run in", () => {
    const menu = openRowMenu("s-one");
    expect(within(menu).queryByTestId("menu-run-in")).toBeNull();
  });

  it("the palette's picker lists the members, the current one running here; a pick closes it and runs thread.run-in", async () => {
    const close = vi.fn();
    render(<RunInPicker threadId="s-drv" close={close} />);
    const picker = screen.getByTestId("runin-picker");
    expect(picker.querySelector('[data-member="repo-gp"]')?.textContent).toContain("runs here");
    fireEvent.click(picker.querySelector('[data-member="repo-cf"]') as HTMLElement);
    expect(close).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(lastInvocation("thread.run-in")).toMatchObject({ args: { project: "repo-cf" }, context: { activeThreadId: "s-drv", activeWorkspaceId: ws } });
    });
  });

  it("the row shows the queued move until it happens, then the project it runs in", () => {
    // The checkout the daemon makes for the move (code-foundry on the thread's branch).
    act(() => {
      addWorktrees("repo-cf", worktree("repo-cf", LOGIN, "cf/login"));
    });
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-drv": { ...(s.byId["s-drv"] as ThreadView), pendingWorktreePath: LOGIN } } }));
    });
    render(<SidebarRow row={{ key: "s:s-drv", kind: "thread", section: "idle", threadId: "s-drv" }} selected={false} cursor={false} onActivate={() => undefined} />);
    expect(screen.getByTestId("row-moving").textContent).toBe("moving to code-foundry…");
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-drv": { ...(s.byId["s-drv"] as ThreadView), projectId: "repo-cf", worktreePath: LOGIN, pendingWorktreePath: "" } } }));
    });
    expect(screen.queryByTestId("row-moving")).toBeNull();
    expect(screen.getByTestId("row-project").textContent).toBe("code-foundry");
    expect(screen.getByTestId("row-branch").textContent).toBe("cf/login");
  });
});
