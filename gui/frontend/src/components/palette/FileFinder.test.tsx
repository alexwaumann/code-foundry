// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { FinderMatchView, FinderSourceView } from "@/api/filesystem";
import type { WorktreeDetailView } from "@/api/worktreeDetail";
import { handleKeyDown, inPalette, presentCommand } from "@/keys/bindings";
import { contextKey, getUiContext } from "@/stores/context";
import { registerCiteTarget } from "@/stores/cite";
import { useCommandsStore } from "@/stores/commands";
import { openFileInPanel } from "@/stores/filePanel";
import { useRecentFilesStore } from "@/stores/recentFiles";
import { useUiStore } from "@/stores/ui";
import { stubLayout, settle } from "@/test/composerWorld";
import { daemon, resetDaemon } from "@/test/daemonFakes";
import { layoutSettled, threadSeed } from "@/test/fakeLayout";
import { addThreads, addWorkspace, CF, GP, HOME, panelActive, resetPanels, seedWorld, thread } from "@/test/projectsWorld";
import { CommandPalette } from "./CommandPalette";
import { FINDER_DEBOUNCE_MS } from "./useFileFinder";

type Search = (req: { sources: readonly FinderSourceView[]; query: string; limit?: number }) => Promise<FinderMatchView[]>;
const search = vi.fn<Search>();

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
vi.mock("@/api/filesystem", async (orig) => ({
  ...(await orig<typeof import("@/api/filesystem")>()),
  findFiles: (req: Parameters<Search>[0]) => search(req),
}));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const FILE_FIND: CommandView = { name: "file.find", title: "Go to File…", description: "", category: "View", args: [], keybindings: ["cmd+p"], available: true };

function detail(projectId: string, path: string, files: { path: string; status: string }[]): WorktreeDetailView {
  return {
    projectId,
    path,
    baseRef: "origin/main",
    mergeBase: "",
    head: "",
    files: files.map((f) => ({ ...f, oldPath: "", added: 1, deleted: 0, binary: false, uncommitted: true })),
    filesTruncated: false,
    computedAtMs: Date.now(),
    error: "",
  };
}

function match(projectId: string, checkout: string, path: string, pathPositions: number[] = [], projectPositions: number[] = []): FinderMatchView {
  return { projectId, checkout, path, pathPositions, projectPositions };
}

/** Every tab op sent so far answered by the layout. */
async function laidOut(): Promise<void> {
  await act(async () => {
    await layoutSettled();
  });
}

/** Past the debounce, and the answer rendered. */
async function searched(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, FINDER_DEBOUNCE_MS + 20));
  });
  await settle(10);
}

beforeEach(async () => {
  stubLayout();
  resetDaemon();
  seedWorld();
  // Thread s-1 in a pane: its tabs open beside it.
  await resetPanels(threadSeed("s-1"));
  search.mockReset();
  search.mockResolvedValue([]);
  useRecentFilesStore.setState({ byKey: {} });
  useCommandsStore.setState({ commands: [FILE_FIND], loading: false, error: null, contextKey: "" });
  // Two projects, the primary ghostty-playground; and a thread without a project.
  addThreads(
    thread("s-two", { projectId: "repo-gp", projectIds: ["repo-gp", "repo-cf"], worktreePath: GP, checkoutPaths: [{ projectId: "repo-cf", path: CF }] }),
    thread("s-home", { projectId: "", projectIds: [], worktreePath: HOME }),
  );
  render(<CommandPalette />);
});

afterEach(() => {
  cleanup();
  act(() => {
    useUiStore.getState().closePalette();
  });
});

async function openFinder(threadId: string): Promise<void> {
  act(() => {
    useUiStore.getState().select({ kind: "thread", id: threadId });
  });
  act(() => {
    presentCommand("file.find");
  });
  await settle(10);
}

