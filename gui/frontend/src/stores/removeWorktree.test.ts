import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmationView } from "@/api/command";
import type { ProjectView, WorktreeView } from "@/api/project";
import { useConfirmStore } from "./confirm";
import { useProjectsStore } from "./projects";

const invokeCommand = vi.hoisted(() => vi.fn());
class NeedsConfirm extends Error {
  constructor(readonly confirm: ConfirmationView) {
    super(confirm.message);
  }
}
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  invokeCommand,
  confirmationOf: (err: unknown) => (err instanceof NeedsConfirm ? err.confirm : null),
}));
const { invokeConfirmed } = await import("./commands");
const { answerRemoveWorktree, useRemoveWorktreeStore } = await import("./removeWorktree");

const P = "/src/app";
const W = "/wt/app/cf-a";
const ctx = { activeTerminalId: "", activeThreadId: "", activeProjectId: "p1", activeWorktreePath: W, activeView: "projects", activeWorkspaceId: "" };
const first = new NeedsConfirm({ command: "project.worktree.remove", title: "Remove Worktree", message: `Remove worktree ${W}? This deletes files on disk.` });
const second = new NeedsConfirm({ command: "project.worktree.remove", title: "Delete Uncommitted Work", message: "uncommitted work", args: { force: "true" } });
const ok = { message: `removed worktree ${W}`, resultJson: "" };

function seed(untracked: number) {
  const status = { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked, conflicted: 0, dirty: untracked > 0, refreshedAtMs: 1, baseRef: "origin/main", baseAhead: 0, baseBehind: 0, error: "" };
  const wt = (path: string, isMain: boolean) => ({ projectId: "p1", path, branch: isMain ? "main" : "cf/a", head: "c", detached: false, isMain, status }) as WorktreeView;
  const project = { id: "p1", path: P, name: "app", defaultBranch: "main", githubSlug: "", remotes: ["origin"], git: true, worktrees: [wt(P, true), wt(W, false)] } as unknown as ProjectView;
  useProjectsStore.setState({ byId: { p1: project }, order: ["p1"] });
}

async function dialogOpen() {
  await vi.waitFor(() => {
    expect(useRemoveWorktreeStore.getState().pending).toMatchObject({ projectId: "p1", path: W });
  });
}

describe("project.worktree.remove's own dialog", () => {
  beforeEach(() => {
    invokeCommand.mockReset();
  });

  it("asks in the remove-worktree dialog, not the generic confirm", async () => {
    seed(0);
    invokeCommand.mockRejectedValueOnce(first).mockResolvedValue(ok);
    const done = invokeConfirmed("project.worktree.remove", { path: W }, ctx);
    await dialogOpen();
    expect(useConfirmStore.getState().pending).toBeNull();
    answerRemoveWorktree(true);
    expect(await done).toEqual(ok);
    expect(invokeCommand).toHaveBeenLastCalledWith("project.worktree.remove", ctx, { path: W }, undefined, { confirmed: true });
  });

  it("a yes while it showed the uncommitted files answers the daemon's second stage too", async () => {
    seed(3);
    invokeCommand.mockRejectedValueOnce(first).mockRejectedValueOnce(second).mockResolvedValue(ok);
    const done = invokeConfirmed("project.worktree.remove", { path: W }, ctx);
    await dialogOpen();
    answerRemoveWorktree(true);
    expect(await done).toEqual(ok);
    expect(useConfirmStore.getState().pending).toBeNull();
    expect(invokeCommand).toHaveBeenLastCalledWith("project.worktree.remove", ctx, { path: W, force: "true" }, undefined, { confirmed: true });
  });

  it("files that appeared after it opened: the dialog asks again, now with them", async () => {
    seed(0);
    invokeCommand.mockRejectedValueOnce(first).mockRejectedValueOnce(second).mockResolvedValue(ok);
    const done = invokeConfirmed("project.worktree.remove", { path: W }, ctx);
    await dialogOpen();
    answerRemoveWorktree(true);
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledTimes(2);
    });
    seed(2);
    await dialogOpen();
    answerRemoveWorktree(false);
    expect(await done).toBeNull();
    expect(invokeCommand).toHaveBeenCalledTimes(2);
  });

  it("without a path (the palette's context-only invoke) the generic confirm asks", async () => {
    seed(0);
    invokeCommand.mockRejectedValueOnce(first).mockResolvedValue(ok);
    const done = invokeConfirmed("project.worktree.remove", {}, ctx);
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending?.message).toBe(first.confirm.message);
    });
    expect(useRemoveWorktreeStore.getState().pending).toBeNull();
    useConfirmStore.getState().pending?.resolve(false);
    useConfirmStore.setState({ pending: null });
    expect(await done).toBeNull();
  });
});
