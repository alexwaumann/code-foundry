// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import type { WorkspaceView } from "@/api/workspace";
import { daemon, invocationsOf, refuse, resetDaemon } from "@/test/daemonFakes";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
// No daemon: refs never load (the pickers show them loading).
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), listRefs: () => new Promise(() => undefined) }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { ThreadCrumb } = await import("./ThreadParts");
const { ThreadHeader } = await import("./ThreadHeader");
const { useMovePickerStore, openMovePicker, canMoveThread } = await import("@/stores/movePicker");
const { useCanMove } = await import("./useNoProject");
const { useProjectsStore } = await import("@/stores/projects");
const { useSettingsStore } = await import("@/stores/settings");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");
const { useWorkspacesStore } = await import("@/stores/workspaces");

const project = (id: string, o: Partial<ProjectView> = {}): ProjectView => ({
  id,
  path: `/Users/me/src/${id}`,
  name: id,
  defaultBranch: "main",
  githubSlug: "",
  remotes: [],
  git: true,
  worktrees: [{ projectId: id, path: `/Users/me/src/${id}`, branch: "main", head: "abc", detached: false, isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null } }],
  ...o,
});

const home = (o: Partial<ThreadView> = {}) =>
  ({
    id: "s-1",
    name: "Plan the week",
    projectId: "",
    worktreePath: "/Users/me",
    workspaceId: "",
    projectIds: [],
    checkoutPaths: [],
    branch: "",
    pendingWorktreePath: "",
    pendingMove: null,
    pinned: false,
    archivedAtMs: null,
    snoozedUntilMs: null,
    createdBy: "",
    createdByName: "",
    parentId: "",
    flags: [],
    naming: false,
    nameProvisional: false,
    ...o,
  }) as ThreadView;

const workspace: WorkspaceView = { id: "w-1", name: "platform", branch: "", members: [{ projectId: "api", worktreePath: "" }, { projectId: "web", worktreePath: "" }], createdAtMs: null };

function setThread(o: Partial<ThreadView> = {}): void {
  act(() => {
    useThreadsStore.setState({ byId: { "s-1": home(o) }, order: ["s-1"], loaded: true });
  });
}

function setWorkIn(v: "new" | "current"): void {
  useSettingsStore.setState({ snapshot: { values: { "threads.default_worktree": v }, sources: {} } as never });
}

