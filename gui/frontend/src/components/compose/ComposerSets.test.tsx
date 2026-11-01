// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceView } from "@/api/workspace";
import { Toaster } from "@/components/ui/sonner";
import { composeIn as storeComposeIn, composeLike, getDraft, updateDraft } from "@/stores/compose";
import { answerConfirm, useConfirmStore } from "@/stores/confirm";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { composeIn, openPicker, optionTexts, pickOption, promptValue, seedComposer, send, settle } from "@/test/composerWorld";
import { SelectedComposer } from "@/test/SelectedComposer";
import { daemon, invocationsOf, lastInvocation } from "@/test/daemonFakes";
import { addThreads, CF, GP, SK, thread, WR } from "@/test/projectsWorld";
import { hoverTooltipText, tooltipText } from "@/test/tooltip";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), ...(await import("@/test/composerFakes")).projectFakes }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), ...(await import("@/test/composerFakes")).filesystemFakes }));

const SHOP = "w-000000000001";

function workspace(id: string, name: string, members: string[], o: Partial<WorkspaceView> = {}): WorkspaceView {
  return { id, name, branch: "", members: members.map((projectId) => ({ projectId, worktreePath: "" })), createdAtMs: null, ...o };
}

function setWorkspaces(...ws: WorkspaceView[]): void {
  act(() => {
    useWorkspacesStore.setState({ byId: Object.fromEntries(ws.map((w) => [w.id, w])), order: ws.map((w) => w.id), loaded: true });
  });
}

const heading = () => screen.getByTestId("composer-heading").textContent;
const chips = () => screen.queryAllByTestId("composer-member");

/** Opens the heading's switcher and returns its list. */
async function openSwitcher(): Promise<HTMLElement> {
  act(() => {
    fireEvent.click(screen.getByTestId("composer-project-trigger"));
  });
  return await screen.findByTestId("composer-project-list");
}

async function clickRow(list: HTMLElement, selector: string): Promise<void> {
  const row = list.querySelector<HTMLElement>(selector);
  if (!row) throw new Error(`no row ${selector}`);
  act(() => {
    fireEvent.click(row);
  });
  await settle();
}

/** Toggles a project in Add project's multi-select list, then closes it. */
async function toggleProject(name: string): Promise<void> {
  const list = await openPicker("composer-add-project");
  await pickOption(list, name);
  act(() => {
    fireEvent.keyDown(list, { key: "Escape" });
  });
  await settle();
}

async function removeChip(name: string): Promise<void> {
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: `Remove ${name}` }));
  });
  await settle();
}

const type = (key: string, text: string) => {
  act(() => {
    updateDraft(key, { text });
  });
};

beforeEach(() => {
  seedComposer();
});

afterEach(() => {
  cleanup();
  act(() => {
    toast.dismiss();
  });
  useConfirmStore.setState({ pending: null });
});

