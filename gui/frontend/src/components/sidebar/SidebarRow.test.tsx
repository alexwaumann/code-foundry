import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { DashboardView, PullRequestDetailView, PullRequestView } from "@/api/gh";
import type { ThreadView } from "@/api/threads";

const renameThread = vi.hoisted(() => vi.fn<(id: string, name: string) => Promise<boolean>>(() => Promise.resolve(true)));
const archiveThread = vi.hoisted(() => vi.fn<(id: string, archived: boolean) => Promise<boolean>>(() => Promise.resolve(true)));
const snoozeThread = vi.hoisted(() => vi.fn<(id: string, untilMs: number | null) => Promise<boolean>>(() => Promise.resolve(true)));
vi.mock("@/stores/threadActions", async (orig) => ({ ...(await orig<typeof import("@/stores/threadActions")>()), renameThread, archiveThread, snoozeThread }));
const showThreadView = vi.hoisted(() => vi.fn<(name: string, threadId: string, params?: Record<string, string>) => boolean>(() => true));
vi.mock("@/stores/threadPanelIntent", () => ({ showThreadView }));
const showThreadInfo = vi.hoisted(() => vi.fn<(threadId: string, focus?: boolean) => void>());
vi.mock("@/stores/threadInfoOverlay", async (orig) => ({ ...(await orig<typeof import("@/stores/threadInfoOverlay")>()), showThreadInfo }));
import { TooltipProvider } from "@/components/ui/tooltip";
import { DASHBOARD_KEY, dashboardResource, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { SidebarRow } from "./SidebarRow";

const thread = (o: Partial<ThreadView>) =>
  ({ id: "s-1", name: "t", projectId: "cf", worktreePath: "/src/cf", workspaceId: "", projectIds: ["cf"], branch: "", createdWorktree: false, pendingWorktreePath: "", state: "connected", status: "idle", statusReason: "", statusChangedAtMs: null, lastActivityAtMs: null, flags: [], agentsRunning: 0, backgroundAgentsRunning: 0, backgroundShellsRunning: 0, linkedPullRequests: [], pinned: false, ...o }) as ThreadView;

beforeEach(() => {
  useProjectsStore.setState({
    byId: {
      cf: { id: "cf", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/cf", branch: "main", head: "a", isMain: true }] },
      notes: { id: "notes", name: "writing", git: false, githubSlug: "", remotes: [], worktrees: [{ path: "/src/notes", branch: "", head: "", isMain: true }] },
    } as never,
    order: ["cf", "notes"],
  });
});

afterEach(cleanup);

function renderRow(o: Partial<ThreadView>): HTMLElement {
  useThreadsStore.setState({ byId: { "s-1": thread(o) }, order: ["s-1"] });
  render(
    <TooltipProvider>
      <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "idle", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
    </TooltipProvider>,
  );
  return screen.getByTestId("thread-body");
}

const NOW = Date.now();
const MIN = 60_000;
const flag = (level: "attention" | "error", reason: string, pluginName = "Lint") => ({ plugin: pluginName.toLowerCase(), pluginName, level, reason, setAtMs: null, untilSeen: false });
const line1 = () => screen.getByTestId("row-line-1");
const line3 = () => screen.getByTestId("row-line-3");

describe("SidebarRow three lines", () => {
  it("project and status, then the name, then the detail or branch, in the 60px box", () => {
    renderRow({ name: "Pick a palette", status: "attention", statusReason: "question: Which color?" });
    const body = screen.getByTestId("thread-body");
    expect(Array.from(body.children).map((c) => c.getAttribute("data-testid") ?? "name")).toEqual(["row-line-1", "name", "row-line-3"]);
    expect(body.className.split(" ")).not.toContain("gap-0.5");
    expect(line1().className.split(" ")).toEqual(expect.arrayContaining(["h-4", "text-caption-sm"]));
    expect(line3().className.split(" ")).toEqual(expect.arrayContaining(["h-4", "text-caption-sm"]));
    expect(screen.getByTestId("thread-name").parentElement?.className).toContain("h-[22px]");
    expect(line1().textContent).toBe("code-foundryQuestion");
    expect(line3().textContent).toBe("Which color?");
  });

  it.each<[string, Partial<ThreadView>, string, string, string, string]>([
    ["permission", { status: "attention", statusReason: "permission: Bash zig build test" }, "input", "lucide-shield-question-mark", "Permission", "text-cf-warning-text"],
    ["question", { status: "attention", statusReason: "question: Which one?" }, "question", "lucide-circle-question-mark", "Question", "text-cf-warning-text"],
    ["plan", { status: "attention", statusReason: "plan: Claude has written up a plan" }, "plan", "lucide-clipboard-check", "Plan", "text-cf-warning-text"],
    ["attention flag: the plugin's name", { flags: [flag("attention", "3 warnings")] }, "flagAttention", "lucide-flag", "Lint", "text-cf-warning-text"],
    ["error flag", { flags: [flag("error", "tests red", "Test Watcher")] }, "flagError", "lucide-flag", "Test Watcher", "text-cf-error-text"],
    ["snooze ended", { state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: NOW - 2 * MIN }, "snoozeEnded", "lucide-bell-ring", "Woke", "text-cf-warning-text"],
    ["error", { status: "attention", statusReason: "error: model_not_found" }, "error", "lucide-circle-alert", "Error", "text-cf-error-text"],
    ["interrupted", { state: "disconnected", status: "error", statusReason: "interrupted", statusChangedAtMs: NOW - MIN }, "interrupted", "lucide-unplug", "Interrupted", "text-cf-error-text"],
    ["crashed", { state: "disconnected", status: "error", statusReason: "crashed", statusChangedAtMs: NOW - MIN }, "crashed", "lucide-triangle-alert", "Crashed", "text-cf-error-text"],
    ["transcript deleted", { state: "disconnected", transcriptMissing: true }, "transcriptDeleted", "lucide-circle-alert", "Error", "text-cf-error-text"],
    ["done", { status: "attention", statusReason: "finished", statusChangedAtMs: NOW - 12 * MIN }, "finished", "lucide-circle-check", "Done", "text-cf-success-text"],
    ["working", { status: "busy", statusChangedAtMs: NOW - 4 * MIN }, "working", "lucide-circle-dashed", "Working", "text-cf-info-text"],
    ["waiting", { status: "idle", statusReason: "waiting on 2 child threads", statusChangedAtMs: NOW - 5 * MIN }, "waiting", "lucide-circle-dashed", "Waiting", "text-cf-sidebar-muted-foreground"],
  ])("%s: its icon and word in its tone", (_name, o, kind, icon, word, tone) => {
    renderRow(o);
    expect(screen.getByTestId("thread-body").getAttribute("data-status-line")).toBe(kind);
    const status = screen.getByTestId("row-status");
    expect(status.getAttribute("data-kind")).toBe(kind);
    expect(status.className.split(" ")).toEqual(expect.arrayContaining([tone, "font-medium"]));
    expect(screen.getByTestId("row-status-icon").getAttribute("class")).toContain(icon);
    expect(screen.getByTestId("row-status-icon").getAttribute("class")).toContain("size-3");
    expect(screen.getByTestId("row-status-word").textContent).toBe(word);
  });

  it("idle: no icon or word, the time since the last activity, muted", () => {
    renderRow({ status: "idle", lastActivityAtMs: NOW - 9 * MIN });
    expect(screen.queryByTestId("row-status")).toBeNull();
    const time = screen.getByTestId("row-time");
    expect(time.textContent).toBe("9m");
    expect(time.className.split(" ")).toEqual(expect.arrayContaining(["text-cf-sidebar-muted-foreground", "tabular-nums"]));
    expect(line1().textContent).toBe("code-foundry9m");
    expect(screen.getByTestId("thread-body").getAttribute("data-status-line")).toBe("place");
  });

  it("idle without a known activity: nothing on the right", () => {
    renderRow({ status: "idle", lastActivityAtMs: null });
    expect(line1().textContent).toBe("code-foundry");
  });

  it.each<[string, Partial<ThreadView>, string]>([
    ["working: the word, a space, the time since the status changed", { status: "busy", statusChangedAtMs: NOW - (60 + 4) * MIN }, "Working 1h 4m"],
    ["waiting: the same", { status: "idle", statusReason: "waiting on 1 child thread", statusChangedAtMs: NOW - 5 * MIN }, "Waiting 5m"],
    ["under a minute: seconds", { status: "busy", statusChangedAtMs: NOW - 4_000 }, "Working 4s"],
  ])("%s", (_name, o, text) => {
    // The clock held at NOW: under load a real second passes between loading the file and
    // rendering, and the seconds case read "5s".
    vi.useFakeTimers({ now: NOW });
    try {
      renderRow(o);
      expect(screen.getByTestId("row-status").textContent).toBe(text);
      // Same tone as the word: the time inherits the status span's colour.
      expect(screen.getByTestId("row-time").className).not.toContain("text-cf-sidebar-muted-foreground");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each<[string, Partial<ThreadView>]>([
    ["question", { status: "attention", statusReason: "question: Which one?", statusChangedAtMs: NOW - 6 * MIN }],
    ["done", { status: "attention", statusReason: "finished", statusChangedAtMs: NOW - 6 * MIN }],
    ["interrupted", { state: "disconnected", status: "error", statusReason: "interrupted", statusChangedAtMs: NOW - 6 * MIN }],
  ])("%s: no time on the row", (_name, o) => {
    renderRow(o);
    expect(screen.queryByTestId("row-time")).toBeNull();
  });

  it("the working time ticks every second under a minute on the shared clock", () => {
    vi.useFakeTimers();
    try {
      renderRow({ status: "busy", statusChangedAtMs: Date.now() - 4_000 });
      expect(screen.getByTestId("row-time").textContent).toBe("4s");
      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      expect(screen.getByTestId("row-time").textContent).toBe("7s");
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(screen.getByTestId("row-time").textContent).toBe("1m");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SidebarRow line 1: the project", () => {
  it("the project, muted, no icon", () => {
    renderRow({});
    const p = screen.getByTestId("row-project");
    expect(p.textContent).toBe("code-foundry");
    expect(p.className).toContain("text-cf-sidebar-muted-foreground");
    expect(p.querySelector("svg")).toBeNull();
  });

  it("no project: plain No project text, no icon", () => {
    renderRow({ projectId: "", projectIds: [], worktreePath: "/Users/dev" });
    const p = screen.getByTestId("row-project");
    expect(p.textContent).toBe("No project");
    expect(p.getAttribute("data-no-project")).toBe("true");
    expect(p.querySelector("svg")).toBeNull();
  });

  it("pinned: the pin glyph right after the project", () => {
    renderRow({ pinned: true });
    expect(screen.getByTestId("row-project").nextElementSibling?.getAttribute("data-testid")).toBe("row-pinned");
  });

  it("not pinned: no pin", () => {
    renderRow({});
    expect(screen.queryByTestId("row-pinned")).toBeNull();
  });
});

describe("SidebarRow line 3: detail or branch", () => {
  it.each<[string, Partial<ThreadView>, string]>([
    ["working on a tool: the tool", { status: "busy", busyTool: "Bash make check" }, "Bash make check"],
    ["compacting", { status: "busy", statusReason: "compacting" }, "compacting"],
    ["a question: its text", { status: "attention", statusReason: "question: Which one?" }, "Which one?"],
    ["a permission: the tool", { status: "attention", statusReason: "permission: Bash zig build" }, "Bash zig build"],
    ["a plan", { status: "attention", statusReason: "plan: Claude has written up a plan" }, "ready for review"],
    ["a flag: its reason", { flags: [flag("attention", "3 warnings in main.go")] }, "3 warnings in main.go"],
    ["interrupted", { state: "disconnected", status: "error", statusReason: "interrupted" }, "resend to continue"],
  ])("%s: the detail, muted and truncated, no branch", (_name, o, text) => {
    renderRow(o);
    const d = screen.getByTestId("row-detail");
    expect(d.textContent).toBe(text);
    expect(d.className.split(" ")).toEqual(expect.arrayContaining(["truncate", "text-cf-sidebar-muted-foreground"]));
    expect(screen.queryByTestId("row-branch")).toBeNull();
  });

  it.each<[string, Partial<ThreadView>]>([
    ["idle", {}],
    ["done", { status: "attention", statusReason: "finished" }],
    ["working with no tool yet", { status: "busy" }],
    // Waiting: the badge carries the count (lib/liveCount), line 3 the branch.
    ["waiting on child threads", { status: "idle", statusReason: "waiting on 2 child threads" }],
    ["waiting on children and a subagent", { status: "idle", statusReason: "waiting on 2 child threads and 1 subagent" }],
    ["waiting on a wake", { status: "idle", statusReason: "waiting" }],
  ])("%s: the branch glyph and the branch in mono", (_name, o) => {
    renderRow(o);
    expect(screen.queryByTestId("row-detail")).toBeNull();
    expect(screen.getByTestId("row-branch").textContent).toBe("main");
    expect(screen.getByTestId("row-branch").className).toContain("font-mono");
    expect(screen.getByTestId("row-branch-icon").getAttribute("class")).toContain("lucide-git-branch");
    expect(line3().textContent).toBe("main");
  });

  it("no project: an empty line that keeps its height", () => {
    renderRow({ projectId: "", projectIds: [], worktreePath: "/Users/dev" });
    expect(line3().textContent).toBe("");
    expect(line3().className).toContain("h-4");
  });

  it("no git: the No git badge instead of a branch", () => {
    renderRow({ projectId: "notes", projectIds: ["notes"], worktreePath: "/src/notes" });
    expect(screen.queryByTestId("row-branch")).toBeNull();
    expect(line3().textContent).toBe("No git");
    expect(screen.getByTestId("no-git-badge")).toBeTruthy();
    expect(screen.getByTestId("row-project").textContent).toBe("writing");
  });

  it("background agents (info, a bot) and shells (muted, a terminal), only when running", () => {
    renderRow({ backgroundAgentsRunning: 3, backgroundShellsRunning: 1 });
    const a = screen.getByTestId("row-bg-agents");
    expect(a.textContent).toBe("3");
    expect(a.className).toContain("text-cf-info-text");
    expect(a.querySelector("svg")?.getAttribute("class")).toContain("lucide-bot");
    const sh = screen.getByTestId("row-bg-shells");
    expect(sh.textContent).toBe("1");
    expect(sh.className).toContain("text-cf-sidebar-muted-foreground");
    expect(sh.querySelector("svg")?.getAttribute("class")).toContain("lucide-square-terminal");
    cleanup();
    renderRow({ agentsRunning: 2, backgroundAgentsRunning: 0, backgroundShellsRunning: 0 });
    expect(screen.queryByTestId("row-bg-agents")).toBeNull();
    expect(screen.queryByTestId("row-bg-shells")).toBeNull();
  });

  it("the bot badge counts background subagents and live child threads as one number", () => {
    const kid = (id: string, o: Partial<ThreadView>) => thread({ id, name: id, createdBy: "s-1", archivedAtMs: null, snoozedUntilMs: null, ...o });
    useThreadsStore.setState({
      byId: {
        "s-1": thread({ status: "idle", statusReason: "waiting on 2 child threads and 1 subagent", backgroundAgentsRunning: 1, archivedAtMs: null, snoozedUntilMs: null }),
        k1: kid("k1", { status: "busy" }),
        k2: kid("k2", { status: "idle", statusReason: "waiting on 1 child thread" }),
        k3: kid("k3", { status: "attention", statusReason: "finished" }),
      },
      order: ["s-1", "k1", "k2", "k3"],
    });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "working", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    const a = screen.getByTestId("row-bg-agents");
    expect(a.textContent).toBe("3");
    expect(a.getAttribute("aria-label")).toBe("3 subagents");
    expect(screen.queryByTestId("row-detail")).toBeNull();
    expect(screen.getByTestId("row-branch").textContent).toBe("main");
    // The last live child settles: the badge follows.
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, k1: kid("k1", { status: "attention", statusReason: "finished" }), k2: kid("k2", { status: "attention", statusReason: "finished" }) } }));
    });
    expect(screen.getByTestId("row-bg-agents").textContent).toBe("1");
    expect(screen.getByTestId("row-bg-agents").getAttribute("aria-label")).toBe("1 subagent");
  });

  it("a stopped thread looks like any other: not dimmed, no offline mark", () => {
    renderRow({ state: "disconnected" });
    const body = screen.getByTestId("thread-body");
    expect(body.className).not.toContain("opacity-50");
    expect(body.getAttribute("data-offline")).toBeNull();
    expect(body.getAttribute("data-thread-badge")).toBe("idle");
  });
});

describe("SidebarRow hover actions", () => {
  it("Snooze and Archive buttons, 20px, rounded-sm, labelled, over the status", () => {
    renderRow({ status: "attention", statusReason: "question: Which one?" });
    const actions = screen.getByTestId("row-actions");
    expect(actions.className.split(" ")).toEqual(expect.arrayContaining(["opacity-0", "group-hover/row:opacity-100"]));
    for (const [id, label, icon] of [
      ["row-snooze", "Snooze thread", "lucide-alarm-clock"],
      ["row-archive", "Archive thread", "lucide-archive"],
    ] as const) {
      const b = screen.getByTestId(id);
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("aria-label")).toBe(label);
      expect(b.className.split(" ")).toEqual(expect.arrayContaining(["size-5", "rounded-sm", "text-cf-icon-muted", "bg-cf-sidebar-row-selected"]));
      expect(b.querySelector("svg")?.getAttribute("class")).toContain(icon);
    }
    expect(screen.getByTestId("row-status").parentElement?.className).toContain("group-hover/row:invisible");
  });

  it("tab stops only on the cursor's row", () => {
    renderRow({});
    expect(screen.getByTestId("row-archive").tabIndex).toBe(-1);
    cleanup();
    useThreadsStore.setState({ byId: { "s-1": thread({}) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "idle", threadId: "s-1" }} selected={false} cursor onActivate={() => undefined} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("row-archive").tabIndex).toBe(0);
    expect(screen.getByTestId("row-snooze").tabIndex).toBe(0);
  });

  it.each([
    ["row-snooze", "Snooze thread"],
    ["row-archive", "Archive thread"],
  ])("%s: its tooltip opens at once, above", async (id, label) => {
    renderRow({});
    fireEvent.focus(screen.getByTestId(id));
    const tip = await screen.findAllByText(label, { selector: "[data-testid$=-tip] *, [data-testid$=-tip]" });
    expect(tip.length).toBeGreaterThan(0);
    expect(screen.getByTestId(`${id}-tip`).getAttribute("data-side")).toBe("top");
  });

  it("Archive archives at once and does not select the row", () => {
    archiveThread.mockClear();
    const onActivate = vi.fn();
    useThreadsStore.setState({ byId: { "s-1": thread({}) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "idle", threadId: "s-1" }} selected={false} cursor={false} onActivate={onActivate} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId("row-archive"));
    expect(archiveThread).toHaveBeenCalledWith("s-1", true);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("Snooze opens the preset menu without selecting the row; a preset snoozes", () => {
    snoozeThread.mockClear();
    const onActivate = vi.fn();
    useThreadsStore.setState({ byId: { "s-1": thread({}) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "idle", threadId: "s-1" }} selected={false} cursor={false} onActivate={onActivate} />
      </TooltipProvider>,
    );
    const trigger = screen.getByTestId("row-snooze");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(trigger);
    expect(onActivate).not.toHaveBeenCalled();
    const presets = screen.getAllByTestId("snooze-preset");
    expect(presets.map((p) => p.getAttribute("data-preset"))).toEqual(["1h", "3h", "tomorrow", "next-week"]);
    expect(screen.getByTestId("row-actions").getAttribute("data-shown")).toBe("true");
    fireEvent.click(presets[0] as HTMLElement);
    expect(snoozeThread).toHaveBeenCalledWith("s-1", expect.any(Number));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("the snooze menu never opens the row's card: not moving over it, nor focus coming back as it closes", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    useThreadsStore.setState({ byId: { "s-1": thread({}) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "idle", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    // Radix opens the card on a timer even at delay 0.
    const cardOpen = () => {
      act(() => {
        vi.advanceTimersByTime(50);
      });
      return screen.queryAllByTestId("thread-tooltip").filter((e) => e.getAttribute("data-state") !== "closed").length;
    };
    const trigger = screen.getByTestId("row-snooze");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.pointerUp(document, { pointerType: "mouse" });
    fireEvent.click(trigger);
    const menu = screen.getByTestId("row-snooze-menu");
    const preset = screen.getAllByTestId("snooze-preset")[0] as HTMLElement;
    // Off the snooze button into the menu, then along it: React bubbles both to the row.
    fireEvent.pointerOver(menu, { pointerType: "mouse", relatedTarget: trigger });
    fireEvent.pointerMove(preset, { pointerType: "mouse" });
    expect(cardOpen()).toBe(0);
    // Escape closes the menu and hands focus back to the snooze button.
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByTestId("row-snooze-menu")).toBeNull();
    expect(cardOpen()).toBe(0);
    // A move over the row itself still opens it.
    fireEvent.pointerMove(screen.getByTestId("thread-name"), { pointerType: "mouse" });
    expect(cardOpen()).toBe(1);
  });

  it("a snoozed or archived row has no hover actions", () => {
    useThreadsStore.setState({ byId: { "s-1": thread({ snoozedUntilMs: Date.now() + MIN }) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "snoozed", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    expect(screen.queryByTestId("row-actions")).toBeNull();
  });
});

describe("SidebarRow provisional name", () => {
  it.each([
    ["provisional: the name, muted and italic", { name: "fix the login redirect", nameProvisional: true }, "fix the login redirect", true, true],
    ["the naming model's title: plain", { name: "Fix the login redirect", nameProvisional: false }, "Fix the login redirect", false, false],
    ["unnamed: the id, muted, not italic", { name: "", nameProvisional: false }, "s-1", true, false],
    ["being regenerated: the name, muted and italic", { name: "Fix the login redirect", nameProvisional: false, naming: true }, "Fix the login redirect", true, true],
  ])("%s", (_name, o, text, muted, italic) => {
    renderRow(o);
    const el = screen.getByTestId("thread-name");
    expect(el.textContent).toBe(text);
    expect(el.className.includes("text-cf-sidebar-muted-foreground")).toBe(muted);
    expect(el.className.includes("italic")).toBe(italic);
    expect(el.getAttribute("data-provisional")).toBe(italic ? "true" : null);
    // One role above the row's text-body-sm, medium; a named thread keeps the row's colour.
    const cls = el.className.split(" ");
    expect(cls).toContain("text-body");
    expect(cls).toContain("font-medium");
    expect(cls).not.toContain("text-body-sm");
    expect(cls.includes("text-inherit")).toBe(!muted);
  });
});

describe("SidebarRow rename field", () => {
  function openRename(o: Partial<ThreadView>): HTMLInputElement {
    renameThread.mockClear();
    useUiStore.setState({ renamingThreadId: "s-1" });
    renderRow(o);
    return screen.getByTestId<HTMLInputElement>("rename-input");
  }

  it("the naming model's title landing while it is open: an untouched commit keeps the title", () => {
    const input = openRename({ name: "fix the login redirect", nameProvisional: true });
    act(() => {
      useThreadsStore.setState({ byId: { "s-1": thread({ name: "Fix login redirect loop", nameProvisional: false }) } });
    });
    fireEvent.blur(input);
    expect(renameThread).not.toHaveBeenCalled();
  });

  it("an edit commits", () => {
    const input = openRename({ name: "fix the login redirect", nameProvisional: true });
    fireEvent.change(input, { target: { value: "Login loop" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameThread).toHaveBeenCalledWith("s-1", "Login loop");
  });
});

describe("SidebarRow archived", () => {
  function renderArchived(o: Partial<ThreadView>): HTMLElement {
    useThreadsStore.setState({ byId: { "s-1": thread({ state: "disconnected", status: "attention", statusReason: "finished", ...o }) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "archived", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    return screen.getByRole("option");
  }

  it("one line: the name and the age of the archive, no status line, not dimmed", () => {
    const row = renderArchived({ name: "Old work", archivedAtMs: Date.now() - 3 * 3_600_000 - 60_000 });
    expect(row.textContent).toBe("Old work3h");
    expect(screen.queryByTestId("row-line-1")).toBeNull();
    expect(screen.queryByTestId("row-actions")).toBeNull();
    expect(screen.getByTestId("row-archived-age").className).toContain("tabular-nums");
    expect(screen.getByTestId("thread-body").className).not.toContain("opacity-50");
  });

  it("quiet: the name keeps text-body but is regular and muted, and so is the age", () => {
    renderArchived({ name: "Old work", archivedAtMs: Date.now() });
    const cls = screen.getByTestId("thread-name").className.split(" ");
    expect(cls).toEqual(expect.arrayContaining(["text-body", "text-cf-sidebar-muted-foreground"]));
    expect(cls).not.toContain("font-medium");
    expect(cls).not.toContain("text-inherit");
    expect(screen.getByTestId("row-archived-age").className.split(" ")).toEqual(expect.arrayContaining(["text-caption-sm", "text-cf-sidebar-muted-foreground"]));
    expect(screen.getByTestId("row-archived-age").querySelector("svg")).toBeNull();
  });

  it("a provisional name stays italic on the quiet row", () => {
    renderArchived({ name: "fix the login redirect", nameProvisional: true, archivedAtMs: Date.now() });
    const cls = screen.getByTestId("thread-name").className.split(" ");
    expect(cls).toEqual(expect.arrayContaining(["text-body", "text-cf-sidebar-muted-foreground", "italic"]));
    expect(cls).not.toContain("font-medium");
  });

  it("an unnamed thread shows its id, muted", () => {
    renderArchived({ name: "", archivedAtMs: Date.now() });
    expect(screen.getByTestId("thread-name").textContent).toBe("s-1");
    expect(screen.getByTestId("thread-name").className).toContain("text-cf-sidebar-muted-foreground");
    expect(screen.getByTestId("row-archived-age").textContent).toBe("0m");
  });
});

describe("SidebarRow snoozed", () => {
  function renderSnoozed(o: Partial<ThreadView>): HTMLElement {
    useThreadsStore.setState({ byId: { "s-1": thread({ state: "disconnected", status: "attention", statusReason: "finished", ...o }) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "snoozed", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    return screen.getByRole("option");
  }

  it.each([
    [45 * 60_000 + 30_000, "45m"],
    [2 * 3_600_000 + 50 * 60_000, "2h"],
    [18 * 3_600_000 + 5 * 60_000, "18h"],
    [4 * 86_400_000 + 3_600_000, "4d"],
    [20_000, "<1m"],
  ])("one line: the name and the time left (%i ms → %s), no status line, not dimmed", (left, want) => {
    const row = renderSnoozed({ name: "Later work", snoozedUntilMs: Date.now() + left });
    expect(row.textContent).toBe(`Later work${want}`);
    expect(row.getAttribute("data-section")).toBe("snoozed");
    expect(screen.queryByTestId("row-line-1")).toBeNull();
    expect(screen.queryByTestId("row-actions")).toBeNull();
    expect(screen.getByTestId("row-snooze-left").className).toContain("tabular-nums");
    expect(screen.getByTestId("row-snooze-left").className).toContain("text-caption-sm");
    expect(screen.getByTestId("thread-body").className).not.toContain("opacity-50");
    expect(screen.getByTestId("thread-body").hasAttribute("data-snoozed")).toBe(true);
  });

  it("quiet: regular muted name; the countdown is an alarm clock then the time left, muted", () => {
    renderSnoozed({ name: "Later work", snoozedUntilMs: Date.now() + 2 * 3_600_000 + 60_000 });
    const name = screen.getByTestId("thread-name").className.split(" ");
    expect(name).toEqual(expect.arrayContaining(["text-body", "text-cf-sidebar-muted-foreground"]));
    expect(name).not.toContain("font-medium");
    const left = screen.getByTestId("row-snooze-left");
    expect(left.className.split(" ")).toEqual(expect.arrayContaining(["text-caption-sm", "text-cf-sidebar-muted-foreground", "gap-1"]));
    const icon = screen.getByTestId("row-snooze-icon");
    expect(left.firstElementChild).toBe(icon);
    expect(icon.getAttribute("class")).toContain("lucide-alarm-clock");
    expect(icon.getAttribute("class")).toContain("size-3");
    expect(left.textContent).toBe("2h");
  });

  it("an unnamed thread shows its id, muted", () => {
    renderSnoozed({ name: "", snoozedUntilMs: Date.now() + 3_600_000 + 1000 });
    expect(screen.getByTestId("thread-name").textContent).toBe("s-1");
    expect(screen.getByTestId("thread-name").className).toContain("text-cf-sidebar-muted-foreground");
    expect(screen.getByTestId("row-snooze-left").textContent).toBe("1h");
  });
});

describe("SidebarRow footer headers", () => {
  it.each([
    ["working", "Working", 2, false],
    ["snoozed", "Snoozed", 3, true],
    ["archived", "Archived", 5, true],
  ] as const)("%s: label and count, a toggle button", (section, label, count, collapsed) => {
    render(<SidebarRow row={{ key: `h:${section}`, kind: "header", section, label, count, collapsed }} selected={false} cursor={false} onActivate={() => undefined} />);
    const button = screen.getByTestId(`${section}-header`);
    expect(button.textContent).toBe(`${label} ${String(count)}`);
    expect(button.getAttribute("aria-expanded")).toBe(collapsed ? "false" : "true");
  });

  it("the Snoozed header toggles only the Snoozed section", () => {
    useUiStore.setState({ workingCollapsed: false, snoozedCollapsed: true, archivedCollapsed: true });
    render(<SidebarRow row={{ key: "h:snoozed", kind: "header", section: "snoozed", label: "Snoozed", count: 1, collapsed: true }} selected={false} cursor={false} onActivate={() => undefined} />);
    fireEvent.click(screen.getByTestId("snoozed-header"));
    expect(useUiStore.getState()).toMatchObject({ workingCollapsed: false, snoozedCollapsed: false, archivedCollapsed: true });
  });
});

describe("SidebarRow created by a thread", () => {
  const glyph = () => screen.queryByTestId("row-created-by");

  it("a muted ↳ before the name of an agent's thread; the other lines unchanged", () => {
    renderRow({ name: "Child", createdBy: "s-p", createdByName: "Parent" });
    const g = glyph();
    expect(g).not.toBeNull();
    expect(g?.getAttribute("class")).toContain("text-cf-icon-muted");
    expect(g?.nextElementSibling?.getAttribute("data-testid")).toBe("thread-name");
    expect(screen.getByTestId("row-branch").textContent).toBe("main");
  });

  it("nothing for the user's thread", () => {
    renderRow({ name: "Mine" });
    expect(glyph()).toBeNull();
  });

  it("in the single-line footers too", () => {
    useThreadsStore.setState({ byId: { "s-1": thread({ name: "Old child", createdBy: "s-p", archivedAtMs: Date.now() }) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "archived", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
      </TooltipProvider>,
    );
    expect(glyph()?.nextElementSibling?.textContent).toBe("Old child");
  });
});

describe("SidebarRow linked PRs tag", () => {
  const SLUG = "o/r";
  const link = (number: number) => ({ slug: SLUG, number, url: `https://github.com/${SLUG}/pull/${String(number)}`, linkedAt: null });
  const pr = (number: number, state: PullRequestView["state"], o: Partial<PullRequestView> = {}) =>
    ({ repoSlug: SLUG, number, state, draft: false, title: `PR ${String(number)}`, updatedAtMs: 1, partial: false, ...o }) as PullRequestView;
  const dashboard = (authored: PullRequestView[], recentlyMerged: PullRequestView[] = []) =>
    ({ authored, reviewRequested: [], reviewed: [], recentlyMerged }) as unknown as DashboardView;

  beforeEach(() => {
    pullRequestDetailResource.store.setState({ entries: {} });
    dashboardResource.store.setState({ entries: {} });
  });

  const tag = () => screen.queryByTestId("row-linked-prs");

  it("no links, or only closed ones: no tag", () => {
    renderRow({});
    expect(tag()).toBeNull();
    cleanup();
    pullRequestDetailResource.set(pullRequestKey(SLUG, 131), { data: { pullRequest: pr(131, "closed") } as PullRequestDetailView });
    renderRow({ linkedPullRequests: [link(131)] });
    expect(tag()).toBeNull();
  });

  it.each([
    ["open: green, the PR icon", pr(142, "open"), "open", "success", "text-cf-success-text"],
    ["draft: the draft tone", pr(145, "open", { draft: true }), "draft", "draft", "text-cf-text-muted"],
    ["merged: the merged tone", pr(138, "merged"), "merged", "merged", "text-cf-highlight-text"],
  ])("one %s, the bare number", (_name, p, state, tone, cls) => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([p]) });
    renderRow({ linkedPullRequests: [link(p.number)] });
    const el = tag();
    expect(el?.textContent).toBe(String(p.number));
    expect(el?.getAttribute("data-state")).toBe(state);
    expect(el?.getAttribute("data-tone")).toBe(tone);
    expect(el?.className).toContain(cls);
    expect(el?.querySelector(`svg[aria-label="${state}"]`)).not.toBeNull();
  });

  it("one not read yet: the number, neutral, the generic icon", () => {
    renderRow({ linkedPullRequests: [link(7)] });
    expect(tag()?.textContent).toBe("7");
    expect(tag()?.getAttribute("data-state")).toBe("unknown");
    expect(tag()?.getAttribute("data-tone")).toBe("neutral");
  });

  it("several: the worst state's icon and tone, +N all of them without closed ones", () => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([pr(1, "open"), pr(2, "open", { draft: true })], [pr(3, "merged")]) });
    pullRequestDetailResource.set(pullRequestKey(SLUG, 4), { data: { pullRequest: pr(4, "closed") } as PullRequestDetailView });
    renderRow({ linkedPullRequests: [link(1), link(2), link(3), link(4)] });
    expect(tag()?.textContent).toBe("+3");
    expect(tag()?.getAttribute("data-kind")).toBe("many");
    expect(tag()?.getAttribute("data-state")).toBe("draft");
    expect(tag()?.getAttribute("data-tone")).toBe("draft");
    expect(tag()?.querySelector("svg")?.getAttribute("aria-label")).toBe("draft");
  });

  it("has no tooltip of its own; the row's card stays shut over it and opens again off it", () => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([pr(1, "open")]) });
    renderRow({ linkedPullRequests: [link(1)] });
    expect(tag()?.hasAttribute("data-tip")).toBe(false);
    expect(tag()?.hasAttribute("data-quiet")).toBe(true);
    const open = () => screen.queryAllByTestId("thread-tooltip").filter((e) => e.getAttribute("data-state") !== "closed").length;
    const t = tag() as HTMLElement;
    fireEvent.pointerMove(t, { pointerType: "mouse" });
    fireEvent.pointerOver(t, { pointerType: "mouse" });
    expect(open()).toBe(0);
    // Off the tag onto the name: open at once.
    fireEvent.pointerOver(screen.getByTestId("thread-name"), { pointerType: "mouse", relatedTarget: t });
    expect(open()).toBe(1);
  });

  it("the fresher read wins: a cached detail newer than the dashboard", () => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([pr(142, "open", { updatedAtMs: 1 })]) });
    pullRequestDetailResource.set(pullRequestKey(SLUG, 142), { data: { pullRequest: pr(142, "merged", { updatedAtMs: 2 }) } as PullRequestDetailView });
    renderRow({ linkedPullRequests: [link(142)] });
    expect(tag()?.getAttribute("data-state")).toBe("merged");
  });

  it("re-renders when the state moves", () => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([pr(142, "open")]) });
    renderRow({ linkedPullRequests: [link(142)] });
    expect(tag()?.getAttribute("data-state")).toBe("open");
    act(() => {
      dashboardResource.set(DASHBOARD_KEY, { data: dashboard([], [pr(142, "merged", { updatedAtMs: 2 })]) });
    });
    expect(tag()?.getAttribute("data-state")).toBe("merged");
  });
});

describe("SidebarRow linked PR tag click", () => {
  const link = (slug: string, number: number) => ({ slug, number, url: `https://github.com/${slug}/pull/${String(number)}`, linkedAt: null });

  beforeEach(() => {
    pullRequestDetailResource.store.setState({ entries: {} });
    dashboardResource.store.setState({ entries: {} });
    showThreadView.mockClear();
    showThreadInfo.mockClear();
  });

  function renderWith(o: Partial<ThreadView>, selected: { kind: "none" } | { kind: "thread"; id: string } = { kind: "none" }) {
    useUiStore.setState({ selection: selected as never });
    const onActivate = vi.fn();
    useThreadsStore.setState({ byId: { "s-1": thread(o) }, order: ["s-1"] });
    render(
      <TooltipProvider>
        <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "idle", threadId: "s-1" }} selected={false} cursor={false} onActivate={onActivate} />
      </TooltipProvider>,
    );
    return onActivate;
  }

  it("one PR: selects the thread and opens the PR in its panel (the link's slug), not the row's click", () => {
    const onActivate = renderWith({ linkedPullRequests: [link("Owner/Repo", 142)] });
    fireEvent.click(screen.getByTestId("row-linked-prs"));
    expect(onActivate).not.toHaveBeenCalled();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    expect(useUiStore.getState().cursorKey).toBe("s:s-1");
    expect(showThreadView).toHaveBeenCalledWith("panel.pr", "s-1", { slug: "Owner/Repo", number: "142" });
    expect(showThreadInfo).not.toHaveBeenCalled();
  });

  it("several: every counted one in the panel, the shown one last (active), closed ones left out", () => {
    pullRequestDetailResource.set(pullRequestKey("o/r", 3), { data: { pullRequest: { repoSlug: "o/r", number: 3, state: "closed", draft: false, title: "", updatedAtMs: 1, partial: false } } as PullRequestDetailView });
    pullRequestDetailResource.set(pullRequestKey("o/r", 1), { data: { pullRequest: { repoSlug: "o/r", number: 1, state: "open", draft: true, title: "", updatedAtMs: 1, partial: false } } as PullRequestDetailView });
    const onActivate = renderWith({ linkedPullRequests: [link("o/r", 1), link("o/r", 2), link("o/r", 3)] });
    expect(screen.getByTestId("row-linked-prs").textContent).toBe("+2");
    fireEvent.click(screen.getByTestId("row-linked-prs"));
    expect(onActivate).not.toHaveBeenCalled();
    expect(showThreadInfo).not.toHaveBeenCalled();
    expect(showThreadView.mock.calls).toEqual([
      ["panel.pr", "s-1", { slug: "o/r", number: "2" }],
      ["panel.pr", "s-1", { slug: "o/r", number: "1" }],
    ]);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
  });

  it("one PR of an already selected thread: the selection stays as it is", () => {
    const select = vi.spyOn(useUiStore.getState(), "select");
    renderWith({ linkedPullRequests: [link("o/r", 7)] }, { kind: "thread", id: "s-1" });
    fireEvent.click(screen.getByTestId("row-linked-prs"));
    expect(select).not.toHaveBeenCalled();
    expect(showThreadView).toHaveBeenCalledWith("panel.pr", "s-1", { slug: "o/r", number: "7" });
    select.mockRestore();
  });
});

describe("SidebarRow card (docs/notes/sidebar-thread-card.md)", () => {
  const SLUG = "o/r";
  const link = (number: number, at: number) => ({ slug: SLUG, number, url: `https://github.com/${SLUG}/pull/${String(number)}`, linkedAt: at });
  const pr = (number: number, state: PullRequestView["state"], o: Partial<PullRequestView> = {}) =>
    ({ repoSlug: SLUG, number, state, draft: false, title: `PR ${String(number)}`, updatedAtMs: 1, partial: false, ...o }) as PullRequestView;
  const dashboard = (authored: PullRequestView[], recentlyMerged: PullRequestView[] = []) =>
    ({ authored, reviewRequested: [], reviewed: [], recentlyMerged }) as unknown as DashboardView;

  beforeEach(() => {
    pullRequestDetailResource.store.setState({ entries: {} });
    dashboardResource.store.setState({ entries: {} });
    useProjectsStore.setState({
      byId: {
        cf: { id: "cf", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/cf", branch: "main", head: "a", isMain: true }, { path: "/wt/cf/feat-x", branch: "feat/x", head: "b", isMain: false }] },
        gp: { id: "gp", name: "ghostty-playground", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/gp", branch: "main", head: "c", isMain: true }, { path: "/wt/gp/cf-login", branch: "cf/login", head: "d", isMain: false }] },
        notes: { id: "notes", name: "writing", git: false, githubSlug: "", remotes: [], worktrees: [{ path: "/src/notes", branch: "", head: "", isMain: true }] },
      } as never,
      order: ["cf", "gp", "notes"],
    });
    useWorkspacesStore.setState({ byId: { "w-1": { id: "w-1", name: "login" } } as never });
  });

  /** Renders the row and opens its card (the provider's 500 ms delay on fake timers). */
  function openCard(o: Partial<ThreadView>): HTMLElement {
    vi.useFakeTimers();
    try {
      renderRow(o);
      fireEvent.pointerMove(screen.getByRole("option"), { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(600);
      });
    } finally {
      vi.useRealTimers();
    }
    return screen.getAllByTestId("thread-tooltip")[0] as HTMLElement;
  }
  const ids = (card: HTMLElement) => Array.from(card.querySelectorAll(":scope > div")).map((e) => e.getAttribute("data-testid"));
  const text = (card: HTMLElement, id: string) => within(card).queryByTestId(id)?.textContent ?? null;

  it.each([
    ["the main checkout: Project folder", { worktreePath: "/src/cf" }, "Project folder", "main"],
    ["a worktree made for it: Fresh copy, no worktree chip on the branch", { worktreePath: "/wt/cf/feat-x", createdWorktree: true, branch: "feat/x" }, "Fresh copy", "feat/x"],
    ["a worktree the user picked: no place", { worktreePath: "/wt/cf/feat-x" }, null, "feat/x"],
  ])("one project, %s", (_name, o, place, branch) => {
    const card = openCard(o);
    expect(ids(card)).toEqual(["tip-name", "tip-project", "tip-branch", "tip-model"]);
    // Where it runs is muted text, like a workspace's count, not a chip.
    expect(text(card, "tip-project-meta")).toBe(place);
    expect(within(card).queryByTestId("tip-project-chip")).toBeNull();
    expect(text(card, "tip-branch")).toBe(branch);
    expect(within(card).queryByTestId("tip-branch-chip")).toBeNull();
  });

  it("a waiting thread's card says the daemon's whole reason and names its live children", () => {
    const kid = (id: string, name: string, o: Partial<ThreadView>) => thread({ id, name, createdBy: "s-1", archivedAtMs: null, snoozedUntilMs: null, ...o });
    const kids = {
      k1: kid("k1", "Inbox row layout", { status: "busy" }),
      k2: kid("k2", "Rewrite the row tests", { status: "idle", statusReason: "waiting on 1 child thread" }),
      k3: kid("k3", "Done one", { status: "attention", statusReason: "finished" }),
    };
    vi.useFakeTimers();
    try {
      useThreadsStore.setState({ byId: { "s-1": thread({ status: "idle", statusReason: "waiting on 2 child threads and 1 subagent", archivedAtMs: null, snoozedUntilMs: null }), ...kids }, order: ["s-1", "k1", "k2", "k3"] });
      render(
        <TooltipProvider>
          <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "working", threadId: "s-1" }} selected={false} cursor={false} onActivate={() => undefined} />
        </TooltipProvider>,
      );
      fireEvent.pointerMove(screen.getByRole("option"), { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(600);
      });
    } finally {
      vi.useRealTimers();
    }
    const card = screen.getAllByTestId("thread-tooltip")[0] as HTMLElement;
    expect(text(card, "tip-waiting")).toContain("Waiting on 2 child threads and 1 subagent");
    expect(within(card).getAllByTestId("tip-waiting-name").map((e) => e.textContent)).toEqual(["Inbox row layout", "Rewrite the row tests"]);
  });

  it("a project without git keeps its no git chip", () => {
    const card = openCard({ projectId: "notes", projectIds: ["notes"], worktreePath: "/src/notes" });
    expect(text(card, "tip-project-chip")).toBe("no git");
    expect(within(card).queryByTestId("tip-project-meta")).toBeNull();
    expect(within(card).queryByTestId("tip-branch")).toBeNull();
  });

  it("a workspace thread: workspace, then the run-in project with Fresh copy, branch, model; no member list", () => {
    const card = openCard({ projectId: "gp", projectIds: ["cf", "gp"], workspaceId: "w-1", worktreePath: "/wt/gp/cf-login", createdWorktree: true, branch: "cf/login" });
    expect(ids(card)).toEqual(["tip-name", "tip-workspace", "tip-project", "tip-branch", "tip-model"]);
    expect(text(card, "tip-workspace")).toBe("login2 projects");
    expect(text(card, "tip-workspace-meta")).toBe("2 projects");
    expect(within(card).getByTestId("tip-workspace").querySelector("svg")?.getAttribute("class")).toContain("lucide-layers");
    expect(text(card, "tip-project")).toBe("ghostty-playgroundFresh copy");
    expect(text(card, "tip-project-meta")).toBe("Fresh copy");
    expect(text(card, "tip-branch")).toBe("cf/login");
    expect(within(card).queryByTestId("tip-set")).toBeNull();
  });

  it("an unnamed set: N projects, in place: Project folder", () => {
    const card = openCard({ projectId: "gp", projectIds: ["cf", "gp"], worktreePath: "/src/gp" });
    expect(text(card, "tip-workspace")).toBe("2 projects");
    expect(within(card).queryByTestId("tip-workspace-meta")).toBeNull();
    expect(text(card, "tip-project-meta")).toBe("Project folder");
  });

  it("a thread in its workspace's folder: the workspace, then the folder as the place, no chip", () => {
    const card = openCard({ projectId: "", projectIds: ["cf", "gp"], workspaceId: "w-1", worktreePath: "/home/.code-foundry/workspaces/w-1", createdWorktree: true, branch: "cf/login" });
    expect(text(card, "tip-workspace")).toBe("login2 projects");
    expect(text(card, "tip-project")).toBe("Workspace folder");
    expect(within(card).queryByTestId("tip-project-chip")).toBeNull();
    expect(within(card).queryByTestId("tip-project-meta")).toBeNull();
  });

  it("no linked PRs, or only closed ones: no section, no hairline", () => {
    let card = openCard({});
    expect(within(card).queryByTestId("tip-prs")).toBeNull();
    cleanup();
    pullRequestDetailResource.set(pullRequestKey(SLUG, 131), { data: { pullRequest: pr(131, "closed") } as PullRequestDetailView });
    card = openCard({ linkedPullRequests: [link(131, 1)] });
    expect(within(card).queryByTestId("tip-prs")).toBeNull();
  });

  it("the linked PRs after the model, newest linked first, closed left out, state icon and number in the state's colour", () => {
    dashboardResource.set(DASHBOARD_KEY, { data: dashboard([pr(142, "open", { title: "Fix the login" }), pr(145, "open", { draft: true, title: "Draft it" })], [pr(138, "merged", { title: "Merged one" })]) });
    pullRequestDetailResource.set(pullRequestKey(SLUG, 131), { data: { pullRequest: pr(131, "closed") } as PullRequestDetailView });
    const card = openCard({ linkedPullRequests: [link(138, 1), link(131, 2), link(145, 3), link(142, 4), link(7, 5)] });
    expect(ids(card).at(-1)).toBe("tip-prs");
    const rows = within(card).getAllByTestId("tip-pr");
    expect(rows.map((r) => r.textContent)).toEqual(["#7", "#142Fix the login", "#145Draft it", "#138Merged one"]);
    expect(rows.map((r) => r.getAttribute("data-state"))).toEqual(["unknown", "open", "draft", "merged"]);
    expect(rows[1]?.querySelector("svg")?.getAttribute("class")).toContain("text-cf-success-text");
    expect(rows[1]?.querySelector("span")?.className).toContain("text-cf-success-text");
    expect(rows[2]?.querySelector('svg[aria-label="draft"]')).not.toBeNull();
    expect(rows[3]?.querySelector("span")?.className).toContain("text-cf-highlight-text");
    expect(rows[1]?.querySelector(".truncate")?.textContent).toBe("Fix the login");
    expect(within(card).queryByTestId("tip-prs-more")).toBeNull();
  });

  it("at most five rows, then +N more", () => {
    const card = openCard({ linkedPullRequests: [1, 2, 3, 4, 5, 6, 7].map((n) => link(n, n)) });
    expect(within(card).getAllByTestId("tip-pr")).toHaveLength(5);
    expect(text(card, "tip-prs-more")).toBe("+2 more");
  });
});

describe("SidebarRow card status time", () => {
  function openCard(o: Partial<ThreadView>): HTMLElement {
    vi.useFakeTimers();
    try {
      renderRow(o);
      fireEvent.pointerMove(screen.getByRole("option"), { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(600);
      });
    } finally {
      vi.useRealTimers();
    }
    return screen.getAllByTestId("thread-tooltip")[0] as HTMLElement;
  }

  it.each<[string, Partial<ThreadView>, string, string]>([
    ["a question: for 6m", { status: "attention", statusReason: "question: Which one?" }, "Asked a question · for 6m", "amber"],
    ["an error: for 6m", { status: "attention", statusReason: "error: model_not_found" }, "Error · model_not_found · for 6m", "red"],
    ["interrupted: for 6m", { state: "disconnected", status: "error", statusReason: "interrupted" }, "Interrupted while working · for 6m", "red"],
    ["done: 6m ago, green", { status: "attention", statusReason: "finished" }, "Finished 6m ago", "emerald"],
  ])("%s", (_name, o, text, tone) => {
    const card = openCard({ ...o, statusChangedAtMs: Date.now() - 6 * MIN - 5_000 });
    const st = within(card).getByTestId("tip-status");
    expect(st.textContent).toBe(text);
    expect(st.getAttribute("data-tone")).toBe(tone);
    expect(within(card).getByTestId("tip-status-time").className).toContain("text-cf-text-muted");
  });

  it("a flag: its reason, no time", () => {
    const card = openCard({ flags: [flag("attention", "3 warnings")], statusChangedAtMs: Date.now() - 6 * MIN });
    expect(within(card).getByTestId("tip-status").textContent).toBe("Lint: 3 warnings");
  });

  it("working and idle: no status row; model stays", () => {
    const card = openCard({ status: "busy", statusChangedAtMs: Date.now() - 6 * MIN });
    expect(within(card).queryByTestId("tip-status")).toBeNull();
    expect(within(card).getByTestId("tip-model")).toBeTruthy();
  });
});

describe("SidebarRow line 1 of a multi-project thread: the run-in project only", () => {
  beforeEach(() => {
    useProjectsStore.setState({
      byId: {
        cf: { id: "cf", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/cf", branch: "main", head: "a", isMain: true }] },
        gp: { id: "gp", name: "ghostty-playground", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/wt/gp/cf-login", branch: "cf/login", head: "d", isMain: false }] },
      } as never,
      order: ["cf", "gp"],
    });
    useWorkspacesStore.setState({ byId: { "w-1": { id: "w-1", name: "login" } } as never });
  });

  it.each([
    ["a workspace thread", { projectId: "gp", projectIds: ["cf", "gp"], workspaceId: "w-1", worktreePath: "/wt/gp/cf-login", createdWorktree: true, branch: "cf/login" }, "ghostty-playground", "cf/login"],
    ["an unnamed set", { projectId: "cf", projectIds: ["cf", "gp"], worktreePath: "/src/cf" }, "code-foundry", "main"],
    ["a thread in its workspace's folder: no project, so the workspace's name", { projectId: "", projectIds: ["cf", "gp"], workspaceId: "w-1", worktreePath: "/home/.code-foundry/workspaces/w-1", createdWorktree: true, branch: "cf/login" }, "login", "cf/login"],
  ])("%s: the Layers glyph, then the project", (_name, o, project, branch) => {
    renderRow(o);
    expect(screen.getByTestId("row-project").textContent).toBe(project);
    expect(screen.getByTestId("row-workspace").getAttribute("class")).toContain("lucide-layers");
    expect(screen.getByTestId("row-branch").textContent).toBe(branch);
  });

  it("a single-project thread: no Layers glyph", () => {
    renderRow({});
    expect(screen.queryByTestId("row-workspace")).toBeNull();
  });
});
