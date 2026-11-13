import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/daemonFakes")).ghFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));
// The cleanup dialog's dry run: the store's merged, clean worktrees (what the daemon's would list).
vi.mock("@/api/project", async (orig) => ({
  ...(await orig<typeof import("@/api/project")>()),
  previewCleanup: async (project: string) => {
    const { useProjectsStore } = await import("@/stores/projects");
    const ws = useProjectsStore.getState().byId[project]?.worktrees ?? [];
    return ws.filter((w) => w.mergedClean === true && !w.isMain).map((w) => ({ path: w.path, branch: w.branch, kind: "merged" as const, baseRef: "origin/main" }));
  },
}));
vi.mock("@/api/gitops", async (orig) => ({ ...(await orig<typeof import("@/api/gitops")>()), ...(await import("@/test/cardFakes")).cardGitopsFakes }));
const copyText = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/clipboard", () => ({ copyText }));

const { ConfirmDialog } = await import("@/components/confirm/ConfirmDialog");
const { RemoveWorktreeDialog } = await import("./RemoveWorktreeDialog");
const { CleanupWorktreesDialog } = await import("./CleanupWorktreesDialog");
const { ProjectsPage } = await import("./ProjectsPage");
const { confirmFirst, daemon, invocationsOf, lastInvocation, needsConfirm, resetDaemon } = await import("@/test/daemonFakes");
const { addLeftovers, addTerminal, addThreads, addWorktrees, fakeGitInit, panelActive, removeWorktrees, resetPanels, CF, COPY, FEAT, FIX, MERGED, SHADERS, SPIKE, menuEntries, seedWorld, status, texts, thread, updateProject, worktree } = await import("@/test/projectsWorld");
const { projectPage, useUiStore } = await import("@/stores/ui");
const { usePublishDialogStore } = await import("@/stores/publish");
const { useComposeStore } = await import("@/stores/compose");
const { useProjectsStore } = await import("@/stores/projects");
const { editorAppsResource } = await import("@/stores/threadInfo");
const { card } = await import("@/test/cardFakes");
const { hoverTooltipText, tooltipText } = await import("@/test/tooltip");

/**
 * A project's page (docs/notes/projects-redesign-1-index.md) and its Worktrees without threads
 * with the remove confirm (docs/notes/projects-redesign-2-leftovers.md, project-page-3-leftovers.md), against the mock's world
 * (src/test/projectsWorld.ts). What the daemon changes after a command (git init, a removal) is a
 * fake handler changing the store, and a tab a row opens is read off the fake daemon's layout
 * (panelActive). e2e/projects.spec.ts keeps what needs the browser: the narrow layout (real width),
 * the Changes tab drawn, scroll memory, and a CLI terminal and Resume over the stream.
 */

const page = () => screen.getByTestId("projects-page");
const list = () => screen.getByTestId("projects-list");
const checkout = (path: string) => document.querySelector<HTMLElement>(`[data-testid="project-worktree"][data-path="${path}"]`);
const checkoutRow = (path: string) => document.querySelector<HTMLElement>(`[data-nav-key="pw:repo-cf::${path}"]`) as HTMLElement;
const leftover = (path: string) => document.querySelector<HTMLElement>(`[data-testid="leftover-row"][data-path="${path}"]`);
const inEl = (el: HTMLElement | null, testId: string) => (el ? within(el).queryByTestId(testId) : null);
const selection = () => useUiStore.getState().selection;

function renderPage(projectId: string) {
  act(() => {
    useUiStore.getState().select(projectPage(projectId));
  });
  return render(
    <>
      <ProjectsPage />
      <ConfirmDialog />
      <RemoveWorktreeDialog />
      <CleanupWorktreesDialog />
    </>,
  );
}

/** Lets the GitHub and detail reads land (and a picked menu item run). */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** A checkout row's right-click menu. */
function openRowMenu(path: string): HTMLElement {
  fireEvent.contextMenu(checkoutRow(path));
  return screen.getByTestId("checkout-menu");
}

function openDropdown(trigger: HTMLElement, menuTestId: string): HTMLElement {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.getByTestId(menuTestId);
}

async function pick(menu: HTMLElement, testId: string) {
  fireEvent.click(within(menu).getByTestId(testId));
  await settle();
}

/** The daemon's project.worktree.remove: asks, then (for uncommitted work, without force) asks again with force. */
function fakeRemove() {
  daemon.handlers.set("project.worktree.remove", (inv) => {
    if (!inv.confirmed) throw needsConfirm({ command: inv.name, title: "Remove Worktree", message: `Remove worktree ${inv.args.path ?? ""}? This deletes files on disk.` });
    const w = useProjectsStore.getState().byId["repo-cf"]?.worktrees.find((x) => x.path === inv.args.path);
    if (w?.status.dirty && inv.args.force !== "true") throw needsConfirm({ command: inv.name, title: "Delete Uncommitted Work", message: "uncommitted work", args: { force: "true" } });
    // The daemon's worktreeRemoved event.
    removeWorktrees("repo-cf", inv.args.path ?? "");
    return { message: "", resultJson: "" };
  });
}