describe("a picked workspace's set (composer-fixes.spec.ts 1, 1b, 4)", () => {
  beforeEach(() => {
    setWorkspaces(workspace(SHOP, "shop", ["repo-cf", "repo-dot"]));
    composeIn("repo-cf");
  });

  it("a project taken out leaves the workspace; the last one out is the empty state; a project picked again is sent alone", async () => {
    render(<SelectedComposer />);
    await settle();
    await clickRow(await openSwitcher(), `[data-workspace="${SHOP}"]`);
    expect(heading()).toBe("What should we build in shop?");
    expect(chips()).toHaveLength(2);
    expect(screen.getByTestId("composer-workspace").getAttribute("data-workspace")).toBe(SHOP);
    await removeChip("code-foundry");
    expect(screen.queryByTestId("composer-workspace")).toBeNull();
    expect(heading()).toBe("What should we build in dotfiles?");

    // The last project out (a lone project has no chip: Add project's list toggles it).
    await toggleProject("dotfiles");
    expect(heading()).toBe("Pick a project");
    expect(chips()).toHaveLength(0);
    expect(screen.getByTestId("composer-empty-note").textContent).toBe("Pick a project or a workspace to start the thread in.");
    expect(screen.queryByTestId("composer-worktree")).toBeNull();
    expect(screen.queryByTestId("composer-primary")).toBeNull();
    type("repo-cf", "Ship it");
    expect(screen.getByTestId("composer-send")).toHaveProperty("disabled", true);
    fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter" });
    await settle();
    expect(invocationsOf("thread.new")).toEqual([]);

    await toggleProject("ghostty-playground");
    expect(heading()).toBe("What should we build in ghostty-playground?");
    expect(screen.getByTestId("composer-send")).toHaveProperty("disabled", false);
    await send();
    const args = lastInvocation("thread.new")?.args;
    expect(args).toMatchObject({ project: "repo-gp", prompt: "Ship it" });
    expect(args).not.toHaveProperty("workspace");
    expect(args).not.toHaveProperty("projects");
  });

  it("a project added leaves the workspace too; taken out again, the workspace is back; added and sent: the set, no workspace", async () => {
    render(<SelectedComposer />);
    await settle();
    await clickRow(await openSwitcher(), `[data-workspace="${SHOP}"]`);
    const list = await openPicker("composer-add-project");
    await pickOption(list, "ghostty-playground");
    expect(screen.queryByTestId("composer-workspace")).toBeNull();
    expect(heading()).toBe("What should we build in 3 projects?");
    await pickOption(list, "ghostty-playground");
    expect(screen.getByTestId("composer-workspace").getAttribute("data-workspace")).toBe(SHOP);
    expect(heading()).toBe("What should we build in shop?");
    await pickOption(list, "ghostty-playground");
    type("repo-cf", "Ship it");
    await send();
    const args = lastInvocation("thread.new")?.args ?? {};
    expect(args).toMatchObject({ prompt: "Ship it" });
    expect(String(args.projects).split(",").sort()).toEqual(["repo-cf", "repo-dot", "repo-gp"]);
    expect(args).not.toHaveProperty("workspace");
  });

  it("cmd+N on a project with an empty draft starts from that project; a draft with text keeps its set and says which", async () => {
    setWorkspaces(workspace(SHOP, "shop", ["repo-gp", "repo-dot"]));
    render(<SelectedComposer />);
    await settle();
    await clickRow(await openSwitcher(), `[data-workspace="${SHOP}"]`);
    expect(heading()).toBe("What should we build in shop?");
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "s-1" });
    });
    act(() => {
      storeComposeIn("repo-cf");
    });
    expect(heading()).toBe("What should we build in code-foundry?");
    expect(screen.queryByTestId("composer-workspace")).toBeNull();

    await clickRow(await openSwitcher(), `[data-workspace="${SHOP}"]`);
    type("repo-cf", "Keep this");
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "s-1" });
    });
    act(() => {
      storeComposeIn("repo-cf");
    });
    expect(heading()).toBe("What should we build in shop?");
    expect(promptValue()).toBe("Keep this");
  });
});

describe("a set without a git project (composer-fixes.spec.ts 3)", () => {
  it("one member: no fresh copies, the note, sent in place with its projects; a workspace without projects: its folder, no projects list", async () => {
    seedComposer({ "threads.default_worktree": "new" });
    setWorkspaces(workspace("w-folders", "folders", ["repo-wr"]), workspace("w-zero", "zero", [], { rootPath: "/Users/dev/zero" }));
    act(() => {
      useUiStore.getState().select({ kind: "compose", projectId: "repo-wr", workspaceId: "w-folders" });
    });
    const { unmount } = render(<SelectedComposer />);
    await settle();
    expect(heading()).toBe("What should we build in folders?");
    // One member: singular.
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Project folder");
    expect(screen.getByTestId("composer-nogit-note").textContent).toBe("No git repository in this set: it runs in place");
    const list = await openPicker("composer-worktree");
    expect(optionTexts(list)).toEqual(["Project folderEdits land in the project's checkout directly. One thread at a time is safest."]);
    act(() => {
      fireEvent.keyDown(list, { key: "Escape" });
    });
    type("ws:w-folders", "Tidy the notes");
    await send();
    expect(lastInvocation("thread.new")?.args).toMatchObject({ projects: "repo-wr", workspace: "w-folders", "new-worktree": "false" });
    unmount();

    act(() => {
      useUiStore.getState().select({ kind: "compose", projectId: "", workspaceId: "w-zero" });
    });
    render(<SelectedComposer />);
    await settle();
    expect(heading()).toBe("What should we build in zero?");
    expect(screen.getByTestId("composer-nogit-note")).not.toBeNull();
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Project folder");
    type("ws:w-zero", "Plan the next quarter");
    await send();
    expect(invocationsOf("thread.new")).toHaveLength(2);
    const args = lastInvocation("thread.new")?.args;
    expect(args).toMatchObject({ project: "workspace", workspace: "w-zero", "new-worktree": "false" });
    expect(args).not.toHaveProperty("projects");
    expect(screen.queryByTestId("composer-error")).toBeNull();
  });
});

