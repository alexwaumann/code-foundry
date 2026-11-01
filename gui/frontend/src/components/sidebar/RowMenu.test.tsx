import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";

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

describe("RowMenu: a child thread (docs/notes/no-sidebar-override-1-gui.md)", () => {
  it("has no Show or Hide in sidebar item: a child stays its creator's", () => {
    openMenu({ createdBy: "s-0" });
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toContain("Archive");
    expect(items.some((t) => /sidebar/i.test(t))).toBe(false);
  });
});