beforeEach(() => {
  resetDaemon();
  useProjectsStore.setState({ byId: { web: project("web"), api: project("api"), notes: project("notes", { git: false }) }, order: ["web", "api", "notes"], loaded: true });
  useWorkspacesStore.setState({ byId: { "w-1": workspace }, order: ["w-1"], loaded: true });
  useMovePickerStore.setState({ open: null, sending: {} });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
  setWorkIn("new");
  setThread();
  if (typeof Element.prototype.scrollIntoView !== "function") Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const crumb = () => screen.getByTestId("thread-crumb-place").textContent;
const picker = () => screen.getByTestId("move-picker");

function openPicker(): HTMLElement {
  render(<ThreadCrumb id="s-1" />);
  fireEvent.click(screen.getByTestId("thread-crumb-move"));
  return picker();
}

/** Picks a row of step 1 (a project id, or "platform" for the workspace) with a click. */
function pick(id: string): HTMLElement {
  const row = picker().querySelector(id === "platform" ? '[data-workspace="w-1"]' : `[data-project="${id}"]`);
  if (!row) throw new Error(`no row ${id}`);
  fireEvent.click(row);
  return screen.getByTestId("move-placement");
}

describe("the crumb as the move picker's trigger", () => {
  it("No project is a trigger; a project thread's place, and an archived thread's, is not", () => {
    render(<ThreadCrumb id="s-1" />);
    expect(screen.getByTestId("thread-crumb-move").textContent).toContain("No project");
    cleanup();
    setThread({ archivedAtMs: 1 });
    render(<ThreadCrumb id="s-1" />);
    expect(screen.queryByTestId("thread-crumb-move")).toBeNull();
    expect(crumb()).toBe("No project");
    cleanup();
    setThread({ projectId: "web", projectIds: ["web"], worktreePath: "/Users/me/src/web" });
    render(<ThreadCrumb id="s-1" />);
    expect(screen.queryByTestId("thread-crumb-move")).toBeNull();
  });

  it("step 1: the filter, workspaces (N projects) above projects (No git for a plain folder), and the footer", () => {
    const p = openPicker();
    expect(p.dataset.step).toBe("1");
    expect(within(p).getByTestId("move-filter").getAttribute("placeholder")).toBe("Move to a project or workspace…");
    const groups = [...p.querySelectorAll("[cmdk-group-heading]")].map((g) => g.textContent);
    expect(groups).toEqual(["Workspaces", "Projects"]);
    expect(p.querySelector('[data-workspace="w-1"]')?.textContent).toBe("platform2 projects");
    expect(p.querySelector('[data-project="notes"]')?.textContent).toBe("NOnotesNo git");
    expect(p.querySelector('[data-project="web"]')?.textContent).toBe("WEweb");
    expect(within(p).getByTestId("move-footer").textContent).toBe("Claude keeps the conversation and carries on there.");
  });
});

describe("step 2: where it works there", () => {
  it("a project: back, its name and path, the composer's Work in with the setting's default, Branch from, the line, and Move", () => {
    openPicker();
    const step = pick("web");
    expect(picker().dataset.step).toBe("2");
    expect(within(step).getByTestId("move-name").textContent).toBe("web");
    expect(within(step).getByTestId("move-detail").textContent).toBe("~/src/web");
    expect(within(step).getByTestId("move-worktree").textContent).toContain("Fresh copy");
    expect(within(step).getByTestId("move-base")).toBeTruthy();
    expect(within(step).queryByTestId("move-primary")).toBeNull();
    expect(within(step).getByTestId("move-line").textContent).toBe("New branch, named from the conversation when it moves.");
    expect(within(step).getByTestId("move-note").textContent).toBe("The thread is renamed and Claude carries on there.");
  });

  it("threads.default_worktree current: Project folder, no Branch from", () => {
    setWorkIn("current");
    openPicker();
    const step = pick("web");
    expect(within(step).getByTestId("move-worktree").textContent).toContain("Project folder");
    expect(within(step).queryByTestId("move-base")).toBeNull();
    expect(within(step).getByTestId("move-line").textContent).toBe("Works in the project's folder, on its current branch.");
  });

  it("the filter narrows the list and Enter picks; a project without git: no Work in, the No git badge", () => {
    openPicker();
    const input = screen.getByTestId("move-filter");
    // A workspace matches on its name only: "web" is the project, not platform (which has web).
    fireEvent.change(input, { target: { value: "web" } });
    expect([...picker().querySelectorAll("[cmdk-item]")].map((r) => r.textContent)).toEqual(["WEweb"]);
    fireEvent.change(input, { target: { value: "note" } });
    expect([...picker().querySelectorAll("[cmdk-item]")].map((r) => r.textContent)).toEqual(["NOnotesNo git"]);
    fireEvent.keyDown(input, { key: "Enter" });
    const step = screen.getByTestId("move-placement");
    expect(within(step).queryByTestId("move-worktree")).toBeNull();
    expect(within(step).getByTestId("no-git-badge")).toBeTruthy();
    expect(within(step).getByTestId("move-line").textContent).toBe("Works in the project's folder.");
  });

  it("a workspace: its members on the right and Run in", () => {
    openPicker();
    const step = pick("platform");
    expect(within(step).getByTestId("move-name").textContent).toBe("platform");
    expect(within(step).getByTestId("move-detail").textContent).toBe("api, web");
    expect(within(step).getByTestId("move-worktree").textContent).toContain("Fresh copies");
    expect(within(step).getByTestId("move-primary").textContent).toContain("api");
  });

  it("Backspace and ← go back to the list; so does the back button", () => {
    openPicker();
    fireEvent.keyDown(pick("web"), { key: "Backspace" });
    expect(picker().dataset.step).toBe("1");
    fireEvent.keyDown(pick("web"), { key: "ArrowLeft" });
    expect(picker().dataset.step).toBe("1");
    pick("web");
    fireEvent.click(screen.getByTestId("move-back"));
    expect(picker().dataset.step).toBe("1");
  });

  it("Enter on a pill is the pill's, not Move", () => {
    openPicker();
    pick("web");
    fireEvent.keyDown(screen.getByTestId("move-worktree"), { key: "Enter" });
    expect(invocationsOf("thread.move")).toEqual([]);
  });
});

describe("Move", () => {
  it("the shell's thread header says Moving to … from the send until the move is done", () => {
    render(<ThreadHeader threadId="s-1" paneId="p-1" />);
    expect(screen.getByTestId("thread-header-place").textContent).toBe("No project");
    // Sent, the daemon not answered yet.
    act(() => {
      useMovePickerStore.setState({ sending: { "s-1": "web" } });
    });
    expect(screen.getByTestId("thread-header-moving").textContent).toBe("Moving to web…");
    expect(screen.queryByTestId("thread-header-place")).toBeNull();
    // The daemon's pending move names it.
    act(() => {
      useMovePickerStore.setState({ sending: {} });
    });
    setThread({ pendingMove: { projectId: "web", workspaceId: "", worktreePath: "", branch: "" } });
    expect(screen.getByTestId("thread-header-moving").textContent).toBe("Moving to web…");
    // Moved: the branch chip.
    setThread({ projectId: "web", projectIds: ["web"], worktreePath: "/Users/me/src/web", branch: "main" });
    expect(screen.queryByTestId("thread-header-moving")).toBeNull();
  });

  it("Enter moves: thread.move with the choice, the picker closes, the crumb says Moving to … until the daemon answers", async () => {
    let answer: () => void = () => undefined;
    daemon.handlers.set(
      "thread.move",
      () =>
        new Promise((r) => {
          answer = () => {
            r({ message: "", resultJson: "" });
          };
        }),
    );
    openPicker();
    fireEvent.keyDown(pick("web"), { key: "Enter" });
    expect(invocationsOf("thread.move").map((i) => [i.args, i.context.activeThreadId])).toEqual([[{ id: "s-1", project: "web", "new-worktree": "true" }, "s-1"]]);
    await waitFor(() => {
      expect(useMovePickerStore.getState().open).toBeNull();
    });
    expect(crumb()).toBe("Moving to web…");
    // The daemon's pending_move takes over, naming its destination.
    setThread({ pendingMove: { projectId: "web", workspaceId: "", worktreePath: "", branch: "" } });
    act(() => {
      answer();
    });
    await waitFor(() => {
      expect(useMovePickerStore.getState().sending).toEqual({});
    });
    expect(crumb()).toBe("Moving to web…");
    expect(screen.queryByTestId("thread-crumb-move")).toBeNull();
    // Moved: the crumb is the project's, like any project thread.
    setThread({ projectId: "web", projectIds: ["web"], worktreePath: "/Users/me/src/web" });
    expect(crumb()).toBe("web");
  });

  it("a workspace sends its id and the primary from Run in", () => {
    openPicker();
    fireEvent.click(within(pick("platform")).getByTestId("move-submit"));
    expect(invocationsOf("thread.move").map((i) => i.args)).toEqual([{ id: "s-1", workspace: "w-1", project: "api", "new-worktree": "true" }]);
  });

  it("a refusal toasts the daemon's words and the thread stays where it was", async () => {
    daemon.handlers.set("thread.move", () => {
      throw refuse("thread s-1 is already moving");
    });
    openPicker();
    fireEvent.keyDown(pick("web"), { key: "Enter" });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
    expect(JSON.stringify(toast.error.mock.calls[0])).toContain("thread s-1 is already moving");
    await waitFor(() => {
      expect(crumb()).toBe("No project");
    });
    expect(screen.getByTestId("thread-crumb-move")).toBeTruthy();
  });
});

describe("between Move and the daemon's pending_move", () => {
  function CanMove() {
    return <span data-testid="can-move">{String(useCanMove("s-1"))}</span>;
  }

  it("Move is not offered again while this window's move is in flight; an opening asked for meanwhile does not pop up after a refusal", async () => {
    let refuseNow: () => void = () => undefined;
    daemon.handlers.set(
      "thread.move",
      () =>
        new Promise((_, reject) => {
          refuseNow = () => {
            reject(refuse("set_cwd refused"));
          };
        }),
    );
    openPicker();
    render(<CanMove />);
    expect(screen.getByTestId("can-move").textContent).toBe("true");
    fireEvent.keyDown(pick("web"), { key: "Enter" });
    await waitFor(() => {
      expect(useMovePickerStore.getState().sending).toEqual({ "s-1": "web" });
    });
    // No pending_move yet: the menus' hook, the palette's rule and openMovePicker all say no.
    expect(screen.getByTestId("can-move").textContent).toBe("false");
    expect(canMoveThread("s-1")).toBe(false);
    expect(openMovePicker("s-1")).toBe(false);
    // An opening that raced in anyway (set before the Move went out) is dropped with the answer.
    act(() => {
      useMovePickerStore.setState({ open: "s-1" });
    });
    act(() => {
      refuseNow();
    });
    await waitFor(() => {
      expect(useMovePickerStore.getState().sending).toEqual({});
    });
    expect(useMovePickerStore.getState().open).toBeNull();
    expect(screen.queryByTestId("move-picker")).toBeNull();
    expect(screen.getByTestId("thread-crumb-move")).toBeTruthy();
    expect(screen.getByTestId("can-move").textContent).toBe("true");
    expect(canMoveThread("s-1")).toBe(true);
  });
});

describe("the keyboard when the crumb's trigger unmounts", () => {
  const seq = () => useUiStore.getState().promptFocusSeq;
  it("Move asks the thread's prompt for it", () => {
    openPicker();
    const before = seq();
    fireEvent.click(within(pick("web")).getByTestId("move-submit"));
    expect(seq()).toBeGreaterThan(before);
  });

  it("a move from elsewhere (pending_move) while the popover is open: the prompt takes it", () => {
    openPicker();
    expect(document.activeElement).toBe(screen.getByTestId("move-filter"));
    const before = seq();
    setThread({ pendingMove: { projectId: "web", workspaceId: "", worktreePath: "", branch: "" } });
    expect(screen.queryByTestId("thread-crumb-move")).toBeNull();
    expect(seq()).toBe(before + 1);
  });

  it("the picker going with the thread view (another selection): the prompt is not asked", () => {
    openPicker();
    const before = seq();
    act(() => {
      useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } });
      useThreadsStore.setState({ byId: {}, order: [] });
    });
    expect(seq()).toBe(before);
  });
});

