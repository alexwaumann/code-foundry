import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareCommitView, CompareFileSidesView, CompareFileView, CompareLogView, CompareSideView, CompareTarget, CompareView } from "@/api/compare";
import type { ProjectView, WorktreeView } from "@/api/project";
import { useCodeViewStore } from "@/stores/codeView";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { DEFAULT_BASE, DEFAULT_HEAD, diffOfTab, diffTab, EMPTY_TREE, sourceParam, type DiffTarget } from "@/surfaces/diffTarget";

/**
 * The Diff tab over faked compare calls (docs/notes/diff-viewer-2.md): what the Changes tab
 * did (conflicts first, the states, live updates), file by file. The diff itself is
 * @pierre/diffs' and the rail's width a real layout's (a real browser: e2e/diff-viewer.spec.ts),
 * so CodeDiff is a stand-in and useWidth says what a test sets.
 */

const api = vi.hoisted(() => ({
  view: null as Partial<CompareView> | null | Error,
  sides: new Map<string, Partial<CompareFileSidesView>>(),
  compares: [] as string[],
  paths: [] as (readonly string[])[],
  reads: [] as string[],
  /** Each read's rename source, in order. */
  oldPaths: [] as string[],
  /** How many times a file's sides were parsed. */
  parses: 0,
  log: null as Partial<CompareLogView> | Error | null,
  logs: [] as string[],
  /** What ProjectService.GetCompareCommit answers, by sha. */
  bodies: new Map<string, string | Error>(),
  bodyReads: [] as string[],
  urls: [] as string[],
  width: 900,
  height: 800,
  /** What the file watcher watches, each with its listeners. */
  watched: new Map<string, Set<() => void>>(),
  dotGit: { isDir: true, path: "", text: null } as { isDir: boolean; path: string; text: string | null },
}));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
vi.mock("@/stores/fileStamps", () => ({
  fileWatcher: {
    watch: (path: string, onChange: () => void) => {
      const listeners = api.watched.get(path) ?? new Set();
      api.watched.set(path, listeners.add(onChange));
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) api.watched.delete(path);
      };
    },
    check: () => undefined,
  },
}));
vi.mock("@/api/files", async (orig) => ({ ...(await orig<typeof import("@/api/files")>()), readFile: () => Promise.resolve(api.dotGit) }));
vi.mock("@/api/compare", () => ({
  compareWorktree: (t: CompareTarget, paths: readonly string[]) => {
    api.compares.push(`${sourceParam(t.base)} ${sourceParam(t.head)}`);
    api.paths.push(paths);
    if (api.view instanceof Error) return Promise.reject(api.view);
    return Promise.resolve({ ...compareDefaults(), ...api.view });
  },
  listCompareCommits: (t: CompareTarget) => {
    api.logs.push(`${sourceParam(t.base)} ${sourceParam(t.head)}`);
    if (api.log instanceof Error) return Promise.reject(api.log);
    return Promise.resolve({ commits: [], total: 0, error: "", ...api.log });
  },
  getCompareCommit: (_t: CompareTarget, sha: string) => {
    api.bodyReads.push(sha);
    const body = api.bodies.get(sha) ?? "";
    return body instanceof Error ? Promise.reject(body) : Promise.resolve({ body, error: "" });
  },
  getCompareFile: (_t: CompareTarget, file: string, oldPath: string) => {
    api.reads.push(file);
    api.oldPaths.push(oldPath);
    return Promise.resolve({ old: side(), new: side(), status: "M", error: "", ...api.sides.get(file) });
  },
}));
vi.mock("@/stores/gh", async (orig) => ({
  ...(await orig<typeof import("@/stores/gh")>()),
  openUrl: (url: string) => {
    api.urls.push(url);
    return Promise.resolve();
  },
}));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), listRefs: () => Promise.resolve({ refs: ["main", "origin/main", "v1.2"], defaultRef: "origin/main", branches: [], defaultBranch: "main" }) }));
vi.mock("@/lib/useWidth", () => ({ useWidth: () => [{ current: null }, api.width], useHeight: () => api.height }));
vi.mock("@/components/code/CodeDiff", () => ({
  CodeDiff: ({ oldFile, newFile }: { oldFile: { name: string } | null; newFile: { name: string } }) => <div data-testid="code-diff" data-old={oldFile?.name ?? ""} data-new={newFile.name} />,
  CodeScroll: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@pierre/diffs", async (orig) => {
  const real = await orig<typeof import("@pierre/diffs")>();
  return {
    ...real,
    parseDiffFromFile: (...args: Parameters<typeof real.parseDiffFromFile>) => {
      api.parses += 1;
      return real.parseDiffFromFile(...args);
    },
  };
});

const { DiffView, RAIL_MIN } = await import("./DiffView");
const { appliedOps, layoutSettled, resetFakeLayout, threadSeed } = await import("@/test/fakeLayout");
const { tabPlace, useTabPlace } = await import("@/shell/host");

const intoView = vi.fn<(this: Element) => void>();

function side(o: Partial<CompareSideView> = {}): CompareSideView {
  return { present: true, text: "", truncated: false, binary: false, submodule: false, ...o };
}
function compareDefaults(): CompareView {
  return {
    files: [],
    truncated: false,
    totalFiles: 0,
    totalAdded: 0,
    totalDeleted: 0,
    base: { source: DEFAULT_BASE, label: "origin/main", sha: "a" },
    head: { source: DEFAULT_HEAD, label: "Working tree", sha: "" },
    baseRef: "origin/main",
    error: "",
    skippedNames: 0,
  };
}
const file = (path: string, o: Partial<CompareFileView> = {}): CompareFileView => ({ path, oldPath: "", status: "M", added: 2, deleted: 1, binary: false, submodule: false, ...o });
const list = (files: CompareFileView[], o: Partial<CompareView> = {}): void => {
  api.view = { files, totalFiles: files.length, totalAdded: files.reduce((n, f) => n + f.added, 0), totalDeleted: files.reduce((n, f) => n + f.deleted, 0), ...o };
};
const changed = (text = "old\n", next = "new\n") => ({ old: side({ text }), new: side({ text: next }) });

const W = "/src/web.wt/feat";
const KEY = "thread:s-1";
const target = (o: Partial<DiffTarget> = {}): DiffTarget => ({ project: "web", worktree: W, base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "", oldPath: "", own: true, ...o });

function world(status: Partial<WorktreeView["status"]> = {}, project: Partial<ProjectView> = {}): void {
  const wt: WorktreeView = { projectId: "web", path: W, branch: "feat/sidebar", head: "abc", detached: false, isMain: false, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: 1, ...status } };
  useProjectsStore.setState({ byId: { web: { id: "web", path: "/src/web", name: "web", defaultBranch: "main", githubSlug: "o/web", remotes: ["origin"], git: true, worktrees: [wt], ...project } }, order: ["web"] });
}

/** The tab as the layout holds it, rendered until both reads answered. */
function Live() {
  const tab = useTabPlace(KEY, (p) => p.tabs[0]);
  const t = tab ? diffOfTab(tab) : null;
  return tab && t ? <DiffView tabId={tab.id} tabTitle={tab.title} target={t} /> : null;
}
/** A layout whose one pane holds thread s-1's tab and, in front, its Diff tab for `t`. */
async function show(t: DiffTarget = target()): Promise<void> {
  const seed = threadSeed("s-1");
  const pane = seed.spaces[0]?.root;
  const tab = diffTab(t);
  pane?.tabs?.push({ id: "t-diff", kind: "diff", thread: "s-1", title: tab.title, params: { ...tab.params } });
  if (pane) pane.active = "t-diff";
  await resetFakeLayout(seed);
  render(<Live />);
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}
const tabNow = () => tabPlace(KEY).tabs[0];
/** Waits for the layout to take what the tab sent (its params, its title): the tab reads them back from there. */
const settle = () =>
  act(async () => {
    await layoutSettled();
  });
