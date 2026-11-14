import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

// Each body as a marker naming what it was given: which one mounts is the question here.
vi.mock("@/components/thread/ThreadPane", () => ({ ThreadPane: ({ threadId }: { threadId: string }) => <div data-testid="body" data-body={`thread:${threadId}`} /> }));
vi.mock("@/components/prs/PullRequestsPage", () => ({ PullRequestsPage: () => <div data-testid="body" data-body="prs" /> }));
vi.mock("@/components/projects/ProjectsPage", () => ({
  ProjectsPageAt: ({ projectId, workspaceId }: { projectId: string; workspaceId: string }) => <div data-testid="body" data-body={`projects:${projectId}:${workspaceId}`} />,
}));
vi.mock("@/components/compose/Composer", () => ({
  Composer: ({ projectId, noProject }: { projectId: string; noProject?: boolean }) => <div data-testid="body" data-body={`compose:${noProject ? "home" : projectId}`} />,
}));
vi.mock("@/components/diff/DiffView", () => ({
  DiffView: ({ tabId, target }: { tabId: string; target: { worktree: string } }) => <div data-testid="body" data-body={`diff:${tabId}:${target.worktree}`} />,
}));
const focused: string[] = [];
vi.mock("@/shell/commands", () => ({
  focusPaneNow: (id: string) => {
    focused.push(id);
    return Promise.resolve(true);
  },
  focusTabNow: () => Promise.resolve(true),
  closeTabNow: () => Promise.resolve(null),
}));

const { PaneView } = await import("./PaneView");
const { resetLayout } = await import("@/stores/layout");
const { requestPaneFocus } = await import("@/stores/shellView");

const RECT = { x: 0, y: 0, w: 600, h: 400, rail: false };
const tabs = [
  tab("t-th", "thread", "s-1"),
  tab("t-d", "diff", "s-1", { params: { project: "pj", worktree: "/w/pj" } }),
  tab("t-prs", "prs"),
  tab("t-pj", "projects", "", { params: { project: "pj" } }),
  tab("t-c", "compose"),
  tab("t-x", "someday.kind"),
];

async function showing(active: string, focus = "p-1"): Promise<void> {
  await act(async () => {
    await seedLayout(layoutOf([space(row("s-r", [pane("p-1", tabs, active), pane("p-2", [tab("t-o", "prs")])]), focus)]));
  });
}

const bodies = () => screen.queryAllByTestId("body").map((b) => b.getAttribute("data-body"));

beforeEach(() => {
  focused.length = 0;
  resetLayout();
});

afterEach(() => {
  cleanup();
  resetLayout();
});

describe("PaneView", () => {
  it.each([
    ["t-th", "thread:s-1"],
    ["t-d", "diff:t-d:/w/pj"],
    ["t-prs", "prs"],
    ["t-pj", "projects:pj:"],
    ["t-c", "compose:home"],
  ])("mounts only the active tab's body (%s)", async (active, body) => {
    await showing(active);
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    expect(bodies()).toEqual([body]);
  });

  it("a kind this build does not know draws a placeholder, not an error", async () => {
    await showing("t-x");
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    expect(screen.getByTestId("shell-unknown-surface").textContent).toContain("someday.kind");
  });

  it("switching tabs unmounts the old body (a hidden tab holds nothing)", async () => {
    await showing("t-th");
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    await showing("t-prs");
    expect(bodies()).toEqual(["prs"]);
  });

  it("sits at its rectangle, marked focused or not", async () => {
    await showing("t-th");
    render(<PaneView paneId="p-1" rect={{ x: 12, y: 30, w: 500, h: 300, rail: false }} focused={false} />);
    const el = screen.getByTestId("shell-pane");
    expect([el.style.left, el.style.top, el.style.width, el.style.height]).toEqual(["12px", "30px", "500px", "300px"]);
    expect(el.hasAttribute("data-focused")).toBe(false);
    expect(el.className).toContain("border-cf-divider");
    expect(el.className).not.toContain("border-cf-accent");
  });

  it("tints the focused pane's border with the accent", async () => {
    await showing("t-th");
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    const el = screen.getByTestId("shell-pane");
    expect(el.getAttribute("data-focused")).toBe("true");
    expect(el.className).toContain("border-cf-accent/60");
    expect(el.className).not.toContain("border-cf-divider");
  });

  it("a press in a pane without the focus focuses it (pane.focus); in the focused pane it asks nothing", async () => {
    await showing("t-prs", "p-2");
    render(<PaneView paneId="p-1" rect={RECT} focused={false} />);
    fireEvent.pointerDown(screen.getByTestId("body"));
    expect(focused).toEqual(["p-1"]);
    cleanup();
    await showing("t-prs", "p-1");
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    fireEvent.pointerDown(screen.getByTestId("body"));
    expect(focused).toEqual(["p-1"]);
  });

  it("its body takes the keyboard only for a focus request: never by a press on a blank spot", async () => {
    await showing("t-prs");
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    const body = screen.getByTestId("shell-pane-body");
    // Not focusable: a press on a composer's heading leaves the keyboard in its prompt.
    expect(body.hasAttribute("tabindex")).toBe(false);
    act(() => {
      requestPaneFocus("p-1");
    });
    // The surface has no focus root of its own: the body takes it, for this request only.
    expect(document.activeElement).toBe(body);
    act(() => {
      body.blur();
    });
    expect(body.hasAttribute("tabindex")).toBe(false);
  });
});
