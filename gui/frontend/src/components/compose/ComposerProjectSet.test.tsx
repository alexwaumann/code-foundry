import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_FROM_ORIGIN_KEY, draftKey, WORK_IN_SETTING_KEY } from "@/lib/compose";
import { composeIn, composeInWorkspace, composeTarget, updateDraft, useComposeStore } from "@/stores/compose";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { card } from "@/test/cardFakes";
import { BACKGROUND } from "@/test/composerWorld";
import { daemon, invocationsOf, lastInvocation, refuse, resetDaemon } from "@/test/daemonFakes";
import { addThreads, addWorkspace, addWorktrees, HOME, removeWorkspace, seedWorld, SK, thread, worktree, WR } from "@/test/projectsWorld";
import { ThreadHeader } from "@/components/thread/ThreadHeader";
import { resetLayout } from "@/stores/layout";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";
import { SaveWorkspaceDialog } from "@/components/thread/SaveWorkspaceDialog";
import { RowMenu } from "@/components/sidebar/RowMenu";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useCommandsStore } from "@/stores/commands";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import type { ThreadView } from "@/api/threads";
import { updateThread } from "@/test/threadInfoWorld";
import { Composer } from "./Composer";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/placement", async (orig) => ({ ...(await orig<typeof import("@/api/placement")>()), ...(await import("@/test/cardFakes")).cardPlacementFakes }));
// The mock's branches: code-foundry has fix/resize of its own; both have main, feat/sidebar and release/v0.3.
const REFS: Readonly<Record<string, string[]>> = { "repo-cf": ["main", "feat/sidebar", "fix/resize", "release/v0.3"], "repo-gp": ["main", "feat/sidebar", "release/v0.3"], "repo-dot": ["main"], "repo-sk": ["main"] };
vi.mock("@/api/project", async (orig) => ({
  ...(await orig<typeof import("@/api/project")>()),
  listRefs: (projectId: string) => Promise.resolve({ refs: REFS[projectId] ?? [], defaultRef: "origin/main", branches: REFS[projectId] ?? [], defaultBranch: REFS[projectId] ? "main" : "" }),
}));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), listSkills: () => new Promise(() => undefined) }));

/**
 * The composer's project set (docs/notes/workspaces-v2-3-composer.md) over the mock's
 * projects (src/test/projectsWorld.ts): Add project's multi-select and the chips, the
 * primary picker, Work in and Branch from for a set, a workspace row and its chip, Clear,
 * the collision banner, and what thread.new gets. Where the pickers sit (one row) stays in
 * e2e/project-sets.spec.ts; what the daemon makes of thread.new (names, worktrees) is Go's.
 */

/** App's Content for the compose selections: the composer its selection names. */
function ComposeHost() {
  const sel = useUiStore((s) => s.selection);
  if (sel.kind !== "compose") return <div data-testid="not-compose" data-kind={sel.kind} data-id={sel.kind === "thread" ? sel.id : undefined} />;
  return (
    <Composer
      key={sel.likeThreadId ? `like:${sel.likeThreadId}` : sel.workspaceId ? `ws:${sel.workspaceId}` : sel.noProject ? "home:" : sel.projectId}
      projectId={sel.projectId}
      workspaceId={sel.workspaceId}
      noProject={sel.noProject}
      likeThreadId={sel.likeThreadId}
    />
  );
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function settings(values: Record<string, string>): void {
  useSettingsStore.setState({ snapshot: { values, sources: {} } as never });
}

async function mount(projectId: string): Promise<void> {
  act(() => {
    composeIn(projectId);
  });
  render(
    <>
      <ComposeHost />
      <Toaster />
    </>,
  );
  await settle();
}

/** A tick and an animation frame: the composer focuses its prompt a frame after it mounts. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

/** The model, effort and permission a draft sends without a pick (the registry's defaults here; the mock's settings in e2e). */
const DEFAULTS = { model: "claude-sonnet-5[1m]", effort: "medium", permission: "auto" };

/** Where hoverTip last put the pointer: a Command ignores a pointer that did not move. */
let pointerX = 0;

/** The Tip on an element, opened the way a pointer does (after the provider's 500 ms). */
async function hoverTip(el: Element): Promise<string | null> {
  pointerX += 1;
  fireEvent.pointerMove(el, { pointerType: "mouse", clientX: pointerX });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 550));
  });
  return screen.queryByRole("tooltip")?.textContent ?? null;
}