const rowOf = (path: string) => screen.getByTestId("diff-file-list").querySelector(`[data-nav-key="f:${path}"]`) as HTMLElement;
const rowKeys = () => [...screen.getByTestId("diff-file-list").querySelectorAll("[data-nav-key]")].map((e) => e.getAttribute("data-nav-key"));

beforeEach(() => {
  intoView.mockClear();
  Element.prototype.scrollIntoView = intoView;
  api.view = null;
  api.sides.clear();
  api.compares.length = 0;
  api.paths.length = 0;
  api.reads.length = 0;
  api.oldPaths.length = 0;
  api.parses = 0;
  api.log = null;
  api.logs.length = 0;
  api.bodies.clear();
  api.bodyReads.length = 0;
  api.urls.length = 0;
  api.width = 900;
  api.height = 800;
  api.watched.clear();
  api.dotGit = { isDir: true, path: `${W}/.git`, text: null };
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
  useCodeViewStore.setState({ diffStyle: "unified" });
  world();
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  // A tab's params update still on its way would land on the next test's layout.
  await layoutSettled();
});

describe("the file list", () => {
  it("lists every file with its counts, conflicts first, and the totals", async () => {
    list([file("a.ts", { added: 3, deleted: 1 }), file("b.ts", { status: "U", added: 1, deleted: 0 })]);
    await show();
    expect(rowKeys()).toEqual(["f:b.ts", "f:a.ts"]);
    expect(screen.getByTestId("diff-totals").textContent).toContain("2 files");
    expect(screen.getByTestId("diff-totals").textContent).toContain("+4");
    expect(screen.getByTestId("diff-totals").textContent).toContain("−1");
    expect(within(rowOf("a.ts")).getByTestId("file-added").textContent).toBe("+3");
    expect(within(rowOf("b.ts")).getByText("conflict")).toBeTruthy();
  });

  it("says bin and sub instead of counts that mean nothing", async () => {
    list([file("logo.png", { binary: true, added: 0, deleted: 0 }), file("vendor/lib", { submodule: true })]);
    await show();
    expect(rowOf("logo.png").textContent).toContain("bin");
    expect(rowOf("vendor/lib").textContent).toContain("sub");
    expect(within(rowOf("vendor/lib")).queryByTestId("file-added")).toBeNull();
  });

  it("says when the daemon listed only the first files", async () => {
    list([file("a.ts")], { truncated: true, totalFiles: 12000 });
    await show();
    expect(screen.getByTestId("diff-truncated-list").textContent).toBe("First 1 of 12000 files");
    expect(screen.getByTestId("diff-totals").textContent).toContain("12000 files");
  });
});

describe("file by file", () => {
  it("reads only the file on screen, the first until one is picked", async () => {
    list([file("a.ts"), file("b.ts"), file("c.ts")]);
    api.sides.set("a.ts", changed());
    await show();
    expect(api.reads).toEqual(["a.ts"]);
    expect(screen.getAllByTestId("code-diff")).toHaveLength(1);
    expect(screen.getByTestId("diff-position").textContent).toBe("1 of 3");
  });

  it("clicking a row shows that file and remembers it in the tab", async () => {
    list([file("a.ts"), file("b.ts")]);
    api.sides.set("b.ts", changed());
    await show();
    fireEvent.click(rowOf("b.ts"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-file").getAttribute("data-path")).toBe("b.ts");
    });
    expect(tabNow()?.params.path).toBe("b.ts");
    expect(api.reads).toEqual(["a.ts", "b.ts"]);
  });

  it("a rename reads both its paths and keeps its source in the tab", async () => {
    list([file("new.ts", { status: "R", oldPath: "old.ts" })]);
    api.sides.set("new.ts", { ...changed(), status: "R" });
    await show();
    expect(screen.getByTestId("code-diff").getAttribute("data-old")).toBe("old.ts");
    fireEvent.click(rowOf("new.ts"));
    await waitFor(() => {
      expect(tabNow()?.params.oldPath).toBe("old.ts");
    });
  });

  it("previous and next walk the list and stop at its ends", async () => {
    list([file("a.ts"), file("b.ts")]);
    await show();
    fireEvent.click(screen.getByTestId("diff-prev"));
    expect(tabNow()?.params.path).toBe("a.ts");
    fireEvent.click(screen.getByTestId("diff-next"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-position").textContent).toBe("2 of 2");
    });
    fireEvent.click(screen.getByTestId("diff-next"));
    expect(tabNow()?.params.path).toBe("b.ts");
  });

  it("previous and next walk what the filter leaves, folded away or not", async () => {
    api.width = 400;
    const rows = Array.from({ length: 8 }, (_, i) => file(i % 2 ? `odd${String(i)}.ts` : `even${String(i)}.ts`));
    list(rows);
    await show(target({ file: "odd1.ts", filter: "odd" }));
    expect(screen.getByTestId("diff-position").textContent).toBe("1 of 4");
    fireEvent.click(screen.getByTestId("diff-next"));
    await settle();
    expect(tabNow()?.params.path).toBe("odd3.ts");
    await waitFor(() => {
      expect(screen.getByTestId("diff-position").textContent).toBe("2 of 4");
    });
    fireEvent.click(screen.getByTestId("diff-fold"));
    await settle();
    expect(screen.queryByTestId("diff-filter")).toBeNull();
    fireEvent.click(screen.getByTestId("diff-next"));
    await settle();
    expect(tabNow()?.params.path).toBe("odd5.ts");
    await waitFor(() => {
      expect(screen.getByTestId("diff-position").textContent).toBe("3 of 4");
    });
    fireEvent.click(screen.getByTestId("diff-prev"));
    await settle();
    expect(tabNow()?.params.path).toBe("odd3.ts");
  });

  it("a tab opened on a file that is not listed stays on it and says so", async () => {
    list([file("a.ts")]);
    api.sides.set("committed-since.ts", { old: side({ text: "same\n" }), new: side({ text: "same\n" }), status: "" });
    await show(target({ file: "committed-since.ts" }));
    expect(screen.getByTestId("diff-file").getAttribute("data-path")).toBe("committed-since.ts");
    expect(screen.getByTestId("diff-unlisted").textContent).toContain("committed-since.ts is no longer in this comparison");
    expect(api.reads).toEqual(["committed-since.ts"]);
    expect(screen.getByTestId("diff-position").textContent).toBe("");
    expect(rowOf("a.ts").getAttribute("aria-selected")).toBe("false");
  });

  it("keyboard: arrows move in the list and Enter shows the file", async () => {
    list([file("a.ts"), file("b.ts")]);
    await show();
    const l = screen.getByTestId("diff-file-list");
    fireEvent.keyDown(l, { key: "ArrowDown" });
    fireEvent.keyDown(l, { key: "Enter" });
    await waitFor(() => {
      expect(tabNow()?.params.path).toBe("b.ts");
    });
  });
});

/** Answers the list again, as a live update does. */
async function again(files: CompareFileView[]): Promise<void> {
  list(files);
  vi.useFakeTimers();
  act(() => {
    world({ modified: (useProjectsStore.getState().byId.web?.worktrees[0]?.status.modified ?? 0) + 1 });
  });
  // Twice: the row's own change starts a wait as the list's answer commits, at the end of an act.
  for (let i = 0; i < 2; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  }
  vi.useRealTimers();
}
const onScreen = () => screen.getByTestId("diff-file").getAttribute("data-path");

