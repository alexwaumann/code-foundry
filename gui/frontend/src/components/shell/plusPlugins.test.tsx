import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

// The verbs the menus run, with the thread of their context, and the tabs they focus.
const runs: { name: string; args: Record<string, string>; thread: string }[] = [];
const focused: string[] = [];
const runCommandForResult = vi.hoisted(() => vi.fn());
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));
const focusTabNow = vi.hoisted(() => vi.fn());
vi.mock("@/shell/commands", async (orig) => ({ ...(await orig<typeof import("@/shell/commands")>()), focusTabNow }));
// A thread's list asked of the daemon (a pane that is not the focused one's thread).
const listCommands = vi.hoisted(() => vi.fn());
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), listCommands }));

const { PanePlusMenu } = await import("./PanePlusMenu");
const { resetLayout } = await import("@/stores/layout");
const { useThreadsStore } = await import("@/stores/threads");
const { useProjectsStore } = await import("@/stores/projects");
const { useTerminalsStore } = await import("@/stores/terminals");
const { usePluginsStore } = await import("@/stores/plugins");
const { useCommandsStore } = await import("@/stores/commands");
const { contextKey, getUiContext } = await import("@/stores/context");
const { useUiStore } = await import("@/stores/ui");
const { setShellFrame } = await import("@/stores/shellView");

const thread = (id: string, name: string) =>
  ({
    id,
    name,
    projectId: "api",
    worktreePath: "/w/api",
    workspaceId: "",
    projectIds: ["api"],
    checkoutPaths: [],
    branch: "",
    pendingWorktreePath: "",
    pendingMove: null,
    pinned: false,
    archivedAtMs: null,
    snoozedUntilMs: null,
    parentId: "",
    linkedPullRequests: [],
    status: "idle",
    state: "connected",
  }) as unknown as ThreadView;

const surface = (plugin: string, id: string, title: string, icon: string, scope: string) => ({
  id,
  title,
  icon,
  scope,
  when: "",
  showCommand: `plugin.${plugin}.show.${id}`,
  kind: `plugin.${plugin}.${id}`,
});

/** Two plugins: Hello with a thread's surface and a pull request's, Test Watcher with two global ones. */
const PLUGINS = {
  hello: { name: "hello", displayName: "Hello", surfaces: [surface("hello", "demo", "Hello Demo", "sparkles", "thread"), surface("hello", "checks", "Actions Checks", "workflow", "pr")] },
  "test-watcher": { name: "test-watcher", displayName: "Test Watcher", surfaces: [surface("test-watcher", "runs", "Test runs", "flask-conical", "global"), surface("test-watcher", "flaky", "Flaky tests", "bug", "project")] },
};

/** s-1's tab beside a pane of the composer; s-2's tab behind s-1's. */
const LAYOUT = layoutOf([
  space(
    row("s-r", [pane("p-1", [tab("t-th", "thread", "s-1", { key: "thread:s-1" }), tab("t-th2", "thread", "s-2", { key: "thread:s-2" })]), pane("p-2", [tab("t-c", "compose", "", { key: "compose" })])]),
    "p-1",
  ),
]);

/** The commands store, listed for `ctx`'s context with these show commands available. */
function listed(sel: Parameters<typeof getUiContext>[0], available: string[]): void {
  const all = Object.values(PLUGINS).flatMap((p) => p.surfaces.map((s) => s.showCommand));
  useCommandsStore.setState({ commands: all.map((name) => ({ name, available: available.includes(name) })) as never, contextKey: contextKey(getUiContext(sel)), loading: false });
}

beforeEach(async () => {
  runs.length = 0;
  focused.length = 0;
  runCommandForResult.mockImplementation((name: string, args: Record<string, string>, opts: { ctx?: { activeThreadId?: string } } = {}) => {
    runs.push({ name, args, thread: opts.ctx?.activeThreadId ?? "" });
    return Promise.resolve({ message: "", resultJson: "" });
  });
  focusTabNow.mockImplementation((id: string) => {
    focused.push(id);
    return Promise.resolve(true);
  });
  listCommands.mockResolvedValue([]);
  Element.prototype.scrollIntoView = vi.fn();
  resetLayout();
  useTerminalsStore.setState({ byId: {}, order: [], loaded: true });
  useProjectsStore.setState({ byId: { api: { id: "api", name: "api", git: true, githubSlug: "", remotes: [], worktrees: [] } } as never, order: ["api"] });
  useThreadsStore.setState({ byId: { "s-1": thread("s-1", "Refactor sidebar tree"), "s-2": thread("s-2", "Write thread docs") }, order: ["s-1", "s-2"], loaded: true });
  usePluginsStore.setState({ byName: PLUGINS as never, order: ["hello", "test-watcher"], loaded: true });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } as never });
  await seedLayout(LAYOUT);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetLayout();
  usePluginsStore.setState({ byName: {}, order: [] });
});

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

/** The menu's items, labels and separators in order ("—" a separator, "# x" a label). */
function entries(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role="menuitem"], [role="separator"], [data-slot="dropdown-menu-label"]')].map((e) =>
    e.getAttribute("role") === "separator" ? "—" : e.getAttribute("data-slot") === "dropdown-menu-label" ? `# ${e.textContent}` : e.textContent,
  );
}

