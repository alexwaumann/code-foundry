import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { WakeSubscriptionView } from "@/api/wakes";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify, notifyProgress: vi.fn(), dismissNotice: vi.fn() }));

const { ComposerRow } = await import("./ComposerRow");
const { TimelineBridge } = await import("./timelineBridge");
const { useThreadsStore } = await import("@/stores/threads");
const { useThreadStore } = await import("@/stores/thread");
const { lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { seedWorld } = await import("@/test/projectsWorld");

// The row above the composer and its pill (docs/notes/composer-row-pill.md): which segments show
// for which thread, the snooze segment's menu and the commands its items run, the shortening and
// its tooltips. The waiting segment's panel: WaitingPanel.test.tsx. Geometry (nothing moves, all
// four fit at 480px): e2e composer-row.spec.ts.

let bridge = new TimelineBridge();

beforeEach(() => {
  resetDaemon();
  seedWorld();
  // The world's threads as the daemon sends them: no background shells.
  useThreadsStore.setState((s) => ({ byId: Object.fromEntries(Object.entries(s.byId).map(([k, t]) => [k, { ...t, backgroundShells: [] }])) }));
  notify.mockClear();
  bridge = new TimelineBridge();
  useThreadStore.setState({ logs: {}, synced: {}, watches: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function set(id: string, o: Partial<ThreadView>): void {
  act(() => {
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, [id]: { ...(s.byId[id] as ThreadView), ...o } } }));
  });
}

const wake = (id: string): WakeSubscriptionView => ({ id, kind: "timer", targetId: id, targetName: id, targetStatus: "", condition: "settled", note: "", ...{} });

/** The thread's Watch as the pill reads it: its wakes, and the live turn's message sent `sentAgo` ms ago. */
function log(id: string, o: { wakes?: WakeSubscriptionView[]; sentAgo?: number }): void {
  const byId = o.sentAgo === undefined ? {} : { m1: { id: "m1", kind: "user", createdAtMs: Date.now() - o.sentAgo } };
  useThreadStore.setState({
    logs: { [id]: { seq: 1, byId, order: Object.keys(byId), pending: [], mcp: null, commands: [], agents: [], wakes: o.wakes ?? [] } as never },
    synced: { [id]: true },
    watches: { [id]: { status: "open", error: null } },
  });
  if (o.sentAgo !== undefined) bridge.setSince("m1");
}

const show = (id: string, working = false) =>
  render(
    <TooltipProvider>
      <ComposerRow threadId={id} working={working} bridge={bridge} />
    </TooltipProvider>,
  );

const segments = () => [...screen.getByTestId("composer-pill").children].map((el) => (el as HTMLElement).dataset.testid);
const woken = (id: string, at = Date.now() - 2 * 60_000) => {
  set(id, { snoozedUntilMs: null, savedAtMs: null, state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: at });
};
const openSnooze = () => {
  fireEvent.pointerDown(screen.getByTestId("pill-snooze"), { button: 0, ctrlKey: false });
};

describe("ComposerRow: which segments show", () => {
  it("is always there; with nothing to say it holds no pill", () => {
    show("s-3");
    expect(screen.getByTestId("composer-row")).toBeTruthy();
    expect(screen.queryByTestId("composer-pill")).toBeNull();
  });

  it("working: the turning circle, Working and the time since the turn's message, as the turn header says it", () => {
    log("s-3", { sentAgo: 130_500 });
    show("s-3", true);
    expect(segments()).toEqual(["pill-working"]);
    const seg = screen.getByTestId("pill-working");
    expect(seg.querySelector('[data-status-circle="working"]')).not.toBeNull();
    expect(seg.textContent).toMatch(/^Working2m 1[01]s$/);
    expect(seg.tagName).toBe("SPAN");
  });

  it("working without a live turn's message: the circle and the word, no time", () => {
    show("s-3", true);
    expect(screen.getByTestId("pill-working").textContent).toBe("Working");
  });

  it("a snoozed thread that is working shows both, Working first", () => {
    set("s-3", { snoozedUntilMs: Date.now() + 3_600_000 });
    show("s-3", true);
    expect(segments()).toEqual(["pill-working", "pill-snooze"]);
  });

  it("idle and waiting: the waiting segment and Stop waiting beside it", () => {
    log("s-3", { wakes: [wake("t1")] });
    show("s-3");
    expect(segments()).toEqual(["pill-waiting", "waiting-stop"]);
    expect(screen.getByTestId("pill-waiting").querySelector('[data-status-circle="waiting"]')).not.toBeNull();
  });

  it("all four, in order: Working, Snooze, Waiting, Jump to bottom; no Stop waiting while working", () => {
    log("s-3", { wakes: [wake("t1")], sentAgo: 5000 });
    woken("s-3");
    act(() => {
      bridge.setAway(true);
    });
    show("s-3", true);
    expect(segments()).toEqual(["pill-working", "pill-snooze", "pill-waiting", "thread-jump-bottom"]);
  });

  it("Jump to bottom shows while the list is away from its bottom and runs the list's jump", () => {
    const jump = vi.fn();
    bridge.setJump(jump);
    show("s-3");
    expect(screen.queryByTestId("thread-jump-bottom")).toBeNull();
    act(() => {
      bridge.setAway(true);
    });
    expect(screen.getByTestId("thread-jump-bottom").textContent).toBe("Jump to bottom");
    fireEvent.click(screen.getByTestId("thread-jump-bottom"));
    expect(jump).toHaveBeenCalledTimes(1);
    act(() => {
      bridge.setAway(false);
    });
    expect(screen.queryByTestId("composer-pill")).toBeNull();
  });
});

describe("ComposerRow: the snooze segment and its menu", () => {
  const tomorrow9 = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };

  it("snoozed: until when; the menu states it, then Dismiss snooze, then the snooze menu", () => {
    set("s-1", { snoozedUntilMs: tomorrow9() });
    show("s-1");
    const sentence = screen.getByTestId("snooze-sentence").textContent;
    expect(sentence).toMatch(/^Snoozed until (Sun|Mon|Tue|Wed|Thu|Fri|Sat) 9:00 AM$/);
    expect(screen.getByTestId("pill-snooze").querySelector(".lucide-alarm-clock")).not.toBeNull();
    openSnooze();
    expect(screen.getByTestId("snooze-menu-state").textContent).toBe(sentence);
    const menu = screen.getByTestId("snooze-menu");
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((el) => el.dataset.testid)).toEqual(["snooze-dismiss", "snooze-preset", "snooze-preset", "snooze-preset", "snooze-preset", "snooze-pick", "snooze-save"]);
    expect(items.map((el) => el.firstChild?.textContent)).toEqual(["Dismiss snooze", "1 hour", "3 hours", "Tomorrow", "Next week", "Pick a date and time", "Save for later"]);
  });

  it("Dismiss snooze runs thread.snooze --clear for its thread, with no toast", async () => {
    set("s-1", { snoozedUntilMs: tomorrow9() });
    show("s-1");
    openSnooze();
    fireEvent.click(screen.getByTestId("snooze-dismiss"));
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze")).toMatchObject({ args: { clear: "true" }, context: { activeThreadId: "s-1" } });
    });
    expect(notify).not.toHaveBeenCalled();
    set("s-1", { snoozedUntilMs: null });
    expect(screen.queryByTestId("pill-snooze")).toBeNull();
  });

  it("a preset moves the snooze: thread.snooze with its time, no toast (the thread stays open)", async () => {
    set("s-1", { snoozedUntilMs: tomorrow9() });
    show("s-1");
    openSnooze();
    const preset = screen.getAllByTestId("snooze-preset").find((el) => el.dataset.preset === "1h");
    fireEvent.click(preset as HTMLElement);
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze")?.args.until).toBeTruthy();
    });
    expect(lastInvocation("thread.snooze")?.context).toMatchObject({ activeThreadId: "s-1" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("saved for later: says so; the menu says no alarm and has no Save for later", async () => {
    set("s-1", { savedAtMs: Date.now() });
    show("s-1");
    expect(screen.getByTestId("snooze-sentence").textContent).toBe("Saved for later");
    expect(screen.getByTestId("pill-snooze").dataset.kind).toBe("saved");
    openSnooze();
    expect(screen.getByTestId("snooze-menu-state").textContent).toBe("Saved for later, no alarm");
    expect(screen.queryByTestId("snooze-save")).toBeNull();
    fireEvent.click(screen.getByTestId("snooze-dismiss"));
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze")).toMatchObject({ args: { clear: "true" } });
    });
  });

  it("woken: Snooze ended and when, in the warning tone; the menu has Clear first", () => {
    woken("s-8");
    show("s-8");
    const line = screen.getByTestId("snooze-sentence");
    expect(line.textContent).toBe("Snooze ended 2m ago");
    expect(line.className).toContain("text-cf-warning-text");
    openSnooze();
    expect(screen.getByTestId("snooze-menu-state").textContent).toBe("Snooze ended 2m ago");
    expect(screen.queryByTestId("snooze-dismiss")).toBeNull();
    expect(screen.getByTestId("woken-clear").textContent).toBe("Clear");
    expect(screen.getByTestId("snooze-save")).toBeTruthy();
  });

  it("Clear runs thread.snooze.clear for its thread, with no toast; cleared, the segment goes", async () => {
    woken("s-8");
    show("s-8");
    openSnooze();
    fireEvent.click(screen.getByTestId("woken-clear"));
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze.clear")).toMatchObject({ args: {}, context: { activeThreadId: "s-8" } });
    });
    expect(notify).not.toHaveBeenCalled();
    set("s-8", { status: "idle", statusReason: "at prompt" });
    expect(screen.queryByTestId("pill-snooze")).toBeNull();
  });

  it("woken, a preset snoozes it again: thread.snooze with its time", async () => {
    woken("s-8");
    show("s-8");
    openSnooze();
    fireEvent.click(screen.getAllByTestId("snooze-preset")[0] as HTMLElement);
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze")).toMatchObject({ context: { activeThreadId: "s-8" } });
    });
    expect(lastInvocation("thread.snooze")?.args.until).toBeTruthy();
  });

  it("Save for later from a woken thread runs thread.snooze --save", async () => {
    woken("s-8");
    show("s-8");
    openSnooze();
    fireEvent.click(screen.getByTestId("snooze-save"));
    await vi.waitFor(() => {
      expect(lastInvocation("thread.snooze")).toMatchObject({ args: { save: "true" }, context: { activeThreadId: "s-8" } });
    });
  });
});