const heading = () => screen.getByTestId("composer-heading").textContent;
const chips = () => screen.queryAllByTestId("composer-member");

/** Opens a pill's picker and returns its list. */
async function openPicker(trigger: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId(trigger));
  return screen.findByTestId(`${trigger === "composer-project-trigger" ? "composer-project" : trigger}-list`);
}

const options = (list: HTMLElement) => within(list).queryAllByRole("option");
const option = (list: HTMLElement, name: string) => options(list).find((o) => o.textContent.startsWith(name)) as HTMLElement;

/** Closes an open picker with Escape and waits for it to go. */
async function escape(list: HTMLElement): Promise<void> {
  fireEvent.keyDown(list, { key: "Escape" });
  await waitFor(() => {
    expect(list.isConnected).toBe(false);
  });
}

/** Types the prompt (the draft's text, as the editor writes it) and sends it with the send button; the editor's Enter is e2e's. */
async function sendPrompt(text: string): Promise<void> {
  const sel = useUiStore.getState().selection;
  if (sel.kind !== "compose") throw new Error("no composer");
  act(() => {
    updateDraft(draftKey(composeTarget(sel)), { text });
  });
  fireEvent.click(screen.getByTestId("composer-send"));
  await tick();
}

beforeEach(() => {
  resetDaemon();
  seedWorld();
  card.refusals.clear();
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
  settings({});
  daemon.handlers.set("thread.new", () => ({ message: "", resultJson: JSON.stringify({ id: "s-new-1" }) }));
});

afterEach(() => {
  toast.dismiss();
  cleanup();
});

