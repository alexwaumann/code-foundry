import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionView } from "@/api/session";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/sessions";
import { SidebarRow } from "./SidebarRow";

const thread = (o: Partial<SessionView>) =>
  ({ id: "s-1", name: "t", repoId: "cf", worktreePath: "/src/cf", workspaceId: "", pendingWorktreePath: "", state: "connected", status: "idle", statusReason: "", statusChangedAtMs: null, linkedPullRequests: [], pinned: false, ...o }) as SessionView;

beforeEach(() => {
  useReposStore.setState({
    byId: {
      cf: { id: "cf", name: "code-foundry", git: true, worktrees: [{ path: "/src/cf", branch: "main", head: "a", isMain: true }] },
      notes: { id: "notes", name: "writing", git: false, worktrees: [{ path: "/src/notes", branch: "", head: "", isMain: true }] },
    } as never,
    order: ["cf", "notes"],
  });
});

afterEach(cleanup);

function renderRow(o: Partial<SessionView>): HTMLElement {
  useSessionsStore.setState({ byId: { "s-1": thread(o) }, order: ["s-1"] });
  render(
    <TooltipProvider>
      <SidebarRow row={{ key: "s:s-1", kind: "session", section: "idle", sessionId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
    </TooltipProvider>,
  );
  return screen.getByTestId("row-place");
}

describe("SidebarRow line 2", () => {
  it.each([
    ["idle: project @ branch", {}, "code-foundry @ main"],
    ["working: the status, then the place", { status: "busy" as const }, "Working · code-foundry @ main"],
    ["starting", { state: "starting" as const }, "Starting · code-foundry @ main"],
    ["no git: the project and the No git badge, no @", { repoId: "notes", worktreePath: "/src/notes" }, "writing No git"],
    ["a question: no place", { status: "attention" as const, statusReason: "question: Which one?" }, "Asked a question"],
  ])("%s", (_name, o, text) => {
    expect(renderRow(o).textContent).toBe(text);
  });

  it("the @ is muted and the branch mono", () => {
    renderRow({});
    expect(screen.getByText("@").className).toContain("opacity-60");
    expect(screen.getByTestId("row-branch").className).toContain("font-mono");
  });
});

describe("SidebarRow archived", () => {
  function renderArchived(o: Partial<SessionView>): HTMLElement {
    useSessionsStore.setState({ byId: { "s-1": thread({ state: "disconnected", status: "attention", statusReason: "finished", ...o }) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "session", section: "archived", sessionId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    return screen.getByRole("option");
  }

  it("one line: the name and the age of the archive, no status line, not dimmed", () => {
    const row = renderArchived({ name: "Old work", archivedAtMs: Date.now() - 3 * 3_600_000 - 60_000 });
    expect(row.textContent).toBe("Old work3h");
    expect(screen.queryByTestId("row-place")).toBeNull();
    expect(screen.getByTestId("row-archived-age").className).toContain("tabular-nums");
    expect(screen.getByTestId("session-body").getAttribute("data-offline")).toBeNull();
  });

  it("an unnamed thread shows its id, muted", () => {
    renderArchived({ name: "", archivedAtMs: Date.now() });
    expect(screen.getByTestId("session-name").textContent).toBe("s-1");
    expect(screen.getByTestId("session-name").className).toContain("text-muted-foreground");
    expect(screen.getByTestId("row-archived-age").textContent).toBe("0m");
  });
});

describe("SidebarRow footer headers", () => {
  it.each([
    ["working", "Working", 2],
    ["archived", "Archived", 5],
  ] as const)("%s: label and count, a toggle button", (section, label, count) => {
    render(<SidebarRow row={{ key: `h:${section}`, kind: "header", section, label, count, collapsed: section === "archived" }} selected={false} cursor={false} onActivate={() => undefined} />);
    const button = screen.getByTestId(`${section}-header`);
    expect(button.textContent).toBe(`${label} ${String(count)}`);
    expect(button.getAttribute("aria-expanded")).toBe(section === "archived" ? "false" : "true");
  });
});