describe("the file being read stays until the reader moves", () => {
  it("with none picked, a new file sorting first does not take the pane", async () => {
    list([file("m.ts")]);
    api.sides.set("m.ts", changed());
    await show();
    expect(onScreen()).toBe("m.ts");
    await waitFor(() => {
      expect(tabNow()?.params.path).toBe("m.ts");
    });
    await again([file("a-new.ts", { status: "?" }), file("m.ts")]);
    expect(onScreen()).toBe("m.ts");
    expect(screen.getByTestId("diff-position").textContent).toBe("2 of 2");
  });

  it("the first file shown goes in the tab without opening or activating anything", async () => {
    list([file("a.ts")]);
    await show();
    await waitFor(() => {
      expect(tabNow()?.params.path).toBe("a.ts");
    });
    await settle();
    // Its params and its title: nothing opened or focused.
    expect(new Set(appliedOps.map((o) => o.op))).toEqual(new Set(["set_tab_params"]));
  });

  it("a picked file that goes stays on screen and says so, and comes back without moving", async () => {
    list([file("a.ts"), file("new.txt", { status: "?" }), file("z.ts")]);
    api.sides.set("new.txt", { old: side({ present: false }), new: side({ text: "n\n" }), status: "A" });
    await show(target({ file: "new.txt" }));
    expect(screen.getByTestId("code-diff")).toBeTruthy();

    api.sides.set("new.txt", { old: side({ present: false }), new: side({ present: false }), status: "" });
    await again([file("a.ts"), file("z.ts")]);
    expect(onScreen()).toBe("new.txt");
    await waitFor(() => {
      expect(screen.getByTestId("diff-unlisted").textContent).toContain("new.txt is no longer in this comparison");
    });
    expect(tabNow()?.params.path).toBe("new.txt");

    api.sides.set("new.txt", { old: side({ present: false }), new: side({ text: "n\n" }), status: "A" });
    await again([file("a-first.ts"), file("a.ts"), file("new.txt", { status: "?" }), file("z.ts")]);
    expect(onScreen()).toBe("new.txt");
    await waitFor(() => {
      expect(screen.getByTestId("code-diff")).toBeTruthy();
    });
    expect(screen.getByTestId("diff-position").textContent).toBe("3 of 4");
  });

  it("the last file going leaves it on screen too, not the empty state", async () => {
    list([file("a.ts")]);
    await show(target({ file: "a.ts" }));
    api.sides.set("a.ts", { old: side({ present: false }), new: side({ present: false }), status: "" });
    await again([]);
    expect(onScreen()).toBe("a.ts");
    await waitFor(() => {
      expect(screen.getByTestId("diff-unlisted")).toBeTruthy();
    });
    expect(screen.queryByTestId("diff-empty")).toBeNull();
    expect(screen.getByTestId("diff-totals").textContent).toContain("0 files");
  });

  it("moving on from an unlisted file goes to the list", async () => {
    list([file("a.ts"), file("b.ts")]);
    await show(target({ file: "gone.ts" }));
    fireEvent.click(screen.getByTestId("diff-next"));
    await waitFor(() => {
      expect(onScreen()).toBe("a.ts");
    });
  });
});