const input = () => screen.getByRole("combobox");
const typeQuery = (q: string) => {
  fireEvent.change(input(), { target: { value: q } });
};
const mode = () => screen.queryByTestId("palette")?.getAttribute("data-mode") ?? null;
const headings = () => Array.from(document.querySelectorAll("[cmdk-group-heading]")).map((h) => h.textContent);
/** Each row as "name dir | open project status", bold letters in [brackets]. */
function rows(): string[] {
  return screen.queryAllByTestId("finder-row").map((r) => {
    const bold = (el: Element | null) => (el ? Array.from(el.childNodes).map((n) => (n instanceof Element && n.hasAttribute("data-hit") ? `[${n.textContent}]` : (n.textContent ?? ""))).join("") : "");
    const name = bold(r.querySelector('[data-testid="finder-name"]'));
    const dir = (r.querySelector('[data-testid="finder-dir"]')?.textContent ?? "").replace(/‎/g, "");
    const right = [r.querySelector('[data-testid="finder-open"]') ? "open" : "", bold(r.querySelector('[data-testid="finder-project"]')), r.querySelector('[data-testid="finder-status"]')?.textContent ?? ""].filter(Boolean).join(" ");
    return `${name}${dir ? ` ${dir}` : ""}${right ? ` | ${right}` : ""}`;
  });
}

describe("opening the file finder", () => {
  it("file.find opens it over a thread with a project, focused, named after the project", async () => {
    await openFinder("s-1");
    expect(mode()).toBe("files");
    expect(input().getAttribute("placeholder")).toBe("Go to file in code-foundry…");
    expect(document.activeElement).toBe(input());
  });

  it("is named after a workspace thread's workspace", async () => {
    const ws = addWorkspace("terminal-port", ["repo-gp", "repo-cf"]);
    addThreads(thread("s-ws", { projectId: "repo-gp", projectIds: ["repo-gp", "repo-cf"], worktreePath: GP, workspaceId: ws.id }));
    await openFinder("s-ws");
    expect(input().getAttribute("placeholder")).toBe("Go to file in terminal-port…");
  });

  it("opens nothing for a thread without a project, nor on a page", async () => {
    await openFinder("s-home");
    expect(useUiStore.getState().palette.open).toBe(false);
    act(() => {
      useUiStore.getState().select({ kind: "view", name: "pullrequests" });
      presentCommand("file.find");
    });
    await settle(10);
    expect(useUiStore.getState().palette.open).toBe(false);
  });

  it("cmd+p does nothing and the palette leaves it out where the daemon lists it unavailable (a thread without a project)", async () => {
    useCommandsStore.setState({ commands: [{ ...FILE_FIND, available: false }], contextKey: contextKey(getUiContext()) });
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "s-home" });
    });
    useCommandsStore.setState({ contextKey: contextKey(getUiContext()) });
    act(() => {
      handleKeyDown(new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true }));
    });
    await settle(10);
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(inPalette({ ...FILE_FIND, available: false })).toBe(false);
    expect(inPalette(FILE_FIND)).toBe(true);
  });

  it("cmd+p runs file.find through the keymap", async () => {
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "s-1" });
    });
    act(() => {
      handleKeyDown(new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true }));
    });
    await settle(10);
    expect(mode()).toBe("files");
  });
});

describe("the empty query", () => {
  it("lists the thread's changed files (no deleted ones), then the thread's recent files not changed", async () => {
    daemon.worktreeDetail.set(`repo-cf\u0000${CF}`, detail("repo-cf", CF, [{ path: "gui/src/lib/tree.ts", status: "M" }, { path: "gone.ts", status: "D" }, { path: "gui/src/lib/virtualRows.ts", status: "A" }]));
    // The panel opened README.md, tree.ts and docs/PLAN.md; README.md's tab is still open.
    useRecentFilesStore.setState({ byKey: { "thread:s-1": [`${CF}/README.md`, `${CF}/gui/src/lib/tree.ts`, `${CF}/docs/PLAN.md`].map((path) => ({ project: "repo-cf", base: CF, path })) } });
    openFileInPanel("thread:s-1", { project: "repo-cf", base: CF, path: "README.md" });
    await laidOut();
    await openFinder("s-1");
    await settle(10);
    expect(headings()).toEqual(["Changed in this thread", "Recently opened"]);
    expect(rows()).toEqual(["tree.ts gui/src/lib | M", "virtualRows.ts gui/src/lib | A", "README.md | open", "PLAN.md docs"]);
    expect(search).not.toHaveBeenCalled();
  });

  it("labels each row with its project in a two-project thread", async () => {
    daemon.worktreeDetail.set(`repo-gp\u0000${GP}`, detail("repo-gp", GP, [{ path: "src/render/Renderer.zig", status: "M" }]));
    useRecentFilesStore.setState({ byKey: { "thread:s-two": [{ project: "repo-cf", base: CF, path: `${CF}/README.md` }] } });
    await openFinder("s-two");
    await settle(10);
    expect(rows()).toEqual(["Renderer.zig src/render | ghostty-playground M", "README.md | code-foundry"]);
  });

  it("says so when there is nothing to list", async () => {
    await openFinder("s-1");
    expect(screen.getByTestId("finder-status-line").textContent).toBe("No changed or recently opened files. Type to search.");
  });
});