/**
 * Lays the row out: the row is `row` px wide, and each measured segment form has the width the
 * table gives it (jsdom lays out nothing).
 */
function layout(row: number, widths: Record<string, readonly number[]>): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const seg = this.dataset.seg;
    const width = this.dataset.testid === "composer-row" ? row : seg ? (widths[seg]?.[Number(this.dataset.form)] ?? 0) : 0;
    return { width, height: 28, top: 0, left: 0, right: width, bottom: 28, x: 0, y: 0, toJSON: () => ({}) };
  });
}

describe("ComposerRow: shortening and its tooltips", () => {
  const W = { working: [110, 70], snooze: [190, 100], waiting: [220, 110, 60], jump: [120] };
  const allFour = () => {
    log("s-3", { wakes: [wake("t1"), wake("t2")], sentAgo: 5000 });
    set("s-3", { snoozedUntilMs: Date.now() + 3_600_000 });
    act(() => {
      bridge.setAway(true);
    });
    show("s-3", true);
  };
  const forms = () => ({
    step: screen.getByTestId("composer-pill").dataset.step,
    working: screen.getByTestId("pill-working").dataset.form,
    snooze: screen.getByTestId("pill-snooze").dataset.form,
    waiting: screen.getByTestId("pill-waiting").dataset.form,
  });
  const tipped = () => ["pill-working", "pill-snooze", "pill-waiting", "thread-jump-bottom"].filter((id) => screen.getByTestId(id).hasAttribute("data-tip"));

  it("in full when it fits: no tooltips", () => {
    layout(800, W);
    allFour();
    expect(forms()).toEqual({ step: "0", working: "0", snooze: "0", waiting: "0" });
    expect(tipped()).toEqual([]);
    expect(screen.getByTestId("waiting-sentence").textContent).toBe("Waiting on 2 timers");
  });

  it("the waiting list becomes a count first, with its words in a tooltip", () => {
    layout(560, W);
    allFour();
    expect(forms()).toEqual({ step: "1", working: "0", snooze: "0", waiting: "1" });
    expect(screen.getByTestId("waiting-sentence").textContent).toBe("Waiting on 2");
    expect(tipped()).toEqual(["pill-waiting"]);
  });

  it("then snooze drops its time", () => {
    layout(470, W);
    allFour();
    expect(forms()).toEqual({ step: "2", working: "0", snooze: "1", waiting: "1" });
    expect(screen.getByTestId("snooze-sentence").textContent).toBe("Snoozed");
    expect(tipped()).toEqual(["pill-snooze", "pill-waiting"]);
  });

  it("then Working drops its word, then waiting its words; Jump to bottom never shrinks", () => {
    layout(410, W);
    allFour();
    expect(forms()).toEqual({ step: "3", working: "1", snooze: "1", waiting: "1" });
    expect(screen.getByTestId("pill-working").textContent).not.toContain("Working");
    cleanup();
    vi.restoreAllMocks();
    layout(300, W);
    allFour();
    expect(forms()).toEqual({ step: "4", working: "1", snooze: "1", waiting: "2" });
    expect(screen.getByTestId("waiting-sentence").textContent).toBe("2");
    expect(screen.getByTestId("thread-jump-bottom").textContent).toBe("Jump to bottom");
    expect(tipped()).toEqual(["pill-working", "pill-snooze", "pill-waiting"]);
  });
});
