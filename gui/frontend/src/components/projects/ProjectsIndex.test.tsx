import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/daemonFakes")).ghFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));

const { ConfirmDialog } = await import("@/components/confirm/ConfirmDialog");
const { ProjectsPage } = await import("./ProjectsPage");
const { confirmFirst, daemon, invocationsOf, lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { addLeftovers, addThreads, addWorkspace, CF, fakeGitInit, MERGED, menuEntries, removeProject, removeWorkspace, seedWorld, texts, thread, updateProject, updateWorkspace } = await import("@/test/projectsWorld");
const { useUiStore } = await import("@/stores/ui");
const { useAddProjectStore } = await import("@/stores/addProject");
const { usePublishDialogStore } = await import("@/stores/publish");
const { useNewWorkspaceDialogStore } = await import("@/stores/workspaceActions");
const { useWorkspaceAddProjectStore } = await import("@/stores/workspaceAddProject");

/**
 * The Projects index (docs/notes/projects-redesign-1-index.md, docs/notes/projects-table-1-index.md,
 * docs/notes/projects-table-2-context-menus.md) against the mock's world (src/test/projectsWorld.ts).
 * What only a browser shows stays in e2e/projects.spec.ts: the columns narrowing with the width, and
 * a CLI terminal holding a worktree. Initialize git's result is a fake handler (fakeGitInit).
 */

const row = (key: string) => document.querySelector<HTMLElement>(`[data-nav-key="${key}"]`);
const projectRow = (id: string) => row(`p:${id}`) as HTMLElement;
const wsRow = (id: string) => row(`ws:${id}`) as HTMLElement;
const indexIds = () => [...document.querySelectorAll('[data-testid="index-project"]')].map((e) => e.getAttribute("data-project"));
const page = () => screen.getByTestId("projects-page");
const list = () => screen.getByTestId("projects-list");
const filter = () => screen.getByTestId<HTMLInputElement>("projects-filter");
const inRow = (el: HTMLElement, testId: string) => within(el).queryByTestId(testId);
const selection = () => useUiStore.getState().selection;

function renderIndex() {
  return render(
    <>
      <ProjectsPage />
      <ConfirmDialog />
    </>,
  );
}

/** Lets the GitHub reads the rows watch land (and a picked menu item run). */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Right-clicks the row: its context menu. */
function openRowMenu(el: HTMLElement, testId: string): HTMLElement {
  fireEvent.contextMenu(el);
  return screen.getByTestId(testId);
}

/** Picks a menu item; the item runs once the menu has closed. */
async function pick(menu: HTMLElement, testId: string) {
  fireEvent.click(within(menu).getByTestId(testId));
  await settle();
}

/** Opens a dropdown (a header's ⋯, the picker): Radix opens on a primary pointer down. */
function openDropdown(trigger: HTMLElement, menuTestId: string): HTMLElement {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.getByTestId(menuTestId);
}

/** A thread in a workspace on its branch, as POST /__mock/workspace-thread makes it. */
function workspaceThread(id: string, ws: { id: string; members: { projectId: string }[] }, o: Parameters<typeof thread>[1] = {}) {
  const ids = ws.members.map((m) => m.projectId);
  return thread(id, { workspaceId: ws.id, projectIds: ids, createdWorktree: true, ...o });
}

beforeEach(() => {
  resetDaemon();
  seedWorld();
  useAddProjectStore.setState({ open: false });
  usePublishDialogStore.setState({ open: false, projectId: "" });
  useNewWorkspaceDialogStore.setState({ open: false });
  useWorkspaceAddProjectStore.setState({ addingTo: null });
});
afterEach(() => {
  cleanup();
});

describe("the index's project rows", () => {
  it("a row per project by last activity, its kind, status sentence, pills, setup links and age", async () => {
    // sketches gets the newest thread; writing has none, so it goes last.
    addThreads(thread("s-sk", { projectId: "repo-sk", worktreePath: "/Users/dev/src/sketches", state: "connected", status: "busy", createdAtMs: Date.now() + 1 }));
    renderIndex();
    await settle();
    const ids = indexIds();
    expect(ids).toHaveLength(5);
    expect(ids[0]).toBe("repo-sk");
    expect(ids.at(-1)).toBe("repo-wr");
    // ghostty-playground's latest thread is older than code-foundry's and dotfiles'.
    expect(ids.indexOf("repo-gp")).toBeGreaterThan(ids.indexOf("repo-cf"));
    expect(ids.indexOf("repo-gp")).toBeGreaterThan(ids.indexOf("repo-dot"));

    // The section titles count their rows; the header row names the columns.
    expect(within(screen.getByTestId("projects-section")).getByTestId("index-section-count").textContent).toBe("(5)");
    expect([...within(screen.getByTestId("projects-table")).getByTestId("index-columns").querySelectorAll("span")].map((s) => s.textContent)).toEqual(["Project", "Activity", "Default branch", "Needs a look", "Updated"]);
    const kinds: [string, string, string, string][] = [
      ["repo-cf", "github", "code-foundry", "2 threads working · 3 checkouts"],
      ["repo-dot", "git", "dotfiles", "idle · main only"],
      ["repo-sk", "git", "sketches", "1 thread working · main only"],
      ["repo-wr", "nogit", "writing", "idle"],
    ];
    for (const [id, kind, name, sentence] of kinds) {
      const r = projectRow(id);
      expect(inRow(r, "index-project")?.getAttribute("data-kind")).toBe(kind);
      expect(inRow(r, "project-kind-icon")?.getAttribute("data-kind")).toBe(kind);
      expect(inRow(r, "project-name")?.textContent).toBe(name);
      expect(inRow(r, "project-status")?.textContent).toBe(sentence);
    }
    // Green dot only while a thread works.
    expect(projectRow("repo-cf").querySelectorAll("[data-live]")).toHaveLength(1);
    expect(projectRow("repo-dot").querySelectorAll("[data-live]")).toHaveLength(0);
    // Pills only for what needs a look: code-foundry's open pull requests (a draft counts).
    expect(inRow(projectRow("repo-cf"), "index-prs")?.textContent).toBe("2 PRs");
    expect(screen.getAllByTestId("index-prs")).toHaveLength(1);
    expect(screen.queryByTestId("index-tidy")).toBeNull();
    // Setup links: Publish on the repository without a remote, Initialize git on the folder.
    expect(screen.getAllByTestId("index-publish")).toHaveLength(1);
    expect(inRow(projectRow("repo-sk"), "index-publish")?.textContent).toBe("Publish to GitHub");
    expect(inRow(projectRow("repo-wr"), "index-init-git")?.textContent).toBe("Initialize git");
    // Ages: a thread's, none for a project without threads.
    expect(inRow(projectRow("repo-sk"), "index-age")?.textContent).toBe("now");
    expect(inRow(projectRow("repo-wr"), "index-age")?.textContent).toBe("");
    // No hover actions or chevron: the row opens the page.
    for (const id of ["project-new-thread", "project-new-terminal", "project-more"]) expect(inRow(projectRow("repo-gp"), id)).toBeNull();
    expect(projectRow("repo-gp").querySelector("svg.lucide-chevron-right")).toBeNull();
  });

  it("the setup links act without opening the page; a click opens the project's page", async () => {
    fakeGitInit();
    renderIndex();
    await settle();
    fireEvent.click(inRow(projectRow("repo-sk"), "index-publish") as HTMLElement);
    await settle();
    expect(usePublishDialogStore.getState()).toMatchObject({ open: true, projectId: "repo-sk" });
    fireEvent.click(inRow(projectRow("repo-wr"), "index-init-git") as HTMLElement);
    await settle();
    expect(lastInvocation("project.git.init")?.args).toEqual({ project: "repo-wr" });
    expect(page().getAttribute("data-page")).toBe("index");
    // Once the daemon says so, the folder is a git repository without a remote: Publish, not Initialize git.
    expect(inRow(projectRow("repo-wr"), "index-project")?.getAttribute("data-kind")).toBe("git");
    expect(inRow(projectRow("repo-wr"), "project-kind-icon")?.getAttribute("data-kind")).toBe("git");
    expect(inRow(projectRow("repo-wr"), "index-init-git")).toBeNull();
    expect(inRow(projectRow("repo-wr"), "index-publish")?.textContent).toBe("Publish to GitHub");

    fireEvent.click(projectRow("repo-gp"));
    expect(page().getAttribute("data-project")).toBe("repo-gp");
  });

  it("Default branch: the branch and its checks on GitHub, a click on failing checks opens the first failed one, — elsewhere", async () => {
    renderIndex();
    await settle();
    const cell = (id: string) => inRow(projectRow(id), "index-default-branch") as HTMLElement;
    expect(inRow(cell("repo-cf"), "index-default-branch-name")?.textContent).toBe("main");
    expect(cell("repo-cf").querySelector("[data-checks]")?.getAttribute("data-checks")).toBe("failure");
    expect(inRow(cell("repo-cf"), "index-checks")?.textContent).toBe("2/16 failing");
    expect(cell("repo-gp").querySelector("[data-checks]")?.getAttribute("data-checks")).toBe("success");
    expect(inRow(cell("repo-gp"), "index-checks")?.textContent).toBe("10/10 passed");
    // Not on GitHub, no remote, no git: a dash.
    for (const id of ["repo-dot", "repo-sk", "repo-wr"]) expect(cell(id).textContent).toBe("—");

    // Failing checks open the first failed check's page, and the row stays put.
    fireEvent.click(inRow(cell("repo-cf"), "index-checks") as HTMLElement);
    await settle();
    expect(lastInvocation("view.open.url")?.args).toEqual({ url: "https://ci.example.com/job/code-foundry/main/812/" });
    expect(page().getAttribute("data-page")).toBe("index");
    // Passing checks open nothing: a click there opens the project's page like the rest of the row.
    fireEvent.click(inRow(cell("repo-gp"), "index-checks") as HTMLElement);
    expect(page().getAttribute("data-project")).toBe("repo-gp");
    expect(invocationsOf("view.open.url")).toHaveLength(1);
  });

  it("worktrees to tidy: the pill counts the cleanable ones", async () => {
    addLeftovers(true);
    renderIndex();
    await settle();
    expect(inRow(projectRow("repo-cf"), "index-tidy")?.textContent).toBe("1 worktree to tidy");
    // A thread on it holds it: nothing to tidy.
    addThreads(thread("s-on-merged", { worktreePath: MERGED }));
    expect(screen.queryByTestId("index-tidy")).toBeNull();
  });
});

describe("the index's header, sections and empty state", () => {
  it("the pane header holds the filter and toggles; Add project and Add workspace sit on their section titles", async () => {
    renderIndex();
    const header = page().querySelector(":scope > header") as HTMLElement;
    expect(within(header).queryAllByRole("button", { name: /Add|New workspace/ })).toHaveLength(0);
    expect(within(header).getByTestId("projects-filter")).toBeTruthy();
    const add = within(screen.getByTestId("projects-section")).getByTestId("projects-register");
    expect(add.textContent).toBe("Add project");
    fireEvent.click(add);
    await settle();
    expect(useAddProjectStore.getState()).toMatchObject({ open: true, tab: "local" });
    // No workspaces yet: the hint names the button.
    const ws = screen.getByTestId("workspaces-section");
    expect(within(ws).getByTestId("workspaces-empty").textContent).toBe("None yet: Add workspace, or code-foundry workspace new.");
    const addWs = within(ws).getByTestId("projects-new-workspace");
    expect(addWs.textContent).toBe("Add workspace");
    fireEvent.click(addWs);
    await settle();
    expect(useNewWorkspaceDialogStore.getState().open).toBe(true);
  });

  it("an empty install: No projects yet with the three ways to add one", async () => {
    seedWorld({ empty: true });
    renderIndex();
    const empty = screen.getByTestId("projects-empty");
    expect(empty.textContent).toContain("No projects yet");
    expect(empty.textContent).toContain("or code-foundry project add ~/src/app");
    const cases: [string, string][] = [
      ["projects-empty-github", "github"],
      ["projects-empty-local", "local"],
      ["projects-empty-new", "new"],
    ];
    for (const [testId, tab] of cases) {
      useAddProjectStore.setState({ open: false });
      fireEvent.click(within(empty).getByTestId(testId));
      await settle();
      expect(useAddProjectStore.getState()).toMatchObject({ open: true, tab });
    }
  });
});

describe("the index's workspace rows", () => {
  it("name, status, projects, contents; a click opens the workspace's page", async () => {
    const ws = addWorkspace("platform", ["repo-cf", "repo-gp"], { skills: ["a", "b"] });
    addThreads(workspaceThread("s-driver", ws, { projectId: "repo-gp", worktreePath: "/wt/gp/cf-platform", name: "driver", state: "connected", status: "busy", branch: "cf/platform" }));
    renderIndex();
    await settle();
    const r = wsRow(ws.id);
    expect(inRow(r, "workspace-name")?.textContent).toBe("platform");
    expect([...within(screen.getByTestId("workspaces-table")).getByTestId("index-columns").querySelectorAll("span")].map((s) => s.textContent)).toEqual(["Workspace", "Activity", "Projects", "Contents", "Updated"]);
    expect(within(screen.getByTestId("workspaces-section")).getByTestId("index-section-count").textContent).toBe("(1)");
    expect(inRow(r, "workspace-projects")?.textContent).toBe("code-foundry + ghostty-playground");
    expect(inRow(r, "workspace-status")?.textContent).toMatch(/^1 thread working/);
    expect(inRow(r, "workspace-contents")?.textContent).toBe("no instructions · 2 skills");
    fireEvent.click(r);
    expect(page().getAttribute("data-page")).toBe("workspace");
    expect(page().getAttribute("data-workspace")).toBe(ws.id);
    expect(screen.getByTestId("page-name").textContent).toBe("platform");
    expect(screen.getByTestId("workspace-meta").textContent).toBe("workspace · 2 projects");
    expect(document.querySelector(`[data-testid="workspace"][data-workspace="${ws.id}"]`)).not.toBeNull();
    // The crumb goes back to the index.
    fireEvent.click(screen.getByTestId("projects-crumb"));
    expect(page().getAttribute("data-page")).toBe("index");
  });

  it("without threads, by name; the contents read from the same fields", () => {
    const shop = addWorkspace("shop", ["repo-gp", "repo-cf"]);
    const mono = addWorkspace("mono", ["repo-dot"], { root: "/Users/dev/mono", instructions: "CLAUDE.md", skills: ["release", "demo"] });
    renderIndex();
    expect(texts(document, "workspace-name")).toEqual(["mono", "shop"]);
    expect(inRow(wsRow(shop.id), "workspace-contents")?.textContent).toBe("no instructions · no skills");
    expect(inRow(wsRow(mono.id), "workspace-contents")?.textContent).toBe("CLAUDE.md · 2 skills");
  });
});

describe("the index's filter and keyboard", () => {
  it("/ focuses the filter; it matches branches, slugs, tildified paths and workspaces; says when nothing matches; Escape clears it", () => {
    addWorkspace("login", ["repo-cf", "repo-gp"]);
    renderIndex();
    list().focus();
    fireEvent.keyDown(list(), { key: "/" });
    expect(document.activeElement).toBe(filter());

    // A branch: the project with it, as a whole row; no workspace matches.
    fireEvent.change(filter(), { target: { value: "RESIZE" } });
    expect(screen.getAllByTestId("index-project")).toHaveLength(1);
    expect(texts(document, "project-name")).toEqual(["code-foundry"]);
    expect(screen.queryByTestId("workspaces-section")).toBeNull();
    // A slug, a tildified path, a workspace by its name.
    fireEvent.change(filter(), { target: { value: "alexwaumann/ghostty" } });
    expect(texts(document, "project-name")).toEqual(["ghostty-playground"]);
    fireEvent.change(filter(), { target: { value: "~/documents" } });
    expect(texts(document, "project-name")).toEqual(["writing"]);
    fireEvent.change(filter(), { target: { value: "logi" } });
    expect(screen.queryAllByTestId("index-project")).toHaveLength(0);
    expect(screen.getAllByTestId("index-workspace")).toHaveLength(1);
    fireEvent.change(filter(), { target: { value: "zig" } });
    expect(screen.getByTestId("projects-no-matches").textContent).toBe("Nothing matches “zig”. The filter looks at names, GitHub slugs, branches and paths.");

    // Escape clears it and gives the list the keyboard.
    fireEvent.keyDown(filter(), { key: "Escape" });
    expect(filter().value).toBe("");
    expect(document.activeElement).toBe(list());
    expect(screen.getAllByTestId("index-project")).toHaveLength(5);
  });

  it("matches a workspace by a member project's name", () => {
    addWorkspace("shop", ["repo-gp", "repo-cf"]);
    addWorkspace("mono", ["repo-dot"], { root: "/Users/dev/mono" });
    renderIndex();
    fireEvent.change(filter(), { target: { value: "ghostty" } });
    expect(texts(document, "workspace-name")).toEqual(["shop"]);
    fireEvent.change(filter(), { target: { value: "" } });
    expect(screen.getAllByTestId("index-workspace")).toHaveLength(2);
  });

  it("the list has the keyboard: ↑/↓ move the cursor over projects then workspaces, Enter opens the page", () => {
    const ws = addWorkspace("login", ["repo-cf"]);
    renderIndex();
    expect(document.activeElement).toBe(list());
    const ids = indexIds();
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(projectRow(ids[0] ?? "").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(projectRow(ids[1] ?? "").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list(), { key: "End" });
    expect(wsRow(ws.id).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list(), { key: "Home" });
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    fireEvent.keyDown(list(), { key: "Enter" });
    expect(page().getAttribute("data-project")).toBe(ids[1]);
    // The project page's list has the keyboard.
    expect(document.activeElement).toBe(list());
  });
});

describe("the page picker", () => {
  it("projects by activity, then workspaces, then Add project; picking switches the page", async () => {
    const ws = addWorkspace("platform", ["repo-cf", "repo-gp"]);
    renderIndex();
    await settle();
    const order = indexIds();
    fireEvent.click(projectRow("repo-cf"));
    const menu = openDropdown(screen.getByTestId("page-picker"), "page-picker-menu");
    expect([...menu.querySelectorAll('[data-testid="page-picker-project"]')].map((e) => e.getAttribute("data-project"))).toEqual(order);
    expect(menu.querySelector('[data-current="true"]')?.getAttribute("data-project")).toBe("repo-cf");
    expect(within(menu).getByTestId("page-picker-workspace").textContent).toMatch(/platform/);
    expect(within(menu).getByTestId("page-picker-add-project").textContent).toBe("Add project");
    fireEvent.click(menu.querySelector('[data-project="repo-dot"]') as HTMLElement);
    await settle();
    expect(page().getAttribute("data-project")).toBe("repo-dot");
    expect(document.activeElement).toBe(list());
    fireEvent.click(within(openDropdown(screen.getByTestId("page-picker"), "page-picker-menu")).getByTestId("page-picker-workspace"));
    await settle();
    expect(page().getAttribute("data-workspace")).toBe(ws.id);
    fireEvent.click(within(openDropdown(screen.getByTestId("page-picker"), "page-picker-menu")).getByTestId("page-picker-add-project"));
    await settle();
    expect(useAddProjectStore.getState().open).toBe(true);
    // The crumb goes back to the index.
    fireEvent.click(screen.getByTestId("projects-crumb"));
    expect(page().getAttribute("data-page")).toBe("index");
  });
});

describe("a project row's context menu", () => {
  it("its items per kind, text only, the cursor on the row", async () => {
    renderIndex();
    await settle();
    const want: [string, string[]][] = [
      ["repo-cf", ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Clean up merged worktrees 0", "—", "Remove project"]],
      ["repo-dot", ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Clean up merged worktrees 0", "—", "Remove project"]],
      ["repo-sk", ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Publish to GitHub", "—", "Remove project"]],
      ["repo-wr", ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Initialize git", "—", "Remove project"]],
    ];
    for (const [id, items] of want) {
      const menu = openRowMenu(projectRow(id), "project-row-menu");
      expect(menuEntries(menu, true), id).toEqual(items);
      expect(menu.querySelectorAll("svg")).toHaveLength(0);
      expect(projectRow(id).getAttribute("aria-selected")).toBe("true");
      fireEvent.keyDown(menu, { key: "Escape" });
      await settle();
      expect(screen.queryByTestId("project-row-menu")).toBeNull();
    }
    // Nothing to clean up: disabled. Remove is destructive.
    const menu = openRowMenu(projectRow("repo-cf"), "project-row-menu");
    expect(within(menu).getByTestId("project-cleanup").hasAttribute("data-disabled")).toBe(true);
    expect(within(menu).getByTestId("project-unregister").getAttribute("data-variant")).toBe("destructive");
  });

  it("Open in Finder reveals the main checkout and New terminal opens a shell there, the index staying; New thread opens the composer", async () => {
    renderIndex();
    await settle();
    await pick(openRowMenu(projectRow("repo-cf"), "project-row-menu"), "project-menu-reveal");
    expect(lastInvocation("worktree.reveal")?.args).toEqual({ worktree: CF });
    expect(page().getAttribute("data-page")).toBe("index");

    await pick(openRowMenu(projectRow("repo-cf"), "project-row-menu"), "project-menu-new-terminal");
    expect(lastInvocation("terminal.new")?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: CF });

    await pick(openRowMenu(projectRow("repo-gp"), "project-row-menu"), "project-menu-new-thread");
    expect(selection()).toEqual({ kind: "compose", projectId: "repo-gp" });
  });

  it("Rename edits the name in place: a taken name is refused, Escape keeps, Enter renames and the list gets the keyboard back", async () => {
    daemon.handlers.set("project.rename", (inv) => {
      updateProject(inv.args.project ?? "", (p) => ({ ...p, name: inv.args.name ?? p.name }));
      return { message: "", resultJson: "" };
    });
    renderIndex();
    await settle();
    await pick(openRowMenu(projectRow("repo-gp"), "project-row-menu"), "project-menu-rename");
    const input = () => within(projectRow("repo-gp")).getByTestId<HTMLInputElement>("project-name-input");
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("ghostty-playground");
    fireEvent.change(input(), { target: { value: "code-foundry" } });
    expect(inRow(projectRow("repo-gp"), "project-name-error")?.textContent).toBe("A project named “code-foundry” exists.");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(inRow(projectRow("repo-gp"), "project-name")?.textContent).toBe("ghostty-playground");
    // Still the index: the field's keys and clicks are its own, not the row's.
    expect(page().getAttribute("data-page")).toBe("index");

    await pick(openRowMenu(projectRow("repo-gp"), "project-row-menu"), "project-menu-rename");
    fireEvent.click(input());
    expect(page().getAttribute("data-page")).toBe("index");
    fireEvent.change(input(), { target: { value: "playground" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await settle();
    expect(inRow(projectRow("repo-gp"), "project-name")?.textContent).toBe("playground");
    expect(document.activeElement).toBe(list());
    expect(page().getAttribute("data-page")).toBe("index");
    expect(invocationsOf("project.rename").map((i) => i.args)).toEqual([{ project: "repo-gp", name: "playground" }]);
  });

  it("Remove project asks first: Escape keeps it, a yes removes it", async () => {
    confirmFirst("project.unregister", "Stop tracking project repo-wr?", (inv) => {
      removeProject(inv.context.activeProjectId);
      return { message: "", resultJson: "" };
    });
    renderIndex();
    await settle();
    await pick(openRowMenu(projectRow("repo-wr"), "project-row-menu"), "project-unregister");
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("Stop tracking project repo-wr?");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await settle();
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(projectRow("repo-wr")).not.toBeNull();

    await pick(openRowMenu(projectRow("repo-wr"), "project-row-menu"), "project-unregister");
    fireEvent.click(within(await screen.findByTestId("confirm-dialog")).getByTestId("confirm-ok"));
    await settle();
    expect(invocationsOf("project.unregister").map((i) => i.confirmed)).toEqual([false, false, true]);
    expect(lastInvocation("project.unregister")?.context).toMatchObject({ activeProjectId: "repo-wr" });
    expect(row("p:repo-wr")).toBeNull();
  });

  it("the cleanup count follows the cleanable worktrees", async () => {
    addLeftovers(true);
    renderIndex();
    await settle();
    const menu = openRowMenu(projectRow("repo-cf"), "project-row-menu");
    expect(within(menu).getByTestId("project-cleanup-count").textContent).toBe("1");
    expect(within(menu).getByTestId("project-cleanup").hasAttribute("data-disabled")).toBe(false);
  });
});

describe("a workspace row's context menu", () => {
  it("its items, text only; New terminal in the workspace's folder; Rename in place; Add project on its page; Remove asks first", async () => {
    const shop = addWorkspace("shop", ["repo-gp", "repo-cf"]);
    daemon.handlers.set("workspace.rename", (inv) => {
      updateWorkspace(shop.id, (w) => ({ ...w, name: inv.args.name ?? w.name }));
      return { message: "", resultJson: "" };
    });
    confirmFirst("workspace.remove", "Remove workspace store? Its instructions and skills are deleted too.", () => {
      removeWorkspace(shop.id);
      return { message: "", resultJson: "" };
    });
    renderIndex();
    await settle();
    const menu = openRowMenu(wsRow(shop.id), "workspace-row-menu");
    expect(menuEntries(menu, true)).toEqual(["New thread", "New terminal", "Open in Finder", "—", "Rename", "Add project", "—", "Remove workspace"]);
    expect(menu.querySelectorAll("svg")).toHaveLength(0);
    expect(within(menu).getByTestId("workspace-menu-remove").getAttribute("data-variant")).toBe("destructive");

    // New terminal: in the workspace's own folder, owned by a member's main checkout.
    await pick(menu, "workspace-menu-new-terminal");
    const term = lastInvocation("terminal.new");
    expect(term?.args.cwd).toBe(`/Users/dev/.code-foundry/workspaces/${shop.id}`);
    expect(term?.context.activeWorktreePath).toBeTruthy();

    // Rename in place.
    await pick(openRowMenu(wsRow(shop.id), "workspace-row-menu"), "workspace-menu-rename");
    const input = within(wsRow(shop.id)).getByTestId<HTMLInputElement>("workspace-name-input");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "store" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();
    expect(lastInvocation("workspace.rename")?.args).toEqual({ name: "store", workspace: shop.id });
    expect(inRow(wsRow(shop.id), "workspace-name")?.textContent).toBe("store");
    expect(page().getAttribute("data-page")).toBe("index");

    // Add project: the workspace's page with its Add project list open.
    await pick(openRowMenu(wsRow(shop.id), "workspace-row-menu"), "workspace-menu-add-project");
    expect(page().getAttribute("data-page")).toBe("workspace");
    expect(page().getAttribute("data-workspace")).toBe(shop.id);
    expect(useWorkspaceAddProjectStore.getState().addingTo).toBe(shop.id);
    fireEvent.click(screen.getByTestId("projects-crumb"));

    // Remove workspace asks first.
    await pick(openRowMenu(wsRow(shop.id), "workspace-row-menu"), "workspace-menu-remove");
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("Remove workspace store?");
    fireEvent.click(within(dialog).getByTestId("confirm-ok"));
    await settle();
    expect(invocationsOf("workspace.remove").map((i) => i.confirmed)).toEqual([false, true]);
    expect(row(`ws:${shop.id}`)).toBeNull();
  });

  it("a workspace with no registered member has no New terminal (nothing to own the shell)", async () => {
    const ws = addWorkspace("sk", ["repo-sk"]);
    removeProject("repo-sk");
    renderIndex();
    await settle();
    const menu = openRowMenu(wsRow(ws.id), "workspace-row-menu");
    expect(menuEntries(menu, true)).toEqual(["New thread", "Open in Finder", "—", "Rename", "Add project", "—", "Remove workspace"]);
  });
});