describe("the open file follows the list", () => {
  it("under Staged, git add reads the file again, as the status moved", async () => {
    list([file("a.ts")]);
    await show(target({ head: { kind: "staged" }, file: "a.ts" }));
    expect(api.reads).toEqual(["a.ts"]);
    vi.useFakeTimers();
    act(() => {
      world({ staged: 1 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(api.reads).toEqual(["a.ts", "a.ts"]);
  });

  /** The file watcher saw `path` written. */
  async function written(path: string): Promise<void> {
    vi.useFakeTimers();
    act(() => {
      api.watched.get(path)?.forEach((f) => {
        f();
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  }

  it("a save that keeps the counts reads the file again, and only that file is watched", async () => {
    list([file("a.ts"), file("b.ts")]);
    await show(target({ file: "a.ts" }));
    expect([...api.watched.keys()]).toEqual([`${W}/a.ts`]);
    await written(`${W}/a.ts`);
    expect(api.reads).toEqual(["a.ts", "a.ts"]);
    expect(api.compares).toHaveLength(1);
  });

  it("under Staged, a write of the index reads the file and the list, and a save does not", async () => {
    list([file("a.ts")]);
    await show(target({ head: { kind: "staged" }, file: "a.ts" }));
    await waitFor(() => {
      expect([...api.watched.keys()]).toEqual([`${W}/.git/index`]);
    });
    await written(`${W}/.git/index`);
    expect(api.reads).toEqual(["a.ts", "a.ts"]);
    expect(api.compares).toHaveLength(2);
  });

  it.each([
    ["an absolute gitdir", "gitdir: /src/web/.git/worktrees/feat\n", "/src/web/.git/worktrees/feat/index"],
    ["a relative one", "gitdir: ../web/.git/worktrees/feat\n", `${W}/../web/.git/worktrees/feat/index`],
  ])("a linked worktree's index is where its .git file says: %s", async (_name, text, index) => {
    api.dotGit = { isDir: false, path: `${W}/.git`, text };
    list([file("a.ts")]);
    await show(target({ base: { kind: "staged" }, file: "a.ts" }));
    await waitFor(() => {
      expect([...api.watched.keys()]).toContain(index);
    });
  });

  it("two commits watch nothing: neither a save nor an index write changes them", async () => {
    list([file("a.ts")]);
    await show(target({ base: { kind: "ref", ref: "main" }, head: { kind: "ref", ref: "HEAD" }, file: "a.ts" }));
    expect([...api.watched.keys()]).toEqual([]);
  });

  it("a read that answers the same parses and draws nothing again", async () => {
    list([file("package-lock.json")]);
    api.sides.set("package-lock.json", changed("a\n".repeat(50), "b\n".repeat(50)));
    await show(target({ file: "package-lock.json" }));
    const drawn = screen.getByTestId("code-diff");
    expect(api.parses).toBe(1);
    await written(`${W}/package-lock.json`);
    expect(api.reads).toEqual(["package-lock.json", "package-lock.json"]);
    expect(api.parses).toBe(1);
    expect(screen.getByTestId("code-diff")).toBe(drawn);
    api.sides.set("package-lock.json", changed("a\n".repeat(50), "c\n".repeat(50)));
    await written(`${W}/package-lock.json`);
    expect(api.parses).toBe(2);
  });

  it("the row's counts changing reads the file again, whatever said so", async () => {
    list([file("a.ts", { added: 1 })]);
    await show(target({ file: "a.ts" }));
    list([file("a.ts", { added: 2 })]);
    fireEvent.click(screen.getByTestId("file-refresh"));
    await waitFor(() => {
      expect(rowOf("a.ts").textContent).toContain("+2");
    });
    const reads = api.reads.length;
    await waitFor(
      () => {
        expect(api.reads.length).toBe(reads + 1);
      },
      { timeout: 1000 },
    );
  });

  it("Refresh reads the list as well as the file", async () => {
    list([file("a.ts")]);
    await show(target({ file: "a.ts" }));
    list([file("a.ts"), file("b.ts")]);
    const compares = api.compares.length;
    fireEvent.click(screen.getByTestId("file-refresh"));
    await waitFor(() => {
      expect(rowKeys()).toEqual(["f:a.ts", "f:b.ts"]);
    });
    expect(api.compares.length).toBe(compares + 1);
    expect(api.reads).toEqual(["a.ts", "a.ts"]);
  });
});

describe("the list keeps the reader's place", () => {
  it("a live update leaves the keyboard cursor on its file, not the file on screen", async () => {
    list([file("f1.ts"), file("f2.ts"), file("f3.ts")]);
    await show(target({ file: "f1.ts" }));
    const l = screen.getByTestId("diff-file-list");
    fireEvent.keyDown(l, { key: "ArrowDown" });
    fireEvent.keyDown(l, { key: "ArrowDown" });
    expect(rowOf("f3.ts").getAttribute("aria-selected")).toBe("true");
    await again([file("f0.ts"), file("f1.ts"), file("f2.ts"), file("f3.ts")]);
    expect(rowOf("f3.ts").getAttribute("aria-selected")).toBe("true");
    expect(rowOf("f1.ts").getAttribute("aria-selected")).toBe("false");
  });

  const scrolled = () => intoView.mock.contexts.map((e) => e.getAttribute("data-nav-key"));

  it("a live update scrolls nothing, the row of a file coming back included", async () => {
    list([file("a.ts"), file("b.ts")]);
    await show(target({ file: "b.ts" }));
    intoView.mockClear();
    await again([file("a.ts")]);
    await again([file("0.ts"), file("a.ts"), file("b.ts")]);
    expect(rowOf("b.ts").getAttribute("aria-selected")).toBe("true");
    expect(scrolled()).toEqual([]);
  });

  it("the keyboard's moves and the file on screen's bring their row into view", async () => {
    list([file("a.ts"), file("b.ts"), file("c.ts")]);
    await show(target({ file: "a.ts" }));
    intoView.mockClear();
    fireEvent.keyDown(screen.getByTestId("diff-file-list"), { key: "End" });
    expect(scrolled()).toEqual(["f:c.ts"]);
    fireEvent.click(screen.getByTestId("diff-next"));
    await waitFor(() => {
      expect(scrolled()).toEqual(["f:c.ts", "f:b.ts"]);
    });
  });

  it("the list on top opening again shows the current row, a fold of its own or the panel's", async () => {
    api.width = 400;
    list(Array.from({ length: 30 }, (_, i) => file(`f${String(i)}.ts`)));
    await show(target({ file: "f24.ts" }));
    fireEvent.click(screen.getByTestId("diff-fold"));
    await settle();
    intoView.mockClear();
    fireEvent.click(screen.getByTestId("diff-fold"));
    await waitFor(() => {
      expect(scrolled()).toEqual(["f:f24.ts"]);
    });
    cleanup();
    api.height = 300;
    await show(target({ file: "f24.ts" }));
    expect(screen.queryByTestId("diff-file-rows")).toBeNull();
    intoView.mockClear();
    fireEvent.click(screen.getByTestId("diff-fold"));
    await waitFor(() => {
      expect(scrolled()).toEqual(["f:f24.ts"]);
    });
  });

  it("the cursor still follows the file on screen when that changes", async () => {
    list([file("a.ts"), file("b.ts")]);
    await show(target({ file: "a.ts" }));
    fireEvent.click(screen.getByTestId("diff-next"));
    await waitFor(() => {
      expect(rowOf("b.ts").getAttribute("aria-selected")).toBe("true");
    });
  });
});

describe("the file's states", () => {
  it.each([
    ["binary", { new: side({ binary: true }), status: "M" }, "diff-binary"],
    ["a pure rename", { old: side({ text: "same\n" }), new: side({ text: "same\n" }), status: "R" }, "diff-renamed"],
    ["the same both sides", { old: side({ text: "same\n" }), new: side({ text: "same\n" }), status: "" }, "diff-none"],
    ["a source that went", { old: side({ present: false }), new: side({ present: false }), error: "gone", status: "" }, "diff-unavailable"],
  ])("%s", async (_name, sides, testId) => {
    list([file("a.ts")]);
    api.sides.set("a.ts", sides);
    await show();
    expect(screen.getByTestId(testId)).toBeTruthy();
    expect(screen.queryByTestId("code-diff")).toBeNull();
  });

  it("a deleted file has nothing to open; a truncated one says so", async () => {
    list([file("a.ts", { status: "D" })]);
    api.sides.set("a.ts", { old: side({ text: "x\n", truncated: true }), new: side({ present: false }), status: "D" });
    await show();
    expect(screen.getByTestId("code-diff")).toBeTruthy();
    expect(screen.queryByTestId("diff-open-file")).toBeNull();
    expect(screen.getByTestId("diff-truncated")).toBeTruthy();
  });

  it("Open file opens the File tab beside it", async () => {
    list([file("src/a.ts")]);
    api.sides.set("src/a.ts", changed());
    await show();
    fireEvent.click(screen.getByTestId("diff-open-file"));
    await waitFor(() => {
      expect(tabPlace(KEY).tabs.map((t) => t.kind)).toEqual(["diff", "files"]);
    });
    expect(tabPlace(KEY).tabs[1]?.params.path).toBe(`${W}/src/a.ts`);
  });
});

describe("the comparison's states", () => {
  it("nothing differs, and Refresh reads again", async () => {
    list([]);
    await show();
    expect(screen.getByTestId("diff-empty")).toBeTruthy();
    expect(api.reads).toEqual([]);
    list([file("a.ts")]);
    fireEvent.click(screen.getByTestId("diff-refresh"));
    await waitFor(() => {
      expect(rowKeys()).toEqual(["f:a.ts"]);
    });
  });

  it("files left out for their names are never \"No changes\"", async () => {
    list([], { skippedNames: 1 });
    await show();
    expect(screen.queryByTestId("diff-empty")).toBeNull();
    expect(screen.getByTestId("diff-skipped-names").textContent).toBe("1 more file not listed: its name is not UTF-8");
    expect(screen.getByTestId("diff-only-skipped").textContent).toContain("The one file that differs has a name that is not UTF-8.");
    cleanup();
    list([], { skippedNames: 2 });
    await show();
    expect(screen.getByTestId("diff-only-skipped").textContent).toContain("The 2 files that differ have names that are not UTF-8.");
    cleanup();
    list([file("a.ts")], { skippedNames: 3 });
    await show();
    expect(screen.getByTestId("diff-skipped-names").textContent).toBe("3 more files not listed: their names are not UTF-8");
    expect(screen.queryByTestId("diff-only-skipped")).toBeNull();
  });

  it("an embedded repository is one row, with its slash", async () => {
    list([file("vendor/emb/", { status: "?", submodule: true, added: 0, deleted: 0 })]);
    await show();
    expect(within(rowOf("vendor/emb/")).getByTestId("file-name").textContent).toBe("emb/");
    expect(rowOf("vendor/emb/").textContent).toContain("sub");
  });

  it("a ref deleted since keeps the bar, so the user can pick another", async () => {
    list([], { error: "soon-gone does not name a commit in this checkout", base: { source: { kind: "ref", ref: "soon-gone" }, label: "soon-gone", sha: "" } });
    await show(target({ base: { kind: "ref", ref: "soon-gone" } }));
    expect(screen.getByTestId("diff-source-missing").textContent).toContain("soon-gone does not name a commit");
    expect(screen.getByTestId("diff-base").textContent).toContain("soon-gone");
  });

  it("a side that cannot be read leaves both sides' names on the bar", async () => {
    list([file("a.ts")]);
    await show();
    api.view = new Error("ref \"^x\" cannot start with ^");
    fireEvent.click(screen.getByTestId("diff-head"));
    fireEvent.change(await screen.findByTestId("diff-head-input"), { target: { value: "^x" } });
    fireEvent.click(await screen.findByTestId("diff-source-ref:^x"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-compare-failed")).toBeTruthy();
    });
    expect(screen.getByTestId("diff-head").textContent).toBe("^x");
    expect(screen.getByTestId("diff-base").textContent).toBe("origin/main");
  });

  it.each([
    ["a ref", { kind: "ref", ref: "nope" } as const, "nope", "merge base"],
    ["the index", { kind: "staged" } as const, "Staged", "merge base"],
  ])("opened on a failing read, %s keeps its name and the merge base says what it is", async (_name, head, headText, baseText) => {
    api.view = new Error("boom");
    await show(target({ head }));
    expect(screen.getByTestId("diff-head").textContent).toBe(headText);
    expect(screen.getByTestId("diff-base").textContent).toBe(baseText);
  });

  it("a failed read offers Retry; a failed refresh keeps the list", async () => {
    api.view = new Error("boom");
    await show();
    expect(screen.getByTestId("diff-compare-failed").textContent).toContain("boom");
    list([file("a.ts")]);
    fireEvent.click(screen.getByTestId("diff-retry"));
    await waitFor(() => {
      expect(rowKeys()).toEqual(["f:a.ts"]);
    });
  });

  it.each([
    ["a project that went", () => { useProjectsStore.setState({ byId: {}, order: [] }); }, "diff-no-project"],
    ["no git", () => { world({}, { git: false }); }, "diff-nogit"],
    ["a worktree that went", () => { world({}, { worktrees: [] }); }, "diff-missing"],
  ])("%s", async (_name, set, testId) => {
    set();
    list([file("a.ts")]);
    await show();
    expect(screen.getByTestId(testId)).toBeTruthy();
    expect(api.compares).toEqual([]);
  });
});

describe("the compare bar", () => {
  it("shows both sides, and names the tab after them, the base without its remote", async () => {
    list([file("a.ts")]);
    await show();
    expect(screen.getByTestId("diff-base").textContent).toContain("origin/main");
    expect(screen.getByTestId("diff-head").textContent).toContain("Working tree");
    await waitFor(() => {
      expect(tabNow()?.title).toBe("feat/sidebar vs main");
    });
  });

  it("picking a ref from the list compares against it; the current side is marked", async () => {
    list([file("a.ts")]);
    await show();
    fireEvent.click(screen.getByTestId("diff-base"));
    const row = await screen.findByTestId("diff-source-ref:v1.2");
    expect(within(screen.getByTestId("diff-source-merge-base")).getByTestId("diff-source-current")).toBeTruthy();
    fireEvent.click(row);
    await waitFor(() => {
      expect(api.compares.at(-1)).toBe("ref:v1.2 working");
    });
    expect(tabNow()?.params.base).toBe("ref:v1.2");
  });

  it("a typed ref need not be listed: a sha, a tag, HEAD~3", async () => {
    list([file("a.ts")]);
    await show();
    fireEvent.click(screen.getByTestId("diff-head"));
    fireEvent.change(await screen.findByTestId("diff-head-input"), { target: { value: "HEAD~3" } });
    fireEvent.click(await screen.findByTestId("diff-source-ref:HEAD~3"));
    await waitFor(() => {
      expect(api.compares.at(-1)).toBe("merge-base ref:HEAD~3");
    });
  });

  it("the arrow swaps the sides", async () => {
    list([file("a.ts")]);
    await show();
    fireEvent.click(screen.getByTestId("diff-swap"));
    await waitFor(() => {
      expect(api.compares.at(-1)).toBe("working merge-base");
    });
    expect(tabNow()?.params).toMatchObject({ base: "working", head: "merge-base" });
  });

  it("a swap keeps a rename's file, under its other name", async () => {
    list([file("new.ts", { status: "R", oldPath: "old.ts" }), file("z.ts")]);
    await show(target({ file: "new.ts", oldPath: "old.ts" }));
    list([file("old.ts", { status: "R", oldPath: "new.ts" }), file("z.ts")]);
    fireEvent.click(screen.getByTestId("diff-swap"));
    await waitFor(() => {
      expect(onScreen()).toBe("old.ts");
    });
    expect(tabNow()?.params).toMatchObject({ path: "old.ts", oldPath: "new.ts" });
    expect(screen.queryByTestId("diff-unlisted")).toBeNull();
  });

  it("a swap leaves any other file as it is, and any other source change leaves a rename", async () => {
    list([file("a.ts")]);
    await show(target({ file: "a.ts" }));
    fireEvent.click(screen.getByTestId("diff-swap"));
    await waitFor(() => {
      expect(tabNow()?.params.base).toBe("working");
    });
    expect(tabNow()?.params.path).toBe("a.ts");
    cleanup();
    list([file("new.ts", { status: "R", oldPath: "old.ts" })]);
    await show(target({ file: "new.ts", oldPath: "old.ts" }));
    fireEvent.click(screen.getByTestId("diff-head"));
    fireEvent.click(await screen.findByTestId("diff-source-staged"));
    await waitFor(() => {
      expect(tabNow()?.params.head).toBe("staged");
    });
    expect(tabNow()?.params).toMatchObject({ path: "new.ts", oldPath: "old.ts" });
  });

  it("a rename that another side no longer lists reads under its own name, and says it is not in the comparison", async () => {
    list([file("src/renamed.ts", { status: "R", oldPath: "src/f3.ts" }), file("src/f1.ts")]);
    await show(target({ file: "src/renamed.ts", oldPath: "src/f3.ts" }));
    expect(api.oldPaths).toEqual(["src/f3.ts"]);
    // The rename is committed: HEAD → working tree lists only the edit, and the file reads the same on both sides.
    list([file("src/f1.ts")]);
    api.sides.set("src/renamed.ts", { old: side({ text: "same\n" }), new: side({ text: "same\n" }), status: "" });
    fireEvent.click(screen.getByTestId("diff-base"));
    fireEvent.click(await screen.findByTestId("diff-source-ref:HEAD"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-unlisted").textContent).toContain("src/renamed.ts is no longer in this comparison");
    });
    expect(api.reads.at(-1)).toBe("src/renamed.ts");
    expect(api.oldPaths.at(-1)).toBe("");
  });

  it("a file not listed that still differs shows its lines under a notice", async () => {
    list([file("a.ts")]);
    api.sides.set("past-the-cap.js", { old: side({ present: false }), new: side({ text: "n\n" }), status: "A" });
    await show(target({ file: "past-the-cap.js" }));
    expect(screen.getByTestId("code-diff")).toBeTruthy();
    expect(screen.getByTestId("diff-unlisted-notice").textContent).toBe("Not in this comparison's file list");
    cleanup();
    api.sides.set("a.ts", changed());
    await show(target({ file: "a.ts" }));
    expect(screen.getByTestId("code-diff")).toBeTruthy();
    expect(screen.queryByTestId("diff-unlisted-notice")).toBeNull();
  });

  it("Unified | Split shows wide; narrow it hides behind ⋯", async () => {
    list([file("a.ts")]);
    api.width = RAIL_MIN - 1;
    await show();
    expect(screen.queryByTestId("diff-style")).toBeNull();
    expect(screen.getByTestId("diff-style-menu")).toBeTruthy();
    cleanup();
    api.width = RAIL_MIN;
    await show();
    fireEvent.click(screen.getByTestId("diff-style-split"));
    expect(useCodeViewStore.getState().diffStyle).toBe("split");
  });
});

describe("rail or list on top", () => {
  it.each([
    [RAIL_MIN, "rail"],
    [RAIL_MIN - 1, "top"],
  ])("at %ipx it is the %s", async (width, layout) => {
    api.width = width;
    list([file("a.ts")]);
    await show();
    expect(screen.getByTestId("diff-file-list").getAttribute("data-layout")).toBe(layout);
  });

  it("on top it folds away and the diff stays", async () => {
    api.width = 400;
    list([file("a.ts")]);
    api.sides.set("a.ts", changed());
    await show();
    fireEvent.click(screen.getByTestId("diff-fold"));
    await settle();
    expect(screen.queryByTestId("diff-file-rows")).toBeNull();
    expect(screen.getByTestId("code-diff")).toBeTruthy();
    expect(screen.getByTestId("diff-totals")).toBeTruthy();
  });

  it("offers a filter only past a screenful, and says when nothing matches", async () => {
    api.width = 400;
    list(Array.from({ length: 5 }, (_, i) => file(`f${String(i)}.ts`)));
    await show();
    expect(screen.queryByTestId("diff-filter")).toBeNull();
    cleanup();
    list(Array.from({ length: 6 }, (_, i) => file(`f${String(i)}.ts`)));
    await show();
    fireEvent.change(screen.getByTestId("diff-filter"), { target: { value: "f3" } });
    await settle();
    expect(rowKeys()).toEqual(["f:f3.ts"]);
    fireEvent.change(screen.getByTestId("diff-filter"), { target: { value: "nope" } });
    await settle();
    expect(screen.getByTestId("diff-filter-none")).toBeTruthy();
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => file(`f${String(i)}.ts`));

  it("the filter box stays while it is filtering, when the list shrinks under it", async () => {
    api.width = 400;
    list(many(6));
    await show();
    fireEvent.change(screen.getByTestId("diff-filter"), { target: { value: "nope" } });
    await settle();
    expect(screen.getByTestId("diff-filter-none")).toBeTruthy();
    await again(many(3));
    const box = screen.getByTestId("diff-filter") as HTMLInputElement;
    expect(box.value).toBe("nope");
    fireEvent.change(box, { target: { value: "" } });
    await settle();
    expect(rowKeys()).toHaveLength(3);
    expect(screen.queryByTestId("diff-filter")).toBeNull();
  });

  it("the filter box stays through a source with a shorter list", async () => {
    api.width = 400;
    list(many(6));
    await show();
    fireEvent.change(screen.getByTestId("diff-filter"), { target: { value: "f9" } });
    list(many(2));
    fireEvent.click(screen.getByTestId("diff-swap"));
    await waitFor(() => {
      expect(api.compares.at(-1)).toBe("working merge-base");
    });
    await waitFor(() => {
      expect(screen.getByTestId("diff-filter-none")).toBeTruthy();
    });
    expect(screen.getByTestId("diff-filter")).toHaveProperty("value", "f9");
  });

  it("the filter and the fold outlast the tab showing something else", async () => {
    api.width = 400;
    list(many(6));
    await show();
    fireEvent.change(screen.getByTestId("diff-filter"), { target: { value: "f3" } });
    await settle();
    fireEvent.click(screen.getByTestId("diff-fold"));
    await settle();
    expect(tabNow()?.params).toMatchObject({ filter: "f3", fold: "1" });
    cleanup();
    render(<Live />);
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
    expect(screen.queryByTestId("diff-file-rows")).toBeNull();
    fireEvent.click(screen.getByTestId("diff-fold"));
    await settle();
    expect(rowKeys()).toEqual(["f:f3.ts"]);
    expect(tabNow()?.params.fold).toBe("0");
  });

  it("a panel too short for a list and the code folds the list; opening it is the user's to keep", async () => {
    api.width = 400;
    api.height = 300;
    list(many(8));
    await show();
    expect(screen.queryByTestId("diff-file-rows")).toBeNull();
    expect(screen.getByTestId("diff-totals")).toBeTruthy();
    expect(screen.getByTestId("diff-file")).toBeTruthy();
    fireEvent.click(screen.getByTestId("diff-fold"));
    await settle();
    expect(screen.getByTestId("diff-file-rows")).toBeTruthy();
    expect(tabNow()?.params.fold).toBe("0");
  });
});

describe("what a thread asked for", () => {
  const sawPaths = () => api.paths.at(-1);

  it("narrows the list to its paths", async () => {
    list([file("a.ts")]);
    await show(target({ paths: ["a.ts", "src/b.ts"] }));
    expect(sawPaths()).toEqual(["a.ts", "src/b.ts"]);
  });

  it("heads the tab with its title and note, as plain text, and keeps that title", async () => {
    list([file("a.ts")]);
    await show(target({ heading: "The two files", note: "<b>Row height</b> comes from one place." }));
    expect(screen.getByTestId("diff-model-title").textContent).toBe("A thread opened this as “The two files”");
    expect(screen.getByTestId("diff-model-note").textContent).toBe("<b>Row height</b> comes from one place.");
    expect(tabNow()?.title).toBe("The two files");
    expect(screen.queryByTestId("diff-reveal")).toBeNull();
  });

  it("names the asking thread and leaves its text no way to pass for the app", async () => {
    useThreadsStore.setState({ byId: { s1: { id: "s1", name: "Fix\u202e the\n  rows" } as never } });
    list([file("a.ts")]);
    await show(target({ thread: "s1", heading: "Security\u200b\n alert", note: "  Your\n\n\u202esession   expired " }));
    expect(screen.getByTestId("diff-model-title").textContent).toBe("Thread \"Fix the rows\" opened this as “Security alert”");
    const note = screen.getByTestId("diff-model-note");
    expect(note.tagName).toBe("BLOCKQUOTE");
    expect(note.textContent).toBe("Your session expired");
  });

  it("a title on another project's checkout leads with its name, or two checkouts' tabs would read the same", async () => {
    list([file("a.ts")]);
    await show(target({ heading: "Review", own: false }));
    await waitFor(() => {
      expect(tabNow()?.title).toBe("web · Review");
    });
  });

  it("a tab of a thread's with no title says so, beside the comparison's name", async () => {
    list([file("a.ts")]);
    await show(target({ thread: "s1", own: true, note: "Why" }));
    await waitFor(() => {
      expect(tabNow()?.title).toBe("From thread · feat/sidebar vs main");
    });
  });

  it("says a list is narrowed and gives it back, the file on screen staying", async () => {
    list([file("a.ts"), file("b.ts")]);
    await show(target({ thread: "s1", file: "b.ts", paths: ["a.ts", "b.ts"] }));
    expect(screen.getByTestId("diff-narrowed").textContent).toBe("Listing only 2 paths");
    expect(screen.getByTestId("diff-reveal").textContent).toBe("Show all files");
    fireEvent.click(screen.getByTestId("diff-reveal"));
    await waitFor(() => {
      expect(sawPaths()).toEqual([]);
    });
    expect(tabNow()?.params.paths).toBeUndefined();
    expect(tabNow()?.params.path).toBe("b.ts");
    expect(screen.queryByTestId("diff-narrowed")).toBeNull();
    expect(screen.queryByTestId("diff-model-band")).toBeNull();
  });

  it("Show controls gives back the list as well; the note stays until it is dismissed", async () => {
    list([file("a.ts")]);
    await show(target({ thread: "s1", paths: ["src"], note: "Why", hide: ["compare"] }));
    expect(screen.getByTestId("diff-narrowed").textContent).toBe("Listing only src");
    expect(screen.getByTestId("diff-reveal").textContent).toBe("Show controls");
    fireEvent.click(screen.getByTestId("diff-reveal"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-compare-bar")).toBeTruthy();
    });
    expect(tabNow()?.params.paths).toBeUndefined();
    expect(screen.queryByTestId("diff-reveal")).toBeNull();
    expect(screen.getByTestId("diff-model-note").textContent).toBe("Why");
    fireEvent.click(screen.getByTestId("diff-note-dismiss"));
    await waitFor(() => {
      expect(screen.queryByTestId("diff-model-band")).toBeNull();
    });
    expect(tabNow()?.params.note).toBeUndefined();
  });

  it("no title, no note, nothing hidden: no band", async () => {
    list([file("a.ts")]);
    await show();
    expect(screen.queryByTestId("diff-model-band")).toBeNull();
  });

  it.each([
    ["compare", ["compare"] as const, "diff-compare-bar", "diff-file-list"],
    ["files", ["files"] as const, "diff-file-list", "diff-compare-bar"],
  ])("--hide %s takes that part away and leaves the rest", async (_name, hide, gone, kept) => {
    list([file("a.ts")]);
    await show(target({ hide }));
    expect(screen.queryByTestId(gone)).toBeNull();
    expect(screen.getByTestId(kept)).toBeTruthy();
    expect(screen.getByTestId("diff-file")).toBeTruthy();
  });

  it("the user can always bring back what was hidden, and it stays back", async () => {
    list([file("a.ts")]);
    await show(target({ heading: "Focused", hide: ["compare", "files"] }));
    expect(screen.queryByTestId("diff-compare-bar")).toBeNull();
    fireEvent.click(screen.getByTestId("diff-reveal"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-compare-bar")).toBeTruthy();
    });
    expect(screen.getByTestId("diff-file-list")).toBeTruthy();
    expect(tabNow()?.params.hide).toBeUndefined();
    expect(screen.queryByTestId("diff-reveal")).toBeNull();
    expect(screen.getByTestId("diff-model-title").textContent).toBe("A thread opened this as “Focused”");
  });

  it("everything hidden and no text still leaves the way back", async () => {
    list([file("a.ts")]);
    await show(target({ hide: ["compare", "files"] }));
    expect(screen.getByTestId("diff-reveal")).toBeTruthy();
  });
});

describe("the Commits section", () => {
  const SHA = (c: string) => c.repeat(40);
  const commit = (c: string, parent: string, o: Partial<CompareCommitView> = {}): CompareCommitView => ({ sha: SHA(c), shortSha: c.repeat(7), parent, subject: `subject ${c}`, authoredAtMs: 1000, shallow: false, ...o });
  const branch = (o: Partial<CompareLogView> = {}) => {
    const commits = [commit("c", SHA("b")), commit("b", SHA("a")), commit("a", "")];
    api.bodies.set(SHA("c"), "Why it changed.\n\nMore.");
    api.log = { commits, total: commits.length, ...o };
  };
  const toggle = () => screen.getByTestId("diff-commits-toggle");
  const commitRow = (c: string) => screen.getByTestId("diff-commits").querySelector(`[data-nav-key="c:${SHA(c)}"]`) as HTMLElement;
  const open = async (t = target()) => {
    await show({ ...t, commitsOpen: true });
  };
  const settled = async () => {
    await act(async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    });
  };

  it("is folded by default, with a count, and opens newest first", async () => {
    list([file("a.ts")]);
    branch({ total: 3 });
    await show();
    expect(screen.getByTestId("diff-commits").getAttribute("data-open")).toBe("false");
    expect(screen.getByTestId("diff-commits-count").textContent).toBe("3");
    expect(screen.queryByTestId("diff-commit-rows")).toBeNull();
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(screen.getByTestId("diff-commit-rows")).toBeTruthy();
    });
    expect(tabNow()?.params.commits).toBe("1");
    expect(screen.getAllByTestId("commit-subject").map((e) => e.textContent)).toEqual(["subject c", "subject b", "subject a"]);
    expect(screen.getAllByTestId("commit-sha").map((e) => e.textContent)).toEqual(["ccccccc", "bbbbbbb", "aaaaaaa"]);
  });

  it("shows nothing with no commits, or from a daemon without the call", async () => {
    list([file("a.ts")]);
    await show();
    expect(screen.queryByTestId("diff-commits")).toBeNull();
    cleanup();
    api.log = new Error("outdated");
    await show();
    expect(screen.queryByTestId("diff-commits")).toBeNull();
    expect(screen.getByTestId("diff-file")).toBeTruthy();
  });

  it("says when the list is cut short", async () => {
    list([file("a.ts")]);
    branch({ total: 900 });
    await open();
    expect(screen.getByTestId("diff-commits-capped").textContent).toBe("First 3 of 900 commits");
  });

  it("follows the sides", async () => {
    list([file("a.ts")]);
    branch();
    await show(target({ base: { kind: "ref", ref: "v1.2" } }));
    expect(api.logs).toEqual(["ref:v1.2 working"]);
  });

  it("a click compares the commit with its parent, and the file list and message follow", async () => {
    list([file("a.ts"), file("b.ts")]);
    branch();
    await open(target({ file: "b.ts" }));
    fireEvent.click(commitRow("c"));
    await waitFor(() => {
      expect(tabNow()?.params.commit).toBe(SHA("c"));
    });
    await settled();
    expect(tabNow()?.params).toMatchObject({ base: `ref:${SHA("b")}`, head: `ref:${SHA("c")}`, path: "a.ts", backPath: "b.ts", backBase: "merge-base", backHead: "working" });
    expect(api.compares.at(-1)).toBe(`ref:${SHA("b")} ref:${SHA("c")}`);
    expect(screen.getByTestId("diff-commit-subject").textContent).toBe("subject c");
    expect(screen.getByTestId("diff-commit-sha").textContent).toBe("ccccccc");
    await waitFor(() => {
      expect(screen.getByTestId("diff-commit-body").textContent).toBe("Why it changed.\n\nMore.");
    });
    // The message is read for this commit alone; the list stays the branch's, read no more than it was, with the commit marked.
    expect(api.bodyReads).toEqual([SHA("c")]);
    expect(api.logs).toEqual(["merge-base working"]);
    expect(commitRow("c").getAttribute("aria-selected")).toBe("true");
  });

  it("a message that cannot be read leaves the rest of the band", async () => {
    list([file("a.ts")]);
    branch();
    api.bodies.set(SHA("c"), new Error("outdated"));
    await open();
    fireEvent.click(commitRow("c"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-commit-subject").textContent).toBe("subject c");
    });
    await settled();
    expect(screen.queryByTestId("diff-commit-body")).toBeNull();
  });

  it("a commit with no message says so, in the list and the band, and one with no date shows none", async () => {
    list([file("a.ts")]);
    api.log = { commits: [commit("c", SHA("b"), { subject: "", authoredAtMs: null })], total: 1 };
    await open();
    expect(screen.getByTestId("commit-subject").textContent).toBe("(no message)");
    fireEvent.click(commitRow("c"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-commit-subject").textContent).toBe("(no message)");
    });
    await settled();
    expect(screen.getByTestId("diff-commit").textContent).not.toContain("ago");
  });

  it("a shallow clone's last commit says it is not a root", async () => {
    list([file("a.ts")]);
    api.log = { commits: [commit("c", "", { shallow: true }), commit("b", "")], total: 2 };
    await open();
    fireEvent.click(commitRow("c"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-commit-shallow").textContent).toContain("every file reads as added");
    });
    fireEvent.click(commitRow("b"));
    await waitFor(() => {
      expect(tabNow()?.params.commit).toBe(SHA("b"));
    });
    await settled();
    expect(screen.queryByTestId("diff-commit-shallow")).toBeNull();
  });

  it.each([
    ["the list on top, folded by its height", 400, 300],
    ["the list on top, with room", 400, 800],
    ["the rail", 900, 300],
  ])("the toggle stays whatever the section's height does to the list: %s", async (_name, width, height) => {
    list([file("a.ts"), file("b.ts"), file("c.ts")]);
    branch();
    api.width = width;
    api.height = height;
    await show();
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(screen.getByTestId("diff-commit-rows")).toBeTruthy();
    });
    expect(tabNow()?.params.commits).toBe("1");
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(screen.queryByTestId("diff-commit-rows")).toBeNull();
    });
    expect(toggle()).toBeTruthy();
  });

  it("a tab reopened on a short panel with the section open still has it", async () => {
    list([file("a.ts"), file("b.ts"), file("c.ts")]);
    branch();
    api.width = 400;
    api.height = 300;
    await open();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("diff-commit-rows")).toBeTruthy();
  });

  it("a branch that nets to nothing keeps its commits, and the diff's place says so", async () => {
    list([]);
    branch();
    await show();
    expect(screen.getByTestId("diff-commits-count").textContent).toBe("3");
    expect(screen.getByTestId("diff-file-list")).toBeTruthy();
    expect(screen.getByTestId("diff-empty")).toBeTruthy();
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(commitRow("c")).toBeTruthy();
    });
    fireEvent.click(commitRow("c"));
    await waitFor(() => {
      expect(tabNow()?.params.commit).toBe(SHA("c"));
    });
  });

  it("with no commits either, the whole tab says there are no changes", async () => {
    list([]);
    await show();
    expect(screen.getByTestId("diff-empty")).toBeTruthy();
    expect(screen.queryByTestId("diff-file-list")).toBeNull();
  });

  it("All changes reads the list again: it paused with the commit", async () => {
    list([file("a.ts")]);
    branch();
    await open();
    fireEvent.click(commitRow("c"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-all-changes")).toBeTruthy();
    });
    await settled();
    expect(api.logs).toEqual(["merge-base working"]);
    fireEvent.click(screen.getByTestId("diff-all-changes"));
    await waitFor(() => {
      expect(api.logs).toEqual(["merge-base working", "merge-base working"]);
    });
  });

  it("a root commit compares against the empty tree; a commit with no message under the subject shows none", async () => {
    list([file("a.ts")]);
    branch();
    await open();
    fireEvent.click(commitRow("a"));
    await waitFor(() => {
      expect(tabNow()?.params.base).toBe(`ref:${EMPTY_TREE}`);
    });
    await settled();
    expect(api.bodyReads).toEqual([SHA("a")]);
    expect(screen.queryByTestId("diff-commit-body")).toBeNull();
  });

  it("names a commit's sides by short sha", async () => {
    list([file("a.ts")], { base: { source: DEFAULT_BASE, label: SHA("b"), sha: SHA("b") }, head: { source: DEFAULT_HEAD, label: SHA("c"), sha: SHA("c") } });
    branch();
    await open();
    fireEvent.click(commitRow("c"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-base").textContent).toBe("bbbbbbb");
    });
    expect(screen.getByTestId("diff-head").textContent).toBe("ccccccc");
  });

  it("All changes goes back to the sides and the file, from any number of commits on", async () => {
    list([file("a.ts"), file("b.ts")]);
    branch();
    await open(target({ head: { kind: "staged" }, file: "b.ts" }));
    expect(screen.queryByTestId("diff-all-changes")).toBeNull();
    fireEvent.click(commitRow("c"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-all-changes")).toBeTruthy();
    });
    await settled();
    fireEvent.click(commitRow("b"));
    await waitFor(() => {
      expect(tabNow()?.params.commit).toBe(SHA("b"));
    });
    await settled();
    fireEvent.click(screen.getByTestId("diff-all-changes"));
    await waitFor(() => {
      expect(tabNow()?.params.commit).toBeUndefined();
    });
    await settled();
    expect(tabNow()?.params).toMatchObject({ head: "staged", path: "b.ts" });
    expect(tabNow()?.params.base).toBeUndefined();
    expect(tabNow()?.params.backHead).toBeUndefined();
    expect(screen.queryByTestId("diff-all-changes")).toBeNull();
    expect(screen.queryByTestId("diff-commit")).toBeNull();
  });

  it("picking a side leaves the commit: nothing is left to go back to", async () => {
    list([file("a.ts")]);
    branch();
    await open();
    fireEvent.click(commitRow("c"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-swap")).toBeTruthy();
      expect(tabNow()?.params.commit).toBe(SHA("c"));
    });
    await settled();
    fireEvent.click(screen.getByTestId("diff-swap"));
    await waitFor(() => {
      expect(tabNow()?.params.commit).toBeUndefined();
    });
    expect(tabNow()?.params).toMatchObject({ base: `ref:${SHA("c")}`, head: `ref:${SHA("b")}` });
    expect(tabNow()?.params.backBase).toBeUndefined();
  });

  it("Open on GitHub opens the commit; a project not on GitHub has no such button", async () => {
    list([file("a.ts")]);
    branch();
    await open();
    fireEvent.click(commitRow("c"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-commit-github")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("diff-commit-github"));
    expect(api.urls).toEqual([`https://github.com/o/web/commit/${SHA("c")}`]);
    act(() => {
      world({}, { githubSlug: "" });
    });
    expect(screen.queryByTestId("diff-commit-github")).toBeNull();
  });

  it("an empty commit keeps the list and its message: the way on is still there", async () => {
    list([]);
    branch();
    await open(target({ base: { kind: "ref", ref: SHA("b") }, head: { kind: "ref", ref: SHA("c") }, commit: { sha: SHA("c"), base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "", oldPath: "" } }));
    expect(screen.getByTestId("diff-empty")).toBeTruthy();
    expect(screen.getByTestId("diff-commit-subject").textContent).toBe("subject c");
    expect(commitRow("b")).toBeTruthy();
  });

  it("a commit the list no longer holds still says which one it is", async () => {
    list([file("a.ts")]);
    api.log = { commits: [], total: 0 };
    await show(target({ base: { kind: "ref", ref: SHA("b") }, head: { kind: "ref", ref: SHA("c") }, commit: { sha: SHA("c"), base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "", oldPath: "" } }));
    expect(screen.getByTestId("diff-commit-sha").textContent).toBe("ccccccc");
    expect(screen.getByTestId("diff-all-changes")).toBeTruthy();
  });

  it("live updates pause on a commit, and Refresh still reads it", async () => {
    list([file("a.ts")]);
    branch();
    await show(target({ base: { kind: "ref", ref: SHA("b") }, head: { kind: "ref", ref: SHA("c") }, file: "a.ts", commit: { sha: SHA("c"), base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "", oldPath: "" } }));
    const [compares, logs, reads] = [api.compares.length, api.logs.length, api.reads.length];
    vi.useFakeTimers();
    act(() => {
      world({ staged: 1 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect([api.compares.length, api.logs.length, api.reads.length]).toEqual([compares, logs, reads]);
    fireEvent.click(screen.getByLabelText("Refresh"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(api.compares.length).toBe(compares + 1);
  });

  it("is live on what the tab compares, with the list", async () => {
    list([file("a.ts")]);
    branch();
    await show();
    const logs = api.logs.length;
    vi.useFakeTimers();
    act(() => {
      world({ staged: 1 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(api.logs.length).toBe(logs + 1);
  });

  it.each([
    ["the file list hidden", { hide: ["files"] as const }],
    ["the sides fixed", { thread: "s1", hide: ["compare"] as const }],
    ["a narrowed list", { thread: "s1", paths: ["a.ts"] }],
  ])("stays away with %s, reads nothing, and Show controls brings it back", async (_name, o) => {
    list([file("a.ts")]);
    branch();
    await show(target(o));
    expect(screen.queryByTestId("diff-commits")).toBeNull();
    expect(api.logs).toEqual([]);
    fireEvent.click(screen.getByTestId("diff-reveal"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-commits")).toBeTruthy();
    });
  });

  it("stays when the list on top is folded by hand", async () => {
    api.width = 400;
    api.height = 800;
    list(Array.from({ length: 10 }, (_, i) => file(`f${String(i)}.ts`)));
    branch();
    await show();
    expect(screen.getByTestId("diff-file-rows")).toBeTruthy();
    fireEvent.click(screen.getByTestId("diff-fold"));
    await waitFor(() => {
      expect(screen.queryByTestId("diff-file-rows")).toBeNull();
    });
    expect(screen.getByTestId("diff-commits")).toBeTruthy();
  });
});

describe("live updates", () => {
  it("a change git's status sees reads the list again, staged-only ones included", async () => {
    list([file("a.ts")]);
    await show(target({ base: { kind: "staged" } }));
    const before = api.compares.length;
    vi.useFakeTimers();
    act(() => {
      world({ staged: 1 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(api.compares.length).toBe(before + 1);
  });

  it("events that never stop still read: each waits out the pace, it does not start it over", async () => {
    list([file("a.ts")]);
    await show();
    const before = api.compares.length;
    vi.useFakeTimers();
    for (let i = 1; i <= 20; i++) {
      act(() => {
        world({ modified: i });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(api.compares.length - before).toBeGreaterThanOrEqual(5);
  });

  it("nothing to see, nothing read: mounting does not read twice", async () => {
    list([file("a.ts")]);
    await show();
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(api.compares).toHaveLength(1);
  });
});
