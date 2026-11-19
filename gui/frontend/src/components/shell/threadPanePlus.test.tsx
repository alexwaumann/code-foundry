import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

// The "+" of a thread pane's header row under Panes and Single (PanePlusMenu threadPane;
// docs/notes/shell-model.md, "A thread pane's header"): named "Open", the thread's surfaces at
// the top level, New thread beside under Panes, none under Single. A strip's "+" is
// linkedTabs.test.tsx's and plusPlugins.test.tsx's.
const runs: { name: string; args: Record<string, string> }[] = [];
const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));
const focusTabNow = vi.hoisted(() => vi.fn());
vi.mock("@/shell/commands", async (orig) => ({ ...(await orig<typeof import("@/shell/commands")>()), focusTabNow }));

const { PanePlusMenu } = await import("./PanePlusMenu");
const { resetLayout } = await import("@/stores/layout");
const { useThreadsStore } = await import("@/stores/threads");
const { useProjectsStore } = await import("@/stores/projects");
const { useTerminalsStore } = await import("@/stores/terminals");
const { useSettingsStore } = await import("@/stores/settings");
const { prKey } = await import("@/shell/linked");

const THREAD = {
  id: "s-1",
  name: "Refactor sidebar tree",
  projectId: "api",
  worktreePath: "/w/api",
  workspaceId: "",
  projectIds: ["api"],
  checkoutPaths: [],
  branch: "",
  createdWorktree: false,
  pendingWorktreePath: "",
  pendingMove: null,
  pinned: false,
  archivedAtMs: null,
  snoozedUntilMs: null,
  createdBy: "",
  createdByName: "",
  parentId: "",
  linkedPullRequests: [{ slug: "o/api", number: 12, url: "", linkedAt: null }],
  status: "idle",
  state: "connected",
} as unknown as ThreadView;

/** s-1's thread pane; its pull request and a terminal open in the pane beside; the empty composer's pane and a draft's. Its diff is not open. */
const LAYOUT = layoutOf([
  space(
    row("s-r", [
      pane("p-1", [tab("t-th", "thread", "s-1", { key: "thread:s-1" })]),
      pane("p-2", [tab("t-pr", "pullrequest", "s-1", { key: prKey("o/api", 12) }), tab("t-term", "terminal", "s-1", { key: "term:t-x", name: "make dev", params: { terminal: "t-x" } })]),
      pane("p-3", [tab("t-c", "compose", "", { key: "compose" })]),
      pane("p-4", [tab("t-dr", "compose", "", { key: "compose:draft:d-1", params: { draft: "d-1" } })]),
    ]),
    "p-1",
  ),
]);

function mode(value: string): void {
  useSettingsStore.setState({ snapshot: { values: { "layout.threads_open_as": value } } as never });
}

beforeEach(async () => {
  runs.length = 0;
  runCommandForResult.mockImplementation((name: string, args: Record<string, string>) => {
    runs.push({ name, args });
    return Promise.resolve({ message: "", resultJson: "" });
  });
  focusTabNow.mockResolvedValue(true);
  Element.prototype.scrollIntoView = vi.fn();
  resetLayout();
  useTerminalsStore.setState({ byId: {}, order: [], loaded: true });
  useProjectsStore.setState({ byId: { api: { id: "api", name: "api", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/w/api", branch: "main", head: "a", isMain: true }] } } as never, order: ["api"] });
  useThreadsStore.setState({ byId: { "s-1": THREAD }, order: ["s-1"], loaded: true });
  await seedLayout(LAYOUT);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetLayout();
  useSettingsStore.setState({ snapshot: null });
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

/** The menu's items, labels and separators in order ("—" a separator, "# x" a label). */
function entries(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role="menuitem"], [role="separator"], [data-slot="dropdown-menu-label"]')].map((e) =>
    e.getAttribute("role") === "separator" ? "—" : e.getAttribute("data-slot") === "dropdown-menu-label" ? `# ${e.textContent}` : e.textContent,
  );
}

function openPlus(paneId: string, threadPane: boolean): HTMLElement {
  render(<PanePlusMenu paneId={paneId} threadPane={threadPane} />);
  fireEvent.pointerDown(screen.getByTestId("pane-plus"), { button: 0, ctrlKey: false });
  return screen.getByTestId("pane-plus-menu");
}

const SURFACES = ["# This thread", "Diff", "PR #12open", "—", "# Terminals", "make devopen", "New terminal tab", "—"];
const REST = ["Terminal", "Pull Requests", "Projects"];

describe("a thread pane's + menu", () => {
  it("a strip's + is unchanged: named Open a tab, the thread's submenu, New thread with its chord", () => {
    mode("panes");
    const menu = openPlus("p-1", false);
    expect(screen.getByTestId("pane-plus").getAttribute("aria-label")).toBe("Open a tab");
    expect(entries(menu)).toEqual(["# This thread", "Refactor sidebar tree", "—", "New thread⌘N", ...REST]);
  });

  it("panes: named Open; the thread's surfaces at the top level, then New thread beside with no chord", () => {
    mode("panes");
    const menu = openPlus("p-1", true);
    expect(screen.getByRole("button", { name: "Open" })).toBe(screen.getByTestId("pane-plus"));
    expect(within(menu).queryByTestId("plus-thread")).toBeNull();
    expect(entries(menu)).toEqual([...SURFACES, "New thread beside", ...REST]);
  });

  it("single: no new thread item", () => {
    mode("single");
    const menu = openPlus("p-1", true);
    expect(screen.getByTestId("pane-plus").getAttribute("aria-label")).toBe("Open");
    expect(entries(menu)).toEqual([...SURFACES, ...REST]);
  });

  it.each([
    ["panes", "p-4", ["New thread beside", ...REST]],
    ["single", "p-4", REST],
    // The space's one empty composer: New thread beside would only focus it where it is.
    ["panes", "p-3", REST],
  ])("%s: a composer's pane (%s) has no thread group", (m, paneId, want) => {
    mode(m);
    expect(entries(openPlus(paneId, true))).toEqual(want);
  });

  it("New thread beside opens a composer beside this pane (composer.new --beside)", async () => {
    mode("panes");
    fireEvent.click(within(openPlus("p-1", true)).getByText("New thread beside"));
    await settle();
    expect(runs).toEqual([{ name: "composer.new", args: { beside: "p-1" } }]);
  });

  it("a surface at the top level runs as in the submenu: the diff, with the pane the + is in", async () => {
    mode("panes");
    fireEvent.click(within(openPlus("p-1", true)).getByText("Diff"));
    await settle();
    expect(runs).toEqual([{ name: "view.open.diff", args: { thread: "s-1", pane: "p-1" } }]);
  });
});
