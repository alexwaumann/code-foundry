import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/daemonFakes")).ghFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));

const { ConfirmDialog } = await import("@/components/confirm/ConfirmDialog");
const { RemoveWorktreeDialog } = await import("./RemoveWorktreeDialog");
const { ProjectsPage } = await import("./ProjectsPage");
const { confirmFirst, daemon, invocationsOf, lastInvocation, needsConfirm, resetDaemon } = await import("@/test/daemonFakes");
const { addLeftovers, addTerminal, addThreads, addWorktrees, removeWorktrees, CF, COPY, FEAT, FIX, MERGED, SHADERS, SPIKE, menuEntries, seedWorld, status, texts, thread, updateProject, worktree } = await import("@/test/projectsWorld");
const { projectPage, useUiStore } = await import("@/stores/ui");
const { usePublishDialogStore } = await import("@/stores/publish");
const { useComposeStore } = await import("@/stores/compose");
const { useProjectsStore } = await import("@/stores/projects");

/**
 * A project's page (docs/notes/projects-redesign-1-index.md) and its Worktrees without threads
 * with the remove confirm (docs/notes/projects-redesign-2-leftovers.md), against the mock's world
 * (src/test/projectsWorld.ts). e2e/projects.spec.ts keeps what needs the browser or the daemon:
 * the narrow layout (real width), the Changes tab a row opens in the page's side panel, scroll
 * memory, and what the daemon changes after a command (git init, a removal, a CLI terminal).
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
    </>,
  );
}

/** Lets the GitHub and detail reads land (and a picked menu item run). */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
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

beforeEach(() => {
  resetDaemon();
  seedWorld();
  usePublishDialogStore.setState({ open: false, projectId: "" });
  useComposeStore.setState({ drafts: {} });
});
afterEach(() => {
  cleanup();
});

