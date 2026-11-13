import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { ConfirmDialog } from "@/components/confirm/ConfirmDialog";
import { SaveWorkspaceDialog } from "@/components/thread/SaveWorkspaceDialog";
import { ThreadCrumb } from "@/components/thread/ThreadParts";
import { useThreadsStore } from "@/stores/threads";
import { card } from "@/test/cardFakes";
import { confirmFirst, daemon, invocationsOf, resetDaemon } from "@/test/daemonFakes";
import { addThreads, addWorkspace, addWorktrees, HOME, thread, worktree } from "@/test/projectsWorld";
import { resetCard, selectThread, updateThread } from "@/test/threadInfoWorld";
import { tooltipText } from "@/test/tooltip";
import { PlaceGroup } from "./PlaceGroup";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/actions", async (orig) => ({ ...(await orig<typeof import("@/api/actions")>()), ...(await import("@/test/cardFakes")).cardActionFakes }));
vi.mock("@/api/gitops", async (orig) => ({ ...(await orig<typeof import("@/api/gitops")>()), ...(await import("@/test/cardFakes")).cardGitopsFakes }));
vi.mock("@/api/placement", async (orig) => ({ ...(await orig<typeof import("@/api/placement")>()), ...(await import("@/test/cardFakes")).cardPlacementFakes }));

/**
 * A thread's project set on the fly from the thread info card (docs/notes/thread-project-set.md):
 * Add project, Save as workspace or Use workspace, Run in's × and a member whose worktree
 * moved. The daemon's own rules (leaving the workspace, the dirty-checkout question, the
 * placement refusal) are Go's: internal/command/commands_thread_project_test.go,
 * internal/store/thread/members_test.go, placement_check_test.go. Here the faked daemon
 * answers the way its events would.
 */

/** Where the daemon's DefaultWorktreePath puts a project's worktree for a branch. */
const worktreeOf = (slug: string, branch: string) => `${HOME}/.code-foundry/worktrees/${slug}/${branch.replaceAll("/", "-")}`;
const SLUGS: Readonly<Record<string, string>> = { "repo-cf": "alexwaumann/code-foundry", "repo-gp": "alexwaumann/ghostty-playground", "repo-sk": "dev/sketches", "repo-dot": "dev/dotfiles" };
const ID = "s-multi";

/** A worktree-mode thread on feat/x over `projects` (worktrees made), in `workspaceId` when given. */
function seedMulti(projects: string[], primary: string, workspaceId = ""): void {
  const ids = [...projects].sort();
  for (const p of ids) addWorktrees(p, worktree(p, worktreeOf(SLUGS[p] ?? p, "feat/x"), "feat/x"));
  addThreads(
    thread(ID, {
      projectId: primary,
      worktreePath: worktreeOf(SLUGS[primary] ?? primary, "feat/x"),
      name: "multi",
      createdWorktree: true,
      branch: "feat/x",
      projectIds: ids,
      checkoutPaths: ids.map((p) => ({ projectId: p, path: worktreeOf(SLUGS[p] ?? p, "feat/x") })),
      workspaceId,
      flags: [],
      createdBy: "",
      createdByName: "",
    }),
  );
  selectThread(ID);
}

const t = (): ThreadView => useThreadsStore.getState().byId[ID] as ThreadView;

