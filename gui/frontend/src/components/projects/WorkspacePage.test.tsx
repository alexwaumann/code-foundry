import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/daemonFakes")).ghFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));

const { ConfirmDialog } = await import("@/components/confirm/ConfirmDialog");
const { NewWorkspaceDialog } = await import("./NewWorkspaceDialog");
const { ProjectsPage } = await import("./ProjectsPage");
const { confirmFirst, daemon, invocationsOf, lastInvocation, refuse, resetDaemon } = await import("@/test/daemonFakes");
const { addThreads, addWorkspace, addWorktrees, menuEntries, removeProject, seedWorld, status, texts, thread, updateProject, updateWorkspace, worktree } = await import("@/test/projectsWorld");
const { useUiStore, workspacePage } = await import("@/stores/ui");
const { openNewWorkspaceDialog, resetInstructionsPresses, useNewWorkspaceDialogStore } = await import("@/stores/workspaceActions");
const { useWorkspaceAddProjectStore } = await import("@/stores/workspaceAddProject");
const { useWorkspacesStore } = await import("@/stores/workspaces");
const { useViewsStore } = await import("@/stores/views");
const { useProjectsStore } = await import("@/stores/projects");

/**
 * A workspace's page (docs/notes/projects-redesign-3-workspace-page.md) and the New workspace
 * dialog, against the mock's world (src/test/projectsWorld.ts). e2e/workspace-page.spec.ts keeps
 * the hover-only actions (CSS), the File and Changes tabs the page's panel opens, and what the
 * daemon changes after a command.
 */

const body = (id: string) => document.querySelector<HTMLElement>(`[data-testid="workspace"][data-workspace="${id}"]`) as HTMLElement;
const member = (id: string, projectId: string) => body(id).querySelector<HTMLElement>(`[data-nav-key="m:${id}::${projectId}"]`) as HTMLElement;
const threadRow = (id: string, threadId: string) => body(id).querySelector<HTMLElement>(`[data-nav-key="wt:${id}::${threadId}"]`) as HTMLElement;
const by = (el: HTMLElement, testId: string) => within(el).getByTestId(testId);
const maybe = (el: HTMLElement, testId: string) => within(el).queryByTestId(testId);
const page = () => screen.getByTestId("projects-page");
const list = () => screen.getByTestId("projects-list");
const selection = () => useUiStore.getState().selection;

function renderPage(workspaceId: string) {
  act(() => {
    useUiStore.getState().select(workspacePage(workspaceId));
  });
  return render(
    <>
      <ProjectsPage />
      <ConfirmDialog />
    </>,
  );
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function nextFrame() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => { r(null); }));
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

/** The two workspaces most tests use: shop (synthetic: ghostty-playground first, so it starts threads) and mono (rooted at ~/mono). */
function twoWorkspaces() {
  const shop = addWorkspace("shop", ["repo-gp", "repo-cf"], { primary: "repo-gp" });
  const mono = addWorkspace("mono", ["repo-dot"], { root: "/Users/dev/mono", instructions: "CLAUDE.md", skills: ["release", "demo"] });
  return { shop: shop.id, mono: mono.id };
}

/** A thread in the workspace on its branch with a worktree per git member, as POST /__mock/workspace-thread makes it. */
function workspaceThread(workspaceId: string, id: string, o: { name: string; status?: "busy" | "idle"; primary?: string; branch?: string; archived?: boolean }) {
  const ws = useWorkspacesStore.getState().byId[workspaceId];
  const members = (ws?.members ?? []).map((m) => m.projectId);
  const branch = o.branch ?? `cf/${ws?.name ?? "ws"}`;
  const primary = o.primary ?? ws?.defaultPrimary ?? members[0] ?? "";
  const checkouts = members.map((p) => ({ projectId: p, path: p === "repo-wr" ? "/Users/dev/Documents/writing" : `/wt/${p}/${branch.replace("/", "-")}` }));
  for (const c of checkouts) if (c.projectId !== "repo-wr") addWorktrees(c.projectId, worktree(c.projectId, c.path, branch, { managed: true, status: status({ upstream: "" }) }));
  const cwd = primary === "workspace" ? (ws?.rootPath || ws?.managedDir || "") : (checkouts.find((c) => c.projectId === primary)?.path ?? "");
  const t = thread(id, {
    name: o.name,
    projectId: primary === "workspace" ? "" : primary,
    projectIds: members,
    workspaceId,
    worktreePath: cwd,
    branch,
    createdWorktree: true,
    checkoutPaths: checkouts,
    state: o.status === "busy" ? "connected" : "disconnected",
    status: o.status ?? "idle",
    archivedAtMs: o.archived ? Date.now() : null,
  });
  addThreads(t);
  return t;
}