describe("the composer's project set", () => {
  it("Add project multi-selects: chips by id, Clear, the primary picker", async () => {
    await mount("repo-cf");
    expect(heading()).toBe("What should we build in code-foundry?");
    // A lone project: no chips, only Add project; no primary picker, no Clear.
    expect(chips()).toHaveLength(0);
    expect(screen.getByTestId("composer-add-project").textContent).toBe("Add project");
    expect(screen.queryByTestId("composer-primary")).toBeNull();
    expect(screen.queryByTestId("composer-clear")).toBeNull();
    const list = await openPicker("composer-add-project");
    expect(options(list).map((o) => o.textContent)).toEqual([
      expect.stringMatching(/^code-foundry/),
      expect.stringMatching(/^dotfiles/),
      expect.stringMatching(/^ghostty-playground/),
      expect.stringMatching(/^sketches/),
      expect.stringMatching(/^writing/),
    ]);
    const addList = () => screen.getByTestId("composer-add-project-list");
    const checked = () => [...addList().querySelectorAll("[data-checked]")].map((o) => o.textContent);
    expect(checked()).toEqual([expect.stringMatching(/^code-foundry/)]);
    // Toggle two more; the list stays open, the set checked, by name.
    fireEvent.click(option(addList(), "sketches"));
    await tick();
    fireEvent.click(option(addList(), "ghostty-playground"));
    await tick();
    expect(checked()).toHaveLength(3);
    // And one out again.
    fireEvent.click(option(addList(), "sketches"));
    await tick();
    expect(checked()).toHaveLength(2);
    await escape(addList());
    expect(heading()).toBe("What should we build in 2 projects?");
    expect(screen.getByTestId("composer-members").querySelector(":scope > li")?.querySelector('[data-testid="composer-add-project"]')).not.toBeNull();
    expect(screen.getByTestId("composer-clear").textContent).toBe("Clear");
    expect(chips().map((c) => [c.dataset.project, c.textContent, c.hasAttribute("data-primary")])).toEqual([
      ["repo-cf", "code-foundry", false],
      ["repo-gp", "ghostty-playground", false],
    ]);
    expect(screen.getByTestId("composer-worktree").textContent).toContain("Project folders");
    expect(screen.queryByTestId("composer-base")).toBeNull();
    const primary = screen.getByTestId("composer-primary");
    expect(primary.textContent).toBe("code-foundry");
    expect(primary.getAttribute("aria-label")).toBe("Run in: code-foundry");
    const runIn = await openPicker("composer-primary");
    expect(options(runIn).map((o) => o.textContent)).toEqual([expect.stringMatching(/^code-foundry/), expect.stringMatching(/^ghostty-playground/)]);
    fireEvent.click(option(runIn, "ghostty-playground"));
    await tick();
    expect(screen.getByTestId("composer-primary").textContent).toBe("ghostty-playground");
    await sendPrompt("Share the login types");
    expect(lastInvocation("thread.new")?.args).toEqual({ ...BACKGROUND, project: "repo-gp", projects: "repo-cf,repo-gp", "new-worktree": "false", ...DEFAULTS, prompt: "Share the login types" });
    // The new thread replaces the composer.
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-new-1" });
  });

  /** code-foundry's composer with ghostty-playground added: a set of two git projects. */
  async function composeTwo(): Promise<void> {
    await mount("repo-cf");
    const list = await openPicker("composer-add-project");
    fireEvent.click(option(list, "ghostty-playground"));
    await tick();
    await escape(list);
    expect(heading()).toBe("What should we build in 2 projects?");
  }

  it("Work in: an existing branch for a set, from every project's branches; thread.new gets it, no base", async () => {
    settings({ [WORK_IN_SETTING_KEY]: "new" });
    await composeTwo();
    expect(screen.getByTestId("composer-worktree").textContent).toContain("Fresh copies");
    const list = await openPicker("composer-worktree");
    // The two choices, then both projects' branches merged by name, without the default branch.
    await waitFor(() => {
      expect(options(list).map((o) => o.textContent)).toEqual([expect.stringMatching(/^Fresh copies\s*Edits land/), expect.stringMatching(/^Project folders\s*Edits land/), "feat/sidebar", "fix/resize", "release/v0.3"]);
    });
    // The search filters the branches only; the choices stay; Enter picks the first match.
    const search = within(list).getByPlaceholderText("Find existing branch");
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "resize" } });
    expect(options(list).map((o) => o.textContent)).toEqual([expect.stringMatching(/^Fresh copies/), expect.stringMatching(/^Project folders/), "fix/resize"]);
    fireEvent.keyDown(search, { key: "Enter" });
    await tick();
    expect(screen.getByTestId("composer-worktree").textContent).toContain("fix/resize");
    expect(screen.queryByTestId("composer-base")).toBeNull();
    await sendPrompt("Fix the resize glitch");
    expect(lastInvocation("thread.new")?.args).toEqual({ ...BACKGROUND, project: "repo-cf", projects: "repo-cf,repo-gp", "new-worktree": "true", branch: "fix/resize", ...DEFAULTS, prompt: "Fix the resize glitch" });
  });

  it("Branch from: Default branches first, the branches every project has, the rule as a footer; every project gets the pick", async () => {
    settings({ [WORK_IN_SETTING_KEY]: "new" });
    await composeTwo();
    expect(screen.getByTestId("composer-base").textContent).toContain("From defaults");
    const list = await openPicker("composer-base");
    await waitFor(() => {
      expect(options(list).map((o) => o.textContent)).toEqual(["Default branches", "feat/sidebar", "release/v0.3"]);
    });
    expect(options(list)[0]?.getAttribute("aria-selected")).toBe("true");
    expect(list.querySelector('[data-slot="picker-footer"]')?.textContent).toBe("Each project takes origin's copy of the branch, or its own when that is ahead.");
    const filter = within(list).getByPlaceholderText("Filter branches…");
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: "release" } });
    expect(options(list).map((o) => o.textContent)).toEqual(["release/v0.3"]);
    fireEvent.keyDown(filter, { key: "Enter" });
    await tick();
    expect(screen.getByTestId("composer-base").textContent).toContain("From release/v0.3");
    await sendPrompt("Backport the fix");
    expect(lastInvocation("thread.new")?.args).toEqual({ ...BACKGROUND, project: "repo-cf", projects: "repo-cf:release/v0.3,repo-gp:release/v0.3", "new-worktree": "true", ...DEFAULTS, prompt: "Backport the fix" });
  });

  it("Branch from: no footer while projects.base_from_origin is off", async () => {
    settings({ [WORK_IN_SETTING_KEY]: "new", [BASE_FROM_ORIGIN_KEY]: "false" });
    await composeTwo();
    const list = await openPicker("composer-base");
    await waitFor(() => {
      expect(options(list).map((o) => o.textContent)).toEqual(["Default branches", "feat/sidebar", "release/v0.3"]);
    });
    expect(list.querySelector('[data-slot="picker-footer"]')).toBeNull();
  });

  it("a workspace row selects its members and the reference; Workspace as the primary; fresh copies", async () => {
    settings({ [WORK_IN_SETTING_KEY]: "new" });
    const ws = addWorkspace("shop", ["repo-cf", "repo-dot"], { primary: "repo-dot", id: "w-000000000001" });
    await mount("repo-dot");
    const list = await openPicker("composer-project-trigger");
    expect([...list.querySelectorAll("[cmdk-group-heading]")].map((h) => h.textContent)).toEqual(["Workspaces", "Projects"]);
    const row = () => screen.getByTestId("composer-project-list").querySelector<HTMLElement>(`[data-workspace="${ws.id}"]`) as HTMLElement;
    expect(within(row()).getByTestId("workspace-detail").textContent).toBe("code-foundry, dotfiles");
    fireEvent.click(row());
    await settle();
    expect(screen.queryByTestId("composer-project-list")).toBeNull();
    expect(heading()).toBe("What should we build in shop?");
    expect(document.activeElement?.closest('[data-testid="composer-prompt"]')).not.toBeNull();
    await openPicker("composer-project-trigger");
    expect(row().getAttribute("data-current")).toBe("true");
    expect(screen.getByTestId("composer-project-list").querySelectorAll("[data-current]")).toHaveLength(1);
    await escape(screen.getByTestId("composer-project-list"));

    expect(screen.getByTestId("composer-workspace").textContent).toContain("shop");
    expect(chips().map((c) => [c.dataset.project, c.textContent])).toEqual([
      ["repo-cf", "code-foundry"],
      ["repo-dot", "dotfiles"],
    ]);
    expect(screen.getByTestId("composer-worktree").textContent).toContain("Fresh copies");
    // The workspace's default primary.
    expect(screen.getByTestId("composer-primary").textContent).toBe("dotfiles");
    const runIn = await openPicker("composer-primary");
    expect(options(runIn).map((o) => o.textContent)).toEqual([expect.stringMatching(/^Workspace folder\s*shop's folder/), expect.stringMatching(/^code-foundry/), expect.stringMatching(/^dotfiles/)]);
    fireEvent.click(options(runIn)[0] as HTMLElement);
    await tick();
    expect(screen.getByTestId("composer-primary").textContent).toBe("Workspace folder");
    // A base applies to every git project, whichever runs the thread: Branch from stays.
    expect(screen.getByTestId("composer-base").textContent).toContain("From defaults");
    await sendPrompt("Ship the shop banner");
    expect(lastInvocation("thread.new")?.args).toEqual({ ...BACKGROUND, project: "workspace", projects: "repo-cf,repo-dot", workspace: ws.id, "new-worktree": "true", ...DEFAULTS, prompt: "Ship the shop banner" });
  });

  it("the workspace chip's × takes its members with it; Clear empties the set; every × goes to the prompt", async () => {
    addWorkspace("shop", ["repo-cf", "repo-dot"], { id: "w-000000000001" });
    await mount("repo-gp");
    await openPicker("composer-project-trigger");
    fireEvent.click(screen.getByTestId("composer-project-list").querySelector('[data-workspace="w-000000000001"]') as HTMLElement);
    await settle();
    expect(heading()).toBe("What should we build in shop?");
    expect(chips()).toHaveLength(2);
    // × on the workspace: shop and its members go; no tooltip on a chip's ×.
    const remove = screen.getByTestId("composer-workspace-remove");
    expect(remove.getAttribute("aria-label")).toBe("Remove workspace shop");
    expect(await hoverTip(remove)).toBeNull();
    fireEvent.click(remove);
    await settle();
    expect(screen.queryByTestId("composer-workspace")).toBeNull();
    expect(heading()).toBe("Pick a project");
    expect(chips()).toHaveLength(0);
    expect(document.activeElement?.closest('[data-testid="composer-prompt"]')).not.toBeNull();

    // Clear: a set of two to nothing, the empty state.
    const again = await openPicker("composer-add-project");
    fireEvent.click(option(again, "sketches"));
    await tick();
    fireEvent.click(option(screen.getByTestId("composer-add-project-list"), "ghostty-playground"));
    await tick();
    await escape(screen.getByTestId("composer-add-project-list"));
    expect(chips()).toHaveLength(2);
    expect(screen.getAllByTestId("composer-member-remove")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("composer-clear"));
    await settle();
    expect(heading()).toBe("Pick a project");
    expect(chips()).toHaveLength(0);
    expect(screen.queryByTestId("composer-clear")).toBeNull();
    expect(document.activeElement?.closest('[data-testid="composer-prompt"]')).not.toBeNull();
    // Add project is still there to start again.
    const back = await openPicker("composer-add-project");
    fireEvent.click(option(back, "dotfiles"));
    await tick();
    await escape(screen.getByTestId("composer-add-project-list"));
    expect(heading()).toBe("What should we build in dotfiles?");
  });

  it("the collision banner before send, and no toast of the daemon's hints that repeat it after", async () => {
    // sketches and the writing folder: another running thread's set.
    addThreads(thread("s-busy", { projectId: "repo-sk", projectIds: ["repo-sk", "repo-wr"], worktreePath: SK, checkoutPaths: [{ projectId: "repo-sk", path: SK }, { projectId: "repo-wr", path: WR }], name: "Busy one", state: "connected", status: "busy" }));
    await mount("repo-sk");
    const text = () => screen.getByTestId("composer-collision-text").textContent;
    expect(text()).toBe("This project is already being edited on main by another running thread. Multiple agents changing the same file at the same time can overwrite each other's work.");
    expect(screen.getByTestId("composer-worktree-warning")).toBeTruthy();
    // "Use a new branch": a fresh copy shares nothing.
    fireEvent.click(screen.getByTestId("composer-collision-new-branch"));
    expect(screen.getByTestId("composer-worktree").textContent).toContain("Fresh copy");
    expect(screen.queryByTestId("composer-collision")).toBeNull();
    expect(screen.queryByTestId("composer-worktree-warning")).toBeNull();
    // With the writing folder, fresh copies still share the folder; already on a new branch: no button.
    const list = await openPicker("composer-add-project");
    fireEvent.click(option(list, "writing"));
    await tick();
    await escape(screen.getByTestId("composer-add-project-list"));
    expect(screen.getByTestId("composer-worktree").textContent).toContain("Fresh copies");
    expect(text()).toContain("1 of 2 projects is already being edited by another running thread.");
    expect(screen.queryByTestId("composer-collision-new-branch")).toBeNull();
    // In place: both, one banner, never a blocker.
    const work = await openPicker("composer-worktree");
    fireEvent.click(option(work, "Project folders"));
    await tick();
    expect(screen.getAllByTestId("composer-collision")).toHaveLength(1);
    expect(text()).toContain("2 of 2 projects are already being edited by another running thread.");
    expect(screen.getByTestId("composer-collision-new-branch")).toBeTruthy();
    // After the Create the daemon's hints repeat the lines shown above: no toast says them again.
    // (CreateThreadResponse.hints, in lib/collisionHints hintLine's words.)
    const hints = ["sketches @ main is also open in Busy one"];
    daemon.handlers.set("thread.new", () => ({ message: "", resultJson: JSON.stringify({ id: "s-new-1" }), warnings: hints }));
    await sendPrompt("Pair on the parser");
    expect(invocationsOf("thread.new")).toHaveLength(1);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-new-1" });
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0);
  });

  it("a workspace removed while its composer is open says so", async () => {
    addWorkspace("login", ["repo-cf", "repo-gp"], { id: "w-000000000001" });
    act(() => {
      composeInWorkspace("w-000000000001");
    });
    render(<ComposeHost />);
    await settle();
    expect(heading()).toBe("What should we build in login?");
    removeWorkspace("w-000000000001");
    expect(screen.getByTestId("composer").textContent).toBe("This workspace no longer exists.");
  });

  it("Work in greys a branch whose worktree moved, with the daemon's refusal as its tooltip; a pick of it does nothing", async () => {
    const path = `${HOME}/.code-foundry/worktrees/alexwaumann/code-foundry/release-v0.3`;
    const refusal = `code-foundry's worktree for release/v0.3 at ${path} has hotfix checked out now; switch it back to release/v0.3, or pick another branch`;
    // A thread's worktree for release/v0.3 that has hotfix checked out now.
    addWorktrees("repo-cf", worktree("repo-cf", path, "hotfix"));
    card.refusals.set("repo-cf@release/v0.3", `failed precondition: ${refusal}`);
    await mount("repo-cf");
    const before = screen.getByTestId("composer-worktree").getAttribute("aria-label");
    const list = await openPicker("composer-worktree");
    const refused = () => option(screen.getByTestId("composer-worktree-list"), "release/v0.3");
    await waitFor(() => {
      expect(refused().hasAttribute("data-unavailable")).toBe(true);
    });
    expect(option(list, "feat/sidebar").hasAttribute("data-unavailable")).toBe(false);
    expect(await hoverTip(refused().querySelector("[data-tip]") as HTMLElement)).toBe(refusal);
    fireEvent.click(refused());
    await tick();
    expect(screen.getByTestId("composer-worktree-list")).toBeTruthy();
    await escape(screen.getByTestId("composer-worktree-list"));
    expect(screen.getByTestId("composer-worktree").getAttribute("aria-label")).toBe(before);
  });
});