function openPlus(paneId: string): HTMLElement {
  render(<PanePlusMenu paneId={paneId} />);
  fireEvent.pointerDown(screen.getByTestId("pane-plus"), { button: 0, ctrlKey: false });
  return screen.getByTestId("pane-plus-menu");
}

async function threadSub(menu: HTMLElement): Promise<HTMLElement> {
  fireEvent.keyDown(within(menu).getByTestId("plus-thread"), { key: "ArrowRight" });
  return screen.findByTestId("plus-thread-surfaces");
}

const GENERAL = ["New thread⌘N", "Terminal", "Pull Requests", "Projects"];

describe("plugin surfaces in a pane's + menu", () => {
  it("lists each available surface of no thread under Plugins, with its plugin's name; a pick opens it in this pane", async () => {
    listed({ kind: "thread", id: "s-1" }, ["plugin.test-watcher.show.runs", "plugin.test-watcher.show.flaky", "plugin.hello.show.demo"]);
    const menu = openPlus("p-2");
    // The thread's surface (demo) is not in the general list.
    expect(entries(menu)).toEqual([...GENERAL, "—", "# Plugins", "Test runsTest Watcher", "Flaky testsTest Watcher"]);
    fireEvent.click(within(menu).getByText("Test runs"));
    await settle();
    expect(runs).toEqual([{ name: "plugin.test-watcher.show.runs", args: { pane: "p-2" }, thread: "" }]);
  });

  it("lists only what the daemon says can show: no label and no separator when nothing can", () => {
    listed({ kind: "thread", id: "s-1" }, ["plugin.test-watcher.show.flaky"]);
    expect(entries(openPlus("p-2"))).toEqual([...GENERAL, "—", "# Plugins", "Flaky testsTest Watcher"]);
    cleanup();
    listed({ kind: "thread", id: "s-1" }, []);
    expect(entries(openPlus("p-2"))).toEqual(GENERAL);
  });

  it("lists none in a pane of terminals with no room for another kind of tab", async () => {
    listed({ kind: "thread", id: "s-1" }, ["plugin.test-watcher.show.runs"]);
    await seedLayout(layoutOf([space(row("s-r", [pane("p-1", [tab("t-th", "thread", "s-1", { key: "thread:s-1" })]), pane("p-t", [tab("t-term", "terminal", "s-1", { key: "term:t-x", params: { terminal: "t-x" } })])]), "p-1")], 2));
    setShellFrame({ w: 900, h: 800, rects: {}, gutters: [] });
    try {
      expect(entries(openPlus("p-t"))).toEqual(["Terminal"]);
    } finally {
      setShellFrame(null);
    }
  });
});

describe("a thread's plugin surfaces in the + menu's thread submenu", () => {
  it("lists the thread's and its pull request's available surfaces after its views; a pick opens it linked to the thread in this pane", async () => {
    listed({ kind: "thread", id: "s-1" }, ["plugin.hello.show.demo", "plugin.hello.show.checks", "plugin.test-watcher.show.runs"]);
    const sub = await threadSub(openPlus("p-1"));
    expect(entries(sub)).toEqual(["Diff", "Hello DemoHello", "Actions ChecksHello", "—", "# Terminals", "New terminal tab"]);
    fireEvent.click(within(sub).getByText("Actions Checks"));
    await settle();
    expect(runs).toEqual([{ name: "plugin.hello.show.checks", args: { thread: "s-1", pane: "p-1" }, thread: "s-1" }]);
    expect(listCommands).not.toHaveBeenCalled();
  });

  it("marks one open in the space and focuses it where it is", async () => {
    await seedLayout(
      layoutOf([
        space(
          row("s-r", [pane("p-1", [tab("t-th", "thread", "s-1", { key: "thread:s-1" })]), pane("p-2", [tab("t-demo", "plugin.hello.demo", "s-1", { key: "plugin:hello/demo/thread:s-1", title: "Hello Demo" })])]),
          "p-1",
        ),
      ]),
    );
    listed({ kind: "thread", id: "s-1" }, ["plugin.hello.show.demo"]);
    const sub = await threadSub(openPlus("p-1"));
    expect(within(sub).getByText("Hello Demo").closest("[data-open]")).not.toBeNull();
    expect(entries(sub)).toContain("Hello DemoHello · open");
    fireEvent.click(within(sub).getByText("Hello Demo"));
    await settle();
    expect(runs).toEqual([]);
    expect(focused).toEqual(["t-demo"]);
  });

  it("asks the daemon for the thread's list when the window's is another context's", async () => {
    // The window shows s-2; the pane's + is s-1's.
    listed({ kind: "thread", id: "s-2" }, ["plugin.hello.show.demo"]);
    listCommands.mockResolvedValue([
      { name: "plugin.hello.show.demo", available: false },
      { name: "plugin.hello.show.checks", available: true },
    ]);
    const sub = await threadSub(openPlus("p-1"));
    await settle();
    expect(listCommands.mock.calls[0]?.[0]).toMatchObject({ activeThreadId: "s-1" });
    expect(entries(sub)).toEqual(["Diff", "Actions ChecksHello", "—", "# Terminals", "New terminal tab"]);
  });
});
