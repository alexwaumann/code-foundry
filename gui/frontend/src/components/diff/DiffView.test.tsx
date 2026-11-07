import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareFileSidesView, CompareFileView, CompareSideView, CompareTarget, CompareView } from "@/api/compare";
import type { ProjectView, WorktreeView } from "@/api/project";
import { useCodeViewStore } from "@/stores/codeView";
import { getPanel, usePanelStore } from "@/stores/panel";
import { useProjectsStore } from "@/stores/projects";
import { useUiStore } from "@/stores/ui";
import { DEFAULT_BASE, DEFAULT_HEAD, diffOfTab, diffTab, sourceParam, type DiffTarget } from "@/surfaces/diffTarget";

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
  reads: [] as string[],
  width: 900,
}));
vi.mock("@/api/compare", () => ({
  compareWorktree: (t: CompareTarget) => {
    api.compares.push(`${sourceParam(t.base)} ${sourceParam(t.head)}`);
    if (api.view instanceof Error) return Promise.reject(api.view);
    return Promise.resolve({ ...compareDefaults(), ...api.view });
  },
  getCompareFile: (_t: CompareTarget, file: string) => {
    api.reads.push(file);
    return Promise.resolve({ old: side(), new: side(), status: "M", error: "", ...api.sides.get(file) });
  },
}));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), listRefs: () => Promise.resolve({ refs: ["main", "origin/main", "v1.2"], defaultRef: "origin/main", branches: [], defaultBranch: "main" }) }));
vi.mock("@/lib/useWidth", () => ({ useWidth: () => [{ current: null }, api.width] }));
vi.mock("@/components/code/CodeDiff", () => ({
  CodeDiff: ({ oldFile, newFile }: { oldFile: { name: string } | null; newFile: { name: string } }) => <div data-testid="code-diff" data-old={oldFile?.name ?? ""} data-new={newFile.name} />,
  CodeScroll: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@pierre/diffs", async (orig) => ({ ...(await orig<typeof import("@pierre/diffs")>()) }));

const { DiffView, RAIL_MIN } = await import("./DiffView");

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

/** The tab as the panel holds it, rendered until both reads answered. */
function Live() {
  const tab = usePanelStore((s) => s.byKey[KEY]?.groups[0]?.tabs[0]);
  const t = tab ? diffOfTab(tab) : null;
  return tab && t ? <DiffView tabId={tab.id} tabTitle={tab.title} target={t} /> : null;
}
async function show(t: DiffTarget = target()): Promise<void> {
  usePanelStore.setState({ byKey: { [KEY]: { open: true, groups: [{ tabs: [diffTab(t)], activeTabId: diffTab(t).id }] } } });
  render(<Live />);
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve();
  });
}
const tabNow = () => getPanel(KEY).groups[0]?.tabs[0];
const rowOf = (path: string) => screen.getByTestId("diff-file-list").querySelector(`[data-nav-key="f:${path}"]`) as HTMLElement;
const rowKeys = () => [...screen.getByTestId("diff-file-list").querySelectorAll("[data-nav-key]")].map((e) => e.getAttribute("data-nav-key"));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  api.view = null;
  api.sides.clear();
  api.compares.length = 0;
  api.reads.length = 0;
  api.width = 900;
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
  useCodeViewStore.setState({ diffStyle: "unified" });
  world();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    expect(tabNow()?.params.path).toBeUndefined();
    fireEvent.click(screen.getByTestId("diff-next"));
    await waitFor(() => {
      expect(screen.getByTestId("diff-position").textContent).toBe("2 of 2");
    });
    fireEvent.click(screen.getByTestId("diff-next"));
    expect(tabNow()?.params.path).toBe("b.ts");
  });

  it("a file that left the list falls back to the first, without losing the tab", async () => {
    list([file("a.ts")]);
    await show(target({ file: "committed-since.ts" }));
    expect(screen.getByTestId("diff-file").getAttribute("data-path")).toBe("a.ts");
    expect(tabNow()?.params.path).toBe("committed-since.ts");
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
      expect(getPanel(KEY).groups[0]?.tabs.map((t) => t.kind)).toEqual(["diff", "files"]);
    });
    expect(getPanel(KEY).groups[0]?.tabs[1]?.params.path).toBe(`${W}/src/a.ts`);
  });
});

describe("the comparison's states", () => {
  it("nothing differs", async () => {
    list([]);
    await show();
    expect(screen.getByTestId("diff-empty")).toBeTruthy();
    expect(api.reads).toEqual([]);
  });

  it("a ref deleted since keeps the bar, so the user can pick another", async () => {
    list([], { error: "soon-gone does not name a commit in this checkout", base: { source: { kind: "ref", ref: "soon-gone" }, label: "soon-gone", sha: "" } });
    await show(target({ base: { kind: "ref", ref: "soon-gone" } }));
    expect(screen.getByTestId("diff-source-missing").textContent).toContain("soon-gone does not name a commit");
    expect(screen.getByTestId("diff-base").textContent).toContain("soon-gone");
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
    expect(rowKeys()).toEqual(["f:f3.ts"]);
    fireEvent.change(screen.getByTestId("diff-filter"), { target: { value: "nope" } });
    expect(screen.getByTestId("diff-filter-none")).toBeTruthy();
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