/** Opens the thread header's menu (ThreadHeader's ⋯). */
function openTitleMenu(): HTMLElement {
  fireEvent.pointerDown(screen.getByTestId("thread-header-menu-trigger"), { button: 0, ctrlKey: false });
  return screen.getByTestId("thread-header-menu");
}

const setItems = (menu: HTMLElement) => [...menu.querySelectorAll('[data-testid="menu-new-like"], [data-testid="menu-save-workspace"]')].map((e) => e.textContent);

/** A thread over `projects` (worktrees made for `branch` when given), selected. */
function setThread(id: string, name: string, projects: string[], primary: string, o: { workspaceId?: string; branch?: string } = {}): void {
  const path = (p: string) => (o.branch ? `${HOME}/.code-foundry/worktrees/${p}/${o.branch.replaceAll("/", "-")}` : (useProjectsStore.getState().byId[p]?.path ?? ""));
  if (o.branch) for (const p of projects) addWorktrees(p, worktree(p, path(p), o.branch));
  addThreads(
    thread(id, {
      name,
      projectId: primary,
      projectIds: [...projects].sort(),
      worktreePath: path(primary),
      checkoutPaths: [...projects].sort().map((p) => ({ projectId: p, path: path(p) })),
      workspaceId: o.workspaceId ?? "",
      branch: o.branch ?? "",
      createdWorktree: Boolean(o.branch),
      state: "connected",
      status: "idle",
      flags: [],
      createdBy: "",
      createdByName: "",
    }),
  );
  act(() => {
    useUiStore.getState().select({ kind: "thread", id });
  });
}