beforeEach(() => {
  resetDaemon();
  seedWorld();
  resetInstructionsPresses();
  useWorkspaceAddProjectStore.setState({ addingTo: null });
  useNewWorkspaceDialogStore.setState({ open: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the workspace page's header", () => {
  it("Open in Finder (header and Folder row) is workspace.reveal; New thread opens the composer in the workspace; ⋯ has the row's items", async () => {
    const { mono } = twoWorkspaces();
    renderPage(mono);
    await settle();
    expect(screen.getByTestId("page-name").textContent).toBe("mono");
    expect(screen.getByTestId("workspace-meta").textContent).toBe("workspace · 1 project");
    fireEvent.click(screen.getByTestId("workspace-page-reveal"));
    await settle();
    expect(lastInvocation("workspace.reveal")?.args).toEqual({ workspace: mono });
    fireEvent.click(by(body(mono), "workspace-folder-reveal"));
    await settle();
    expect(invocationsOf("workspace.reveal").map((i) => i.args)).toEqual([{ workspace: mono }, { workspace: mono }]);
    const menu = openDropdown(screen.getByTestId("workspace-page-more"), "workspace-page-more-menu");
    expect(menuEntries(menu)).toEqual(["New thread", "New terminal", "Open in Finder", "Rename", "Add project", "Remove workspace"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await settle();
    fireEvent.click(screen.getByTestId("workspace-page-new-thread"));
    expect(selection()).toEqual({ kind: "compose", projectId: "repo-dot", workspaceId: mono });
  });

  it("a workspace with no registered member: no New terminal in the page's ⋯", async () => {
    const ws = addWorkspace("sk", ["repo-sk"]);
    removeProject("repo-sk");
    renderPage(ws.id);
    await settle();
    expect(menuEntries(openDropdown(screen.getByTestId("workspace-page-more"), "workspace-page-more-menu"))).toEqual(["New thread", "Open in Finder", "Rename", "Add project", "Remove workspace"]);
  });

  it("rename from the header's menu: a taken name is refused, Escape keeps, Enter renames once, leaving the field renames once", async () => {
    const { shop } = twoWorkspaces();
    // The daemon renames it (and the page shows the new name from its event).
    daemon.handlers.set("workspace.rename", (inv) => {
      updateWorkspace(shop, (w) => ({ ...w, name: inv.args.name ?? w.name }));
      return { message: "", resultJson: "" };
    });
    renderPage(shop);
    await settle();
    const input = () => screen.getByTestId<HTMLInputElement>("workspace-name-input");
    await pick(openDropdown(screen.getByTestId("workspace-page-more"), "workspace-page-more-menu"), "workspace-menu-rename");
    expect(document.activeElement).toBe(input());
    fireEvent.change(input(), { target: { value: "MONO" } });
    expect(screen.getByTestId("workspace-name-error").textContent).toBe("A workspace named “MONO” exists.");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toBeTruthy();
    fireEvent.keyDown(input(), { key: "Escape" });
    await nextFrame();
    expect(screen.getByTestId("page-name").textContent).toBe("shop");
    expect(invocationsOf("workspace.rename")).toHaveLength(0);

    await pick(openDropdown(screen.getByTestId("workspace-page-more"), "workspace-page-more-menu"), "workspace-menu-rename");
    fireEvent.change(input(), { target: { value: "store" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await settle();
    await nextFrame();
    expect(screen.getByTestId("page-name").textContent).toBe("store");
    const inv = lastInvocation("workspace.rename");
    expect(inv?.args).toEqual({ name: "store", workspace: shop });
    expect(inv?.context).toMatchObject({ activeView: "projects", activeWorkspaceId: shop });
    // The page's list has the keyboard back, and Enter renamed once (the blur that follows does not again).
    expect(document.activeElement).toBe(list());
    expect(invocationsOf("workspace.rename")).toHaveLength(1);

    // Leaving the field renames, once.
    await pick(openDropdown(screen.getByTestId("workspace-page-more"), "workspace-page-more-menu"), "workspace-menu-rename");
    fireEvent.change(input(), { target: { value: "shop" } });
    fireEvent.blur(input());
    await settle();
    expect(screen.getByTestId("page-name").textContent).toBe("shop");
    expect(invocationsOf("workspace.rename").map((i) => i.args.name)).toEqual(["store", "shop"]);
  });

  it("Remove workspace asks first with the daemon's words; the workspace goes by its name", async () => {
    const { shop, mono } = twoWorkspaces();
    confirmFirst("workspace.remove", "Remove workspace mono? Its root folder /Users/dev/mono and everything in it stay.");
    const r = renderPage(mono);
    await settle();
    await pick(openDropdown(screen.getByTestId("workspace-page-more"), "workspace-page-more-menu"), "workspace-menu-remove");
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("Remove workspace mono? Its root folder /Users/dev/mono and everything in it stay");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await settle();
    expect(body(mono)).toBeTruthy();
    r.unmount();

    confirmFirst("workspace.remove", "Remove workspace shop? Its instructions and skills are deleted too.");
    renderPage(shop);
    await settle();
    await pick(openDropdown(screen.getByTestId("workspace-page-more"), "workspace-page-more-menu"), "workspace-menu-remove");
    expect((await screen.findByTestId("confirm-dialog")).textContent).toContain("Remove workspace shop? Its instructions and skills are deleted too.");
    fireEvent.click(screen.getByTestId("confirm-ok"));
    await settle();
    const removed = invocationsOf("workspace.remove");
    expect(removed.map((i) => i.confirmed)).toEqual([false, false, true]);
    expect(removed.at(-1)?.args).toEqual({ workspace: "shop" });
  });

  it("the page goes back to the index once its workspace is removed", async () => {
    const { shop } = twoWorkspaces();
    renderPage(shop);
    await settle();
    act(() => {
      useWorkspacesStore.setState((s) => ({ byId: Object.fromEntries(Object.entries(s.byId).filter(([id]) => id !== shop)), order: s.order.filter((id) => id !== shop) }));
    });
    await settle();
    expect(page().getAttribute("data-page")).toBe("index");
    expect(screen.getAllByTestId("index-project")).toHaveLength(5);
  });
});

describe("the workspace's Projects card", () => {
  it("a synthetic workspace: its projects by name with where threads start and their captions, no folder row, no worktrees", async () => {
    const { shop } = twoWorkspaces();
    renderPage(shop);
    await settle();
    const s = body(shop);
    expect(s.hasAttribute("data-rooted")).toBe(false);
    expect(by(s, "workspace-projects-title").textContent).toMatch(/Projects\s*· every thread checks these out together on one branch/);
    expect(texts(s, "member-name")).toEqual(["code-foundry", "ghostty-playground"]);
    expect(texts(s, "member-caption")).toEqual(["alexwaumann/code-foundry", "alexwaumann/ghostty-playground"]);
    // The first project given starts threads; its row carries the pill, the others none.
    expect(s.querySelector('[data-testid="workspace-member"][data-default]')?.getAttribute("data-project")).toBe("repo-gp");
    expect(within(s).getAllByTestId("workspace-default")).toHaveLength(1);
    expect(by(member(shop, "repo-gp"), "workspace-default").textContent).toBe("starts here");
    expect(maybe(s, "workspace-folder")).toBeNull();
    expect(maybe(s, "project-worktree")).toBeNull();
  });

  it("a rooted workspace: its folder row (the root, where threads start, marked missing when moved)", async () => {
    const { mono } = twoWorkspaces();
    renderPage(mono);
    await settle();
    const m = body(mono);
    expect(m.getAttribute("data-rooted")).toBe("true");
    const folder = by(m, "workspace-folder");
    expect(folder.getAttribute("data-default")).toBe("true");
    expect(folder.textContent).toContain("Workspace folder");
    expect(by(folder, "workspace-default").textContent).toBe("starts here");
    expect(by(folder, "workspace-root").textContent).toBe("~/mono");
    expect(texts(m, "member-caption")).toEqual(["origin · not GitHub"]);
    expect(maybe(m, "workspace-root-missing")).toBeNull();
    updateWorkspace(mono, (w) => ({ ...w, rootMissing: true }));
    expect(by(m, "workspace-root-missing").textContent).toBe("missing");
    expect(by(m, "workspace-root").getAttribute("data-missing")).toBe("true");
  });

  it("Start here on a project, or on a rooted workspace's folder; the row that starts threads has none", async () => {
    const { shop } = twoWorkspaces();
    const rooted = addWorkspace("rooted", ["repo-cf"], { root: "/Users/dev/rooted", primary: "repo-cf" });
    const r = renderPage(shop);
    await settle();
    expect(maybe(member(shop, "repo-gp"), "member-make-default")).toBeNull();
    const make = by(member(shop, "repo-cf"), "member-make-default");
    expect(make.textContent).toBe("Start here");
    fireEvent.click(make);
    await settle();
    expect(lastInvocation("workspace.set-primary")?.args).toEqual({ primary: "repo-cf", workspace: shop });
    // Once the daemon says so, the pill moves and Start here goes.
    updateWorkspace(shop, (w) => ({ ...w, defaultPrimary: "repo-cf" }));
    expect(body(shop).querySelector('[data-testid="workspace-member"][data-default]')?.getAttribute("data-project")).toBe("repo-cf");
    expect(maybe(member(shop, "repo-cf"), "member-make-default")).toBeNull();
    r.unmount();

    renderPage(rooted.id);
    await settle();
    const folder = by(body(rooted.id), "workspace-folder");
    expect(folder.hasAttribute("data-default")).toBe(false);
    fireEvent.click(by(folder, "member-make-default"));
    await settle();
    expect(lastInvocation("workspace.set-primary")?.args).toEqual({ primary: "workspace", workspace: rooted.id });
    updateWorkspace(rooted.id, (w) => ({ ...w, defaultPrimary: "workspace" }));
    expect(by(body(rooted.id), "workspace-folder").getAttribute("data-default")).toBe("true");
    expect(body(rooted.id).querySelector('[data-testid="workspace-member"][data-default]')).toBeNull();
  });

  it("Add project lists the registered projects not in it; Remove takes one out without asking", async () => {
    const { shop } = twoWorkspaces();
    renderPage(shop);
    await settle();
    fireEvent.click(by(body(shop), "workspace-add-member"));
    await settle();
    const options = () => within(screen.getByRole("dialog")).getAllByRole("option");
    // Plain folders can be members too.
    expect(options().map((o) => o.textContent)).toEqual(["dotfiles", "sketches", "writing"]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("option", { name: "writing" }));
    await settle();
    expect(lastInvocation("workspace.add-project")?.args).toEqual({ project: "repo-wr", workspace: shop });
    updateWorkspace(shop, (w) => ({ ...w, members: [...w.members, { projectId: "repo-wr", worktreePath: "" }] }));
    expect(texts(body(shop), "member-name")).toEqual(["code-foundry", "ghostty-playground", "writing"]);
    expect(screen.getByTestId("workspace-meta").textContent).toBe("workspace · 3 projects");

    const remove = by(member(shop, "repo-gp"), "member-remove");
    expect(remove.textContent).toBe("Remove");
    fireEvent.click(remove);
    await settle();
    expect(lastInvocation("workspace.remove-project")?.args).toEqual({ project: "repo-gp", workspace: shop });
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    // The project that started threads gone, the folder does: a synthetic workspace's folder row then shows.
    updateWorkspace(shop, (w) => ({ ...w, members: w.members.filter((m) => m.projectId !== "repo-gp"), defaultPrimary: "workspace" }));
    expect(texts(body(shop), "member-name")).toEqual(["code-foundry", "writing"]);
    expect(by(body(shop), "workspace-folder").getAttribute("data-default")).toBe("true");
    expect(by(body(shop), "workspace-folder").textContent).toContain("kept by the app");
  });

  it("the index row's Add project opens the list here", async () => {
    const { shop } = twoWorkspaces();
    renderPage(shop);
    act(() => {
      useWorkspaceAddProjectStore.setState({ addingTo: shop });
    });
    await settle();
    expect(screen.getByRole("dialog").textContent).toContain("Add a project");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("option", { name: "dotfiles" }));
    await settle();
    expect(lastInvocation("workspace.add-project")?.args).toEqual({ project: "repo-dot", workspace: shop });
  });

  it("a project named “workspace”: Start here and Remove go by its id, not the workspace's folder", async () => {
    updateProject("repo-dot", (p) => ({ ...p, name: "workspace" }));
    const { mono } = twoWorkspaces();
    renderPage(mono);
    await settle();
    expect(by(body(mono), "workspace-folder").getAttribute("data-default")).toBe("true");
    const dot = member(mono, "repo-dot");
    expect(by(dot, "member-name").textContent).toBe("workspace");
    fireEvent.click(by(dot, "member-make-default"));
    await settle();
    expect(lastInvocation("workspace.set-primary")?.args).toEqual({ primary: "repo-dot", workspace: mono });
    updateWorkspace(mono, (w) => ({ ...w, defaultPrimary: "repo-dot" }));
    expect(body(mono).querySelector('[data-testid="workspace-member"][data-default]')?.getAttribute("data-project")).toBe("repo-dot");
    expect(by(body(mono), "workspace-folder").hasAttribute("data-default")).toBe(false);
    fireEvent.click(by(member(mono, "repo-dot"), "member-remove"));
    await settle();
    expect(lastInvocation("workspace.remove-project")?.args).toEqual({ project: "repo-dot", workspace: mono });
    updateWorkspace(mono, (w) => ({ ...w, members: [], defaultPrimary: "workspace" }));
    expect(within(body(mono)).queryAllByTestId("workspace-member")).toHaveLength(0);
  });

  it("an unregistered member reads “not registered”", async () => {
    const ws = addWorkspace("sk", ["repo-sk", "repo-cf"]);
    removeProject("repo-sk");
    renderPage(ws.id);
    await settle();
    const sk = member(ws.id, "repo-sk");
    expect(by(sk, "workspace-member").getAttribute("data-unregistered")).toBe("true");
    expect(sk.textContent).toContain("not registered");
  });
});

describe("the workspace's Threads table", () => {
  it("one column per member with its checkout, working first, archived only counted; the row menu; a click opens the thread", async () => {
    const ws = addWorkspace("platform", ["repo-cf", "repo-gp", "repo-wr"], { primary: "repo-cf" });
    const idle = workspaceThread(ws.id, "s-helper", { name: "helper" });
    const driver = workspaceThread(ws.id, "s-driver", { name: "driver", status: "busy" });
    workspaceThread(ws.id, "s-old", { name: "old", archived: true });
    // ghostty-playground's worktree has two files changed.
    const gpPath = "/wt/repo-gp/cf-platform";
    updateProject("repo-gp", (p) => ({ ...p, worktrees: p.worktrees.map((w) => (w.path === gpPath ? { ...w, status: status({ upstream: "", modified: 2, dirty: true }) } : w)) }));
    renderPage(ws.id);
    await settle();
    const b = body(ws.id);
    expect(by(b, "workspace-threads-title").textContent).toMatch(/Threads\s*· 1 working · 1 idle · 1 archived/);
    expect(by(b, "threads-head").textContent).toMatch(/Branch\s*Thread\s*code-foundry\s*ghostty-playground\s*writing/);
    expect(within(b).getAllByTestId("workspace-thread")).toHaveLength(2);
    const nameStatus = texts(b, "thread-name-status");
    expect(nameStatus[0]).toMatch(/driver\s*·\s*working/);
    expect(nameStatus[1]).toMatch(/helper\s*·\s*idle/);
    const d = threadRow(ws.id, driver.id);
    expect(by(d, "thread-branch").textContent).toBe("cf/platform");
    expect(d.querySelectorAll('[data-live="true"]')).toHaveLength(1);
    expect(texts(d, "thread-member-state")).toEqual(["clean · no commits yet", "2 files · no commits yet", "folder · no git"]);

    // A project added to the workspace later is not in the thread's set.
    updateWorkspace(ws.id, (w) => ({ ...w, members: [...w.members, { projectId: "repo-dot", worktreePath: "" }] }));
    expect(d.querySelector('[data-testid="thread-member-state"][data-project="repo-dot"]')?.textContent).toBe("not in this thread");
    expect(texts(b, "threads-col-member")).toEqual(["code-foundry", "dotfiles", "ghostty-playground", "writing"]);

    // The row menu: each git member's changes, Finder, the path.
    const menu = openDropdown(by(d, "thread-more"), "thread-more-menu");
    expect(menuEntries(menu)).toEqual(["Show changes in code-foundry", "Show changes in ghostty-playground", "Open in Finder", "Copy path"]);
    await pick(menu, "thread-menu-reveal");
    const reveal = lastInvocation("worktree.reveal");
    expect(reveal?.args).toEqual({ worktree: driver.worktreePath });
    expect(reveal?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: driver.worktreePath });

    // Its chevron opens the thread; so does a click on the row.
    fireEvent.click(by(d, "thread-open"));
    expect(selection()).toEqual({ kind: "thread", id: driver.id });
    act(() => {
      useUiStore.getState().select(workspacePage(ws.id));
    });
    await settle();
    fireEvent.click(threadRow(ws.id, idle.id));
    expect(selection()).toEqual({ kind: "thread", id: idle.id });
  });

  it("a thread whose primary is the workspace's folder: Open in Finder shows the folder", async () => {
    const { mono } = twoWorkspaces();
    const t = workspaceThread(mono, "s-docs", { name: "docs", primary: "workspace" });
    renderPage(mono);
    await settle();
    const r = threadRow(mono, t.id);
    expect(texts(r, "thread-member-state")).toEqual(["clean · no commits yet"]);
    await pick(openDropdown(by(r, "thread-more"), "thread-more-menu"), "thread-menu-reveal");
    expect(lastInvocation("workspace.reveal")?.args).toEqual({ workspace: mono });
  });

  it("members show by name, not by id, and the keyboard walks them then the threads", async () => {
    // repo-cf sorts first by id; as "Zebra" it goes last by name.
    updateProject("repo-cf", (p) => ({ ...p, name: "Zebra" }));
    const ws = addWorkspace("zoo", ["repo-cf", "repo-gp", "repo-dot"], { primary: "repo-gp" });
    const t = workspaceThread(ws.id, "s-zt", { name: "zt" });
    renderPage(ws.id);
    await settle();
    expect(texts(body(ws.id), "member-name")).toEqual(["dotfiles", "ghostty-playground", "Zebra"]);
    expect(texts(body(ws.id), "threads-col-member")).toEqual(["dotfiles", "ghostty-playground", "Zebra"]);
    expect(document.activeElement).toBe(list());
    const cursor = () => document.querySelector('[aria-selected="true"][data-nav-key]')?.getAttribute("data-nav-key");
    fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(cursor()).toBe(`m:${ws.id}::repo-dot`);
    for (let i = 0; i < 3; i++) fireEvent.keyDown(list(), { key: "ArrowDown" });
    expect(cursor()).toBe(`wt:${ws.id}::${t.id}`);
    fireEvent.keyDown(list(), { key: "Enter" });
    expect(selection()).toEqual({ kind: "thread", id: t.id });
  });
});

describe("the workspace's Instructions and skills", () => {
  it("a synthetic workspace without either: the rows say so and where they live; what a thread writes shows up", async () => {
    const { shop } = twoWorkspaces();
    renderPage(shop);
    await settle();
    const s = body(shop);
    expect(by(s, "workspace-threads-title").textContent).toMatch(/Threads\s*· none yet/);
    expect(by(s, "workspace-threads-empty")).toBeTruthy();
    expect(by(s, "workspace-instructions-label").textContent).toBe("CLAUDE.md");
    expect(by(s, "workspace-instructions-none").textContent).toBe("None yet");
    expect(by(s, "workspace-edit-instructions").textContent).toBe("Write instructions");
    expect(by(s, "workspace-instructions-reach").textContent).toBe("(starts a thread)");
    expect(by(s, "workspace-skills-none").textContent).toBe("None yet");
    expect(by(s, "workspace-folder-path").textContent).toMatch(new RegExp(`/workspaces/${shop}$`));
    expect(by(s, "workspace-folder-kind").textContent).toBe("kept by the app");

    // What a thread writes in the workspace's folder shows up (the daemon re-reads it after a turn).
    updateWorkspace(shop, (w) => ({ ...w, instructions: `${w.managedDir ?? ""}/AGENTS.md`, skills: ["docs", "lint"] }));
    expect(by(s, "workspace-instructions-label").textContent).toBe("AGENTS.md");
    expect(by(s, "workspace-instructions-path").textContent).toMatch(/\/AGENTS\.md$/);
    expect(by(s, "workspace-instructions-open").textContent).toBe("View");
    expect(by(s, "workspace-edit-instructions").textContent).toBe("Edit instructions");
    expect(by(s, "workspace-skills-list").textContent).toBe("docs, lint");

    // Browse marketplace: Settings → Skills.
    fireEvent.click(by(s, "workspace-browse-skills"));
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "skills" });
  });

  it("a rooted workspace: the root's instructions and skills", async () => {
    const { mono } = twoWorkspaces();
    renderPage(mono);
    await settle();
    const m = body(mono);
    expect(by(m, "workspace-instructions").getAttribute("data-file")).toBe("/Users/dev/mono/CLAUDE.md");
    expect(by(m, "workspace-instructions-path").textContent).toBe("~/mono/CLAUDE.md");
    expect(by(m, "workspace-skills-list").textContent).toBe("demo, release");
    expect(by(m, "workspace-folder-path").textContent).toBe("~/mono");
    expect(by(m, "workspace-folder-kind").textContent).toBe("its root");
  });

  it("Write instructions starts a thread in the workspace's folder; while it is on its first turn a press only shows it; idle, a press steers it", async () => {
    const { mono } = twoWorkspaces();
    updateWorkspace(mono, (w) => ({ ...w, instructions: "" }));
    daemon.handlers.set("thread.new", () => ({ message: "", resultJson: JSON.stringify({ id: "s-new" }) }));
    renderPage(mono);
    await settle();
    const m = body(mono);
    expect(by(m, "workspace-instructions-reach").textContent).toBe("(starts a thread)");
    fireEvent.click(by(m, "workspace-edit-instructions"));
    await settle();
    const started = lastInvocation("thread.new");
    expect(started?.args).toMatchObject({ workspace: mono, project: "workspace", "new-worktree": "false" });
    expect(started?.context).toMatchObject({ activeView: "compose", activeWorkspaceId: mono });
    expect(started?.args.prompt).toContain("/Users/dev/mono/CLAUDE.md");

    // Again while that thread is still on its first turn: it is only shown, nothing is sent or started.
    addThreads(thread("s-new", { name: "s-new", projectId: "", projectIds: ["repo-dot"], workspaceId: mono, worktreePath: "/Users/dev/mono", state: "starting", status: "busy" }));
    expect(by(m, "workspace-instructions-reach").textContent).toMatch(/^\(sends to /);
    fireEvent.click(by(m, "workspace-edit-instructions"));
    await settle();
    expect(selection()).toEqual({ kind: "thread", id: "s-new" });
    expect(invocationsOf("thread.send")).toHaveLength(0);
    expect(invocationsOf("thread.new")).toHaveLength(1);

    // Once it is up and idle: the thread in the workspace's folder is steered, not a second one started.
    addThreads(thread("s-new", { name: "s-new", projectId: "", projectIds: ["repo-dot"], workspaceId: mono, worktreePath: "/Users/dev/mono", state: "connected", status: "idle" }));
    act(() => {
      useUiStore.getState().select(workspacePage(mono));
    });
    await settle();
    fireEvent.click(by(body(mono), "workspace-edit-instructions"));
    await settle();
    expect(lastInvocation("thread.send")?.args.text).toContain("/Users/dev/mono/CLAUDE.md");
    expect(lastInvocation("thread.send")?.context).toMatchObject({ activeThreadId: "s-new", activeWorkspaceId: mono });
    expect(invocationsOf("thread.new")).toHaveLength(1);
    expect(selection()).toEqual({ kind: "thread", id: "s-new" });
  });

  it("Edit instructions steers once: the toast names the thread (no CLI text); while it works a press only shows it", async () => {
    const success = vi.spyOn(toast, "success");
    const { mono } = twoWorkspaces();
    daemon.handlers.set("thread.send", () => ({ message: "Sent. wait with: code-foundry thread wait s-driver", resultJson: "" }));
    addThreads(thread("s-driver", { name: "driver", projectId: "", projectIds: ["repo-dot"], workspaceId: mono, worktreePath: "/Users/dev/mono", state: "connected", status: "busy" }));
    renderPage(mono);
    await settle();
    expect(by(body(mono), "workspace-instructions-reach").textContent).toBe("(sends to driver)");
    fireEvent.click(by(body(mono), "workspace-edit-instructions"));
    await settle();
    expect(selection()).toEqual({ kind: "thread", id: "s-driver" });
    expect(success.mock.calls.map((c) => c[0])).toEqual(["Sent to driver"]);
    expect(invocationsOf("thread.send")).toHaveLength(1);

    // Still working on it: shown again, not sent again.
    act(() => {
      useUiStore.getState().select(workspacePage(mono));
    });
    await settle();
    fireEvent.click(by(body(mono), "workspace-edit-instructions"));
    await settle();
    expect(selection()).toEqual({ kind: "thread", id: "s-driver" });
    expect(invocationsOf("thread.send")).toHaveLength(1);

    // Done: the next press steers again.
    addThreads(thread("s-driver", { name: "driver", projectId: "", projectIds: ["repo-dot"], workspaceId: mono, worktreePath: "/Users/dev/mono", state: "connected", status: "idle" }));
    act(() => {
      useUiStore.getState().select(workspacePage(mono));
    });
    await settle();
    fireEvent.click(by(body(mono), "workspace-edit-instructions"));
    await settle();
    expect(invocationsOf("thread.send")).toHaveLength(2);
    expect(invocationsOf("thread.new")).toHaveLength(0);
  });
});

describe("the New workspace dialog", () => {
  function openDialog() {
    render(<NewWorkspaceDialog />);
    act(() => {
      openNewWorkspaceDialog();
    });
  }
  const dialog = () => screen.getByTestId("new-workspace-dialog");
  const nameInput = () => within(dialog()).getByTestId<HTMLInputElement>("new-workspace-name");
  const submit = () => within(dialog()).getByTestId<HTMLButtonElement>("new-workspace-submit");
  const check = (projectId: string) => {
    fireEvent.click(within(dialog().querySelector(`[data-project="${projectId}"]`) as HTMLElement).getByRole("checkbox"));
  };

  it("a name and its projects, then workspace.new with them in the page's order; it closes and the workspace's row opens its page", async () => {
    // The daemon makes it, the first project given starting its threads.
    daemon.handlers.set("workspace.new", (inv) => {
      const names = (inv.args.projects ?? "").split(",");
      const ids = names.map((n) => Object.values(useProjectsStore.getState().byId).find((p) => p.name === n)?.id ?? n);
      addWorkspace(inv.args.name ?? "", ids, { primary: ids[0] });
      return { message: "", resultJson: "" };
    });
    render(<ProjectsPage />);
    expect(screen.getByTestId("workspaces-empty")).toBeTruthy();
    fireEvent.click(screen.getByTestId("projects-new-workspace"));
    render(<NewWorkspaceDialog />);
    await settle();
    await settle();
    expect(document.activeElement).toBe(nameInput());
    expect(submit().disabled).toBe(true);
    fireEvent.change(nameInput(), { target: { value: "workspace" } });
    expect(within(dialog()).getByTestId("new-workspace-name-error").textContent).toBe("“workspace” is reserved.");
    fireEvent.change(nameInput(), { target: { value: "payments" } });
    expect(submit().disabled).toBe(true); // no project yet
    check("repo-gp");
    check("repo-dot");
    expect(submit().disabled).toBe(false);
    fireEvent.click(submit());
    await settle();
    expect(screen.queryByTestId("new-workspace-dialog")).toBeNull();
    // The page's order (by name): dotfiles first, so it is the default primary.
    expect(lastInvocation("workspace.new")?.args).toEqual({ name: "payments", projects: "dotfiles,ghostty-playground" });
    const created = screen.getByTestId("index-workspace");
    expect(by(created, "workspace-name").textContent).toBe("payments");
    fireEvent.click(created);
    expect(screen.getByTestId("page-name").textContent).toBe("payments");
    const c = screen.getByTestId("workspace");
    expect(texts(c, "member-name")).toEqual(["dotfiles", "ghostty-playground"]);
    expect(c.querySelector('[data-testid="workspace-member"][data-default]')?.getAttribute("data-project")).toBe("repo-dot");
  });

  it("a taken name, whatever its case, is caught before the daemon is asked; a refusal shows the daemon's words", async () => {
    addWorkspace("payments", ["repo-cf"]);
    daemon.handlers.set("workspace.new", () => {
      throw refuse("a workspace named books exists in the config");
    });
    openDialog();
    await settle();
    fireEvent.change(nameInput(), { target: { value: "Payments" } });
    expect(within(dialog()).getByTestId("new-workspace-name-error").textContent).toBe("A workspace named “Payments” exists.");
    fireEvent.change(nameInput(), { target: { value: "books" } });
    check("repo-cf");
    fireEvent.click(submit());
    await settle();
    expect(within(dialog()).getByTestId("new-workspace-error").textContent).toBe("a workspace named books exists in the config");
  });

  it("lists the projects by name", async () => {
    updateProject("repo-cf", (p) => ({ ...p, name: "Zebra" }));
    openDialog();
    await settle();
    expect([...dialog().querySelectorAll('[data-testid="new-workspace-project"] label')].map((l) => l.textContent)).toEqual(["dotfiles", "ghostty-playground", "sketches", "writing", "Zebra"]);
  });
});