describe("a typed query", () => {
  it("searches the thread's checkouts, the primary first, and bolds the matched letters", async () => {
    search.mockResolvedValue([match("repo-gp", GP, "src/render/Tree.zig", [11, 12, 13, 14]), match("repo-cf", CF, "gui/src/lib/tree.ts", [12, 13, 14, 15], [0, 1])]);
    await openFinder("s-two");
    typeQuery("tree");
    await searched();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]?.[0]).toMatchObject({
      sources: [
        { projectId: "repo-gp", path: GP },
        { projectId: "repo-cf", path: CF },
      ],
      query: "tree",
    });
    expect(rows()).toEqual(["[Tree].zig src/render | ghostty-playground", "[tree].ts gui/src/lib | [co]de-foundry"]);
    expect(headings()).toEqual([]);
  });

  it("shows no project label in a one-project thread, and a changed file's status", async () => {
    daemon.worktreeDetail.set(`repo-cf\u0000${CF}`, detail("repo-cf", CF, [{ path: "gui/src/lib/tree.ts", status: "M" }]));
    search.mockResolvedValue([match("repo-cf", CF, "gui/src/lib/tree.ts", [12, 13, 14, 15]), match("repo-cf", CF, "tree.go", [0, 1, 2, 3])]);
    await openFinder("s-1");
    typeQuery("tree");
    await searched();
    expect(rows()).toEqual(["[tree].ts gui/src/lib | M", "[tree].go"]);
  });

  it("sends a name:line query without the line", async () => {
    await openFinder("s-1");
    typeQuery("tree.ts:42");
    await searched();
    expect(search.mock.calls.map((c) => c[0].query)).toEqual(["tree.ts"]);
  });

  it("sends nothing for more than 8 words and says so", async () => {
    await openFinder("s-1");
    typeQuery("a b c d e f g h i");
    await searched();
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByTestId("finder-status-line").textContent).toBe("At most 8 words");
  });

  it("keeps the last rows while the next search is out, and debounces a burst", async () => {
    search.mockResolvedValueOnce([match("repo-cf", CF, "tree.ts", [0, 1])]);
    await openFinder("s-1");
    typeQuery("tr");
    await searched();
    expect(rows()).toEqual(["[tr]ee.ts"]);
    search.mockReturnValue(new Promise(() => undefined));
    typeQuery("tre");
    typeQuery("tree");
    await searched();
    expect(search.mock.calls.map((c) => c[0].query)).toEqual(["tr", "tree"]);
    expect(rows()).toEqual(["[tr]ee.ts"]);
  });

  it("says Searching… (not No matching files.) while a new query's search is out after an empty answer", async () => {
    search.mockResolvedValueOnce([]);
    await openFinder("s-1");
    typeQuery("zz");
    await searched();
    expect(screen.getByTestId("finder-status-line").textContent).toBe("No matching files.");
    search.mockReturnValue(new Promise(() => undefined));
    typeQuery("zzz");
    await searched();
    expect(screen.getByTestId("finder-status-line").textContent).toBe("Searching…");
  });

  it("shows a failed search's message", async () => {
    search.mockRejectedValue(new Error("list /x: permission denied"));
    await openFinder("s-1");
    typeQuery("tree");
    await searched();
    expect(screen.getByTestId("finder-error").textContent).toBe("Cannot search: list /x: permission denied");
  });
});