describe("the picker across its header mounting", () => {
  const frame = () =>
    act(async () => {
      await new Promise((r) => {
        requestAnimationFrame(() => {
          r(null);
        });
      });
    });

  it("asked for as the thread's tab draws, it survives the header mounting again at once", async () => {
    useMovePickerStore.setState({ open: "s-1" });
    const { rerender } = render(<ThreadCrumb key="first" id="s-1" />);
    // The tab's body drawn again: the old header unmounts as the new one mounts, in one commit.
    rerender(<ThreadCrumb key="again" id="s-1" />);
    await frame();
    expect(useMovePickerStore.getState().open).toBe("s-1");
    expect(picker()).toBeTruthy();
  });

  it("a header remounting while the keyboard is nowhere (the menu that asked just went) does not ask the thread's prompt for it", () => {
    const before = useUiStore.getState().promptFocusSeq;
    (document.activeElement as HTMLElement | null)?.blur();
    const { rerender } = render(<ThreadCrumb key="first" id="s-1" />);
    rerender(<ThreadCrumb key="again" id="s-1" />);
    expect(useUiStore.getState().promptFocusSeq).toBe(before);
  });

  it("leaving the thread (the header gone) closes it a frame later, so coming back does not reopen it", async () => {
    useMovePickerStore.setState({ open: "s-1" });
    const { unmount } = render(<ThreadCrumb id="s-1" />);
    unmount();
    await frame();
    expect(useMovePickerStore.getState().open).toBeNull();
  });
});

describe("openMovePicker (the menus' Move to project…, thread.move.open)", () => {
  it("selects the thread, then opens its picker; false for a thread that cannot move", async () => {
    useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } });
    expect(openMovePicker("s-1")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    await waitFor(() => {
      expect(useMovePickerStore.getState().open).toBe("s-1");
    });
    setThread({ archivedAtMs: 1 });
    expect(openMovePicker("s-1")).toBe(false);
  });
});