describe("a project's page", () => {
  it("the header, the checkouts table by activity, Details, and the sections in order", async () => {
    renderPage("repo-cf");
    await settle();
    expect(screen.getByTestId("page-name").textContent).toBe("code-foundry");
    expect(screen.getByTestId("project-meta").textContent).toBe("alexwaumann/code-foundry");
    for (const id of ["project-refresh", "project-terminal", "project-new-thread", "project-more"]) expect(screen.getByTestId(id)).toBeTruthy();
    expect(screen.getByTestId("project-terminal").textContent).toBe("Terminal");
    expect(screen.getByTestId("checkouts-title").textContent).toContain("main plus 2 worktrees · 2 threads working");
    expect(screen.getByTestId("checkouts-head").textContent).toMatch(/Branch\s*Threads\s*Changes\s*Sync\s*Pull request/);

    // Working first (main: s-1, feat/sidebar: s-5 starting), then the rest.
    expect(texts(document, "worktree-branch")).toHaveLength(3);
    expect(texts(document, "worktree-branch").at(-1)).toBe("fix/resize");
    expect(inEl(checkout(CF), "worktree-main-tag")?.textContent).toBe("main");
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
    expect(screen.getByTestId("details-path").textContent).toContain("~/src/code-foundry");
    expect(screen.getByTestId("details-default-branch").textContent).toContain("main");
    expect(screen.getByTestId("details-refreshed").textContent).toMatch(/^refreshed (just now|\d+m ago)$/);
    expect(screen.getByTestId("details-remote").textContent).toContain("origin · github.com/alexwaumann/code-foundry");
    expect(screen.getByTestId("details-worktrees").textContent).toContain("~/src/code-foundry.worktrees · 2");
    expect(screen.queryByText("Show in sidebar")).toBeNull();
    // Worktrees without threads sits between Checkouts and Details; threads hold both worktrees here.
    expect([...list().children].map((c) => c.getAttribute("data-testid"))).toEqual(["project-checkouts", "leftover-worktrees", "project-details"]);
    expect(screen.getByTestId("leftover-empty")).toBeTruthy();
  });

  it("a checkout row's menu: main has no Remove; Open in Finder reveals it; Remove worktree asks in its dialog, then removes", async () => {
    fakeRemove();
    renderPage("repo-cf");
    await settle();
    let menu = openDropdown(within(checkoutRow(CF)).getByTestId("worktree-more"), "worktree-more-menu");
    expect(menuEntries(menu)).toEqual(["New thread here", "New terminal here", "Show changes", "Open in Finder", "Copy path"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await settle();
    menu = openDropdown(within(checkoutRow(FEAT)).getByTestId("worktree-more"), "worktree-more-menu");
    expect(menuEntries(menu)).toEqual(["New thread here", "New terminal here", "Show changes", "Open pull request #142", "Open in Finder", "Copy path", "Remove worktree"]);
    await pick(menu, "worktree-reveal");
    expect(lastInvocation("worktree.reveal")?.args).toEqual({ worktree: FEAT });

    await pick(openDropdown(within(checkoutRow(FIX)).getByTestId("worktree-more"), "worktree-more-menu"), "worktree-remove");
    expect((await screen.findByTestId("remove-worktree-title")).textContent).toBe("Remove the worktree on fix/resize?");
    fireEvent.click(screen.getByTestId("remove-worktree-ok"));
    await settle();
    const removes = invocationsOf("project.worktree.remove");
    expect(removes.map((i) => i.confirmed)).toEqual([false, true]);
    expect(removes.at(-1)?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: FIX });
  });

  it("the header's menu has no New worktree; New thread and Terminal start in the project", async () => {
    renderPage("repo-cf");
    await settle();
    const menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(menuEntries(menu)).toEqual(["New action", "New thread", "New terminal", "Open in Finder", "Rename", "Clean up merged worktrees 0", "Remove project"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await settle();
    fireEvent.click(screen.getByTestId("project-terminal"));
    await settle();
    expect(lastInvocation("terminal.new")?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: CF });
    fireEvent.click(screen.getByTestId("project-new-thread"));
    expect(selection()).toEqual({ kind: "compose", projectId: "repo-cf" });
  });

  it("kind variants: no remote (note, Publish, no Sync or PR), another remote (no PR), no git (note, Threads, no table)", async () => {
    const r = renderPage("repo-sk");
    await settle();
    expect(screen.getByTestId("project-meta").textContent).toBe("local only · no remote");
    expect(screen.getByTestId("project-note").textContent).toContain("This repository has no remote. Threads can commit, but nothing can be pushed and there are no pull requests.");
    expect(screen.queryByTestId("checkouts-col-sync")).toBeNull();
    expect(screen.queryByTestId("checkouts-col-pr")).toBeNull();
    expect(screen.getByTestId("checkouts-title").textContent).toContain("main only");
    expect(screen.queryByTestId("details-remote")).toBeNull();
    fireEvent.click(screen.getByTestId("project-publish"));
    await settle();
    expect(usePublishDialogStore.getState()).toMatchObject({ open: true, projectId: "repo-sk" });
    const menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(menuEntries(menu)).toEqual(["New action", "New thread", "New terminal", "Open in Finder", "Rename", "Publish to GitHub", "Remove project"]);
    r.unmount();

    const d = renderPage("repo-dot");
    await settle();
    expect(screen.getByTestId("project-meta").textContent).toBe("origin · not GitHub");
    expect(screen.queryByTestId("project-note")).toBeNull();
    expect(screen.getAllByTestId("checkouts-col-sync")).toHaveLength(1);
    expect(screen.queryByTestId("checkouts-col-pr")).toBeNull();
    expect(screen.getByTestId("details-remote").textContent).toContain("origin · pull requests need GitHub");
    d.unmount();

    renderPage("repo-wr");
    await settle();
    expect(screen.getByTestId("project-meta").textContent).toBe("~/Documents/writing");
    expect(screen.getByTestId("project-note").textContent).toContain("A plain folder, not a git repository.");
    expect(screen.queryByTestId("checkouts-table")).toBeNull();
    expect(screen.queryByTestId("project-refresh")).toBeNull();
    expect(screen.getByTestId("project-threads").textContent).toContain("No thread is working here. New thread or Terminal.");
    expect(screen.queryByTestId("details-default-branch")).toBeNull();
    expect(screen.getByTestId("details-actions").textContent).toMatch(/none\s*·\s*Add an action/);
    fireEvent.click(screen.getByTestId("project-init-git"));
    await settle();
    const init = lastInvocation("project.git.init");
    expect(init?.args).toEqual({ project: "repo-wr" });
    expect(init?.context).toMatchObject({ activeProjectId: "repo-wr", activeView: "projects" });
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

  it("a failed refresh shows in the header and Details; everything else keeps the last known state", async () => {
    renderPage("repo-cf");
    await settle();
    expect(screen.queryByTestId("project-refresh-failed")).toBeNull();
    const fail = (error: string, ago: number) => {
      updateProject("repo-cf", (p) => ({ ...p, worktrees: p.worktrees.map((w) => (w.path === CF ? { ...w, status: { ...w.status, error, refreshedAtMs: Date.now() - ago } } : w)) }));
    };
    fail("could not reach origin", 870_000);
    expect(screen.getByTestId("project-refresh-failed").textContent).toMatch(/^Refresh failed · could not reach origin· 1[45]m ago$/);
    expect(screen.getByTestId("details-refreshed").textContent).toMatch(/^refresh failed 1[45]m ago$/);
    expect(screen.getByTestId("details-refreshed").getAttribute("data-failed")).toBe("true");
    expect(texts(document, "worktree-branch")).toHaveLength(3);
    fail("", 0);
    expect(screen.queryByTestId("project-refresh-failed")).toBeNull();
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
    fakeCleanup("Fetch, then remove 2 worktrees whose branches are merged: cf/usage-polish, cf/old-docs?");
    renderPage("repo-cf");
    await settle();
    const menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(menuEntries(menu)).toEqual(["New action", "New thread", "New terminal", "Open in Finder", "Rename", "Clean up merged worktrees 2", "Remove project"]);
    await pick(menu, "project-cleanup");
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("Fetch, then remove 2 worktrees");
    fireEvent.click(within(dialog).getByTestId("confirm-ok"));
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
  it("a row per leftover with why it stayed and its actions; a worktree shows once; the three cleanable counts agree", async () => {
    addLeftovers(true);
    renderPage("repo-cf");
    await settle();
    const menu = openDropdown(screen.getByTestId("project-more"), "project-more-menu");
    expect(within(menu).getByTestId("project-cleanup-count").textContent).toBe("1");
    fireEvent.keyDown(menu, { key: "Escape" });
    await settle();

    expect(screen.getByTestId("leftover-title").textContent).toMatch(/Worktrees without threads\s*· 4 kept/);
    expect(screen.getByTestId("leftover-remove-clean").textContent).toBe("Remove the 1 that is clean");
    // Threads hold feat/sidebar and fix/resize: not leftovers.
    expect(screen.getAllByTestId("leftover-row")).toHaveLength(4);
    expect(leftover(FEAT)).toBeNull();
    // A worktree shows once: the table keeps main and the two held ones, the caption counts all seven.
    expect(screen.getByTestId("checkouts-title").textContent).toContain("main plus 6 worktrees · 2 threads working");
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
      // Holding work: Show diff and Resume; clean: New thread. Remove… on every row.
      expect(inEl(r, "leftover-show-diff") !== null).toBe(work);
      expect(inEl(r, "leftover-resume") !== null).toBe(work);
      expect(inEl(r, "leftover-new-thread") !== null).toBe(!work);
      expect(inEl(r, "leftover-remove")?.textContent).toBe("Remove…");
      expect(r?.getAttribute("data-work")).toBe(work ? "true" : null);
    }
    expect(screen.getByTestId("leftover-footer").textContent).toBe(
      "Worktrees made for a thread go on their own once its last thread is archived and the work is on main. These stayed because they still hold something.",
    );
    // Details counts the worktrees Code Foundry made.
    expect(screen.getByTestId("details-worktrees").textContent).toContain("6, 3 made by Code Foundry");
    // Uncommitted files on a leftover show in its reason.
    updateProject("repo-cf", (p) => ({ ...p, worktrees: p.worktrees.map((w) => (w.path === SHADERS ? { ...w, status: status({ upstream: "", baseRef: "origin/main", modified: 2, dirty: true }) } : w)) }));
    expect(inEl(leftover(SHADERS), "leftover-reason")?.textContent).toBe("made outside Code Foundry · 2 uncommitted files · merged otherwise");
  });

  it("New thread on a clean one and Resume without an archived thread open the composer in that checkout; Resume with one unarchives and shows it", async () => {
    addLeftovers(true);
    renderPage("repo-cf");
    await settle();
    fireEvent.click(inEl(leftover(MERGED), "leftover-new-thread") as HTMLElement);
    expect(selection()).toEqual({ kind: "compose", projectId: "repo-cf" });
    expect(useComposeStore.getState().drafts["repo-cf"]?.worktree).toEqual({ kind: "existing", path: MERGED });

    act(() => {
      useUiStore.getState().select(projectPage("repo-cf"));
    });
    await settle();
    fireEvent.click(inEl(leftover(SPIKE), "leftover-resume") as HTMLElement);
    await settle();
    const archive = lastInvocation("thread.archive");
    expect(archive?.args).toMatchObject({ archived: "false" });
    expect(archive?.context).toMatchObject({ activeThreadId: "s-lo-spike" });
    expect(selection()).toEqual({ kind: "thread", id: "s-lo-spike" });

    // Resume with no archived thread there (exp/shaders, once it holds uncommitted files).
    updateProject("repo-cf", (p) => ({ ...p, worktrees: p.worktrees.map((w) => (w.path === SHADERS ? { ...w, status: status({ upstream: "", baseRef: "origin/main", modified: 2, dirty: true }) } : w)) }));
    act(() => {
      useUiStore.getState().select(projectPage("repo-cf"));
    });
    await settle();
    fireEvent.click(inEl(leftover(SHADERS), "leftover-resume") as HTMLElement);
    expect(selection()).toEqual({ kind: "compose", projectId: "repo-cf" });
    expect(useComposeStore.getState().drafts["repo-cf"]?.worktree).toEqual({ kind: "existing", path: SHADERS });
  });

  it("Remove…: the confirm names what goes and what stays; with uncommitted files it warns and lists them; Cancel keeps; one yes removes", async () => {
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

    // Clean: no warning, no force.
    fireEvent.click(inEl(leftover(SHADERS), "leftover-remove") as HTMLElement);
    expect((await screen.findByTestId("remove-worktree-title")).textContent).toBe("Remove the worktree on exp/shaders?");
    expect(screen.queryByTestId("remove-worktree-loss")).toBeNull();
    fireEvent.click(screen.getByTestId("remove-worktree-ok"));
    await settle();
    expect(lastInvocation("project.worktree.remove")?.args).toEqual({ path: SHADERS });
  });

  it("Remove the N that are clean runs the cleanup after its confirm; with nothing kept the section says so", async () => {
    addLeftovers(true);
    fakeCleanup("Fetch, then remove 1 worktree whose branch is merged: cf/usage-polish?");
    const r = renderPage("repo-cf");
    await settle();
    fireEvent.click(screen.getByTestId("leftover-remove-clean"));
    fireEvent.click(within(await screen.findByTestId("confirm-dialog")).getByTestId("confirm-ok"));
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
    expect(screen.getByTestId("leftover-title").textContent).toBe("Worktrees without threads");
    expect(screen.getByTestId("leftover-empty").textContent).toBe("Nothing kept. Worktrees made for a thread go on their own once its last thread is archived and the work is on main.");
    expect(screen.queryByTestId("leftover-footer")).toBeNull();
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
    expect(screen.getByTestId("leftover-title").textContent).toContain("2 kept");
    expect(page().getAttribute("data-project")).toBe("repo-cf");
  });
});