describe("New thread on this branch (composer-fixes.spec.ts 2, 7, 8, 9, 14, 15)", () => {
  it("in place in a workspace: its name, the read-only pill's role, Workspace folder as the primary; sent as thread.new-like", async () => {
    setWorkspaces(workspace(SHOP, "shop", ["repo-cf", "repo-gp"]));
    addThreads(thread("s-set-1", { name: "Shop member", state: "connected", projectIds: ["repo-cf", "repo-gp"], workspaceId: SHOP, checkoutPaths: [{ projectId: "repo-cf", path: CF }, { projectId: "repo-gp", path: GP }] }));
    act(() => {
      composeLike("s-set-1");
    });
    render(<SelectedComposer />);
    await settle();
    expect(screen.getByTestId("composer").getAttribute("data-like")).toBe("s-set-1");
    expect(heading()).toBe("What's next in shop?");
    const pill = screen.getByTestId("composer-like-mode");
    expect(pill.textContent).toBe("Project folders");
    expect(pill.className).toMatch(/\btext-body-sm\b/);
    expect(pill.querySelector(".font-mono")).toBeNull();
    expect(screen.getByTestId("composer-primary").textContent).toBe("code-foundry");
    const list = await openPicker("composer-primary");
    expect(optionTexts(list)).toEqual(["Workspace foldershop's folder", "code-foundry", "ghostty-playground"]);
    await pickOption(list, "Workspace folder");
    expect(screen.getByTestId("composer-primary").textContent).toBe("Workspace folder");
    type("like:s-set-1", "Write the shop notes");
    await send();
    expect(lastInvocation("thread.new-like")?.args).toMatchObject({ id: "s-set-1", project: "workspace", prompt: "Write the shop notes" });
  });

  it("a single-project like reads the project's name; a branch keeps the branch form, mono for the branch only", async () => {
    addThreads(
      thread("s-solo", { name: "Solo", projectIds: ["repo-cf"], checkoutPaths: [{ projectId: "repo-cf", path: CF }] }),
      thread("s-wt", { name: "Parser", projectIds: ["repo-cf", "repo-gp"], branch: "feat/parser", createdWorktree: true, worktreePath: `${CF}.worktrees/feat-parser` }),
    );
    act(() => {
      composeLike("s-solo");
    });
    render(<SelectedComposer />);
    await settle();
    expect(heading()).toBe("What's next in code-foundry?");
    act(() => {
      composeLike("s-wt");
    });
    await settle();
    expect(heading()).toBe("What's next on feat/parser?");
    expect(screen.getByTestId("composer-like-mode").textContent).toBe("On feat/parser");
    expect(screen.getByTestId("composer-like-mode").querySelector(".font-mono")?.textContent).toBe("feat/parser");
  });

  it("a like draft whose thread is removed becomes a plain draft with the text, and says so", async () => {
    render(<Toaster />);
    addThreads(thread("s-src", { name: "Src", projectId: "repo-gp", projectIds: ["repo-cf", "repo-gp"], worktreePath: GP, checkoutPaths: [{ projectId: "repo-cf", path: CF }, { projectId: "repo-gp", path: GP }] }));
    act(() => {
      composeLike("s-src");
    });
    render(<SelectedComposer />);
    await settle();
    expect(screen.getByTestId("composer").getAttribute("data-like")).toBe("s-src");
    type("like:s-src", "Carry on");
    act(() => {
      useThreadsStore.setState((s) => {
        const { "s-src": _gone, ...byId } = s.byId;
        return { byId, order: s.order.filter((id) => id !== "s-src") };
      });
    });
    await settle();
    expect(await screen.findByText("Thread Src was removed; starting fresh")).not.toBeNull();
    expect(screen.getByTestId("composer").hasAttribute("data-like")).toBe(false);
    expect(heading()).toBe("What should we build in 2 projects?");
    expect(promptValue()).toBe("Carry on");
    expect(chips()).toHaveLength(2);
    expect(screen.getByTestId("composer-primary").textContent).toBe("ghostty-playground");
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Project folders");
  });
});

