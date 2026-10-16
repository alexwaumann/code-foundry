import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionView } from "@/api/session";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
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
    ["starting reads as working", { state: "starting" as const }, "Working · code-foundry @ main"],
    ["stopped at its prompt: the place, like idle", { state: "disconnected" as const }, "code-foundry @ main"],
    ["no git: the project and the No git badge, no @", { repoId: "notes", worktreePath: "/src/notes" }, "writing No git"],
    ["a question: no place", { status: "attention" as const, statusReason: "question: Which one?" }, "Asked a question"],
    ["no project: No project alone, no branch", { repoId: "", worktreePath: "/Users/dev" }, "No project"],
    ["no project, working", { repoId: "", worktreePath: "/Users/dev", status: "busy" as const }, "Working · No project"],
  ])("%s", (_name, o, text) => {
    expect(renderRow(o).textContent).toBe(text);
  });

  it("a stopped thread looks like any other: not dimmed, no offline mark", () => {
    renderRow({ state: "disconnected" });
    const body = screen.getByTestId("session-body");
    expect(body.className).not.toContain("opacity-50");
    expect(body.getAttribute("data-offline")).toBeNull();
    expect(screen.getByTestId("row-place").getAttribute("data-session-badge")).toBe("idle");
  });

  it("the @ is muted and the branch mono", () => {
    renderRow({});
    expect(screen.getByText("@").className).toContain("opacity-60");
    expect(screen.getByTestId("row-branch").className).toContain("font-mono");
  });
});

describe("SidebarRow running agents", () => {
  it.each([
    ["idle: N agents, then the place", { agentsRunning: 3 }, "3 agents · code-foundry @ main"],
    ["one", { agentsRunning: 1 }, "1 agent · code-foundry @ main"],
    ["working: before the status", { agentsRunning: 2, status: "busy" as const }, "2 agents · Working · code-foundry @ main"],
    ["a question: before it, no place", { agentsRunning: 1, status: "attention" as const, statusReason: "question: Which one?" }, "1 agent · Asked a question"],
    ["none: nothing", { agentsRunning: 0 }, "code-foundry @ main"],
  ])("%s", (_name, o, text) => {
    expect(renderRow(o).textContent).toBe(text);
  });

  it("is sky with a bot icon", () => {
    renderRow({ agentsRunning: 2 });
    const el = screen.getByTestId("row-agents");
    expect(el.className).toContain("text-info");
    expect(el.querySelector("svg")).not.toBeNull();
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
    expect(screen.getByTestId("session-body").className).not.toContain("opacity-50");
  });

  it("an unnamed thread shows its id, muted", () => {
    renderArchived({ name: "", archivedAtMs: Date.now() });
    expect(screen.getByTestId("session-name").textContent).toBe("s-1");
    expect(screen.getByTestId("session-name").className).toContain("text-muted-foreground");
    expect(screen.getByTestId("row-archived-age").textContent).toBe("0m");
  });
});

describe("SidebarRow snoozed", () => {
  function renderSnoozed(o: Partial<SessionView>): HTMLElement {
    useSessionsStore.setState({ byId: { "s-1": thread({ state: "disconnected", status: "attention", statusReason: "finished", ...o }) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "session", section: "snoozed", sessionId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    return screen.getByRole("option");
  }

  it.each([
    [45 * 60_000 + 30_000, "45m"],
    [2 * 3_600_000 + 50 * 60_000, "2h"],
    [18 * 3_600_000 + 5 * 60_000, "18h"],
    [4 * 86_400_000 + 3_600_000, "4d"],
    [20_000, "<1m"],
  ])("one line: the name and the time left (%i ms → %s), no status line, not dimmed", (left, want) => {
    const row = renderSnoozed({ name: "Later work", snoozedUntilMs: Date.now() + left });
    expect(row.textContent).toBe(`Later work${want}`);
    expect(row.getAttribute("data-section")).toBe("snoozed");
    expect(screen.queryByTestId("row-place")).toBeNull();
    expect(screen.getByTestId("row-snooze-left").className).toContain("tabular-nums");
    expect(screen.getByTestId("row-snooze-left").className).toContain("text-caption-sm");
    expect(screen.getByTestId("session-body").className).not.toContain("opacity-50");
    expect(screen.getByTestId("session-body").hasAttribute("data-snoozed")).toBe(true);
  });

  it("an unnamed thread shows its id, muted", () => {
    renderSnoozed({ name: "", snoozedUntilMs: Date.now() + 3_600_000 + 1000 });
    expect(screen.getByTestId("session-name").textContent).toBe("s-1");
    expect(screen.getByTestId("session-name").className).toContain("text-muted-foreground");
    expect(screen.getByTestId("row-snooze-left").textContent).toBe("1h");
  });
});

describe("SidebarRow line 2 after a snooze", () => {
  it("a woken thread reads Snooze ended with how long ago, amber, without the place", () => {
    renderRow({ state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: Date.now() - 2 * 60_000 });
    expect(screen.getByTestId("row-place").textContent).toBe("Snooze ended · 2 min ago");
    expect(screen.getByTestId("row-status").className).toContain("text-warning");
    expect(screen.getByTestId("row-place").getAttribute("data-status-line")).toBe("snoozeEnded");
  });
});

describe("SidebarRow footer headers", () => {
  it.each([
    ["working", "Working", 2, false],
    ["snoozed", "Snoozed", 3, true],
    ["archived", "Archived", 5, true],
  ] as const)("%s: label and count, a toggle button", (section, label, count, collapsed) => {
    render(<SidebarRow row={{ key: `h:${section}`, kind: "header", section, label, count, collapsed }} selected={false} cursor={false} onActivate={() => undefined} />);
    const button = screen.getByTestId(`${section}-header`);
    expect(button.textContent).toBe(`${label} ${String(count)}`);
    expect(button.getAttribute("aria-expanded")).toBe(collapsed ? "false" : "true");
  });

  it("the Snoozed header toggles only the Snoozed section", () => {
    useUiStore.setState({ workingCollapsed: false, snoozedCollapsed: true, archivedCollapsed: true });
    render(<SidebarRow row={{ key: "h:snoozed", kind: "header", section: "snoozed", label: "Snoozed", count: 1, collapsed: true }} selected={false} cursor={false} onActivate={() => undefined} />);
    fireEvent.click(screen.getByTestId("snoozed-header"));
    expect(useUiStore.getState()).toMatchObject({ workingCollapsed: false, snoozedCollapsed: false, archivedCollapsed: true });
  });
});
