import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";

const removeThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/threadActions", async (orig) => ({ ...(await orig<typeof import("@/stores/threadActions")>()), removeThread }));

const { ContextMenu, ContextMenuTrigger } = await import("@/components/ui/context-menu");
const { RowMenu } = await import("./RowMenu");
const { useThreadsStore } = await import("@/stores/threads");

const thread = (o: Partial<ThreadView>) =>
  ({ id: "s-1", name: "t", projectId: "web", worktreePath: "/src/web", workspaceId: "", projectIds: ["web"], branch: "", pinned: false, archivedAtMs: null, snoozedUntilMs: null, createdBy: "", flags: [], ...o }) as ThreadView;

function openMenu(o: Partial<ThreadView>): void {
  useThreadsStore.setState({ byId: { "s-1": thread(o) }, order: ["s-1"] });
  render(
    <ContextMenu>
      <ContextMenuTrigger data-testid="row">row</ContextMenuTrigger>
      <RowMenu id="s-1" />
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId("row"));
}

afterEach(cleanup);

describe("RowMenu: Fork (docs/notes/transcript-deleted.md)", () => {
  it("is offered for a thread that can continue", () => {
    openMenu({});
    expect(screen.getByTestId("menu-fork").hasAttribute("data-disabled")).toBe(false);
  });

  it("is disabled once Claude Code deleted the transcript", () => {
    openMenu({ transcriptMissing: true });
    expect(screen.getByTestId("menu-fork").hasAttribute("data-disabled")).toBe(true);
  });
});

describe("RowMenu: a setup that has not finished", () => {
  const setup = (phase: "running" | "failed" | "done") => ({ phase, startedAtMs: 1, endedAtMs: null, steps: [], error: "", background: true });
  const fork = () => screen.queryAllByTestId("menu-fork").length;

  // A terminal is Open ▸'s (the shell's row, sidebar/shell): the row's own items end with Fork and Remove.
  it.each<[string, Partial<ThreadView>, number]>([
    ["running with no checkout: no fork", { worktreePath: "", setup: setup("running") }, 0],
    ["failed with no checkout: no fork", { worktreePath: "", setup: setup("failed") }, 0],
    ["failed after its worktree landed: a fork still needs Claude", { worktreePath: "/w/x", setup: setup("failed") }, 0],
    ["done: a fork", { worktreePath: "/w/x", setup: setup("done") }, 1],
    ["no setup: a fork", {}, 1],
  ])("%s", (_n, o, forks) => {
    openMenu(o);
    expect(screen.queryAllByRole("menuitem", { name: "New terminal here" })).toHaveLength(0);
    expect(fork()).toBe(forks);
  });
});

describe("RowMenu: a child thread (docs/notes/no-sidebar-override-1-gui.md)", () => {
  it("has no Show or Hide in sidebar item: a child stays its creator's", () => {
    openMenu({ createdBy: "s-0" });
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toContain("Archive");
    expect(items.some((t) => /sidebar/i.test(t))).toBe(false);
  });
});

describe("RowMenu: Remove", () => {
  it("removes the thread through thread.remove, which asks first (ConfirmDialog.test)", () => {
    openMenu({});
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(removeThread).toHaveBeenCalledExactlyOnceWith("s-1");
  });
});