describe("collisions (composer-collision.spec.ts, composer-fixes.spec.ts 11, 13)", () => {
  it("a set: 2 of 3 projects, one banner, the pill and the two chips name the threads; a new branch shares nothing", async () => {
    // s-1 works in code-foundry's folder, s-2 in ghostty-playground's; s-6 (dotfiles) is closing, s-8 and s-9 snoozed.
    addThreads(thread("s-2", { projectId: "repo-gp", worktreePath: GP, name: "Port renderer", state: "connected", status: "idle" }));
    composeIn("repo-cf");
    render(<SelectedComposer />);
    await settle();
    await toggleProject("ghostty-playground");
    await toggleProject("dotfiles");
    await pickOption(await openPicker("composer-worktree"), "Project folders");

    const banners = screen.getAllByTestId("composer-collision");
    expect(banners).toHaveLength(1);
    expect(screen.getByTestId("composer-collision-text").textContent).toBe(
      "2 of 3 projects are already being edited on main by another running thread. Multiple agents changing the same file at the same time can overwrite each other's work.",
    );
    expect(banners[0]?.querySelector(".font-mono")?.textContent).toBe("main");

    const pill = screen.getByTestId("composer-worktree");
    expect(pill.getAttribute("data-warning")).toBe("");
    expect(tooltipText(pill)).toBe("code-foundry · main is open in Refactor sidebar tree (working)ghostty-playground · main is open in Port renderer (idle)");
    act(() => {
      pill.blur();
    });
    await settle();
    const warned = chips().filter((c) => c.querySelector('[data-testid="composer-member-warning"]'));
    expect(warned.map((c) => c.dataset.project)).toEqual(["repo-cf", "repo-gp"]);
    expect(chips().find((c) => c.dataset.project === "repo-dot")?.hasAttribute("data-warning")).toBe(false);
    const gpWarning = chips()
      .find((c) => c.dataset.project === "repo-gp")
      ?.querySelector<HTMLElement>('[data-testid="composer-member-warning"]');
    expect(gpWarning && (await hoverTooltipText(gpWarning))).toBe("ghostty-playground · main is open in Port renderer (idle)");

    act(() => {
      fireEvent.click(screen.getByTestId("composer-collision-new-branch"));
    });
    await settle();
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Fresh copies");
    expect(screen.queryByTestId("composer-collision")).toBeNull();
    expect(screen.queryByTestId("composer-member-warning")).toBeNull();
  });

  it("the collisions the banner showed are not toasted again; a chip is the project's name alone, with no tooltip", async () => {
    render(<Toaster />);
    addThreads(thread("s-set-1", { name: "Busy one", projectId: "repo-sk", worktreePath: SK, state: "connected", status: "busy", projectIds: ["repo-sk", "repo-wr"], checkoutPaths: [{ projectId: "repo-sk", path: SK }, { projectId: "repo-wr", path: WR }] }));
    // The daemon's hints for the same checkouts, as thread.new answers them.
    daemon.handlers.set("thread.new", () => ({
      message: "",
      resultJson: JSON.stringify({ id: "s-new-1" }),
      warnings: ["sketches @ main is also open in Busy one (s-set-1)", "writing is also open in Busy one (s-set-1)"],
    }));
    composeIn("repo-sk");
    render(<SelectedComposer />);
    await settle();
    await toggleProject("writing");
    expect(screen.getByTestId("composer-collision-text").textContent).toContain("2 of 2 projects are already being edited by another running thread.");
    const body = chips()
      .find((c) => c.dataset.project === "repo-sk")
      ?.querySelector<HTMLElement>('[data-testid="composer-member-body"]');
    expect(body?.textContent).toBe("sketches");
    if (!body) throw new Error("no sketches chip");
    // No tooltip on hover (the pickers say where it runs): past the open delay, none showed.
    fireEvent.pointerMove(body, { pointerType: "mouse" });
    await new Promise((r) => setTimeout(r, 700));
    expect(screen.queryByRole("tooltip")).toBeNull();
    type("repo-sk", "Pair on the parser");
    await send();
    expect(screen.getByTestId("selected-thread").textContent).toBe("s-new-1");
    expect(screen.queryByText(/is also open in Busy one/)).toBeNull();
  });
});