async function renderThreadChrome(id: string): Promise<void> {
  resetLayout();
  await seedLayout(layoutOf([space(pane("p-1", [tab("t-1", "thread", id)]), "p-1")]));
  render(
    <>
      <ThreadHeader threadId={id} paneId="p-1" />
      <ComposeHost />
      <SaveWorkspaceDialog />
      <Toaster />
    </>,
  );
  await settle();
}

describe("Save as workspace and New thread on this branch", () => {
  beforeEach(() => {
    useCommandsStore.setState({ commands: [] });
  });

  it("Save as workspace: offered for an unsaved set of two or more, names it and sets the reference; saved, it is gone", async () => {
    setThread("s-pair", "Pair", ["repo-cf", "repo-gp"], "repo-gp");
    daemon.handlers.set("workspace.new", (inv) => {
      const w = addWorkspace(inv.args.name ?? "", (inv.args.projects ?? "").split(","), { id: "w-000000000001" });
      return { message: "", resultJson: JSON.stringify({ id: w.id }) };
    });
    daemon.handlers.set("thread.workspace", (inv) => {
      addThreads({ ...(useThreadsStore.getState().byId["s-pair"] as ThreadView), workspaceId: inv.args.workspace ?? "" });
      return { message: "", resultJson: "" };
    });
    await renderThreadChrome("s-pair");
    const menu = openTitleMenu();
    expect(setItems(menu)).toEqual(["New thread on this branch", "Save as workspace"]);
    fireEvent.click(within(menu).getByTestId("menu-save-workspace"));
    const dialog = await screen.findByTestId("save-workspace-dialog");
    expect(within(dialog).getByTestId("save-workspace-projects").textContent).toBe("code-foundry, ghostty-playground");
    // That the name takes the keyboard as the menu closes is real focus: e2e/project-sets.spec.ts.
    const name = within(dialog).getByTestId("save-workspace-name");
    fireEvent.change(name, { target: { value: "parser pair" } });
    fireEvent.submit(name.closest("form") as HTMLFormElement);
    await waitFor(() => {
      expect(screen.queryByTestId("save-workspace-dialog")).toBeNull();
    });
    expect(lastInvocation("workspace.new")?.args).toEqual({ name: "parser pair", projects: "repo-cf,repo-gp", primary: "repo-gp" });
    expect(lastInvocation("thread.workspace")?.args).toEqual({ workspace: "w-000000000001" });
    // Saved: the set matches a workspace now, so the item is gone.
    expect(setItems(openTitleMenu())).toEqual(["New thread on this branch"]);
  });

  it("Save as workspace refuses a taken name in place", async () => {
    setThread("s-pair", "Pair", ["repo-cf", "repo-gp"], "repo-cf");
    daemon.handlers.set("workspace.new", () => {
      throw refuse('a workspace named "taken" exists');
    });
    await renderThreadChrome("s-pair");
    fireEvent.click(within(openTitleMenu()).getByTestId("menu-save-workspace"));
    const dialog = await screen.findByTestId("save-workspace-dialog");
    fireEvent.change(within(dialog).getByTestId("save-workspace-name"), { target: { value: "Taken" } });
    fireEvent.click(within(dialog).getByTestId("save-workspace-submit"));
    expect((await within(dialog).findByTestId("save-workspace-error")).textContent).toContain('a workspace named "taken" exists');
    expect(screen.getByTestId("save-workspace-dialog")).toBeTruthy();
  });

  it("New thread on this branch from the row menu: the composer shows what the daemon copies, read-only; only the prompt and primary change", async () => {
    const ws = addWorkspace("shop", ["repo-cf", "repo-gp"], { id: "w-000000000001" });
    setThread("s-parser", "Parser", ["repo-cf", "repo-gp"], "repo-cf", { workspaceId: ws.id, branch: "feat/parser" });
    updateThread("s-parser", { status: "busy" });
    render(
      <>
        <ContextMenu>
          <ContextMenuTrigger data-testid="row">row</ContextMenuTrigger>
          <RowMenu id="s-parser" />
        </ContextMenu>
        <ComposeHost />
      </>,
    );
    fireEvent.contextMenu(screen.getByTestId("row"));
    fireEvent.click(within(screen.getByTestId("row-menu")).getByTestId("menu-new-like"));
    await settle();
    expect(screen.getByTestId("composer").dataset.like).toBe("s-parser");
    expect(heading()).toBe("What's next on feat/parser?");
    await waitFor(() => {
      expect(document.activeElement?.closest('[data-testid="composer-prompt"]')).not.toBeNull();
    });
    // What the daemon copies, read-only: the workspace, the set by id on the thread's branch, the mode.
    expect(screen.getByTestId("composer-workspace").textContent).toContain("shop");
    expect(screen.queryByTestId("composer-workspace-remove")).toBeNull();
    expect(chips()).toHaveLength(2);
    expect(screen.queryByTestId("composer-member-branch")).toBeNull();
    expect(screen.queryByTestId("composer-member-remove")).toBeNull();
    expect(screen.queryByTestId("composer-add-project")).toBeNull();
    expect(screen.getByTestId("composer-like-mode").textContent).toBe("On feat/parser");
    expect(screen.queryByTestId("composer-worktree")).toBeNull();
    expect(screen.queryByTestId("composer-base")).toBeNull();
    // The same checkouts as the thread it copies: said, not blocked; its mode is its thread's: nothing to switch.
    expect(screen.getByTestId("composer-collision").textContent).toContain("already being edited on feat/parser by another running thread.");
    expect(screen.queryByTestId("composer-collision-new-branch")).toBeNull();
    expect(screen.getByTestId("composer-like-mode").hasAttribute("data-warning")).toBe(true);
    // The primary is the thread's, changeable.
    expect(screen.getByTestId("composer-primary").textContent).toBe("code-foundry");
    const runIn = await openPicker("composer-primary");
    expect(options(runIn).map((o) => o.textContent)).toEqual([expect.stringMatching(/^Workspace folder/), expect.stringMatching(/^code-foundry/), expect.stringMatching(/^ghostty-playground/)]);
    fireEvent.click(option(runIn, "ghostty-playground"));
    await tick();
    await sendPrompt("Add the error cases");
    expect(lastInvocation("thread.new-like")?.args).toEqual({ ...BACKGROUND, id: "s-parser", project: "repo-gp", ...DEFAULTS, prompt: "Add the error cases" });
  });

  it("New thread on this branch from the title menu: one project in place, no primary", async () => {
    setThread("s-solo", "Solo", ["repo-cf"], "repo-cf");
    await renderThreadChrome("s-solo");
    const menu = openTitleMenu();
    // A single project: nothing to save.
    expect(setItems(menu)).toEqual(["New thread on this branch"]);
    fireEvent.click(within(menu).getByTestId("menu-new-like"));
    await settle();
    expect(screen.getByTestId("composer").dataset.like).toBe("s-solo");
    expect(heading()).toBe("What's next in code-foundry?");
    expect(chips()).toHaveLength(1);
    expect(screen.getByTestId("composer-like-mode").textContent).toBe("Project folder");
    expect(screen.queryByTestId("composer-primary")).toBeNull();
  });
});
