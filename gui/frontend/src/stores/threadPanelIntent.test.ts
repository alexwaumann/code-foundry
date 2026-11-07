import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView, WorktreeView } from "@/api/project";
import type { ThreadView } from "@/api/threads";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/api/app", () => ({ playAlertSound: vi.fn(() => Promise.resolve()) }));

const { applyIntent, clearPendingFocus } = await import("./intents");
const { getPanel, makeTab, usePanelStore } = await import("./panel");
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
const show = (name: string, threadId?: string) => {
  applyIntent(threadId ? { kind: "showView", name, threadId } : { kind: "showView", name });
};
const tabIds = (key: string) => getPanel(key).groups.flatMap((g) => g.tabs.map((t) => t.id));

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingFocus();
  usePanelStore.setState({ byKey: {} });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
  useProjectsStore.setState({ byId: { web }, order: ["web"] });
  useThreadsStore.setState({
    byId: { a: thread("a"), b: thread("b", { worktreePath: WEB_FEAT }), home: thread("home", { projectId: "", worktreePath: "/Users/me" }) },
    order: ["a", "b", "home"],
  });
  useUiStore.setState({ selection: inA, focus: "content", panelFocusSeq: 0, promptFocusSeq: 0 });
});

describe("a ShowView scoped to a thread", () => {
  it.each([["panel.mcp", "mcp"]])("%s opens the tab in that thread's panel and leaves the selection and focus alone", (name, tab) => {
    show(name, "b");
    expect(useUiStore.getState().selection).toEqual(inA);
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
    expect(getPanel("thread:b").open).toBe(true);
    expect(tabIds("thread:b")).toEqual([tab]);
    expect(getPanel("thread:a")).toEqual(getPanel("thread:never"));
  });

  it("on the selected thread shows the change at once, still without taking focus", () => {
    show("panel.mcp", "a");
    expect(getPanel().open).toBe(true);
    expect(tabIds("thread:a")).toEqual(["mcp"]);
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
    expect(useUiStore.getState().focus).toBe("content");
  });

  it("is there when the user opens the thread", () => {
    show("panel.mcp", "b");
    useUiStore.getState().select({ kind: "thread", id: "b" });
    expect(getPanel().open).toBe(true);
    expect(tabIds("thread:b")).toEqual(["mcp"]);
  });

  it("applies while the settings page is up, which stays", () => {
    useViewsStore.setState({ settingsOpen: true });
    show("panel.mcp", "b");
    expect(getPanel("thread:b").open).toBe(true);
    expect(useViewsStore.getState().settingsOpen).toBe(true);
  });

  it("the removed surfaces' names change nothing and say nothing", () => {
    for (const name of ["panel.worktree", "panel.linked-prs", "panel.agents", "panel.usage", "panel.threads"]) expect(showThreadView(name, "b")).toBe(false);
    expect(usePanelStore.getState().byKey).toEqual({});
    expect(toast).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("a thread the window does not know, or a name that is no panel action, changes nothing", () => {
    expect(showThreadView("panel.mcp", "zz")).toBe(false);
    expect(showThreadView("settings", "b")).toBe(false);
    show("settings", "b");
    show("dashboard", "b");
    expect(useViewsStore.getState().settingsOpen).toBe(false);
    expect(useUiStore.getState().selection).toEqual(inA);
    expect(usePanelStore.getState().byKey).toEqual({});
  });

  describe("the panel actions", () => {
    const file = makeTab("files", "a.go", { path: "/src/web/a.go" });
    const mcp = makeTab("mcp", "MCP");
    beforeEach(() => {
      usePanelStore.setState({ byKey: { "thread:b": { open: false, groups: [{ tabs: [file, mcp], activeTabId: file.id }] } } });
    });

    it("panel.toggle shows, then hides the thread's panel", () => {
      show("panel.toggle", "b");
      expect(getPanel("thread:b").open).toBe(true);
      show("panel.toggle", "b");
      expect(getPanel("thread:b").open).toBe(false);
    });

    it("panel.expand shows a hidden panel expanded, then restores the split", () => {
      show("panel.expand", "b");
      expect(getPanel("thread:b")).toMatchObject({ open: true, expanded: true });
      show("panel.expand", "b");
      expect(getPanel("thread:b").expanded).toBeUndefined();
    });

    it("panel.new-tab shows the surface list", () => {
      show("panel.new-tab", "b");
      expect(getPanel("thread:b")).toMatchObject({ open: true, groups: [{ activeTabId: null, pickFrom: file.id }] });
    });

    it("panel.split splits a hidden panel, shown; then joins it", () => {
      show("panel.split", "b");
      expect(getPanel("thread:b").open).toBe(true);
      expect(getPanel("thread:b").groups).toHaveLength(2);
      show("panel.split", "b");
      expect(getPanel("thread:b").groups).toHaveLength(1);
    });

    it("none of them moves the selection, focus or another thread's panel", () => {
      for (const name of ["panel.toggle", "panel.expand", "panel.new-tab", "panel.split"]) show(name, "b");
      expect(useUiStore.getState().selection).toEqual(inA);
      expect(useUiStore.getState().panelFocusSeq).toBe(0);
      expect(Object.keys(usePanelStore.getState().byKey)).toEqual(["thread:b"]);
    });
  });

  describe("the item actions (view.panel.file, diff, pr)", () => {
    const showItem = (name: string, params: Record<string, string>) => {
      applyIntent({ kind: "showView", name, threadId: "b", params });
    };
    const active = (key: string) => {
      const g = getPanel(key).groups[0];
      return g?.tabs.find((t) => t.id === g.activeTabId);
    };
    const untouched = () => {
      expect(useUiStore.getState().selection).toEqual(inA);
      expect(useUiStore.getState().panelFocusSeq).toBe(0);
      expect(getPanel("thread:a")).toEqual(getPanel("thread:never"));
    };

    it("panel.file opens the file's tab at its line in the thread's panel", () => {
      showItem("panel.file", { path: `${WEB_FEAT}/src/main.go`, line: "12", project: "web", base: WEB_FEAT });
      expect(getPanel("thread:b").open).toBe(true);
      expect(active("thread:b")).toMatchObject({ kind: "files", title: "main.go", params: { path: `${WEB_FEAT}/src/main.go`, line: "12", project: "web", base: WEB_FEAT } });
      untouched();
    });

    it("panel.file with page=1 (view.panel.page) opens the file as the thread's page, titled", () => {
      showItem("panel.file", { path: `${WEB_FEAT}/welcome.html`, project: "web", base: WEB_FEAT, page: "1", title: "Welcome" });
      expect(active("thread:b")).toMatchObject({ kind: "files", title: "Welcome", params: { path: `${WEB_FEAT}/welcome.html`, page: "1", title: "Welcome" } });
      untouched();
    });

    describe("a thread's request to edit a file (--edit)", () => {
      const ENV = `${WEB_FEAT}/.env`;
      const ask = { path: ENV, project: "web", base: WEB_FEAT, edit: "1", thread: "b" };
      const params = () => getPanel("thread:b").groups[0]?.tabs[0]?.params;

      it("opens the tab editing, with who asked and what they said, and takes no focus", () => {
        const before = document.activeElement;
        showItem("panel.file", { ...ask, note: "Put the key on line 2", line: "2" });
        expect(params()).toMatchObject({ edit: "1", asker: "b", note: "Put the key on line 2", line: "2" });
        expect(useUiStore.getState().selection).toEqual(inA);
        expect(useUiStore.getState().panelFocusSeq).toBe(0);
        expect(useUiStore.getState().promptFocusSeq).toBe(0);
        expect(document.activeElement).toBe(before);
      });

      it("two requests are two, the same note or not", () => {
        showItem("panel.file", { ...ask, note: "Same" });
        const first = params()?.askId;
        showItem("panel.file", { ...ask, note: "Same" });
        expect(first).toBeTruthy();
        expect(params()?.askId).not.toBe(first);
      });

      it("a plain open has none of it", () => {
        showItem("panel.file", { path: ENV, project: "web", base: WEB_FEAT });
        expect(params()).toEqual({ path: ENV, project: "web", base: WEB_FEAT });
      });

      it("with --focus the editor takes the keyboard at the end of the line, once it is there", () => {
        showItem("panel.file", { ...ask, line: "2", focus: "1" });
        const key = fileEditKey("thread:b", fileTab({ project: "web", base: WEB_FEAT, path: ENV }).id);
        const focus = vi.fn();
        noteEditor(key, { focus, caret: () => null });
        expect(focus).toHaveBeenCalledTimes(1);
      });

      // Its own file: an editor noted for one tab stays noted, and would answer in place of this one.
      it("without it the editor takes nothing", () => {
        const path = `${WEB_FEAT}/no-focus.env`;
        showItem("panel.file", { ...ask, path, line: "2" });
        const key = fileEditKey("thread:b", fileTab({ project: "web", base: WEB_FEAT, path }).id);
        const focus = vi.fn();
        noteEditor(key, { focus, caret: () => null });
        expect(focus).not.toHaveBeenCalled();
      });

      describe("with the user typing in an editor of that group", () => {
        const A = `${WEB_FEAT}/a.env`;
        const a = fileTab({ project: "web", base: WEB_FEAT, path: A });
        const b = fileTab({ project: "web", base: WEB_FEAT, path: ENV });
        const aKey = fileEditKey("thread:b", a.id);
        let wrap: HTMLElement;

        beforeEach(async () => {
          usePanelStore.setState({ byKey: { "thread:b": { open: true, groups: [{ tabs: [a], activeTabId: a.id }] } } });
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

        it("a request joins the strip behind it", () => {
          showItem("panel.file", ask);
          const g = getPanel("thread:b").groups[0];
          expect(g?.activeTabId).toBe(a.id);
          expect(g?.tabs.map((t) => t.id)).toEqual([a.id, b.id]);
          expect(g?.tabs[1]?.params).toMatchObject({ asker: "b", edit: "1" });
        });

        it("a repeat request updates its tab there", () => {
          showItem("panel.file", ask);
          showItem("panel.file", { ...ask, note: "Second" });
          const g = getPanel("thread:b").groups[0];
          expect(g?.activeTabId).toBe(a.id);
          expect(g?.tabs[1]?.params.note).toBe("Second");
        });

        it("--focus goes to it: the user asked to be taken there", () => {
          showItem("panel.file", { ...ask, focus: "1" });
          expect(getPanel("thread:b").groups[0]?.activeTabId).toBe(b.id);
        });

        it("a plain open behaves as it always has", () => {
          showItem("panel.file", { path: ENV, project: "web", base: WEB_FEAT });
          expect(getPanel("thread:b").groups[0]?.activeTabId).toBe(b.id);
        });

        it("in the other group it opens as usual: that group's screen is not the user's", () => {
          usePanelStore.setState({ byKey: { "thread:b": { open: true, focused: 1, groups: [{ tabs: [a], activeTabId: a.id }, { tabs: [], activeTabId: null }] } } });
          showItem("panel.file", ask);
          expect(getPanel("thread:b").groups[1]?.activeTabId).toBe(b.id);
          expect(getPanel("thread:b").groups[0]?.activeTabId).toBe(a.id);
        });
      });
    });

    it("panel.file again moves the open tab to the new line", () => {
      showItem("panel.file", { path: `${WEB_FEAT}/a.html`, project: "web", base: WEB_FEAT });
      showItem("panel.file", { path: `${WEB_FEAT}/a.html`, line: "3", project: "web", base: WEB_FEAT });
      expect(tabIds("thread:b")).toHaveLength(1);
      expect(active("thread:b")?.params.line).toBe("3");
    });

    it.each([
      ["working", { project: "web", worktree: WEB_FEAT, path: "src/main.go", scope: "working" }],
      ["branch", { project: "web", worktree: WEB_FEAT, path: "src/main.go", scope: "branch" }],
    ])("panel.diff opens the file's Diff tab (%s)", (scope, params) => {
      showItem("panel.diff", params);
      expect(active("thread:b")).toMatchObject({ kind: "diff", title: "main.go", params: { project: "web", worktree: WEB_FEAT, path: "src/main.go", scope } });
      untouched();
    });

    it("panel.pr opens the pull request's tab", () => {
      showItem("panel.pr", { slug: "owner/web", number: "42" });
      expect(active("thread:b")).toMatchObject({ kind: "pullrequest", title: "#42", params: { slug: "owner/web", number: "42" } });
      untouched();
    });

    it("panel.pr switches to the tab it opened, in any letter case", () => {
      showItem("panel.pr", { slug: "Owner/Web", number: "42" });
      showItem("panel.pr", { slug: "owner/web", number: "42" });
      expect(usePanelStore.getState().byKey["thread:b"]?.groups[0]?.tabs).toHaveLength(1);
      expect(active("thread:b")).toMatchObject({ params: { slug: "Owner/Web", number: "42" } });
    });

    it("panel.gallery opens a tab for its title and takes no focus", () => {
      const images = JSON.stringify([{ path: "/tmp/a.png", caption: "Before" }]);
      showItem("panel.gallery", { title: "Shots", images, project: "web", base: WEB_FEAT });
      expect(active("thread:b")).toMatchObject({ kind: "gallery", title: "Shots", params: { title: "Shots", images, project: "web", base: WEB_FEAT } });
      untouched();
    });

    it("panel.gallery with the same title updates its tab, and another title adds one", () => {
      const first = JSON.stringify([{ path: "/tmp/a.png" }]);
      const second = JSON.stringify([{ path: "/tmp/a.png" }, { path: "/tmp/b.png" }]);
      showItem("panel.gallery", { title: "Shots", images: first });
      showItem("panel.gallery", { title: "Shots", images: second });
      expect(tabIds("thread:b")).toHaveLength(1);
      expect(active("thread:b")?.params.images).toBe(second);
      showItem("panel.gallery", { title: "Others", images: first });
      expect(tabIds("thread:b")).toHaveLength(2);
    });

    it.each([
      ["panel.gallery", { title: "Shots", images: "[]" }],
      ["panel.gallery", { images: JSON.stringify([{ path: "/tmp/a.png" }]) }],
      ["panel.file", {}],
      ["panel.diff", { project: "web", path: "a.go" }],
      ["panel.pr", { slug: "nope", number: "42" }],
      ["panel.pr", { slug: "owner/web", number: "0" }],
    ])("%s with params that name nothing changes nothing", (name, params) => {
      expect(showThreadView(name, "b", params)).toBe(false);
      expect(usePanelStore.getState().byKey).toEqual({});
    });
  });

  it("without a thread id it acts on the selection as before, and takes focus", () => {
    show("panel.mcp");
    expect(tabIds("thread:a")).toEqual(["mcp"]);
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
  });

  it("--focus: the focusThread before it selects the thread, then its panel opens", () => {
    applyIntent({ kind: "focusThread", threadId: "b" });
    show("panel.mcp", "b");
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "b" });
    expect(getPanel().open).toBe(true);
    expect(tabIds("thread:b")).toEqual(["mcp"]);
  });

  it("does not drop a pending focusThread", () => {
    applyIntent({ kind: "focusThread", threadId: "late" });
    show("panel.mcp", "b");
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, late: thread("late", { createdAtMs: null }) }, order: [...s.order, "late"] }));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "late" });
  });
});
