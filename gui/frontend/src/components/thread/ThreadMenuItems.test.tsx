import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";

const pinThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const archiveThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const snoozeThread = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const setThreadSidebar = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/threadActions", async (orig) => ({ ...(await orig<typeof import("@/stores/threadActions")>()), pinThread, archiveThread, snoozeThread, setThreadSidebar }));
const runCommand = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommand }));
const openSnoozeDialog = vi.hoisted(() => vi.fn());
vi.mock("@/stores/snoozeDialog", async (orig) => ({ ...(await orig<typeof import("@/stores/snoozeDialog")>()), openSnoozeDialog }));
const openSaveWorkspace = vi.hoisted(() => vi.fn());
vi.mock("@/stores/saveWorkspace", async (orig) => ({ ...(await orig<typeof import("@/stores/saveWorkspace")>()), openSaveWorkspace }));

const { ContextMenu, ContextMenuTrigger } = await import("@/components/ui/context-menu");
const { RowMenu } = await import("@/components/sidebar/RowMenu");
const { ThreadTitle } = await import("./ThreadParts");
const { useCommandsStore } = await import("@/stores/commands");
const { useProjectsStore } = await import("@/stores/projects");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");
const { useWorkspacesStore } = await import("@/stores/workspaces");

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
    pinned: false,
    archivedAtMs: null,
    snoozedUntilMs: null,
    createdBy: "",
    createdByName: "",
    parentId: "",
    inSidebar: null,
    flags: [],
    ...o,
  }) as ThreadView;

function setThread(o: Partial<ThreadView>, others: ThreadView[] = []): void {
  const all = [thread(o), ...others];
  useThreadsStore.setState({ byId: Object.fromEntries(all.map((t) => [t.id, t])), order: all.map((t) => t.id) });
}

const PROJECT = (id: string) => ({ id, name: id, git: true, worktrees: [{ path: `/src/${id}`, branch: "main", head: "a", isMain: true }] });

beforeEach(() => {
  useCommandsStore.setState({ commands: [cmd("thread.snooze"), cmd("thread.archive"), cmd("thread.pin"), cmd("thread.sidebar"), cmd("thread.restart"), cmd("thread.flag.clear")] });
  useProjectsStore.setState({ byId: { web: PROJECT("web"), api: PROJECT("api") } as never, order: ["web", "api"] });
  useWorkspacesStore.setState({ byId: {}, order: [] });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
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

function openTitleMenu(): HTMLElement {
  render(<ThreadTitle id="s-1" />);
  fireEvent.keyDown(screen.getByTestId("thread-title"), { key: "Enter" });
  return screen.getByTestId("thread-title-menu");
}

/** The menu's items and separators in order ("—" for a separator). */
function entries(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')].map((e) => (e.getAttribute("role") === "separator" ? "—" : e.textContent));
}

describe("ThreadMenuItems: one list for the sidebar row and the title menu", () => {
  it("in order: Rename, Pin, Snooze; New thread on this branch, Save as workspace, Run in, Hide from sidebar; Archive", () => {
    setThread({ projectIds: ["web", "api"], createdBy: "s-0", inSidebar: true }, [thread({ id: "s-0", name: "Parent" })]);
    const want = ["Rename", "Pin", "Snooze", "—", "New thread on this branch", "Save as workspace", "Run in…", "Hide from sidebar", "—", "Archive"];
    expect(entries(openTitleMenu())).toEqual(want);
    cleanup();
    // The row adds what only it offers after the shared list.
    expect(entries(openRowMenu())).toEqual([...want, "—", "New terminal here", "Fork", "Remove…"]);
  });

  it("a one-project thread of the user's: no Save as workspace, Run in or sidebar item", () => {
    setThread({});
    expect(entries(openTitleMenu())).toEqual(["Rename", "Pin", "Snooze", "—", "New thread on this branch", "—", "Archive"]);
  });

  it("a thread without a project: no second group", () => {
    setThread({ projectId: "", projectIds: [], worktreePath: "/Users/me" });
    expect(entries(openTitleMenu())).toEqual(["Rename", "Pin", "Snooze", "—", "Archive"]);
  });

  it("a hidden child: Show in sidebar, which shows it", () => {
    setThread({ createdBy: "s-0", inSidebar: false });
    fireEvent.click(within(openTitleMenu()).getByTestId("menu-sidebar-show"));
    expect(setThreadSidebar).toHaveBeenCalledWith("s-1", true);
  });

  it("no sidebar item when the daemon does not list thread.sidebar", () => {
    useCommandsStore.setState({ commands: useCommandsStore.getState().commands.filter((c) => c.name !== "thread.sidebar") });
    setThread({ createdBy: "s-0", inSidebar: true });
    expect(within(openTitleMenu()).queryByTestId("menu-sidebar-hide")).toBeNull();
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
    expect(entries(menu)).toEqual(["Rename", "Pin", "Snooze", "—", "New thread on this branch", "Restart Claude", "Clear flags", "—", "Archive"]);
    fireEvent.click(within(menu).getByTestId("menu-clear-flags"));
    expect(runCommand).toHaveBeenCalledWith("thread.flag.clear", { id: "s-1" }, expect.objectContaining({ activeThreadId: "s-1" }));
    cleanup();
    setThread({ flags: [flag("hello")] });
    expect(within(openTitleMenu()).getByTestId("menu-clear-flags").textContent).toBe("Clear flag");
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
    ["Save as workspace", { projectIds: ["web", "api"] }, "menu-save-workspace", () => {
        expect(openSaveWorkspace).toHaveBeenCalledWith("s-1");
      }],
  ])("%s runs its command for the thread", (label, o, testId, check) => {
    setThread(o);
    const item = within(openTitleMenu()).getByTestId(testId);
    expect(item.textContent).toBe(label);
    fireEvent.click(item);
    check();
  });

  it("Snooze ▸ lists the presets with their times; a preset snoozes; Pick a date and time… opens the dialog", () => {
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

  it("Rename starts the sidebar row's inline edit, and the menu leaves focus there", () => {
    setThread({});
    fireEvent.click(within(openTitleMenu()).getByTestId("menu-rename"));
    expect(useUiStore.getState().renamingThreadId).toBe("s-1");
  });
});