/** The daemon's project.worktree.cleanup once confirmed: removes the merged, clean worktrees no thread is on. */
function fakeCleanup(message: string) {
  confirmFirst("project.worktree.cleanup", message, (inv) => {
    const p = useProjectsStore.getState().byId[inv.args.project ?? ""];
    const gone = (p?.worktrees ?? []).filter((w) => w.mergedClean === true && !w.isMain).map((w) => w.path);
    removeWorktrees(inv.args.project ?? "", ...gone);
    return { message: "", resultJson: "" };
  });
}

/** The Projects index (the crumb), to read its pills. */
function toIndex() {
  fireEvent.click(screen.getByTestId("projects-crumb"));
}

/** The tab the project page opened last (its target's: the current space's unlinked tabs), off the layout. */
const pagePanel = (projectId = "repo-cf") => panelActive(`view:projects:project:${projectId}`);

beforeEach(async () => {
  resetDaemon();
  seedWorld();
  await resetPanels();
  usePublishDialogStore.setState({ open: false, projectId: "" });
  useComposeStore.setState({ drafts: {} });
  card.editors = [];
  editorAppsResource.store.setState({ entries: {} });
  copyText.mockClear();
});
afterEach(() => {
  cleanup();
});

describe("a project's page", () => {
  it("the title block, the checkouts table by activity, Details, and the sections in order", async () => {
    renderPage("repo-cf");
    await settle();
    expect(screen.getByTestId("page-name").textContent).toBe("code-foundry");
    const title = screen.getByTestId("project-title");
    expect(within(title).getByTestId("project-title-name").textContent).toBe("code-foundry");
    expect(within(title).getByTestId("project-meta").textContent).toBe("alexwaumann/code-foundry");
    expect(within(title).getByTestId("project-title-meta").textContent).toMatch(/^alexwaumann\/code-foundry·main \S+ \S+·refreshed (just now|\d+m ago)$/);
    expect(within(title).getByTestId("title-default-branch").querySelector("[data-checks]")).toBeTruthy();
    for (const id of ["project-refresh", "project-more"]) expect(within(title).getByTestId(id)).toBeTruthy();
    expect(screen.getByTestId("checkouts-title").textContent).toBe("Checkouts(3)· 2 threads working");
    expect(screen.getByTestId("checkouts-head").textContent).toMatch(/Branch\s*Threads\s*Changes\s*Sync\s*Pull request/);

    // Working first (main: s-1, feat/sidebar: s-5 starting), then the rest.
    expect(texts(document, "worktree-branch")).toHaveLength(3);
    expect(texts(document, "worktree-branch").at(-1)).toBe("fix/resize");
    expect(inEl(checkout(CF), "worktree-main-signal")).toBeTruthy();
    expect(inEl(checkout(FEAT), "worktree-main-signal")).toBeNull();
    // main: s-1 working, s-8 snoozed (idle); s-7 archived is left out.
    expect(inEl(checkout(CF), "worktree-threads")?.textContent).toBe("1 working · 1 idle");
    expect(inEl(checkout(FIX), "worktree-threads")?.textContent).toBe("1 idle");
    expect(inEl(checkout(FIX), "worktree-sync")?.textContent).toBe("1 behind");
    expect(inEl(checkout(CF), "worktree-sync")?.textContent).toBe("up to date");
    expect(inEl(checkout(CF), "worktree-changes-cell")?.textContent).toBe("clean");
    // Pull requests as tinted pills; none on main.
    expect(inEl(checkout(FEAT), "worktree-pr")?.textContent).toContain("#142");
    expect(inEl(checkout(FEAT), "worktree-pr")?.getAttribute("data-state")).toBe("open");
    expect(inEl(checkout(CF), "worktree-pr")).toBeNull();

    // Details.
    expect(screen.getByTestId("details-path-value").textContent).toBe("~/src/code-foundry");
    expect(screen.getByTestId("details-remote-value").textContent).toBe("origin · github.com/alexwaumann/code-foundry");
    expect(screen.getByTestId("details-worktrees-value").textContent).toBe("2 in ~/src/code-foundry.worktrees");
    // Worktrees without threads sits between Checkouts and Details; threads hold both worktrees here.
    expect([...list().children].map((c) => c.getAttribute("data-testid"))).toEqual(["project-title", "project-checkouts", "leftover-worktrees", "project-details"]);
    expect(screen.getByTestId("leftover-empty")).toBeTruthy();

    // A row has no click: no tab opens, the cursor stays put.
    fireEvent.click(checkoutRow(FIX));
    fireEvent.doubleClick(checkoutRow(FIX));
    expect(pagePanel()).toBeNull();
    expect(checkoutRow(FIX).getAttribute("aria-selected")).toBe("false");
    expect(page().getAttribute("data-project")).toBe("repo-cf");
  });

  it("the project page's list has the keyboard: End moves the cursor, Enter does nothing, Shift+F10 opens that row's menu", async () => {
    renderPage("repo-cf");
    await settle();
    expect(document.activeElement).toBe(list());
    fireEvent.keyDown(list(), { key: "End" });
    fireEvent.keyDown(list(), { key: "Enter" });
    expect(checkoutRow(FIX).getAttribute("aria-selected")).toBe("true");
    expect(pagePanel()).toBeNull();
    fireEvent.keyDown(list(), { key: "F10", shiftKey: true });
    expect(menuEntries(screen.getByTestId("checkout-menu"))).toContain("Open “Fix resize race”");
    fireEvent.keyDown(screen.getByTestId("checkout-menu"), { key: "Escape" });
    await settle();
    fireEvent.keyDown(list(), { key: "ContextMenu" });
    expect(screen.getByTestId("checkout-menu")).toBeTruthy();
  });

  it("a checkout row's menu: main has no Remove; Show changes opens its tab; Remove worktree asks in its dialog, then removes", async () => {
    fakeRemove();
    renderPage("repo-cf");
    await settle();
    // main: s-1 working and s-8 snoozed (s-7 archived is left out): the Open thread submenu; nothing to show; no actions (CheckoutsTable.test.tsx has Run action).
    let menu = openRowMenu(CF);
    expect(menuEntries(menu, true)).toEqual(["Open thread", "New thread here", "New terminal here", "—", "Open in Finder", "Copy path", "Copy branch name"]);
    expect(checkoutRow(CF).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(menu, { key: "Escape" });
    await settle();
    menu = openRowMenu(FEAT);
    expect(menuEntries(menu, true)).toEqual(["Open thread", "New thread here", "New terminal here", "—", "Show changes", "Open pull request #142", "—", "Open in Finder", "Copy path", "Copy branch name", "—", "Remove worktree"]);
    await pick(menu, "checkout-menu-changes");
    expect(pagePanel()).toEqual({ open: true, kind: "diff", title: "Diff · code-foundry", params: { project: "repo-cf", worktree: FEAT } });

    await pick(openRowMenu(FIX), "checkout-menu-remove");
    expect((await screen.findByTestId("remove-worktree-title")).textContent).toBe("Remove the worktree on fix/resize?");
    fireEvent.click(screen.getByTestId("remove-worktree-ok"));
    await settle();
    const removes = invocationsOf("project.worktree.remove");
    expect(removes.map((i) => i.confirmed)).toEqual([false, true]);
    expect(removes.at(-1)?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: FIX });
    // Once the daemon removed it: gone from the table and from Details' count.
    expect(checkout(FIX)).toBeNull();
    expect(screen.getByTestId("details-worktrees-value").textContent).toBe("1 in ~/src/code-foundry.worktrees");
  });

  it("the title block's ⋯: no New worktree, New action or Open in Finder; New terminal and New thread start in the project", async () => {
    renderPage("repo-cf");
    await settle();
    let menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(menuEntries(menu, true)).toEqual(["New thread", "New terminal", "—", "Rename", "Clean up merged worktrees 0", "—", "Remove project"]);
    await pick(menu, "project-menu-new-terminal");
    expect(lastInvocation("terminal.new")?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: CF });
    menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    await pick(menu, "project-menu-new-thread");
    expect(selection()).toEqual({ kind: "compose", projectId: "repo-cf" });
  });

  it("Details' path: Copy shows a check for a moment, no toast; Open in Finder reveals the main checkout, its ⋯ lists Finder, the editors and Terminal", async () => {
    card.editors = [{ bundleId: "com.microsoft.VSCode", name: "Visual Studio Code" }] as typeof card.editors;
    renderPage("repo-cf");
    await settle();
    const copy = screen.getByTestId("details-copy-path");
    expect(tooltipText(copy)).toBe("Copy path");
    vi.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.click(copy);
        await Promise.resolve();
      });
      expect(copyText).toHaveBeenCalledWith(CF);
      expect(copy.getAttribute("data-copied")).toBe("true");
      expect(document.querySelector("[data-sonner-toast]")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(copy.getAttribute("data-copied")).toBeNull();
    } finally {
      vi.useRealTimers();
    }

    fireEvent.click(screen.getByTestId("details-reveal"));
    await settle();
    expect(lastInvocation("worktree.reveal")).toMatchObject({ args: { worktree: CF }, context: { activeProjectId: "repo-cf", activeWorktreePath: CF } });
    expect(screen.getByTestId("details-reveal").textContent).toBe("Open in Finder");

    let menu = openDropdown(screen.getByTestId("details-open-in-more"), "details-open-in-menu");
    expect(menuEntries(menu, true)).toEqual(["Finder", "Visual Studio Code", "—", "Terminal"]);
    await pick(menu, "details-open-editor");
    expect(lastInvocation("worktree.open.editor")?.args).toEqual({ worktree: CF, app: "com.microsoft.VSCode" });
    menu = openDropdown(screen.getByTestId("details-open-in-more"), "details-open-in-menu");
    await pick(menu, "details-open-terminal");
    expect(lastInvocation("terminal.new")?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: CF });
  });

  it("kind variants: no remote (note, Publish, no Sync or PR), another remote (no PR), no git (note, Threads, no table)", async () => {
    fakeGitInit();
    const r = renderPage("repo-sk");
    await settle();
    expect(screen.getByTestId("project-meta").textContent).toBe("local only · no remote");
    // Not on GitHub: the default branch by name, no checks.
    expect(screen.getByTestId("title-default-branch").textContent).toBe("main");
    expect(screen.getByTestId("title-default-branch").querySelector("[data-checks]")).toBeNull();
    expect(screen.getByTestId("project-note").textContent).toContain("This repository has no remote. Threads can commit, but nothing can be pushed and there are no pull requests.");
    expect(screen.queryByTestId("checkouts-col-sync")).toBeNull();
    expect(screen.queryByTestId("checkouts-col-pr")).toBeNull();
    expect(screen.getByTestId("checkouts-title").textContent).toBe("Checkouts(1)");
    expect(screen.queryByTestId("details-remote")).toBeNull();
    fireEvent.click(screen.getByTestId("project-publish"));
    await settle();
    expect(usePublishDialogStore.getState()).toMatchObject({ open: true, projectId: "repo-sk" });
    const menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(menuEntries(menu)).toEqual(["New thread", "New terminal", "Rename", "Publish to GitHub", "Remove project"]);
    r.unmount();

    const d = renderPage("repo-dot");
    await settle();
    expect(screen.getByTestId("project-meta").textContent).toBe("origin · not GitHub");
    expect(screen.queryByTestId("project-note")).toBeNull();
    expect(screen.getAllByTestId("checkouts-col-sync")).toHaveLength(1);
    expect(screen.queryByTestId("checkouts-col-pr")).toBeNull();
    expect(screen.getByTestId("details-remote-value").textContent).toBe("origin · pull requests need GitHub");
    d.unmount();

    renderPage("repo-wr");
    await settle();
    expect(page().getAttribute("data-kind")).toBe("nogit");
    expect(screen.queryByTestId("worktree-branch")).toBeNull();
    expect(screen.getByTestId("project-meta").textContent).toBe("~/Documents/writing");
    // No git: the path alone on the meta line, no branch, no refresh.
    expect(screen.getByTestId("project-title-meta").textContent).toBe("~/Documents/writing");
    expect(screen.getByTestId("project-note").textContent).toContain("A plain folder, not a git repository.");
    expect(screen.queryByTestId("checkouts-table")).toBeNull();
    expect(screen.queryByTestId("project-refresh")).toBeNull();
    expect(screen.getByTestId("project-threads").textContent).toContain("No thread is working here. New thread or Terminal.");
    expect(screen.getByTestId("details-actions-value").textContent).toBe("none");
    expect(screen.getByTestId("details-add-action").textContent).toBe("Add action");
    fireEvent.click(screen.getByTestId("project-init-git"));
    await settle();
    const init = lastInvocation("project.git.init");
    expect(init?.args).toEqual({ project: "repo-wr" });
    expect(init?.context).toMatchObject({ activeProjectId: "repo-wr", activeView: "projects" });
    // Once the daemon made it a git repository without a remote: its checkout on main and the Publish note.
    expect(page().getAttribute("data-kind")).toBe("git");
    expect(screen.getByTestId("checkouts-table")).toBeTruthy();
    expect(texts(document, "worktree-branch")).toEqual(["main"]);
    expect(screen.getByTestId("project-note").textContent).toContain("no remote");
  });

  it("a project without git: the header menu's Initialize git runs project.git.init on it; then it is a git repository on main", async () => {
    fakeGitInit();
    renderPage("repo-wr");
    await settle();
    const menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(menuEntries(menu)).toContain("Initialize git");
    await pick(menu, "project-menu-init-git");
    expect(lastInvocation("project.git.init")?.context).toMatchObject({ activeProjectId: "repo-wr" });
    expect(page().getAttribute("data-kind")).toBe("git");
    expect(texts(document, "worktree-branch")).toEqual(["main"]);
  });

  it("Refresh fetches (with a remote) then refreshes, disabled and spinning meanwhile; without a remote only refreshes", async () => {
    let answer: () => void = () => undefined;
    daemon.handlers.set("git.fetch", () => new Promise((resolve) => (answer = () => { resolve({ message: "", resultJson: "" }); })));
    const r = renderPage("repo-cf");
    const refresh = screen.getByTestId<HTMLButtonElement>("project-refresh");
    fireEvent.click(refresh);
    await settle();
    expect(refresh.disabled).toBe(true);
    expect(refresh.querySelector("svg")?.getAttribute("class")).toMatch(/animate-spin/);
    answer();
    await settle();
    expect(refresh.disabled).toBe(false);
    expect(lastInvocation("git.fetch")?.args).toEqual({ worktree: CF });
    expect(daemon.invocations.map((i) => i.name).filter((n) => n === "git.fetch" || n === "project.refresh")).toEqual(["git.fetch", "project.refresh"]);
    expect(lastInvocation("project.refresh")?.args).toEqual({ project: "repo-cf" });
    r.unmount();

    renderPage("repo-sk");
    fireEvent.click(screen.getByTestId("project-refresh"));
    await settle();
    expect(invocationsOf("project.refresh")).toHaveLength(2);
    expect(invocationsOf("git.fetch")).toHaveLength(1);
  });

  it("a failed refresh turns the title block's refreshed part red with the error as its tooltip; everything else keeps the last known state", async () => {
    renderPage("repo-cf");
    await settle();
    expect(screen.getByTestId("project-refreshed").getAttribute("data-failed")).toBeNull();
    const fail = (error: string, ago: number) => {
      updateProject("repo-cf", (p) => ({ ...p, worktrees: p.worktrees.map((w) => (w.path === CF ? { ...w, status: { ...w.status, error, refreshedAtMs: Date.now() - ago } } : w)) }));
    };
    fail("could not reach origin", 870_000);
    const refreshed = screen.getByTestId("project-refreshed");
    expect(refreshed.textContent).toMatch(/^Refresh failed · 1[45]m ago$/);
    expect(refreshed.getAttribute("data-failed")).toBe("true");
    expect(await hoverTooltipText(refreshed)).toBe("could not reach origin");
    expect(texts(document, "worktree-branch")).toHaveLength(3);
    fail("", 0);
    expect(screen.getByTestId("project-refreshed").textContent).toBe("refreshed just now");
    expect(screen.getByTestId("project-refreshed").getAttribute("data-failed")).toBeNull();
  });
});

