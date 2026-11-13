import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";

const pinThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const archiveThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const snoozeThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const saveThreadForLater = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const regenerateThreadName = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/threadActions", async (orig) => ({ ...(await orig<typeof import("@/stores/threadActions")>()), pinThread, archiveThread, snoozeThread, saveThreadForLater, regenerateThreadName }));
const runCommand = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommand }));
const openSnoozeDialog = vi.hoisted(() => vi.fn());
vi.mock("@/stores/snoozeDialog", async (orig) => ({ ...(await orig<typeof import("@/stores/snoozeDialog")>()), openSnoozeDialog }));
const openSaveWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/stores/saveWorkspace", async (orig) => ({ ...(await orig<typeof import("@/stores/saveWorkspace")>()), openSaveWorkspace }));

const { ContextMenu, ContextMenuTrigger } = await import("@/components/ui/context-menu");
const { RowMenu } = await import("@/components/sidebar/RowMenu");
const { ThreadHeader } = await import("./ThreadHeader");
const { layoutOf, pane, seedLayout, space, tab } = await import("@/test/shellLayout");
const { resetLayout } = await import("@/stores/layout");
const { useCommandsStore } = await import("@/stores/commands");
const { useProjectsStore } = await import("@/stores/projects");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");
const { useWorkspacesStore } = await import("@/stores/workspaces");
const { useMovePickerStore } = await import("@/stores/movePicker");

const cmd = (name: string): CommandView => ({ name, title: name, description: "", category: "", args: [], keybindings: [], available: true });
const thread = (o: Partial<ThreadView>) =>
  ({
    id: "s-1",
    name: "Fix the stale PR badge",
    projectId: "web",
    worktreePath: "/src/web",
    workspaceId: "",
    projectIds: ["web"],
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
    ...o,
  }) as ThreadView;

function setThread(o: Partial<ThreadView>, others: ThreadView[] = []): void {
  const all = [thread(o), ...others];
  useThreadsStore.setState({ byId: Object.fromEntries(all.map((t) => [t.id, t])), order: all.map((t) => t.id) });
}

const PROJECT = (id: string) => ({ id, name: id, git: true, githubSlug: "", remotes: [], worktrees: [{ path: `/src/${id}`, branch: "main", head: "a", isMain: true }] });