/** The daemon's thread.project.add and .remove: the set changes and the thread leaves its workspace. */
function daemonChangesSets(): void {
  daemon.handlers.set("thread.project.add", (inv) => {
    const p = inv.args.project ?? "";
    updateThread(ID, { projectIds: [...t().projectIds, p].sort(), checkoutPaths: [...t().checkoutPaths, { projectId: p, path: worktreeOf(SLUGS[p] ?? p, "feat/x") }], workspaceId: "" });
    return { message: "", resultJson: "" };
  });
  daemon.handlers.set("thread.project.remove", (inv) => {
    const p = inv.args.project ?? "";
    updateThread(ID, { projectIds: t().projectIds.filter((x) => x !== p), checkoutPaths: t().checkoutPaths.filter((c) => c.projectId !== p), workspaceId: "" });
    return { message: "", resultJson: "" };
  });
  daemon.handlers.set("thread.workspace", (inv) => {
    updateThread(ID, { workspaceId: inv.args.workspace ?? "" });
    return { message: "", resultJson: "" };
  });
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function renderPlace(): Promise<void> {
  render(
    <>
      <ThreadCrumb id={ID} />
      <PlaceGroup threadId={ID} />
      <SaveWorkspaceDialog />
      <ConfirmDialog />
      <Toaster />
    </>,
  );
  await tick();
}

/** The project row's menu, open. */
async function openProjectMenu(): Promise<HTMLElement> {
  fireEvent.pointerDown(screen.getByTestId("ti-project"), { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.findByTestId("ti-project-menu");
}

async function pick(item: HTMLElement): Promise<void> {
  fireEvent.click(item);
  await tick();
}

/** Add project's list, open from the menu. */
async function openAddList(): Promise<HTMLElement> {
  await pick(within(await openProjectMenu()).getByTestId("ti-add-project"));
  return screen.findByTestId("ti-add-project-picker-list");
}

const options = (list: HTMLElement) => within(list).queryAllByRole("option");
const crumb = () => screen.getByTestId("thread-crumb");
const runIn = (menu: HTMLElement, project: string) => menu.querySelector<HTMLElement>(`[data-testid="ti-runin-item"][data-project="${project}"]`) as HTMLElement;

beforeEach(() => {
  resetDaemon();
  resetCard();
  daemonChangesSets();
});

afterEach(() => {
  toast.dismiss();
  cleanup();
});

describe("the card's project set", () => {
  it("Add project: one pick adds and closes the list, the thread leaves its workspace, then Save as workspace attaches it to the new one", async () => {
    addWorkspace("login", ["repo-cf", "repo-gp"], { id: "w-login" });
    seedMulti(["repo-cf", "repo-gp"], "repo-gp", "w-login");
    await renderPlace();
    expect(crumb().dataset.icon).toBe("layers");
    expect(screen.getByTestId("thread-crumb-place").textContent).toBe("login");

    // A named workspace: nothing to save.
    expect(within(await openProjectMenu()).queryByTestId("ti-save-workspace")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("ti-project-menu"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("ti-project-menu")).toBeNull();
    });
    const list = await openAddList();
    // Only the projects not in the set are listed; a pick adds one and the list closes.
    expect(options(list).map((o) => o.textContent)).toEqual([expect.stringMatching(/^dotfiles/), expect.stringMatching(/^sketches/), expect.stringMatching(/^writing/)]);
    await pick(options(list).find((o) => o.textContent.startsWith("dotfiles")) as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByTestId("ti-add-project-picker-list")).toBeNull();
    });
    expect(invocationsOf("thread.project.add").map((i) => [i.args, i.context.activeThreadId])).toEqual([[{ project: "repo-dot" }, ID]]);
    expect(screen.getByTestId("ti-project").textContent).toContain("+2");
    // The next add is another pick; dotfiles is no longer offered.
    const next = await openAddList();
    expect(options(next).map((o) => o.textContent.split("~")[0])).toEqual(["sketches", "writing"]);
    await pick(options(next)[0] as HTMLElement);
    await waitFor(() => {
      expect(invocationsOf("thread.project.add")).toHaveLength(2);
    });
    await pick(options(await openAddList())[0] as HTMLElement);
    await waitFor(() => {
      expect(invocationsOf("thread.project.add")).toHaveLength(3);
    });
    // The last one in: the list says every project is in the thread.
    const full = await openAddList();
    expect(full.textContent).toContain("Every project is in this thread.");
    expect(options(full)).toHaveLength(0);
    fireEvent.keyDown(full, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("ti-add-project-picker-list")).toBeNull();
    });

    // Out of the workspace: the crumb is the unnamed form, the card's workspace row is gone.
    expect(crumb().dataset.icon).toBe("folders");
    expect(screen.getByTestId("thread-crumb-place").textContent).toBe("ghostty-playground +4");
    expect(screen.queryByTestId("ti-workspace")).toBeNull();

    // Save as workspace is offered now; the thread then references the new workspace.
    daemon.handlers.set("workspace.new", (inv) => {
      const w = addWorkspace(inv.args.name ?? "", (inv.args.projects ?? "").split(","), { id: "w-quad" });
      return { message: "", resultJson: JSON.stringify({ id: w.id }) };
    });
    await pick(within(await openProjectMenu()).getByTestId("ti-save-workspace"));
    const dialog = await screen.findByTestId("save-workspace-dialog");
    fireEvent.change(within(dialog).getByTestId("save-workspace-name"), { target: { value: "quad" } });
    fireEvent.click(within(dialog).getByTestId("save-workspace-submit"));
    await waitFor(() => {
      expect(screen.queryByTestId("save-workspace-dialog")).toBeNull();
    });
    expect(invocationsOf("workspace.new").map((i) => i.args)).toEqual([{ name: "quad", projects: "repo-cf,repo-dot,repo-gp,repo-sk,repo-wr", primary: "repo-gp" }]);
    expect(invocationsOf("thread.workspace").map((i) => i.args)).toEqual([{ workspace: "w-quad" }]);
    expect(crumb().dataset.icon).toBe("layers");
    expect(screen.getByTestId("thread-crumb-place").textContent).toBe("quad");
    expect(screen.getByTestId("ti-workspace").textContent).toContain("quad");
  });

  it("Use workspace: a set that equals a saved workspace is offered that workspace, not a save", async () => {
    addWorkspace("login", ["repo-cf", "repo-gp"], { id: "w-login" });
    seedMulti(["repo-cf", "repo-gp", "repo-sk"], "repo-gp");
    await renderPlace();
    expect(crumb().dataset.icon).toBe("folders");
    // Three projects match no workspace: Save as workspace.
    const menu = await openProjectMenu();
    expect(within(menu).getByTestId("ti-save-workspace")).toBeTruthy();
    expect(within(menu).queryByTestId("ti-use-workspace")).toBeNull();
    fireEvent.click(within(runIn(menu, "repo-sk")).getByTestId("ti-runin-remove"));
    await tick();
    expect(invocationsOf("thread.project.remove").map((i) => [i.args, i.context.activeThreadId])).toEqual([[{ project: "repo-sk" }, ID]]);
    // Down to login's two: Use workspace login takes the save's place, and attaches the thread.
    const again = await openProjectMenu();
    expect(within(again).queryByTestId("ti-save-workspace")).toBeNull();
    const use = within(again).getByTestId("ti-use-workspace");
    expect(use.textContent).toBe("Use workspace login");
    await pick(use);
    expect(invocationsOf("thread.workspace").map((i) => [i.args.workspace, i.context.activeThreadId])).toEqual([["w-login", ID]]);
    expect(crumb().dataset.icon).toBe("layers");
    expect(screen.getByTestId("ti-workspace").textContent).toContain("login");
  });

  it("Remove from this thread: a × on every member but the cwd's, no Run in; a checkout the daemon asks about goes once confirmed", async () => {
    seedMulti(["repo-cf", "repo-gp", "repo-sk"], "repo-gp");
    await renderPlace();
    const menu = await openProjectMenu();
    expect(within(menu).getAllByTestId("ti-runin-item")).toHaveLength(3);
    expect(within(runIn(menu, "repo-gp")).queryByTestId("ti-runin-remove")).toBeNull();
    const x = within(runIn(menu, "repo-sk")).getByTestId("ti-runin-remove");
    // The × says what it does.
    expect(x.getAttribute("aria-label")).toBe("Remove sketches from this thread");
    expect(tooltipText(x)).toBe("Remove project");
    fireEvent.click(x);
    await tick();
    expect(invocationsOf("thread.project.remove").map((i) => [i.args, i.context.activeThreadId])).toEqual([[{ project: "repo-sk" }, ID]]);
    // The × is only a removal: the thread did not run in sketches (the item's own select).
    expect(invocationsOf("thread.run-in")).toEqual([]);

    // The daemon asks first (uncommitted work, its words); confirmed, it goes.
    const remove = daemon.handlers.get("thread.project.remove");
    confirmFirst("thread.project.remove", "code-foundry's checkout has uncommitted work; this thread no longer sees it once removed.", (inv) => (remove ? remove(inv) : { message: "", resultJson: "" }));
    const again = await openProjectMenu();
    expect(within(again).getAllByTestId("ti-runin-item")).toHaveLength(2);
    fireEvent.click(within(runIn(again, "repo-cf")).getByTestId("ti-runin-remove"));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("has uncommitted work");
    fireEvent.click(within(dialog).getByTestId("confirm-ok"));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    });
    expect(invocationsOf("thread.project.remove").map((i) => [i.args.project, i.confirmed])).toEqual([
      ["repo-sk", false],
      ["repo-cf", false],
      ["repo-cf", true],
    ]);
    // One project left: the menu has no Run in.
    expect(within(await openProjectMenu()).queryByTestId("ti-runin-item")).toBeNull();
  });

  it("a member whose worktree moved is greyed in Run in with the move in plain words, and still runs there", async () => {
    seedMulti(["repo-cf", "repo-gp"], "repo-cf");
    const gp = worktreeOf("alexwaumann/ghostty-playground", "feat/x");
    addWorktrees("repo-gp", worktree("repo-gp", gp, "other"));
    card.refusals.set("repo-gp", `failed precondition: ghostty-playground's worktree for feat/x at ${gp} has other checked out now`);
    await renderPlace();
    const menu = await openProjectMenu();
    await waitFor(() => {
      expect(runIn(menu, "repo-gp").hasAttribute("data-refused")).toBe(true);
    });
    const item = runIn(menu, "repo-gp");
    expect(item.textContent).toBe("ghostty-playground @ other");
    expect(runIn(menu, "repo-cf").hasAttribute("data-refused")).toBe(false);
    // The thread's own checkout: the move in plain words, not the daemon's refusal naming this thread.
    expect(tooltipText(item)).toBe("This checkout moved from feat/x to other; a new thread on feat/x would be refused here.");
    await pick(item);
    expect(invocationsOf("thread.run-in").map((i) => [i.args.project, i.context.activeThreadId])).toEqual([["repo-gp", ID]]);
  });
});