describe("the heading's set picker (composer-switch.spec.ts)", () => {
  beforeEach(() => {
    seedComposer({ "threads.default_worktree": "new" });
    composeIn("repo-cf");
  });

  it("the current project checked, no hints; a project row is the whole set, the draft kept; sent as that project alone", async () => {
    render(<SelectedComposer />);
    await settle();
    const trigger = screen.getByTestId("composer-project-trigger");
    expect(trigger.getAttribute("aria-label")).toBe("Change projects");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    type("repo-cf", "Port the login form");
    await pickOption(await openPicker("composer-model"), "Haiku 4.5");

    let list = await openSwitcher();
    expect(screen.getByPlaceholderText("Switch to a workspace or project…")).not.toBeNull();
    // No workspaces: no group heading; the same rows as cmd+N without the cmd+1..9 hints.
    expect(list.querySelectorAll("[cmdk-group-heading]")).toHaveLength(0);
    expect(list.querySelectorAll("[data-project]")).toHaveLength(5);
    expect(list.querySelectorAll('[data-slot="command-shortcut"]')).toHaveLength(0);
    expect(list.querySelector('[data-testid="project-source"]')?.textContent).toBe("alexwaumann/code-foundry · ~/src/code-foundry");
    expect(list.querySelector('[data-project="repo-cf"]')?.getAttribute("data-current")).toBe("true");
    expect(list.querySelector('[data-project="repo-cf"] [data-testid="picker-current"]')).not.toBeNull();
    expect(list.querySelectorAll("[data-current]")).toHaveLength(1);

    await clickRow(list, '[data-project="repo-gp"]');
    expect(screen.queryByTestId("composer-project-list")).toBeNull();
    expect(heading()).toBe("What should we build in ghostty-playground?");
    expect(promptValue()).toBe("Port the login form");
    expect(screen.getByTestId("composer-model").textContent).toBe("Haiku 4.5");
    expect(chips()).toHaveLength(0);
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Fresh copy");

    // A set of two: nothing checked (the set is not one row); the heading's project row still replaces it all.
    await toggleProject("code-foundry");
    expect(heading()).toBe("What should we build in 2 projects?");
    list = await openSwitcher();
    expect(list.querySelectorAll("[data-current]")).toHaveLength(0);
    await clickRow(list, '[data-project="repo-gp"]');
    expect(heading()).toBe("What should we build in ghostty-playground?");
    expect(chips()).toHaveLength(0);
    await send();
    const args = lastInvocation("thread.new")?.args ?? {};
    expect(args).toMatchObject({ project: "repo-gp", "new-worktree": "true", model: "claude-4.5-haiku[1m]", prompt: "Port the login form" });
    expect(args.projects).toBeUndefined();
    // The draft was code-foundry's composer's: it is clear now.
    expect(getDraft("repo-cf").text).toBe("");
  });

  it("No project moves the draft, and a project row moves it back", async () => {
    render(<SelectedComposer />);
    await settle();
    type("repo-cf", "Plan the week");
    await clickRow(await openSwitcher(), '[data-testid="picker-no-project"]');
    expect(screen.queryByTestId("composer-project-list")).toBeNull();
    expect(heading()).toBe("What should we build with No project?");
    expect(promptValue()).toBe("Plan the week");

    const list = await openSwitcher();
    expect(list.querySelector('[data-testid="picker-no-project"]')?.getAttribute("data-current")).toBe("true");
    await clickRow(list, '[data-project="repo-gp"]');
    expect(heading()).toBe("What should we build in ghostty-playground?");
    expect(promptValue()).toBe("Plan the week");
    expect(getDraft("repo-cf").text).toBe("");
  });

  it("taking a project out asks first when the text has its tags; Cancel keeps both, Confirm drops its tags only", async () => {
    render(<SelectedComposer />);
    await settle();
    await toggleProject("sketches");
    const CFT = "[/deploy](cf-skill://repo-cf/deploy)";
    const SKT = "[/deploy](cf-skill://repo-sk/deploy)";
    const USER = "[/commit](cf-skill://~/commit)";
    type("repo-cf", `${CFT} ${SKT} ${USER} `);

    fireEvent.click(screen.getByRole("button", { name: "Remove code-foundry" }));
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    expect(useConfirmStore.getState().pending).toMatchObject({ title: "Remove code-foundry from the thread?", message: "1 reference to code-foundry in your text will be removed." });
    act(() => {
      answerConfirm(false);
    });
    await settle();
    expect(promptValue()).toBe(`${CFT} ${SKT} ${USER} `);
    expect(chips()).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove code-foundry" }));
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    act(() => {
      answerConfirm(true);
    });
    await settle();
    expect(heading()).toBe("What should we build in sketches?");
    // sketches stays, so its tag stays; the user's skill always does.
    expect(promptValue()).toBe(`${SKT} ${USER}`);
  });

  it("without references, taking a project out asks nothing (composer-skills.spec.ts)", async () => {
    render(<SelectedComposer />);
    await settle();
    await toggleProject("sketches");
    await removeChip("sketches");
    expect(useConfirmStore.getState().pending).toBeNull();
    expect(chips()).toHaveLength(0);
  });
});
