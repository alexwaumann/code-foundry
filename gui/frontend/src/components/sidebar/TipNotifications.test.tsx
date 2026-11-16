import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationView } from "@/api/notifications";
import type { ThreadView } from "@/api/threads";
import { note, noteEvent } from "@/test/notificationFakes";

const runCommandForResult = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ message: string; resultJson: string } | null>>(() => Promise.resolve({ message: "", resultJson: "{}" })));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { SidebarRow } = await import("./SidebarRow");
const { NotificationMark } = await import("./NotificationMark");
const { applyNotificationEvent, resetNotifications } = await import("@/stores/notifications");
const { usePluginsStore } = await import("@/stores/plugins");
const { useProjectsStore } = await import("@/stores/projects");
const { useThreadsStore } = await import("@/stores/threads");

/**
 * A thread row's hover card lists the notifications naming the thread
 * (docs/notes/notifications-4-row-mark.md): which ones, in which order, without the thread link,
 * what each button runs, that presses stay in the card, and that the card holds open while the
 * pointer is in it. The pointer's path from the row into the card is e2e's (sidebar-notifications).
 */

const thread = (id: string, o: Partial<ThreadView> = {}) =>
  ({ id, name: `Thread ${id}`, projectId: "cf", worktreePath: "/src/cf", workspaceId: "", projectIds: ["cf"], branch: "", createdWorktree: false, pendingWorktreePath: "", state: "connected", status: "idle", statusReason: "", statusChangedAtMs: null, lastActivityAtMs: null, agentsRunning: 0, backgroundAgentsRunning: 0, backgroundShellsRunning: 0, linkedPullRequests: [], pinned: false, ...o }) as ThreadView;

const ACTIONS: NotificationView["actions"] = [
  { label: "Send to thread", kind: "send", resolves: true, url: "" },
  { label: "Open log", kind: "open", resolves: false, url: "https://ci.example/482" },
];

function show(...notes: NotificationView[]): void {
  act(() => {
    applyNotificationEvent(noteEvent(notes));
  });
}

const onActivate = vi.fn();

function renderRow(): void {
  render(
    <TooltipProvider>
      <SidebarRow row={{ key: "s:s-1", kind: "thread", section: "idle", threadId: "s-1" }} selected={false} cursor={false} onActivate={onActivate} />
    </TooltipProvider>,
  );
}

/** Hovers the row (jsdom: a pointer move, then Radix's timer) and returns its card. */
function openCard(): HTMLElement {
  vi.useFakeTimers();
  try {
    fireEvent.pointerMove(screen.getByRole("option"), { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(600);
    });
  } finally {
    vi.useRealTimers();
  }
  return card() as HTMLElement;
}

const card = () => screen.queryAllByTestId("thread-tooltip")[0] ?? null;
const cards = (el: HTMLElement) => within(el).queryAllByTestId("notification-card");
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  resetNotifications();
  usePluginsStore.setState({ byName: { jenkins: { name: "jenkins", displayName: "Jenkins" } as never }, order: ["jenkins"] });
  useProjectsStore.setState({ byId: { cf: { id: "cf", name: "code-foundry", git: true, githubSlug: "", remotes: [], worktrees: [{ path: "/src/cf", branch: "main", head: "a", isMain: true }] } } as never, order: ["cf"] });
  useThreadsStore.setState({ byId: { "s-1": thread("s-1"), "s-2": thread("s-2") }, order: ["s-1", "s-2"], loaded: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetNotifications();
});

