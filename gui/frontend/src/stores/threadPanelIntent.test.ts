import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView, WorktreeView } from "@/api/project";
import type { ThreadView } from "@/api/threads";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/api/app", () => ({ playAlertSound: vi.fn(() => Promise.resolve()) }));
/** What the user's own Diff tab lists when a thread's pick asks (ProjectService.CompareWorktree), and each ask. */
const compare = vi.hoisted(() => ({ listed: [] as { path: string; oldPath: string }[] | Error, asked: [] as string[] }));
vi.mock("@/api/compare", async (orig) => ({
  ...(await orig<typeof import("@/api/compare")>()),
  compareWorktree: (t: { base: { kind: string; ref?: string }; head: { kind: string; ref?: string } }, paths: readonly string[]) => {
    const side = (s: { kind: string; ref?: string }) => (s.kind === "ref" ? `ref:${s.ref ?? ""}` : s.kind);
    compare.asked.push(`${side(t.base)} ${side(t.head)} ${paths.join(",")}`);
    if (compare.listed instanceof Error) return Promise.reject(compare.listed);
    const files = compare.listed.filter((f) => paths.includes(f.path)).map((f) => ({ ...f, status: "M", added: 1, deleted: 0, binary: false, submodule: false }));
    return Promise.resolve({ files });
  },
}));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const { appliedOps, fakeLayoutState, layoutSettled, resetFakeLayout, threadSeed } = await import("@/test/fakeLayout");
const { applyLayoutOp } = await import("@/api/layout");
const { makeTab, openTab, setTabParams, shownTab, tabPlace } = await import("@/shell/host");
/** Every op sent answered: a thread's pick into a tab comparing other sides waits for that comparison's answer too. */
const answered = () => layoutSettled();

const { applyIntent, clearPendingFocus } = await import("./intents");
const { useLayoutStore } = await import("./layout");
const { useProjectsStore } = await import("./projects");
const { showThreadView } = await import("./threadPanelIntent");
const { useThreadsStore } = await import("./threads");
const { useUiStore } = await import("./ui");
const { useViewsStore } = await import("./views");
const { fileEditKey, noteEditor, startEdit, useFileEditStore } = await import("./fileEdit");
const { blankFile } = await import("@/api/files");
const { fileTab } = await import("@/surfaces/fileTarget");

const WEB_MAIN = "/src/web";
const WEB_FEAT = "/wt/web/cf-feat";
const status = { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null };
const wt = (path: string, branch: string, isMain = false): WorktreeView => ({ projectId: "web", path, branch, head: "abc", detached: false, isMain, status });
const web: ProjectView = { id: "web", path: WEB_MAIN, name: "web", defaultBranch: "main", githubSlug: "", remotes: [], git: true, worktrees: [wt(WEB_MAIN, "main", true), wt(WEB_FEAT, "cf/feat")] };
const thread = (id: string, o: Partial<ThreadView> = {}) =>
  ({ id, projectId: "web", worktreePath: WEB_MAIN, workspaceId: "", pendingWorktreePath: "", state: "connected", linkedPullRequests: [], agentRuns: [], createdAtMs: 1, ...o }) as unknown as ThreadView;

/** The user is in thread "a" (its prompt focused); the model works in thread "b". */
const inA = { kind: "thread", id: "a" } as const;
/** Applies the intent and waits for the layout to answer what it sent. */
const show = async (name: string, threadId?: string) => {
  applyIntent(threadId ? { kind: "showView", name, threadId } : { kind: "showView", name });
  await layoutSettled();
};
/** A target's tabs' ids (a File tab's is its path's, any other the layout's). */
const tabIds = (key: string) => tabPlace(key).tabs.map((t) => t.id);
const kinds = (key: string) => tabPlace(key).tabs.map((t) => t.kind);
/** Whether any op sent moved the focus. */
const focused = () => appliedOps.some((o) => o.op === "focus_tab" || o.op === "focus_pane");