describe("picking a file", () => {
  it("Enter opens it as a File tab among the thread's tabs (none before), at a typed line", async () => {
    search.mockResolvedValue([match("repo-cf", CF, "gui/src/lib/tree.ts", [12, 13, 14, 15])]);
    await openFinder("s-1");
    expect(panelActive("thread:s-1")).toBeNull();
    typeQuery("tree:42");
    await searched();
    fireEvent.keyDown(input(), { key: "Enter" });
    await settle(5);
    await laidOut();
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(panelActive("thread:s-1")).toEqual({ open: true, kind: "files", title: "tree.ts", params: { project: "repo-cf", base: CF, path: `${CF}/gui/src/lib/tree.ts`, line: "42" } });
  });

  it("Enter before the typed query's answer waits for it and opens its first row, not the previous query's", async () => {
    search.mockResolvedValueOnce([match("repo-cf", CF, "gui/src/lib/tree.ts", [12, 13])]);
    await openFinder("s-1");
    typeQuery("tr");
    await searched();
    let answer: (m: FinderMatchView[]) => void = () => undefined;
    search.mockReturnValueOnce(
      new Promise((r) => {
        answer = r;
      }),
    );
    typeQuery("app:7");
    fireEvent.keyDown(input(), { key: "Enter" });
    await searched();
    expect(useUiStore.getState().palette.open).toBe(true);
    expect(panelActive("thread:s-1")).toBeNull();
    await act(async () => {
      answer([match("repo-cf", CF, "src/app.ts", [4, 5, 6])]);
      await Promise.resolve();
    });
    await settle(5);
    await laidOut();
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(panelActive("thread:s-1")?.params).toEqual({ project: "repo-cf", base: CF, path: `${CF}/src/app.ts`, line: "7" });
  });

  it("a waiting Enter is dropped when the query changes or the search fails", async () => {
    search.mockReturnValueOnce(new Promise(() => undefined));
    await openFinder("s-1");
    typeQuery("tree");
    fireEvent.keyDown(input(), { key: "Enter" });
    await searched();
    expect(screen.getByTestId("finder-status-line").textContent).toBe("Searching…");
    search.mockResolvedValueOnce([match("repo-cf", CF, "tree.go", [0])]);
    typeQuery("tree.go");
    await searched();
    expect(rows()).toEqual(["[t]ree.go"]);
    expect(useUiStore.getState().palette.open).toBe(true);
    search.mockRejectedValueOnce(new Error("boom"));
    typeQuery("tree.g");
    fireEvent.keyDown(input(), { key: "Enter" });
    await searched();
    expect(screen.getByTestId("finder-error").textContent).toBe("Cannot search: boom");
    expect(useUiStore.getState().palette.open).toBe(true);
    await laidOut();
    expect(panelActive("thread:s-1")).toBeNull();
  });

  it("a failed search lists none of the previous query's files, and a later Enter opens nothing", async () => {
    await openFinder("s-1");
    search.mockResolvedValueOnce([match("repo-cf", CF, "tree.go", [0])]);
    typeQuery("tr");
    await searched();
    expect(rows()).toEqual(["[t]ree.go"]);
    search.mockRejectedValueOnce(new Error("boom"));
    typeQuery("tree.g");
    await searched();
    expect(screen.getByTestId("finder-error").textContent).toBe("Cannot search: boom");
    expect(rows()).toEqual([]);
    fireEvent.keyDown(input(), { key: "Enter" });
    await settle(5);
    await laidOut();
    expect(panelActive("thread:s-1")).toBeNull();
  });

  it("Enter on a changed file opens a File tab, not a Diff tab, and an open one only activates", async () => {
    daemon.worktreeDetail.set(`repo-cf\u0000${CF}`, detail("repo-cf", CF, [{ path: "a.ts", status: "M" }]));
    openFileInPanel("thread:s-1", { project: "repo-cf", base: CF, path: "a.ts" });
    openFileInPanel("thread:s-1", { project: "repo-cf", base: CF, path: "b.ts" });
    await laidOut();
    expect(panelActive("thread:s-1")?.params.path).toBe(`${CF}/b.ts`);
    await openFinder("s-1");
    await settle(10);
    fireEvent.keyDown(input(), { key: "Enter" });
    await settle(5);
    await laidOut();
    expect(panelActive("thread:s-1")?.params.path).toBe(`${CF}/a.ts`);
    expect(panelActive("thread:s-1")?.kind).toBe("files");
  });

  it("⌥⏎ puts the file in the thread's prompt as an @ file and closes", async () => {
    const insertTag = vi.fn();
    const unregister = registerCiteTarget("thread:s-two", { insert: () => undefined, insertTag, focus: () => undefined });
    search.mockResolvedValue([match("repo-cf", CF, "gui/src/lib/tree.ts")]);
    await openFinder("s-two");
    typeQuery("tree");
    await searched();
    fireEvent.keyDown(input(), { key: "Enter", altKey: true });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(r));
    });
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(insertTag).toHaveBeenCalledWith({ tagKind: "file", projectId: "repo-cf", path: "gui/src/lib/tree.ts" });
    expect(panelActive("thread:s-two")).toBeNull();
    unregister();
  });
});