describe("Clean up merged worktrees", () => {
  it("the project menu counts the cleanable ones; a terminal open in one holds it", async () => {
    addWorktrees("repo-cf", worktree("repo-cf", MERGED, "cf/usage-polish", { managed: true, landed: true, mergedClean: true }));
    renderPage("repo-cf");
    await settle();
    let menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(within(menu).getByTestId("project-cleanup-count").textContent).toBe("1");
    fireEvent.keyDown(menu, { key: "Escape" });
    await settle();
    // Without threads it is in its own block, not the table.
    expect(leftover(MERGED)).not.toBeNull();
    expect(checkout(MERGED)).toBeNull();
    addTerminal("t-merged", "repo-cf", MERGED);
    expect(inEl(leftover(MERGED), "leftover-reason")?.textContent).toContain("a terminal is open in it");
    menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(within(menu).getByTestId("project-cleanup-count").textContent).toBe("0");
  });

  it("removes them after the daemon's confirm", async () => {
    addWorktrees(
      "repo-cf",
      worktree("repo-cf", MERGED, "cf/usage-polish", { managed: true, landed: true, mergedClean: true }),
      worktree("repo-cf", `${MERGED}-docs`, "cf/old-docs", { managed: true, landed: true, mergedClean: true }),
    );
    fakeCleanup("Remove 2 merged worktrees?");
    renderPage("repo-cf");
    await settle();
    const menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(menuEntries(menu)).toEqual(["New thread", "New terminal", "Rename", "Clean up merged worktrees 2", "Remove project"]);
    await pick(menu, "project-cleanup");
    const dialog = await screen.findByTestId("cleanup-dialog");
    expect(within(dialog).getAllByTestId("cleanup-branch").map((b) => b.textContent)).toEqual(["cf/usage-polish", "cf/old-docs"]);
    fireEvent.click(within(dialog).getByTestId("cleanup-ok"));
    await settle();
    expect(invocationsOf("project.worktree.cleanup").map((i) => i.confirmed)).toEqual([false, true]);
    expect(lastInvocation("project.worktree.cleanup")?.args).toEqual({ project: "repo-cf" });
    expect(texts(document, "worktree-branch")).toHaveLength(3);
    toIndex();
    await settle();
    expect(screen.queryByTestId("index-tidy")).toBeNull();
  });
});

