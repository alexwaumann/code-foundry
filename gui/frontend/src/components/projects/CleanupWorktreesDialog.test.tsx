import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CleanupRowView } from "@/api/project";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
const preview = vi.hoisted(() => ({ rows: [] as CleanupRowView[], fail: false, calls: [] as [string, string][] }));
vi.mock("@/api/project", async (orig) => ({
  ...(await orig<typeof import("@/api/project")>()),
  previewCleanup: (project: string, path = "") => {
    preview.calls.push([project, path]);
    return preview.fail ? Promise.reject(new Error("unavailable")) : Promise.resolve(preview.rows);
  },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { ConfirmDialog } = await import("@/components/confirm/ConfirmDialog");
const { CleanupWorktreesDialog } = await import("./CleanupWorktreesDialog");
const { cleanupMergedWorktrees } = await import("@/stores/projectActions");
const { confirmFirst, invocationsOf, resetDaemon } = await import("@/test/daemonFakes");

/**
 * project.worktree.cleanup's own confirm (stores/cleanupWorktrees.tsx): the rows from the
 * daemon's dry run (branch and why in a few words, no paths, nothing kept), and the result
 * toast naming only what went. docs/notes/cleanup-dialog.md.
 */

const WT = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry";
const row = (branch: string, kind: CleanupRowView["kind"]): CleanupRowView => ({ path: `${WT}/${branch.replace("/", "-")}`, branch, kind, baseRef: "origin/main" });

/** The daemon removes what the dry run listed and answers with its JSON. */
function fakeCleanup(removed: readonly CleanupRowView[]) {
  confirmFirst("project.worktree.cleanup", "Remove merged worktrees?", () => ({
    message: "",
    resultJson: JSON.stringify({ projectId: "repo-cf", removed: removed.map((r) => ({ worktree: { branch: r.branch, path: r.path }, kind: "CLEANUP_KIND_MERGED" })) }),
  }));
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Starts the cleanup the way the project page does and waits for its question; `done` settles with its answer. */
async function start(): Promise<{ done: Promise<boolean> }> {
  let done!: Promise<boolean>;
  act(() => {
    done = cleanupMergedWorktrees("repo-cf");
  });
  await settle();
  return { done };
}

beforeEach(() => {
  resetDaemon();
  preview.rows = [];
  preview.fail = false;
  preview.calls = [];
  toast.success.mockClear();
  render(
    <>
      <ConfirmDialog />
      <CleanupWorktreesDialog />
    </>,
  );
});
afterEach(() => {
  cleanup();
});

describe("CleanupWorktreesDialog", () => {
  it("lists what goes, branch and a short why, no paths; Remove runs it confirmed and the toast names only what went", async () => {
    preview.rows = [row("cf/usage-polish", "merged"), row("cf/prs-shrink-gui", "squash-merged"), row("cf/try-oxlint", "no commits")];
    fakeCleanup(preview.rows);
    const { done } = await start();
    expect(preview.calls).toEqual([["repo-cf", ""]]);
    const dialog = screen.getByTestId("cleanup-dialog");
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(within(dialog).getByTestId("cleanup-title").textContent).toBe("Remove 3 merged worktrees?");
    expect(within(dialog).getByTestId("cleanup-body").textContent).toBe("Their work is already in origin/main. Branches are kept.");
    const rows = within(dialog).getAllByTestId("cleanup-row");
    expect(rows.map((r) => [within(r).getByTestId("cleanup-branch").textContent, within(r).getByTestId("cleanup-kind").textContent])).toEqual([
      ["cf/usage-polish", "merged"],
      ["cf/prs-shrink-gui", "squash-merged"],
      ["cf/try-oxlint", "no commits"],
    ]);
    expect(dialog.textContent).not.toContain(WT);
    expect(within(dialog).getByTestId("cleanup-ok").textContent).toBe("Remove 3 worktrees");

    fireEvent.click(within(dialog).getByTestId("cleanup-ok"));
    expect(await done).toBe(true);
    expect(invocationsOf("project.worktree.cleanup").map((i) => [i.confirmed, i.args])).toEqual([
      [false, { project: "repo-cf" }],
      [true, { project: "repo-cf" }],
    ]);
    expect(toast.success).toHaveBeenCalledTimes(1);
    const [title, opts] = toast.success.mock.calls[0] as [string, { description: React.ReactNode }];
    expect(title).toBe("Removed 3 worktrees");
    render(<>{opts.description}</>);
    expect(screen.getByTestId("cleanup-toast-branches").textContent).toBe("cf/usage-polishcf/prs-shrink-guicf/try-oxlint");
  });

  it("one worktree: singular words", async () => {
    preview.rows = [row("cf/usage-polish", "merged")];
    fakeCleanup(preview.rows);
    const { done } = await start();
    const dialog = screen.getByTestId("cleanup-dialog");
    expect(within(dialog).getByTestId("cleanup-title").textContent).toBe("Remove 1 merged worktree?");
    expect(within(dialog).getByTestId("cleanup-body").textContent).toBe("Its work is already in origin/main. The branch is kept.");
    expect(within(dialog).getByTestId("cleanup-ok").textContent).toBe("Remove 1 worktree");
    fireEvent.click(within(dialog).getByTestId("cleanup-ok"));
    await done;
    expect(toast.success.mock.calls[0]?.[0]).toBe("Removed 1 worktree");
  });

  it("nothing merged right now: offers the fetch alone; nothing removed says so", async () => {
    fakeCleanup([]);
    const { done } = await start();
    const dialog = screen.getByTestId("cleanup-dialog");
    expect(within(dialog).getByTestId("cleanup-title").textContent).toBe("No merged worktrees right now");
    expect(within(dialog).queryByTestId("cleanup-rows")).toBeNull();
    expect(within(dialog).getByTestId("cleanup-ok").textContent).toBe("Fetch and check");
    fireEvent.click(within(dialog).getByTestId("cleanup-ok"));
    await done;
    expect(toast.success).toHaveBeenCalledWith("No merged worktrees to remove");
  });

  it("Cancel runs nothing and toasts nothing", async () => {
    preview.rows = [row("cf/usage-polish", "merged")];
    fakeCleanup(preview.rows);
    const { done } = await start();
    fireEvent.click(within(screen.getByTestId("cleanup-dialog")).getByTestId("cleanup-cancel"));
    expect(await done).toBe(false);
    expect(invocationsOf("project.worktree.cleanup").map((i) => i.confirmed)).toEqual([false]);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("a failed dry run falls back to the daemon's words in the generic confirm", async () => {
    preview.fail = true;
    fakeCleanup([]);
    const { done } = await start();
    expect(screen.queryByTestId("cleanup-dialog")).toBeNull();
    const generic = screen.getByTestId("confirm-dialog");
    expect(generic.textContent).toContain("Remove merged worktrees?");
    fireEvent.click(within(generic).getByTestId("confirm-ok"));
    expect(await done).toBe(true);
  });
});