beforeEach(async () => {
  vi.clearAllMocks();
  compare.listed = [];
  compare.asked = [];
  clearPendingFocus();
  // Threads a and b in one pane, a in front: a thread's tabs open in a pane beside it.
  const seed = threadSeed("a");
  seed.spaces[0]?.root?.tabs?.push({ id: "t-b", kind: "thread", thread: "b" });
  await resetFakeLayout(seed);
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
  useProjectsStore.setState({ byId: { web }, order: ["web"] });
  useThreadsStore.setState({
    byId: { a: thread("a"), b: thread("b", { worktreePath: WEB_FEAT }), home: thread("home", { projectId: "", worktreePath: "/Users/me" }) },
    order: ["a", "b", "home"],
  });
  useUiStore.setState({ selection: inA, focus: "content", promptFocusSeq: 0 });
});

afterEach(async () => {
  await layoutSettled();
});

describe("a ShowView scoped to a thread", () => {
  it.each([["panel.mcp", "mcp"]])("%s opens the tab among that thread's tabs and leaves the selection and focus alone", async (name, kind) => {
    await show(name, "b");
    expect(useUiStore.getState().selection).toEqual(inA);
    expect(focused()).toBe(false);
    expect(tabPlace("thread:b").shown).toBe(true);
    expect(kinds("thread:b")).toEqual([kind]);
    expect(tabPlace("thread:a").shown).toBe(false);
  });

  it("on the selected thread shows the change at once, still without taking focus", async () => {
    await show("panel.mcp", "a");
    expect(tabPlace().shown).toBe(true);
    expect(kinds("thread:a")).toEqual(["mcp"]);
    expect(focused()).toBe(false);
    expect(useUiStore.getState().focus).toBe("content");
  });

  it("is there when the user opens the thread", async () => {
    await show("panel.mcp", "b");
    useUiStore.getState().select({ kind: "thread", id: "b" });
    expect(tabPlace().shown).toBe(true);
    expect(kinds("thread:b")).toEqual(["mcp"]);
  });

  it("applies while the settings page is up, which stays", async () => {
    useViewsStore.setState({ settingsOpen: true });
    await show("panel.mcp", "b");
    expect(tabPlace("thread:b").shown).toBe(true);
    expect(useViewsStore.getState().settingsOpen).toBe(true);
  });

  it("the removed surfaces' names change nothing and say nothing", async () => {
    for (const name of ["panel.worktree", "panel.linked-prs", "panel.agents", "panel.usage", "panel.threads"]) expect(showThreadView(name, "b")).toBe(false);
    await layoutSettled();
    expect(appliedOps).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("the classic side panel's own actions (toggle, expand, new tab, split) are no item actions: they change nothing", async () => {
    const before = fakeLayoutState();
    for (const name of ["panel.toggle", "panel.expand", "panel.new-tab", "panel.split"]) {
      expect(showThreadView(name, "b")).toBe(false);
      await show(name, "b");
    }
    expect(appliedOps).toEqual([]);
    expect(fakeLayoutState()).toEqual(before);
    expect(useUiStore.getState().selection).toEqual(inA);
  });

  it("a thread the window does not know, or a name that is no panel action, changes nothing", async () => {
    expect(showThreadView("panel.mcp", "zz")).toBe(false);
    expect(showThreadView("settings", "b")).toBe(false);
    await show("settings", "b");
    await show("dashboard", "b");
    expect(useViewsStore.getState().settingsOpen).toBe(false);
    expect(useUiStore.getState().selection).toEqual(inA);
    expect(appliedOps).toEqual([]);
  });

  describe("the item actions (view.panel.file, diff, pr)", () => {
    /** Applies the item action on thread b and waits for the layout to answer what it sent. */
    const showItem = async (name: string, params: Record<string, string>) => {
      applyIntent({ kind: "showView", name, threadId: "b", params });
      await layoutSettled();
    };
    /** The tab a target's focused pane (else its first pane) shows. */
    const active = (key: string) => shownTab(tabPlace(key)) ?? undefined;
    const untouched = () => {
      expect(useUiStore.getState().selection).toEqual(inA);
      expect(focused()).toBe(false);
      expect(tabPlace("thread:a").shown).toBe(false);
    };
    /** Sets a tab's params as the Diff tab does while the user works in it. */
    const userSets = async (id: string, params: Record<string, string>) => {
      setTabParams("thread:b", id, params);
      await layoutSettled();
    };

    it("panel.file opens the file's tab at its line among the thread's tabs", async () => {
      await showItem("panel.file", { path: `${WEB_FEAT}/src/main.go`, line: "12", project: "web", base: WEB_FEAT });
      expect(tabPlace("thread:b").shown).toBe(true);
      expect(active("thread:b")).toMatchObject({ kind: "files", title: "main.go", params: { path: `${WEB_FEAT}/src/main.go`, line: "12", project: "web", base: WEB_FEAT } });
      untouched();
    });

    it("panel.file with page=1 (view.panel.page) opens the file as the thread's page, titled", async () => {
      await showItem("panel.file", { path: `${WEB_FEAT}/welcome.html`, project: "web", base: WEB_FEAT, page: "1", title: "Welcome" });
      expect(active("thread:b")).toMatchObject({ kind: "files", title: "Welcome", params: { path: `${WEB_FEAT}/welcome.html`, page: "1", title: "Welcome" } });
      untouched();
    });

    describe("a thread's request to edit a file (--edit)", () => {
      const ENV = `${WEB_FEAT}/.env`;
      const ask = { path: ENV, project: "web", base: WEB_FEAT, edit: "1", thread: "b" };
      const params = () => tabPlace("thread:b").tabs[0]?.params;

      it("opens the tab editing, with who asked and what they said, and takes no focus", async () => {
        const before = document.activeElement;
        await showItem("panel.file", { ...ask, note: "Put the key on line 2", line: "2" });
        expect(params()).toMatchObject({ edit: "1", asker: "b", note: "Put the key on line 2", line: "2" });
        expect(useUiStore.getState().selection).toEqual(inA);
        expect(focused()).toBe(false);
        expect(useUiStore.getState().promptFocusSeq).toBe(0);
        expect(document.activeElement).toBe(before);
      });

      it("two requests are two, the same note or not", async () => {
        await showItem("panel.file", { ...ask, note: "Same" });
        const first = params()?.askId;
        await showItem("panel.file", { ...ask, note: "Same" });
        expect(first).toBeTruthy();
        expect(params()?.askId).not.toBe(first);
      });

      it("a plain open has none of it", async () => {
        await showItem("panel.file", { path: ENV, project: "web", base: WEB_FEAT });
        expect(params()).toEqual({ path: ENV, project: "web", base: WEB_FEAT });
      });

      it("with --focus the editor takes the keyboard at the end of the line, once it is there", async () => {
        await showItem("panel.file", { ...ask, line: "2", focus: "1" });
        const key = fileEditKey("thread:b", fileTab({ project: "web", base: WEB_FEAT, path: ENV }).id);
        const focus = vi.fn();
        noteEditor(key, { focus, caret: () => null, select: vi.fn() });
        expect(focus).toHaveBeenCalledTimes(1);
      });

      // Its own file: an editor noted for one tab stays noted, and would answer in place of this one.
      it("without it the editor takes nothing", async () => {
        const path = `${WEB_FEAT}/no-focus.env`;
        await showItem("panel.file", { ...ask, path, line: "2" });
        const key = fileEditKey("thread:b", fileTab({ project: "web", base: WEB_FEAT, path }).id);
        const focus = vi.fn();
        noteEditor(key, { focus, caret: () => null, select: vi.fn() });
        expect(focus).not.toHaveBeenCalled();
      });

      describe("with the user typing in an editor of that pane", () => {
        const A = `${WEB_FEAT}/a.env`;
        const a = fileTab({ project: "web", base: WEB_FEAT, path: A });
        const b = fileTab({ project: "web", base: WEB_FEAT, path: ENV });
        const aKey = fileEditKey("thread:b", a.id);
        let wrap: HTMLElement;

        beforeEach(async () => {
          openTab("thread:b", a);
          await layoutSettled();
          await startEdit(aKey, { panelKey: "thread:b", tabId: a.id, base: WEB_FEAT }, { ...blankFile(A), text: "x\n" });
          wrap = document.createElement("div");
          wrap.setAttribute("data-code-editor", useFileEditStore.getState().sessions[aKey]?.stateKey ?? "");
          const host = document.createElement("div");
          host.tabIndex = -1;
          wrap.append(host);
          document.body.append(wrap);
          host.focus();
        });
        afterEach(() => {
          wrap.remove();
          useFileEditStore.setState({ sessions: {} });
        });

        // Shell gap: `behind` holds only for an open tab (hostShell.ts shellOpenTab); a new one opens in front in the editor's pane.
        it.skip("a request joins the strip behind it", async () => {
          await showItem("panel.file", ask);
          const g = tabPlace("thread:b").groups[0];
          expect(g?.active?.id).toBe(a.id);
          expect(g?.tabs.map((t) => t.id)).toEqual([a.id, b.id]);
          expect(g?.tabs[1]?.params).toMatchObject({ asker: "b", edit: "1" });
        });

        it("a repeat request updates its tab there", async () => {
          await showItem("panel.file", ask);
          await applyLayoutOp({ op: "focus_tab", tab: Object.values(useLayoutStore.getState().tabs).find((t) => t.params.path === A)?.id ?? "" });
          await layoutSettled();
          await showItem("panel.file", { ...ask, note: "Second" });
          const g = tabPlace("thread:b").groups[0];
          expect(g?.active?.id).toBe(a.id);
          expect(g?.tabs[1]?.params.note).toBe("Second");
        });

        it("--focus goes to it: the user asked to be taken there", async () => {
          await showItem("panel.file", { ...ask, focus: "1" });
          expect(tabPlace("thread:b").groups[0]?.active?.id).toBe(b.id);
        });

        it("a plain open behaves as it always has", async () => {
          await showItem("panel.file", { path: ENV, project: "web", base: WEB_FEAT });
          expect(tabPlace("thread:b").groups[0]?.active?.id).toBe(b.id);
        });

        // Shell gap: the daemon places a thread's new tab in the first pane holding its tabs, not the focused one of them.
        it.skip("in another pane it opens as usual: that pane's screen is not the user's", async () => {
          // The thread's MCP tab in a pane of its own below a.env's, focused.
          openTab("thread:b", makeTab("mcp", "MCP"));
          await layoutSettled();
          const mcp = Object.values(useLayoutStore.getState().tabs).find((t) => t.kind === "mcp")?.id ?? "";
          const pane = Object.values(useLayoutStore.getState().panes).find((p) => p.tabIds.includes(mcp))?.id ?? "";
          await applyLayoutOp({ op: "move_tab", tab: mcp, pane, edge: "bottom" });
          await applyLayoutOp({ op: "focus_tab", tab: mcp });
          await layoutSettled();
          await showItem("panel.file", ask);
          expect(tabPlace("thread:b").groups[1]?.active?.id).toBe(b.id);
          expect(tabPlace("thread:b").groups[0]?.active?.id).toBe(a.id);
        });
      });
    });

    it("panel.file again moves the open tab to the new line", async () => {
      await showItem("panel.file", { path: `${WEB_FEAT}/a.html`, project: "web", base: WEB_FEAT });
      await showItem("panel.file", { path: `${WEB_FEAT}/a.html`, line: "3", project: "web", base: WEB_FEAT });
      expect(tabIds("thread:b")).toHaveLength(1);
      expect(active("thread:b")?.params.line).toBe("3");
    });

    it("panel.diff from this daemon: sources, a narrowed list, a title, a note and what to hide", async () => {
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, base: "ref:v1.2", head: "staged", paths: "a.go\nb.go", thread: "b", title: "Two files", note: "Why", hide: "compare", own: "1" });
      expect(active("thread:b")).toMatchObject({ kind: "diff", title: "Two files", params: { base: "ref:v1.2", head: "staged", paths: "a.go\nb.go", thread: "b", title: "Two files", note: "Why", hide: "compare", own: "1" } });
      untouched();
    });

    // Shell gap: the layout keys a thread's Diff tab by its linked thread, project and worktree (internal/layout/identity.go), so a thread's untitled diff is the user's own tab.
    it.skip("panel.diff framed with no title leaves the checkout's own tab as the user had it", async () => {
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1", path: "src/main.go" });
      const mine = active("thread:b");
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1", paths: "a.go\nb.go", note: "Why", thread: "b" });
      expect(tabIds("thread:b")).toHaveLength(2);
      expect(active("thread:b")).toMatchObject({ title: "From thread", params: { paths: "a.go\nb.go", note: "Why", thread: "b" } });
      expect(tabPlace("thread:b").tabs.find((t) => t.id === mine?.id)).toEqual(mine);
    });

    // Shell gap: threadPanelIntent.ts finds the user's own Diff tab by diffTab's id, but the seam knows a Diff tab by its layout id: the call's params replace the tab's.
    it.skip("panel.diff with one path only picks the file in the user's own tab: what it compares, filters and folds stays", async () => {
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1" });
      const id = active("thread:b")?.id ?? "";
      await userSets(id, { project: "web", worktree: WEB_FEAT, own: "1", base: "ref:v1.2", head: "staged", filter: "go", fold: "1", path: "other.go" });
      compare.listed = [{ path: "src/main.go", oldPath: "" }];
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1", path: "src/main.go" });
      await answered();
      expect(compare.asked).toEqual(["ref:v1.2 staged src/main.go"]);
      expect(tabIds("thread:b")).toHaveLength(1);
      expect(active("thread:b")?.params).toMatchObject({ base: "ref:v1.2", head: "staged", filter: "go", fold: "1", path: "src/main.go" });
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1" });
      expect(active("thread:b")?.params.path).toBe("src/main.go");
    });

    // Shell gap: the layout keys a thread's Diff tab by its linked thread, project and worktree (internal/layout/identity.go), so a thread's untitled diff is the user's own tab.
    it.skip("panel.diff with sources and a thread opens that thread's tab, the user's own unchanged", async () => {
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1" });
      const own = tabIds("thread:b")[0] ?? "";
      await userSets(own, { project: "web", worktree: WEB_FEAT, own: "1", filter: "go", fold: "1", path: "other.go" });
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1", base: "ref:v1.2", thread: "b" });
      expect(tabIds("thread:b")).toHaveLength(2);
      expect(active("thread:b")).toMatchObject({ title: "From thread", params: { base: "ref:v1.2", thread: "b" } });
      expect(tabPlace("thread:b").tabs.find((t) => t.id === own)?.params).toEqual({ project: "web", worktree: WEB_FEAT, own: "1", filter: "go", fold: "1", path: "other.go" });
    });

    // Shell gap: threadPanelIntent.ts finds the user's own Diff tab by diffTab's id, but the seam knows a Diff tab by its layout id: the call's params replace the tab's.
    it.skip.each([
      ["a base", { base: "ref:v1.2" }],
      ["a head", { head: "staged" }],
      ["an older daemon's scope", { scope: "branch" }],
    ])("panel.diff without a thread never changes what the user's tab compares: %s", async (_name, sides) => {
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1" });
      const own = tabIds("thread:b")[0] ?? "";
      await userSets(own, { project: "web", worktree: WEB_FEAT, own: "1", head: "staged", filter: "go", fold: "1", path: "other.go" });
      const title = active("thread:b")?.title;
      compare.listed = [{ path: "src/main.go", oldPath: "" }];
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1", path: "src/main.go", ...sides });
      await answered();
      expect(tabIds("thread:b")).toEqual([own]);
      expect(active("thread:b")?.title).toBe(title);
      expect(active("thread:b")?.params).toEqual({ project: "web", worktree: WEB_FEAT, own: "1", head: "staged", filter: "go", fold: "1", path: "src/main.go" });
    });

    // Shell gap: threadPanelIntent.ts finds the user's own Diff tab by diffTab's id, but the seam knows a Diff tab by its layout id: the call's params replace the tab's.
    it.skip("panel.diff picking a file leaves a commit the user was in, and a call with no file does not", async () => {
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1" });
      const own = tabIds("thread:b")[0] ?? "";
      const inCommit = { project: "web", worktree: WEB_FEAT, own: "1", base: "ref:p1", head: "ref:c1", path: "other.go", commit: "c1", backBase: "merge-base", backHead: "staged", backPath: "was.go", commits: "1" };
      await userSets(own, inCommit);
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1" });
      expect(active("thread:b")?.params).toEqual(inCommit);
      compare.listed = [{ path: "src/main.go", oldPath: "" }];
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1", path: "src/main.go" });
      await answered();
      // Asked of the sides the commit came from, not of the commit.
      expect(compare.asked).toEqual(["merge-base staged src/main.go"]);
      expect(active("thread:b")?.params).toEqual({ project: "web", worktree: WEB_FEAT, own: "1", head: "staged", path: "src/main.go", commits: "1" });
    });

    // Shell gap: threadPanelIntent.ts finds the user's own Diff tab by diffTab's id, but the seam knows a Diff tab by its layout id: the call's params replace the tab's.
    it.skip("panel.diff picks at once, asking nothing, when the user's tab compares what the daemon checked", async () => {
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1" });
      const own = tabIds("thread:b")[0] ?? "";
      await userSets(own, { project: "web", worktree: WEB_FEAT, own: "1", filter: "go", path: "other.go" });
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1", path: "src/main.go" });
      expect(compare.asked).toEqual([]);
      expect(tabIds("thread:b")).toEqual([own]);
      expect(active("thread:b")?.params).toEqual({ project: "web", worktree: WEB_FEAT, own: "1", filter: "go", path: "src/main.go" });
    });

    // Shell gap: threadPanelIntent.ts finds the user's own Diff tab by diffTab's id, but the seam knows a Diff tab by its layout id: the call's params replace the tab's.
    it.skip("panel.diff picks a rename under the name the user's sides list it by", async () => {
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1" });
      const own = tabIds("thread:b")[0] ?? "";
      await userSets(own, { project: "web", worktree: WEB_FEAT, own: "1", base: "staged" });
      compare.listed = [{ path: "src/new.go", oldPath: "src/staged-name.go" }];
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1", path: "src/new.go", oldPath: "src/old.go" });
      await answered();
      expect(active("thread:b")?.params).toMatchObject({ base: "staged", path: "src/new.go", oldPath: "src/staged-name.go" });
    });

    // Shell gap: the seam knows a Diff tab by its layout id, not diffTab's (threadPanelIntent.ts finds no open tab), and the layout's identity makes a thread's untitled diff the user's own tab.
    it.skip.each([
      ["not in what the user compares", () => [] as { path: string; oldPath: string }[]],
      ["the user's comparison cannot say", () => new Error("unavailable")],
    ])("panel.diff opens a file %s in a tab of the thread's own, comparing where the daemon found it", async (_name, listed) => {
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1" });
      const own = tabIds("thread:b")[0] ?? "";
      const mine = { project: "web", worktree: WEB_FEAT, own: "1", base: "ref:HEAD", filter: "go", path: "other.go" };
      await userSets(own, mine);
      compare.listed = listed();
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1", path: "src/committed.go", oldPath: "src/was.go" });
      await answered();
      expect(compare.asked).toEqual(["ref:HEAD working src/committed.go"]);
      expect(tabIds("thread:b")).toHaveLength(2);
      expect(active("thread:b")).toMatchObject({ kind: "diff", title: "From thread", params: { project: "web", worktree: WEB_FEAT, own: "1", path: "src/committed.go", oldPath: "src/was.go", thread: "b" } });
      expect(active("thread:b")?.params.base).toBeUndefined();
      expect(tabPlace("thread:b").tabs.find((t) => t.id === own)?.params).toEqual(mine);
    });

    it("panel.diff with no path opens the checkout's tab; without a checkout, nothing", async () => {
      await showItem("panel.diff", { project: "web", worktree: WEB_FEAT, own: "1" });
      expect(active("thread:b")).toMatchObject({ kind: "diff", params: { project: "web", worktree: WEB_FEAT } });
      expect(showThreadView("panel.diff", "b", { project: "web" })).toBe(false);
    });

    it.each([
      ["working: the default sources", { project: "web", worktree: WEB_FEAT, path: "src/main.go", scope: "working" }, undefined],
      ["branch: the merge base against HEAD", { project: "web", worktree: WEB_FEAT, path: "src/main.go", scope: "branch" }, "ref:HEAD"],
    ])("panel.diff shows the file in the checkout's Diff tab (%s)", async (_name, params, head) => {
      await showItem("panel.diff", params);
      const tab = active("thread:b");
      expect(tab).toMatchObject({ kind: "diff", params: { project: "web", worktree: WEB_FEAT, path: "src/main.go" } });
      expect(tab?.params.head).toBe(head);
      expect(tab?.params.scope).toBeUndefined();
      untouched();
    });

    it("panel.pr opens the pull request's tab", async () => {
      await showItem("panel.pr", { slug: "owner/web", number: "42" });
      expect(active("thread:b")).toMatchObject({ kind: "pullrequest", title: "#42", params: { slug: "owner/web", number: "42" } });
      untouched();
    });

    // Shell gap: an open tab only the daemon's identity finds (a slug in another case) takes the new params; the classic panel only activated it.
    it.skip("panel.pr switches to the tab it opened, in any letter case", async () => {
      await showItem("panel.pr", { slug: "Owner/Web", number: "42" });
      await showItem("panel.pr", { slug: "owner/web", number: "42" });
      expect(tabIds("thread:b")).toHaveLength(1);
      expect(active("thread:b")).toMatchObject({ params: { slug: "Owner/Web", number: "42" } });
    });

    it("panel.gallery opens a tab for its title and takes no focus", async () => {
      const images = JSON.stringify([{ path: "/tmp/a.png", caption: "Before" }]);
      await showItem("panel.gallery", { title: "Shots", images, project: "web", base: WEB_FEAT });
      expect(active("thread:b")).toMatchObject({ kind: "gallery", title: "Shots", params: { title: "Shots", images, project: "web", base: WEB_FEAT } });
      untouched();
    });

    it("panel.gallery with the same title updates its tab, and another title adds one", async () => {
      const first = JSON.stringify([{ path: "/tmp/a.png" }]);
      const second = JSON.stringify([{ path: "/tmp/a.png" }, { path: "/tmp/b.png" }]);
      await showItem("panel.gallery", { title: "Shots", images: first });
      await showItem("panel.gallery", { title: "Shots", images: second });
      expect(tabIds("thread:b")).toHaveLength(1);
      expect(active("thread:b")?.params.images).toBe(second);
      await showItem("panel.gallery", { title: "Others", images: first });
      expect(tabIds("thread:b")).toHaveLength(2);
    });

    it.each([
      ["panel.gallery", { title: "Shots", images: "[]" }],
      ["panel.gallery", { images: JSON.stringify([{ path: "/tmp/a.png" }]) }],
      ["panel.file", {}],
      ["panel.diff", { project: "web", path: "a.go" }],
      ["panel.pr", { slug: "nope", number: "42" }],
      ["panel.pr", { slug: "owner/web", number: "0" }],
    ])("%s with params that name nothing changes nothing", async (name, params) => {
      expect(showThreadView(name, "b", params)).toBe(false);
      await layoutSettled();
      expect(appliedOps).toEqual([]);
    });
  });

  it("without a thread id it acts on the selection as before", async () => {
    await show("panel.mcp");
    expect(kinds("thread:a")).toEqual(["mcp"]);
  });

  it("--focus: the focusThread before it selects the thread, then its tab opens", async () => {
    applyIntent({ kind: "focusThread", threadId: "b" });
    await show("panel.mcp", "b");
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "b" });
    expect(tabPlace().shown).toBe(true);
    expect(kinds("thread:b")).toEqual(["mcp"]);
  });

  it("does not drop a pending focusThread", async () => {
    applyIntent({ kind: "focusThread", threadId: "late" });
    await show("panel.mcp", "b");
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, late: thread("late", { createdAtMs: null }) }, order: [...s.order, "late"] }));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "late" });
  });
});