beforeEach(async () => {
  resetLayout();
  await seedLayout(layoutOf([space(pane("p-1", [tab("t-1", "thread", "s-1")]), "p-1")]));
  useCommandsStore.setState({ commands: [cmd("thread.snooze"), cmd("thread.archive"), cmd("thread.pin"), cmd("thread.restart"), cmd("thread.flag.clear")] });
  useProjectsStore.setState({ byId: { web: PROJECT("web"), api: PROJECT("api") } as never, order: ["web", "api"] });
  useWorkspacesStore.setState({ byId: {}, order: [] });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
  useMovePickerStore.setState({ open: null, sending: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openRowMenu(): HTMLElement {
  render(
    <ContextMenu>
      <ContextMenuTrigger data-testid="row">row</ContextMenuTrigger>
      <RowMenu id="s-1" />
    </ContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId("row"));
  return screen.getByTestId("row-menu");
}

/** The thread's header's one menu (ThreadHeader, in its pane): Open ▸, Move to space ▸, the thread's items, Close. */
function openTitleMenu(): HTMLElement {
  render(<ThreadHeader threadId="s-1" paneId="p-1" />);
  fireEvent.pointerDown(screen.getByTestId("thread-header-menu-trigger"), { button: 0, ctrlKey: false });
  return screen.getByTestId("thread-header-menu");
}

/** The header menu's own items (ThreadMenuItems): between its Open ▸ / Move to space ▸ group and its Close. */
function shared(menu: HTMLElement): string[] {
  return entries(menu).slice(3, -1);
}

/** The menu's items and separators in order ("—" for a separator). */
function entries(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((e) => (e.getAttribute("role") === "separator" ? "—" : e.textContent));
}

describe("ThreadMenuItems: one list for the sidebar row and the thread header's menu", () => {
  it("in order: Rename, Regenerate name, Pin, Snooze; New thread on this branch, Save as workspace, Run in; Archive (no sidebar item on a child)", () => {
    setThread({ projectIds: ["web", "api"], createdBy: "s-0" }, [thread({ id: "s-0", name: "Parent" })]);
    const want = ["Rename", "Regenerate name", "Pin", "Snooze", "—", "New thread on this branch", "Save as workspace", "Run in", "—", "Archive"];
    expect(entries(openTitleMenu())).toEqual(["Open", "Move to space", "—", ...want, "Close⌘W"]);
    cleanup();
    // The row adds what only it offers after the shared list.
    expect(entries(openRowMenu())).toEqual([...want, "—", "Fork", "Remove"]);
  });

  it("a one-project thread of the user's: no Save as workspace or Run in", () => {
    setThread({});
    expect(shared(openTitleMenu())).toEqual(["Rename", "Regenerate name", "Pin", "Snooze", "—", "New thread on this branch", "—", "Archive"]);
  });

  it("a thread without a project: Move to project… after the names, no second group", () => {
    setThread({ projectId: "", projectIds: [], worktreePath: "/Users/me" });
    expect(shared(openTitleMenu())).toEqual(["Rename", "Regenerate name", "Move to project…", "—", "Pin", "Snooze", "—", "Archive"]);
  });

  it.each<[string, Partial<ThreadView>]>([
    ["a project thread", {}],
    ["a workspace folder thread", { projectId: "", projectIds: [], workspaceId: "w-docs", worktreePath: "/ws" }],
    ["an archived thread without a project", { projectId: "", projectIds: [], worktreePath: "/Users/me", archivedAtMs: 1 }],
    ["a thread without a project that is moving", { projectId: "", projectIds: [], worktreePath: "/Users/me", pendingMove: { projectId: "web", workspaceId: "", worktreePath: "", branch: "" } }],
    ["a thread without a project whose transcript is deleted", { projectId: "", projectIds: [], worktreePath: "/Users/me", transcriptMissing: true }],
  ])("no Move to project… for %s", (_, o) => {
    setThread(o);
    expect(entries(openRowMenu())).not.toContain("Move to project…");
  });

  it("Move to project… from the sidebar row opens the thread and its move picker", async () => {
    setThread({ projectId: "", projectIds: [], worktreePath: "/Users/me" });
    useUiStore.setState({ selection: { kind: "view", name: "pullrequests" } });
    const menu = openRowMenu();
    fireEvent.click(within(menu).getByText("Move to project…"));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    await waitFor(() => {
      expect(useMovePickerStore.getState().open).toBe("s-1");
    });
  });

  it("a thread in its workspace's folder: New thread on this branch, no Save as workspace; the same set outside the folder is offered it (composer-fixes.spec.ts)", () => {
    useWorkspacesStore.setState({ byId: { "w-docs": { id: "w-docs", name: "docs", branch: "", members: [{ projectId: "web", worktreePath: "" }, { projectId: "api", worktreePath: "" }], createdAtMs: null } }, order: ["w-docs"] });
    const set = ["web", "api", "notes"];
    setThread({ projectId: "", projectIds: set, workspaceId: "w-docs" });
    const items = (menu: HTMLElement) => [...menu.querySelectorAll('[data-testid="menu-new-like"], [data-testid="menu-save-workspace"]')].map((e) => e.textContent);
    expect(items(openTitleMenu())).toEqual(["New thread on this branch"]);
    cleanup();
    setThread({ projectId: "web", projectIds: set, workspaceId: "" });
    expect(items(openTitleMenu())).toEqual(["New thread on this branch", "Save as workspace"]);
  });

  it.each<[string, Partial<ThreadView>, boolean, boolean]>([
    ["a thread without a project: neither", { projectId: "", projectIds: [], worktreePath: "/Users/me" }, false, false],
    ["a workspace without projects, in its folder: New thread on this branch only (nowhere else to run)", { projectId: "", projectIds: [], workspaceId: "w-zero" }, true, false],
    ["two projects: both", { projectIds: ["web", "api"] }, true, true],
  ])("the row menu's New thread on this branch and Run in: %s (composer-fixes.spec.ts)", (_name, o, newLike, runIn) => {
    useWorkspacesStore.setState({ byId: { "w-zero": { id: "w-zero", name: "zero", branch: "", members: [], createdAtMs: null } }, order: ["w-zero"] });
    setThread(o);
    const menu = openRowMenu();
    expect(within(menu).queryAllByTestId("menu-new-like")).toHaveLength(newLike ? 1 : 0);
    expect(within(menu).queryAllByTestId("menu-run-in")).toHaveLength(runIn ? 1 : 0);
  });

  it("Restart Claude only while the plugin environment changed; it runs thread.restart for the thread", () => {
    setThread({});
    expect(within(openTitleMenu()).queryByTestId("menu-restart")).toBeNull();
    cleanup();
    setThread({ pluginEnvStale: true, pluginEnvChange: "gh-actions changed GH_TOKEN" });
    const item = within(openTitleMenu()).getByTestId("menu-restart");
    expect(item.textContent).toBe("Restart Claude");
    fireEvent.click(item);
    expect(runCommand).toHaveBeenCalledWith("thread.restart", {}, expect.objectContaining({ activeThreadId: "s-1" }));
  });

  it("Clear flag only while plugins flagged the thread, after Restart Claude; it clears every flag of the thread", () => {
    setThread({});
    expect(within(openTitleMenu()).queryByTestId("menu-clear-flags")).toBeNull();
    cleanup();
    const flag = (plugin: string): ThreadView["flags"][number] => ({ plugin, pluginName: plugin, level: "attention", reason: "deploy needs approval", setAtMs: 1, untilSeen: false });
    setThread({ pluginEnvStale: true, flags: [flag("hello"), flag("gh-actions")] });
    const menu = openTitleMenu();
    expect(shared(menu)).toEqual(["Rename", "Regenerate name", "Pin", "Snooze", "—", "New thread on this branch", "Restart Claude", "Clear flags", "—", "Archive"]);
    fireEvent.click(within(menu).getByTestId("menu-clear-flags"));
    expect(runCommand).toHaveBeenCalledWith("thread.flag.clear", { id: "s-1" }, expect.objectContaining({ activeThreadId: "s-1" }));
    cleanup();
    setThread({ flags: [flag("hello")] });
    expect(within(openTitleMenu()).getByTestId("menu-clear-flags").textContent).toBe("Clear flag");
  });

  it("a setup that runs takes neither Snooze, Run in nor New thread on this branch; after a failure it snoozes", () => {
    const setup = (phase: "running" | "failed") => ({ phase, startedAtMs: 1, endedAtMs: null, steps: [], error: "", background: true });
    const ids = () => screen.getAllByRole("menuitem").map((m) => m.dataset.testid);
    setThread({ projectIds: ["api", "web"], worktreePath: "", setup: setup("running") });
    openRowMenu();
    expect(ids()).not.toEqual(expect.arrayContaining(["menu-snooze"]));
    expect(ids()).not.toEqual(expect.arrayContaining(["menu-run-in"]));
    expect(ids()).not.toEqual(expect.arrayContaining(["menu-new-like"]));
    expect(ids()).not.toEqual(expect.arrayContaining(["menu-fork"]));
    expect(screen.queryByRole("menuitem", { name: "New terminal here" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Remove" })).toBeTruthy();
    cleanup();
    setThread({ projectIds: ["api", "web"], worktreePath: "", setup: setup("failed") });
    openRowMenu();
    expect(ids()).toEqual(expect.arrayContaining(["menu-snooze"]));
    expect(ids()).not.toEqual(expect.arrayContaining(["menu-run-in"]));
    expect(ids()).not.toEqual(expect.arrayContaining(["menu-new-like"]));
  });

  it("Save as workspace goes while a setup has not finished: the daemon refuses thread.workspace there, after the workspace was made", () => {
    const setup = (phase: "running" | "failed" | "cancelled" | "done") => ({ phase, startedAtMs: 1, endedAtMs: null, steps: [], error: "", background: true });
    const offered = () => within(openTitleMenu()).queryAllByTestId("menu-save-workspace").length;
    for (const phase of ["running", "failed", "cancelled"] as const) {
      setThread({ projectIds: ["web", "api"], setup: setup(phase) });
      expect(offered()).toBe(0);
      cleanup();
    }
    setThread({ projectIds: ["web", "api"], setup: setup("done") });
    expect(offered()).toBe(1);
  });

  it("no Regenerate name for a resident thread; disabled while a naming call runs", () => {
    setThread({ resident: "ember" });
    expect(within(openTitleMenu()).queryByTestId("menu-regenerate-name")).toBeNull();
    cleanup();
    setThread({ naming: true });
    const item = within(openTitleMenu()).getByTestId("menu-regenerate-name");
    expect(item.getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(item);
    expect(regenerateThreadName).not.toHaveBeenCalled();
  });

  it("no Clear flag where the daemon does not list thread.flag.clear", () => {
    useCommandsStore.setState({ commands: useCommandsStore.getState().commands.filter((c) => c.name !== "thread.flag.clear") });
    setThread({ flags: [{ plugin: "hello", pluginName: "Hello", level: "error", reason: "x" }] as unknown as ThreadView["flags"] });
    expect(within(openTitleMenu()).queryByTestId("menu-clear-flags")).toBeNull();
  });

  it.each([
    ["Pin", {}, "menu-pin", () => {
        expect(pinThread).toHaveBeenCalledWith("s-1", true);
      }],
    ["Unpin", { pinned: true }, "menu-pin", () => {
        expect(pinThread).toHaveBeenCalledWith("s-1", false);
      }],
    ["Archive", {}, "menu-archive", () => {
        expect(archiveThread).toHaveBeenCalledWith("s-1", true);
      }],
    ["Unarchive", { archivedAtMs: 5 }, "menu-archive", () => {
        expect(archiveThread).toHaveBeenCalledWith("s-1", false);
      }],
    ["Unsnooze", { snoozedUntilMs: Date.now() + 3_600_000 }, "menu-unsnooze", () => {
        expect(snoozeThread).toHaveBeenCalledWith("s-1", null);
      }],
    ["Unsnooze", { savedAtMs: Date.now() }, "menu-unsnooze", () => {
        expect(snoozeThread).toHaveBeenCalledWith("s-1", null);
      }],
    ["Save as workspace", { projectIds: ["web", "api"] }, "menu-save-workspace", () => {
        expect(openSaveWorkspace).toHaveBeenCalledWith("s-1");
      }],
    ["Regenerate name", {}, "menu-regenerate-name", () => {
        expect(regenerateThreadName).toHaveBeenCalledWith("s-1");
      }],
  ])("%s runs its command for the thread", (label, o, testId, check) => {
    setThread(o);
    const item = within(openTitleMenu()).getByTestId(testId);
    expect(item.textContent).toBe(label);
    fireEvent.click(item);
    check();
  });

  it("Snooze ▸ lists the presets with their times; a preset snoozes; Pick a date and time opens the dialog", () => {
    setThread({});
    const menu = openTitleMenu();
    fireEvent.keyDown(within(menu).getByTestId("menu-snooze"), { key: "ArrowRight" });
    const presets = screen.getAllByTestId("snooze-preset");
    expect(presets.map((i) => i.dataset.preset)).toEqual(["1h", "3h", "tomorrow", "next-week"]);
    const before = Date.now();
    fireEvent.click(presets[0] as HTMLElement);
    const [id, until] = snoozeThread.mock.calls[0] as unknown as [string, number];
    expect(id).toBe("s-1");
    expect(until - before).toBeGreaterThan(3_600_000 - 5_000);
    cleanup();
    setThread({});
    fireEvent.keyDown(within(openTitleMenu()).getByTestId("menu-snooze"), { key: "ArrowRight" });
    fireEvent.click(screen.getByTestId("snooze-pick"));
    expect(openSnoozeDialog).toHaveBeenCalledWith("s-1");
  });

  it("Snooze ▸ Save for later comes after Pick a date and time, says No alarm, and saves the thread", () => {
    setThread({});
    fireEvent.keyDown(within(openTitleMenu()).getByTestId("menu-snooze"), { key: "ArrowRight" });
    const item = screen.getByTestId("snooze-save");
    expect(item.textContent).toBe("Save for laterNo alarm");
    expect(screen.getByTestId("snooze-pick").compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(item);
    expect(saveThreadForLater).toHaveBeenCalledWith("s-1");
    expect(snoozeThread).not.toHaveBeenCalled();
  });

  it("Snooze ▸ leaves Save for later out for a thread already saved", () => {
    setThread({ savedAtMs: Date.now() });
    fireEvent.keyDown(within(openTitleMenu()).getByTestId("menu-snooze"), { key: "ArrowRight" });
    expect(screen.getByTestId("snooze-pick")).toBeTruthy();
    expect(screen.queryByTestId("snooze-save")).toBeNull();
  });

  it.each([
    ["Pin", "menu-pin", {}],
    ["Archive", "menu-archive", {}],
    ["Unsnooze", "menu-unsnooze", { snoozedUntilMs: Date.now() + 3_600_000 }],
  ])("%s from the header's menu asks the thread's prompt for the keyboard", async (_label, testId, o) => {
    setThread(o);
    const before = useUiStore.getState().promptFocusSeq;
    fireEvent.click(within(openTitleMenu()).getByTestId(testId));
    await waitFor(() => {
      expect(screen.queryByTestId("thread-header-menu")).toBeNull();
    });
    expect(useUiStore.getState().promptFocusSeq).toBe(before + 1);
  });

  it("a snooze preset from the header's menu does too", async () => {
    setThread({});
    const before = useUiStore.getState().promptFocusSeq;
    fireEvent.keyDown(within(openTitleMenu()).getByTestId("menu-snooze"), { key: "ArrowRight" });
    fireEvent.click(screen.getAllByTestId("snooze-preset")[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByTestId("thread-header-menu")).toBeNull();
    });
    expect(useUiStore.getState().promptFocusSeq).toBe(before + 1);
  });

  it("Pin from the sidebar row's menu leaves the prompt alone", async () => {
    setThread({});
    const before = useUiStore.getState().promptFocusSeq;
    fireEvent.click(within(openRowMenu()).getByTestId("menu-pin"));
    await waitFor(() => {
      expect(screen.queryByTestId("row-menu")).toBeNull();
    });
    expect(useUiStore.getState().promptFocusSeq).toBe(before);
  });

  it("Rename starts the sidebar row's inline edit, and the menu leaves focus there", () => {
    setThread({});
    fireEvent.click(within(openTitleMenu()).getByTestId("menu-rename"));
    expect(useUiStore.getState().renamingThreadId).toBe("s-1");
  });
});