describe("the row's hover card: Notifications", () => {
  it("lists the thread's shown ones in the daemon's order under an overline, after the rest of the card", () => {
    show(
      note("n-ts", { threadId: "s-1", source: "jenkins", timeSensitive: true, title: "cf-nightly is waiting" }),
      note("n-other", { threadId: "s-2", title: "Not this thread's" }),
      note("n-err", { threadId: "s-1", source: "jenkins", level: "error", title: "Stage integration failed", actions: ACTIONS }),
      note("n-snz", { threadId: "s-1", status: "snoozed", title: "Snoozed" }),
      note("n-info", { threadId: "s-1", title: "Follow up on the retry" }),
    );
    renderRow();
    const c = openCard();
    const section = within(c).getByTestId("tip-notifications");
    expect(within(section).getByTestId("tip-notifications-label").textContent).toBe("Notifications");
    expect(within(section).getByTestId("tip-notifications-label").className).toContain("text-overline");
    expect(cards(section).map((e) => e.dataset.notificationId)).toEqual(["n-ts", "n-err", "n-info"]);
    // Last in the card, below the model.
    expect(c.lastElementChild?.getAttribute("data-testid")).toBe("tip-notifications");
    // Each card is the bell's: the source, the title, its buttons; divided by hairlines.
    const err = cards(section)[1] as HTMLElement;
    expect(within(err).getByTestId("notification-source").textContent).toBe("Jenkins");
    expect(within(err).getByTestId("notification-title").textContent).toBe("Stage integration failed");
    expect(within(err).getAllByTestId("notification-action").map((b) => b.textContent)).toEqual(["Send to thread", "Open log"]);
    expect(err.className).toContain("border-t");
  });

  it("leaves out the link to the thread: the card is that thread's", () => {
    show(note("n-1", { threadId: "s-1" }));
    renderRow();
    const c = openCard();
    expect(cards(c)).toHaveLength(1);
    expect(within(c).queryByTestId("notification-thread")).toBeNull();
  });

  it("caps the list's height and scrolls it on its own", () => {
    show(...Array.from({ length: 8 }, (_, i) => note(`n-${String(i)}`, { threadId: "s-1" })));
    renderRow();
    const list = within(openCard()).getByTestId("tip-notifications-list");
    expect(list.className.split(" ")).toEqual(expect.arrayContaining(["max-h-80", "overflow-y-auto", "overscroll-contain"]));
    expect(cards(list)).toHaveLength(8);
  });

  it("is wider and lets the pointer in only with notifications; without, it is the plain 260px tooltip with no section", () => {
    renderRow();
    let c = openCard();
    expect(within(c).queryByTestId("tip-notifications")).toBeNull();
    expect(c.className).toContain("w-[260px]");
    expect(c.dataset.hoverable).toBeUndefined();
    cleanup();
    show(note("n-1", { threadId: "s-1" }));
    renderRow();
    c = openCard();
    expect(c.className).toContain("w-[340px]");
    expect(c.dataset.hoverable).toBe("true");
  });

  it("a plugin's button runs notification.act with the notification's id and the button's number", async () => {
    show(note("n-err", { threadId: "s-1", level: "error", actions: ACTIONS }));
    renderRow();
    const c = openCard();
    fireEvent.click(within(c).getAllByTestId("notification-action")[1] as HTMLElement);
    await settle();
    expect(runCommandForResult).toHaveBeenCalledWith("notification.act", { id: "n-err", action: "2" }, expect.objectContaining({ quiet: true }));
    fireEvent.click(within(c).getAllByTestId("notification-action")[0] as HTMLElement);
    await settle();
    expect(runCommandForResult).toHaveBeenLastCalledWith("notification.act", { id: "n-err", action: "1" }, expect.objectContaining({ quiet: true }));
  });

  it("Dismiss runs notification.dismiss; the card stays open and the row is not opened", async () => {
    show(note("n-1", { threadId: "s-1" }));
    renderRow();
    const c = openCard();
    const dismiss = within(c).getByTestId("notification-dismiss");
    fireEvent.pointerDown(dismiss, { button: 0 });
    fireEvent.click(dismiss);
    fireEvent.doubleClick(dismiss);
    await settle();
    expect(runCommandForResult).toHaveBeenCalledWith("notification.dismiss", { id: "n-1" }, { inView: true });
    // React brings a press in the portalled card to the row: it stays in the card.
    expect(onActivate).not.toHaveBeenCalled();
    expect(card()).not.toBeNull();
  });

  it("holds open while the pointer is in it when another tooltip opens (a corner button's), and shuts once it is not", () => {
    show(note("n-1", { threadId: "s-1" }));
    renderRow();
    const c = openCard();
    fireEvent.pointerEnter(c);
    // Radix shuts every open tooltip when another one opens.
    act(() => {
      document.dispatchEvent(new CustomEvent("tooltip.open"));
    });
    expect(card()).not.toBeNull();
    fireEvent.pointerLeave(c);
    act(() => {
      document.dispatchEvent(new CustomEvent("tooltip.open"));
    });
    expect(card()).toBeNull();
  });

  it("holds open while a card's snooze menu is up", async () => {
    show(note("n-1", { threadId: "s-1" }));
    renderRow();
    const c = openCard();
    fireEvent.pointerDown(within(c).getByTestId("notification-snooze"), { button: 0, ctrlKey: false });
    expect(await screen.findByTestId("notification-snooze-menu")).toBeTruthy();
    act(() => {
      document.dispatchEvent(new CustomEvent("tooltip.open"));
    });
    expect(card()).not.toBeNull();
    expect(screen.getByTestId("notification-snooze-menu")).toBeTruthy();
  });

  it("a thread without notifications keeps the plain tooltip: another tooltip opening shuts it", () => {
    renderRow();
    const c = openCard();
    fireEvent.pointerEnter(c);
    act(() => {
      document.dispatchEvent(new CustomEvent("tooltip.open"));
    });
    expect(card()).toBeNull();
  });
});

describe("the row's mark: a narrow selector", () => {
  it("a thread no notification names does not re-render when another thread's change", () => {
    const renders: string[] = [];
    render(
      <>
        <Profiler id="s-1" onRender={() => renders.push("s-1")}>
          <NotificationMark id="s-1" />
        </Profiler>
        <Profiler id="s-2" onRender={() => renders.push("s-2")}>
          <NotificationMark id="s-2" />
        </Profiler>
      </>,
    );
    renders.length = 0;
    show(note("n-1", { threadId: "s-1" }));
    show(note("n-1", { threadId: "s-1" }), note("n-2", { threadId: "s-1", level: "error" }));
    show(note("n-1", { threadId: "s-1", title: "changed" }), note("n-2", { threadId: "s-1", level: "error" }));
    expect(renders.filter((r) => r === "s-2")).toEqual([]);
    // s-1 renders for its count and tone, not for a change that leaves both as they were.
    expect(renders.filter((r) => r === "s-1")).toHaveLength(2);
    expect(screen.getByTestId("row-notifications").textContent).toBe("2");
    expect(screen.getByTestId("row-notifications").dataset.tone).toBe("error");
  });
});
