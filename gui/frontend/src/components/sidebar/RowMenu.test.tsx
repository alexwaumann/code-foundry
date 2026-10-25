import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";

const setThreadSidebar = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/threadActions", async (orig) => ({ ...(await orig<typeof import("@/stores/threadActions")>()), setThreadSidebar }));

const { ContextMenu, ContextMenuTrigger } = await import("@/components/ui/context-menu");
const { RowMenu } = await import("./RowMenu");
const { useThreadsStore } = await import("@/stores/threads");

const thread = (o: Partial<ThreadView>) =>
  ({ id: "s-1", name: "t", projectId: "web", worktreePath: "/src/web", workspaceId: "", projectIds: ["web"], branch: "", pinned: false, archivedAtMs: null, snoozedUntilMs: null, createdBy: "", inSidebar: null, ...o }) as ThreadView;

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

beforeEach(() => {
  setThreadSidebar.mockClear();
});

afterEach(cleanup);

describe("RowMenu: Hide from sidebar (docs/notes/hidden-children-2-gui.md)", () => {
  it("a thread another thread created (shown, since its row is listed): Hide from sidebar after Archive, hiding it", () => {
    openMenu({ createdBy: "s-0", inSidebar: true });
    const items = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(items.indexOf("Hide from sidebar")).toBe(items.indexOf("Archive") + 1);
    const item = screen.getByTestId("menu-sidebar-hide");
    expect(item.querySelector("svg")?.getAttribute("class")).toContain("lucide-eye-off");
    fireEvent.click(item);
    expect(setThreadSidebar).toHaveBeenCalledWith("s-1", false);
  });

  it("the user's own thread: no such item", () => {
    openMenu({});
    expect(screen.getByTestId("row-menu")).toBeTruthy();
    expect(screen.queryByTestId("menu-sidebar-hide")).toBeNull();
  });
});
