import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileDiffRequest, FileDiffView, FileSideView } from "@/api/fileDiff";
import { useCodeViewStore } from "@/stores/codeView";
import { usePanelStore } from "@/stores/panel";
import { useProjectsStore } from "@/stores/projects";
import { useUiStore } from "@/stores/ui";
import type { DiffTarget } from "@/surfaces/fileTarget";

/**
 * The Diff tab's header and states (docs/notes/file-viewer-3-tabs.md) over a faked
 * GetWorktreeFileDiff: the status letter, the counts and the base, Unified | Split in the
 * codeView store, the scope switch, Open file, and the binary, renamed, deleted and
 * no-change states. The diff itself is @pierre/diffs' (a real browser: file-tabs.spec.ts),
 * so CodeDiff is a stand-in that says which sides it got.
 */

const diffs = vi.hoisted(() => ({ byKey: new Map<string, Partial<FileDiffView>>(), calls: [] as string[] }));
vi.mock("@/api/fileDiff", () => ({
  getWorktreeFileDiff: (req: FileDiffRequest) => {
    diffs.calls.push(`${req.file} ${req.scope}`);
    const d = diffs.byKey.get(`${req.file} ${req.scope}`) ?? {};
    return Promise.resolve({ old: side(), new: side(), baseRef: "origin/main", mergeBase: "m", head: "h", status: "", error: "", ...d });
  },
}));
vi.mock("@/components/code/CodeDiff", () => ({
  CodeDiff: ({ oldFile, newFile }: { oldFile: { name: string } | null; newFile: { name: string; contents: string } }) => (
    <div data-testid="code-diff" data-old={oldFile?.name ?? ""} data-new={newFile.name} data-new-empty={newFile.contents === "" || undefined} />
  ),
  CodeScroll: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { DiffTab } = await import("./DiffTab");

function side(o: Partial<FileSideView> = {}): FileSideView {
  return { present: true, text: "", truncated: false, binary: false, ...o };
}

const W = "/Users/dev/src/code-foundry";
const target = (o: Partial<DiffTarget> = {}): DiffTarget => ({ project: "repo-cf", worktree: W, path: "README.md", oldPath: "", scope: "working", ...o });

const README_OLD = "# code-foundry\n\nA desktop app.\n";
const README_NEW = "# code-foundry\n\nA desktop app.\n\nRun make check.\nRun make build.\n";

beforeEach(() => {
  useProjectsStore.setState({ byId: { "repo-cf": { remotes: ["origin"] } as never } });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
  usePanelStore.setState({ byKey: {} });
  diffs.byKey.set("README.md working", { status: "M", old: side({ text: README_OLD }), new: side({ text: README_NEW }) });
});

afterEach(() => {
  cleanup();
  diffs.byKey.clear();
  diffs.calls = [];
  useCodeViewStore.setState({ diffStyle: "unified" });
  localStorage.clear();
});

const tab = () => screen.getByTestId("diff-tab");

describe("DiffTab", () => {
  it("a modified file: its name, M, the counts and the base without its remote", async () => {
    render(<DiffTab target={target()} />);
    await screen.findByTestId("code-diff");
    expect(tab().dataset.scope).toBe("working");
    expect(screen.getByTestId("file-header-name").textContent).toBe("README.md");
    expect(screen.getByTestId("diff-status").textContent).toBe("M");
    expect(screen.getByTestId("diff-meta").textContent).toBe("M · +3 · vs main");
    expect(screen.getByTestId("code-diff").dataset.old).toBe("README.md");
    expect(screen.getByTestId("diff-open-file")).toBeTruthy();
  });

  it("Unified ↔ Split is the codeView store's, persisted for every diff", async () => {
    render(<DiffTab target={target()} />);
    await screen.findByTestId("code-diff");
    expect(tab().dataset.style).toBe("unified");
    expect(screen.getByTestId("diff-style-unified").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("diff-style-split"));
    expect(tab().dataset.style).toBe("split");
    expect(screen.getByTestId("diff-style-split").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("code-foundry.codeView")).toContain('"diffStyle":"split"');
    fireEvent.click(screen.getByTestId("diff-style-unified"));
    expect(tab().dataset.style).toBe("unified");
  });

  it("the scope switch re-opens the tab on the branch, which reads again; nothing committed says so", async () => {
    usePanelStore.setState({ byKey: {} });
    const { rerender } = render(<DiffTab target={target()} />);
    await screen.findByTestId("code-diff");
    fireEvent.click(screen.getByTestId("diff-scope-branch"));
    // The panel's tab takes the new scope (the panel re-renders the tab with it).
    const tabs = usePanelStore.getState().byKey["thread:s-1"]?.groups[0]?.tabs ?? [];
    expect(tabs.map((t) => [t.kind, t.params.path, t.params.scope])).toEqual([["diff", "README.md", "branch"]]);
    rerender(<DiffTab target={target({ scope: "branch" })} />);
    await screen.findByTestId("diff-none");
    expect(tab().dataset.scope).toBe("branch");
    expect(screen.getByTestId("diff-none").textContent).toContain("No changes");
    expect(screen.getByTestId("diff-none").textContent).toContain("Nothing committed on the branch changes this file against main.");
    expect(diffs.calls).toEqual(["README.md working", "README.md branch"]);
  });

  it("Open file opens the file's tab at its first change", async () => {
    render(<DiffTab target={target()} />);
    await screen.findByTestId("code-diff");
    fireEvent.click(screen.getByTestId("diff-open-file"));
    const tabs = usePanelStore.getState().byKey["thread:s-1"]?.groups[0]?.tabs ?? [];
    expect(tabs.map((t) => [t.kind, t.params.path, t.params.line])).toEqual([["files", `${W}/README.md`, "4"]]);
  });

  it("an added file: A", async () => {
    diffs.byKey.set("notes/plan.md working", { status: "A", old: side({ present: false }), new: side({ text: "# Plan\n" }) });
    render(<DiffTab target={target({ path: "notes/plan.md" })} />);
    await screen.findByTestId("code-diff");
    expect(screen.getByTestId("diff-status").textContent).toBe("A");
    expect(screen.getByTestId("code-diff").dataset.old).toBe("");
  });

  it("a rename on the branch: R, the old name in the full path, the old side under its old name", async () => {
    diffs.byKey.set("docs/notes/sidebar.md branch", { status: "R", old: side({ text: "# Sidebar\n" }), new: side({ text: "# Sidebar\n\nThe tree.\n" }) });
    render(<DiffTab target={target({ path: "docs/notes/sidebar.md", oldPath: "docs/sidebar.md", scope: "branch", worktree: `${W}.worktrees/feat-sidebar` })} />);
    await screen.findByTestId("code-diff");
    expect(tab().dataset.scope).toBe("branch");
    expect(screen.getByTestId("diff-status").textContent).toBe("R");
    expect(screen.getByTestId("file-header-name").textContent).toBe("sidebar.md");
    expect(screen.getByTestId("code-diff").dataset.old).toBe("docs/sidebar.md");
  });

  it("a rename with the same contents says so", async () => {
    diffs.byKey.set("b.md branch", { status: "R", old: side({ text: "same\n" }), new: side({ text: "same\n" }) });
    render(<DiffTab target={target({ path: "b.md", oldPath: "a.md", scope: "branch" })} />);
    expect((await screen.findByTestId("diff-renamed")).textContent).toContain("From a.md; the contents are the same.");
  });

  it("a deletion: D, every line removed, nothing to open", async () => {
    diffs.byKey.set("gui/frontend/src/lib/old-tree.ts branch", { status: "D", old: side({ text: "export const tree = 1;\n" }), new: side({ present: false }) });
    render(<DiffTab target={target({ path: "gui/frontend/src/lib/old-tree.ts", scope: "branch" })} />);
    await screen.findByTestId("code-diff");
    expect(screen.getByTestId("diff-status").textContent).toBe("D");
    expect(screen.getByTestId("diff-meta").textContent).toBe("D · −1 · vs main");
    expect(screen.getByTestId("code-diff").dataset.newEmpty).toBe("true");
    expect(screen.queryByTestId("diff-open-file")).toBeNull();
  });

  it("a binary: Binary file with what happened to it, no counts", async () => {
    diffs.byKey.set("assets/icon.png branch", { status: "A", old: side({ present: false }), new: side({ binary: true }) });
    render(<DiffTab target={target({ path: "assets/icon.png", scope: "branch" })} />);
    const bin = await screen.findByTestId("diff-binary");
    expect(bin.textContent).toContain("Binary file");
    expect(bin.textContent).toContain("Added");
    expect(screen.getByTestId("diff-meta").textContent).toBe("A · vs main");
    expect(screen.queryByTestId("code-diff")).toBeNull();
  });

  it("the daemon's refusal reads Cannot compare", async () => {
    diffs.byKey.set("README.md working", { error: "not a git worktree" });
    render(<DiffTab target={target()} />);
    await waitFor(() => {
      expect(screen.getByTestId("diff-unavailable").textContent).toContain("not a git worktree");
    });
    expect(screen.queryByTestId("diff-meta")).toBeNull();
  });
});