describe("Worktrees without threads", () => {
  const leftoverRow = (path: string) => document.querySelector<HTMLElement>(`[data-nav-key="pw:repo-cf::${path}"]`) as HTMLElement;
  function openLeftoverMenu(path: string): HTMLElement {
    fireEvent.contextMenu(leftoverRow(path));
    return screen.getByTestId("leftover-menu");
  }

  it("a row per leftover: Branch | Why it stayed | icons; a worktree shows once; the three cleanable counts agree", async () => {
    addLeftovers(true);
    renderPage("repo-cf");
    await settle();
    const menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(within(menu).getByTestId("project-cleanup-count").textContent).toBe("1");
    fireEvent.keyDown(menu, { key: "Escape" });
    await settle();

    // The index's title grammar: the count, the hint, the bulk button at the right.
    expect(screen.getByTestId("leftover-title").textContent).toBe("Worktrees without threads(4)Remove the 1 that is clean");
    expect(screen.getByTestId("leftover-remove-clean").textContent).toBe("Remove the 1 that is clean");
    expect(screen.getByTestId("leftover-head").textContent).toBe("BranchWhy it stayed");
    // Threads hold feat/sidebar and fix/resize: not leftovers.
    expect(screen.getAllByTestId("leftover-row")).toHaveLength(4);
    expect(leftover(FEAT)).toBeNull();
    // A worktree shows once: the table keeps main and the two held ones.
    expect(screen.getByTestId("checkouts-title").textContent).toBe("Checkouts(3)· 2 threads working");
    expect(screen.getAllByTestId("project-worktree")).toHaveLength(3);
    for (const path of [CF, FEAT, FIX]) expect(checkout(path)).not.toBeNull();
    for (const path of [SPIKE, COPY, SHADERS, MERGED]) expect(checkout(path)).toBeNull();
    const rows: [string, string, string, boolean][] = [
      [SPIKE, "cf/perf-spike", "3 commits not on main · last thread archived 12d ago", true],
      [COPY, "cf/old-copy", "4 uncommitted files · merged otherwise · last thread archived 3w ago", true],
      [SHADERS, "exp/shaders", "made outside Code Foundry · clean · merged", false],
      [MERGED, "cf/usage-polish", "clean · merged", false],
    ];
    for (const [path, branch, reason, work] of rows) {
      const r = leftover(path);
      expect(inEl(r, "leftover-branch")?.textContent).toBe(branch);
      expect(inEl(r, "leftover-reason")?.textContent).toBe(reason);
      expect(inEl(r, "leftover-dot")?.className).toContain(work ? "bg-cf-warning" : "bg-cf-border-strong");
      // Holding work: Show diff (icon only), else its slot stays empty so the icons line up; Remove on every row.
      expect(inEl(r, "leftover-show-diff") !== null).toBe(work);
      expect(r?.lastElementChild?.children).toHaveLength(2);
      expect(inEl(r, "leftover-remove")?.textContent).toBe("");
      expect(inEl(r, "leftover-remove")?.getAttribute("aria-label")).toBe("Remove worktree");
      expect(r?.getAttribute("data-work")).toBe(work ? "true" : null);
    }
    // The icons' tooltips name them; the branch, on screen in full, has none.
    expect(tooltipText(inEl(leftover(COPY), "leftover-show-diff") as HTMLElement)).toBe("Show diff");
    expect(tooltipText(inEl(leftover(COPY), "leftover-remove") as HTMLElement)).toBe("Remove worktree");
    expect(inEl(leftover(COPY), "leftover-branch")?.hasAttribute("data-tip")).toBe(false);
    // Details counts the worktrees Code Foundry made.
    expect(screen.getByTestId("details-worktrees-value").textContent).toContain("6 · 3 made by Code Foundry");
    // Uncommitted files on a leftover show in its reason, and it holds work then.
    updateProject("repo-cf", (p) => ({ ...p, worktrees: p.worktrees.map((w) => (w.path === SHADERS ? { ...w, status: status({ upstream: "", baseRef: "origin/main", modified: 2, dirty: true }) } : w)) }));
    expect(inEl(leftover(SHADERS), "leftover-reason")?.textContent).toBe("made outside Code Foundry · 2 uncommitted files · merged otherwise");
    expect(inEl(leftover(SHADERS), "leftover-show-diff")).not.toBeNull();

    // A row has no click (it tints on hover): no tab opens, the cursor stays put. Show diff: the worktree's Changes tab, for this page.
    fireEvent.click(leftoverRow(COPY));
    fireEvent.doubleClick(leftoverRow(COPY));
    expect(pagePanel()).toBeNull();
    expect(leftoverRow(COPY).getAttribute("aria-selected")).toBe("false");
    expect(leftoverRow(COPY).className).toContain("hover:bg-cf-control-hover/50");
    fireEvent.click(inEl(leftover(COPY), "leftover-show-diff") as HTMLElement);
    await settle();
    expect(pagePanel()).toMatchObject({ open: true, kind: "diff", params: { project: "repo-cf", worktree: COPY } });
    expect(page().getAttribute("data-project")).toBe("repo-cf");
  });

  it("the right-click menu: Resume by the archived thread's name, Show changes while it holds work; the keyboard reaches it after the checkouts", async () => {
    addLeftovers(true);
    renderPage("repo-cf");
    await settle();
    let menu = openLeftoverMenu(SPIKE);
    expect(menuEntries(menu, true)).toEqual(["Resume “Profile the renderer”", "New thread here", "New terminal here", "—", "Show changes", "—", "Open in Finder", "Copy path", "Copy branch name", "—", "Remove worktree"]);
    // The row shows the cursor while its menu is open.
    expect(leftoverRow(SPIKE).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(menu, { key: "Escape" });
    await settle();
    // Clean, nothing archived on it: no Resume, no Show changes.
    menu = openLeftoverMenu(MERGED);
    expect(menuEntries(menu, true)).toEqual(["New thread here", "New terminal here", "—", "Open in Finder", "Copy path", "Copy branch name", "—", "Remove worktree"]);
    await pick(menu, "leftover-menu-new-thread");
    expect(selection()).toEqual({ kind: "compose", projectId: "repo-cf" });
    expect(useComposeStore.getState().drafts["repo-cf"]?.worktree).toEqual({ kind: "existing", path: MERGED });

    act(() => {
      useUiStore.getState().select(projectPage("repo-cf"));
    });
    await settle();
    await pick(openLeftoverMenu(COPY), "leftover-menu-changes");
    expect(pagePanel()).toMatchObject({ open: true, kind: "diff", params: { project: "repo-cf", worktree: COPY } });
    await pick(openLeftoverMenu(SPIKE), "leftover-menu-resume");
    const archive = lastInvocation("thread.archive");
    expect(archive?.args).toMatchObject({ archived: "false" });
    expect(archive?.context).toMatchObject({ activeThreadId: "s-lo-spike" });
    expect(selection()).toEqual({ kind: "thread", id: "s-lo-spike" });

    // The keyboard: the leftovers follow the checkouts on the page's list; Shift+F10 opens the cursor row's menu.
    act(() => {
      useUiStore.getState().select(projectPage("repo-cf"));
    });
    await settle();
    list().focus();
    fireEvent.keyDown(list(), { key: "End" });
    const last = [...document.querySelectorAll<HTMLElement>('[data-testid="leftover-row"]')].at(-1)?.getAttribute("data-path") ?? "";
    expect(leftoverRow(last).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list(), { key: "F10", shiftKey: true });
    expect(menuEntries(screen.getByTestId("leftover-menu"))).toContain("Remove worktree");
  });

  it("Remove: the confirm names what goes and what stays; with uncommitted files it warns and lists them; Cancel keeps; one yes removes", async () => {
    addLeftovers();
    fakeRemove();
    renderPage("repo-cf");
    await settle();
    expect(screen.queryByTestId("leftover-remove-clean")).toBeNull();

    // Dirty: the warning, the first three files and how many more; Show diff closes it.
    fireEvent.click(inEl(leftover(COPY), "leftover-remove") as HTMLElement);
    expect((await screen.findByTestId("remove-worktree-title")).textContent).toBe("Remove the worktree on cf/old-copy?");
    expect(screen.getByTestId("remove-worktree-body").textContent).toBe("~/.code-foundry/worktrees/alexwaumann/code-foundry/cf-old-copy goes. The branch cf/old-copy stays.");
    expect(screen.getByTestId("remove-worktree-loss-count").textContent).toBe("4 uncommitted files are lost.");
    await settle();
    expect(screen.getByTestId("remove-worktree-loss-files").textContent).toBe("gui/frontend/src/lib/tree.ts, docs/notes/sidebar.md, scratch.txt and 1 more · Show diff");
    fireEvent.click(screen.getByTestId("remove-worktree-show-diff"));
    await settle();
    expect(screen.queryByTestId("remove-worktree-dialog")).toBeNull();
    expect(invocationsOf("project.worktree.remove").map((i) => i.confirmed)).toEqual([false]);
    // ... and opens the worktree's Changes tab; the leftover stays.
    expect(pagePanel()).toMatchObject({ open: true, kind: "diff", params: { project: "repo-cf", worktree: COPY } });
    expect(leftover(COPY)).not.toBeNull();

    // Cancel keeps it.
    fireEvent.click(inEl(leftover(SPIKE), "leftover-remove") as HTMLElement);
    await screen.findByTestId("remove-worktree-dialog");
    expect(screen.queryByTestId("remove-worktree-loss")).toBeNull();
    fireEvent.click(screen.getByTestId("remove-worktree-cancel"));
    await settle();
    expect(screen.queryByTestId("remove-worktree-dialog")).toBeNull();
    expect(invocationsOf("project.worktree.remove").filter((i) => i.args.path === SPIKE).map((i) => i.confirmed)).toEqual([false]);

    // One yes removes the dirty one: the daemon's second question (force) is answered by it.
    fireEvent.click(inEl(leftover(COPY), "leftover-remove") as HTMLElement);
    fireEvent.click(await screen.findByTestId("remove-worktree-ok"));
    await settle();
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    const last = lastInvocation("project.worktree.remove");
    expect(last?.args).toEqual({ path: COPY, force: "true" });
    expect(last?.confirmed).toBe(true);
    // The daemon's removal: its row goes.
    expect(leftover(COPY)).toBeNull();

    // Clean, from the menu: no warning, no force.
    await pick(openLeftoverMenu(SHADERS), "leftover-menu-remove");
    expect((await screen.findByTestId("remove-worktree-title")).textContent).toBe("Remove the worktree on exp/shaders?");
    expect(screen.queryByTestId("remove-worktree-loss")).toBeNull();
    fireEvent.click(screen.getByTestId("remove-worktree-ok"));
    await settle();
    expect(lastInvocation("project.worktree.remove")?.args).toEqual({ path: SHADERS });
    expect(leftover(SHADERS)).toBeNull();
    expect(leftover(SPIKE)).not.toBeNull();
    expect(within(screen.getByTestId("leftover-title")).getByTestId("section-count").textContent).toBe("(1)");
  });

  it("Remove the N that are clean runs the cleanup after its confirm; with nothing kept the section says so in one line", async () => {
    addLeftovers(true);
    fakeCleanup("Remove the merged worktree cf/usage-polish?");
    const r = renderPage("repo-cf");
    await settle();
    fireEvent.click(screen.getByTestId("leftover-remove-clean"));
    const dialog = await screen.findByTestId("cleanup-dialog");
    expect(within(dialog).getAllByTestId("cleanup-branch").map((b) => b.textContent)).toEqual(["cf/usage-polish"]);
    fireEvent.click(within(dialog).getByTestId("cleanup-ok"));
    await settle();
    expect(lastInvocation("project.worktree.cleanup")?.args).toEqual({ project: "repo-cf" });
    expect(lastInvocation("project.worktree.cleanup")?.confirmed).toBe(true);
    expect(leftover(MERGED)).toBeNull();
    expect(screen.queryByTestId("leftover-remove-clean")).toBeNull();
    // Only the cleanable one goes: the others still hold something (or were made outside the app).
    expect(screen.getAllByTestId("leftover-row")).toHaveLength(3);
    toIndex();
    await settle();
    expect(screen.queryByTestId("index-tidy")).toBeNull();
    r.unmount();

    // ghostty-playground: nothing kept.
    renderPage("repo-gp");
    await settle();
    expect(screen.getByTestId("leftover-title").textContent).toBe("Worktrees without threads(0)");
    expect(screen.getByTestId("leftover-empty").textContent).toBe("Nothing kept. Every worktree here has a thread.");
    expect(screen.queryByTestId("leftover-table")).toBeNull();
    expect(screen.queryByTestId("leftover-remove-clean")).toBeNull();
  });
});

describe("renaming a project from its page", () => {
  it("refused names stay in the field, Escape keeps, Enter renames everywhere and gives the list the keyboard", async () => {
    daemon.handlers.set("project.rename", (inv) => {
      updateProject(inv.args.project ?? "", (p) => ({ ...p, name: inv.args.name ?? p.name }));
      return { message: "", resultJson: "" };
    });
    renderPage("repo-cf");
    await settle();
    const input = () => screen.getByTestId<HTMLInputElement>("project-name-input");
    const error = () => screen.getByTestId("project-name-error");
    await pick(openDropdown(screen.getByTestId("project-more"), "project-more-menu"), "project-menu-rename");
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("code-foundry");
    fireEvent.change(input(), { target: { value: "DOTFILES" } });
    expect(error().textContent).toBe("A project named “dotfiles” exists.");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toBeTruthy();
    fireEvent.change(input(), { target: { value: "web/site" } });
    expect(error().textContent).toBe("No / or , in a project name.");
    fireEvent.keyDown(input(), { key: "Escape" });
    await settle();
    expect(screen.getByTestId("page-name").textContent).toBe("code-foundry");
    expect(invocationsOf("project.rename")).toHaveLength(0);

    await pick(openDropdown(screen.getByTestId("project-more"), "project-more-menu"), "project-menu-rename");
    fireEvent.change(input(), { target: { value: "foundry" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => { r(null); }));
    });
    expect(document.activeElement).toBe(list());
    const done = invocationsOf("project.rename");
    expect(done).toHaveLength(1);
    expect(done[0]?.args).toEqual({ project: "repo-cf", name: "foundry" });
    expect(done[0]?.context).toMatchObject({ activeProjectId: "repo-cf" });
    expect(screen.getByTestId("page-name").textContent).toBe("foundry");
    // The index has the new name too.
    toIndex();
    expect(document.querySelector('[data-nav-key="p:repo-cf"]')?.textContent).toContain("foundry");
  });

  it("a rename from elsewhere shows on the open page", () => {
    renderPage("repo-gp");
    updateProject("repo-gp", (p) => ({ ...p, name: "playground" }));
    expect(screen.getByTestId("page-name").textContent).toBe("playground");
  });
});

describe("a project's page and its threads", () => {
  it("a thread starting on a leftover moves it to the table", async () => {
    addLeftovers();
    renderPage("repo-cf");
    await settle();
    addThreads(thread("s-new", { worktreePath: SPIKE, state: "connected", status: "busy" }));
    expect(leftover(SPIKE)).toBeNull();
    expect(checkout(SPIKE)).not.toBeNull();
    expect(within(screen.getByTestId("leftover-title")).getByTestId("section-count").textContent).toBe("(2)");
    expect(page().getAttribute("data-project")).toBe("repo-cf");
  });
});
