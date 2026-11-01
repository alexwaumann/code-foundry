import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmberWorld, putEmberThread, setEmberEnabled } from "@/test/emberBoard";

// The board stream is the store's (one WatchBoard however many views: ember.spec.ts); the test publishes boards itself.
vi.mock("@/stores/ember", async (orig) => ({ ...(await orig<typeof import("@/stores/ember")>()), holdEmberBoard: () => () => undefined }));
const runCommandForResult = vi.hoisted(() => vi.fn(() => Promise.resolve({ message: "", resultJson: "" })));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));

const { BoardSurface } = await import("./BoardSurface");
const { focusEmberTask, useEmberStore } = await import("@/stores/ember");
const { useUiStore } = await import("@/stores/ui");

/**
 * The Board panel (docs/notes/ember-3-gui.md, ember-fixes-1-gui.md, ember-fixes-2-gui.md,
 * ember-fixes-2-timers.md, ember-fixes-3-board.md) over the mock's seeded board: its
 * sections and counts, the cards and their worker rows, a lead's team, the Scheduled list
 * and its ×, and the task a link asked for. lib/ember.test.ts has the rules.
 */

let world: EmberWorld;

const board = () => screen.getByTestId("ember-board");
const counts = () => screen.getByTestId("ember-board-counts").textContent;
const card = (id: string) => {
  const el = board().querySelector<HTMLElement>(`[data-testid="ember-task"][data-task="${id}"]`);
  if (!el) throw new Error(`no card ${id}`);
  return el;
};
const worker = (thread: string) => {
  const el = board().querySelector<HTMLElement>(`[data-testid="ember-worker"][data-thread="${thread}"]`);
  if (!el) throw new Error(`no worker row ${thread}`);
  return el;
};
const text = (el: HTMLElement, id: string) => within(el).queryByTestId(id)?.textContent ?? null;
const ids = (section: string) => [...screen.getByTestId(`ember-section-${section}`).querySelectorAll("[data-testid=ember-task]")].map((e) => e.getAttribute("data-task"));
const sections = () => [...board().querySelectorAll("section[data-testid^='ember-section-']")].map((e) => e.getAttribute("data-testid"));

beforeEach(() => {
  setEmberEnabled(true);
  putEmberThread();
  world = new EmberWorld();
  world.publish();
  runCommandForResult.mockClear();
});

afterEach(() => {
  cleanup();
  useEmberStore.setState({ board: null, error: null, focus: null });
});

describe("BoardSurface", () => {
  it("In progress and Done today in board order, the counts, no empty sections; a new todo lands in Up next, live", () => {
    render(<BoardSurface />);
    expect(counts()).toBe("3 in progress · 0 up next");
    expect(ids("in-progress")).toEqual(["t-1a2b3c4d", "t-9c0d1e2f", "t-4c5d6e7f"]);
    expect(ids("done-today")).toEqual(["t-3a4b5c6d", "t-7e8f9a0b"]);
    expect(screen.queryByTestId("ember-section-up-next")).toBeNull();
    expect(screen.queryByTestId("ember-section-scheduled")).toBeNull();
    act(() => {
      world.addTask("t-0f0f0f0f", "Same for thread read");
    });
    expect(counts()).toBe("3 in progress · 1 up next");
    expect(ids("up-next")).toEqual(["t-0f0f0f0f"]);
  });

  it("a parent's card: x of y, a progress bar, its worker and its pieces; the done piece's outcome and branch", () => {
    render(<BoardSurface />);
    const notes = card("t-1a2b3c4d");
    expect(text(notes, "ember-task-meta")).toBe("1 of 2");
    expect(within(notes).getByTestId("ember-task-progress")).toBeTruthy();
    expect(within(notes).getAllByTestId("ember-worker")).toHaveLength(3);
    const piece = notes.querySelector<HTMLElement>('[data-testid="ember-worker"][data-subtask]');
    if (!piece) throw new Error("no piece");
    expect(text(piece, "ember-worker-title")).toBe("List the PRs merged since v0.19.1");
    expect(text(piece, "ember-worker-meta")).toBe("done");
    expect(text(notes, "ember-worker-outcome")).toBe("42 PRs in docs/release-notes/prs.txt");
    expect(text(notes, "ember-worker-branch")).toBe("cf/release-notes-prs");
  });

  it("a blocked card's outcome in amber and no branch; a done card's branch under its outcome", () => {
    render(<BoardSurface />);
    const blocked = card("t-9c0d1e2f");
    expect(text(blocked, "ember-task-outcome")).toBe("wails v3.1 needs Go 1.27; the toolchain here is 1.26");
    expect(within(blocked).getByTestId("ember-task-outcome").className).toContain("text-cf-warning-text");
    expect(text(blocked, "ember-task-branch")).toBeNull();
    // A worker named after its task says Worker, not the title again.
    expect(text(worker("s-ember-wails"), "ember-worker-title")).toBe("Worker");
    const flaky = card("t-3a4b5c6d");
    expect(text(flaky, "ember-task-outcome")).toBe("Raised the spawn timeout to 5s under -race; PR #251 merged");
    expect(text(flaky, "ember-task-branch")).toBe("cf/spawn-timeout-race");
  });

  it("every age says what it is", () => {
    render(<BoardSurface />);
    const ages = screen.getAllByTestId("ember-worker-age").map((e) => e.textContent);
    expect(ages.length).toBeGreaterThan(0);
    for (const a of ages) expect(a).toMatch(/^updated (just now|\d+[mhd] ago)$/);
  });

  it("a lead's team: its rows under the lead's, counted as working; a member finishing, live; a row opens its thread", () => {
    render(<BoardSurface />);
    const lead = card("t-4c5d6e7f");
    // The lead waits on its team: Working, not Idle.
    expect(text(lead, "ember-task-meta")).toBe("Working");
    const rows = within(lead).getAllByTestId("ember-worker");
    expect(rows.map((r) => [r.dataset.thread, r.dataset.team ?? ""])).toEqual([
      ["s-ember-lead", ""],
      ["s-ember-team-schema", "true"],
      ["s-ember-team-post", "true"],
      ["s-ember-team-put", "true"],
    ]);
    // The lead's report names its workers by id: the board says their names.
    expect(text(worker("s-ember-lead"), "ember-worker-meta")).toBe("Schema done; handlers in Notes API: validate POST /notes and Notes API: validate PUT /notes/:id");
    expect(text(worker("s-ember-team-schema"), "ember-worker-meta")).toBe("Schema in internal/api/notes_schema.go");
    expect(text(worker("s-ember-team-post"), "ember-worker-meta")).toBe("Working");
    expect(worker("s-ember-team-post").querySelector("[data-dot]")?.getAttribute("data-dot")).toBe("doing");
    act(() => {
      world.status("s-ember-team-post", "attention", "finished");
    });
    expect(text(worker("s-ember-team-post"), "ember-worker-meta")).toBe("Finished");
    fireEvent.click(worker("s-ember-team-put"));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-ember-team-put" });
    fireEvent.click(worker("s-ember-notes"));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-ember-notes" });
  });

  it("a worker waiting on the user: Needs input on its row and its card; a budget stop says so", () => {
    render(<BoardSurface />);
    act(() => {
      world.status("s-ember-team-put", "attention", "question: 404 or 422 for a bad id?");
      world.status("s-ember-notes", "attention", "budget reached");
    });
    expect(text(worker("s-ember-team-put"), "ember-worker-meta")).toBe("Needs input");
    expect(text(card("t-4c5d6e7f"), "ember-task-meta")).toBe("Needs input");
    expect(text(worker("s-ember-notes"), "ember-worker-meta")).toBe("Stopped at budget");
  });

  it("a lead reporting done waits on Ember's check: reported done, the waiting line, a done dot; closed, it leaves In progress", () => {
    render(<BoardSurface />);
    act(() => {
      for (const id of ["s-ember-team-post", "s-ember-team-put", "s-ember-lead"]) world.status(id, "attention", "finished");
      world.report("s-ember-lead", "done", "POST and PUT /notes validated; pushed cf/notes-validation");
    });
    const lead = card("t-4c5d6e7f");
    expect(text(lead, "ember-task-meta")).toBe("reported done");
    expect(text(lead, "ember-task-unclosed")).toBe("Worker reported done, waiting for Ember to check");
    expect(worker("s-ember-lead").querySelector("[data-dot]")?.getAttribute("data-dot")).toBe("done");
    act(() => {
      world.task("t-4c5d6e7f", { state: "done" });
    });
    expect(ids("in-progress")).toEqual(["t-1a2b3c4d", "t-9c0d1e2f"]);
  });

  it("Scheduled: Ember's timers soonest first, between Up next and Done today; the × cancels through thread.unsubscribe", async () => {
    render(<BoardSurface />);
    const note = "Remind the user to review the PWA branch (t-aa39dec3)";
    act(() => {
      world.addTimer("sub-once", 90, { note });
      world.addTimer("sub-ping", 2, { every: "2m" });
    });
    const scheduled = screen.getByTestId("ember-section-scheduled");
    const timers = () => within(scheduled).queryAllByTestId("ember-timer");
    expect(timers().map((t) => t.dataset.timer)).toEqual(["sub-ping", "sub-once"]);
    expect(counts()).toBe("3 in progress · 0 up next · 2 scheduled");
    expect(sections()).toEqual(["ember-section-in-progress", "ember-section-scheduled", "ember-section-done-today"]);
    const [ping, once] = timers();
    if (!ping || !once) throw new Error("no timers");
    // A ping has no note: Reminder.
    expect(text(ping, "ember-timer-note")).toBe("Reminder");
    expect(text(ping, "ember-timer-every")).toBe("every 2m");
    expect(text(once, "ember-timer-note")).toBe(note);
    expect(text(once, "ember-timer-every")).toBeNull();
    expect(text(once, "ember-timer-when")).toMatch(/^(\w{3} )?\d{1,2}:\d{2} [AP]M$/);
    expect(within(once).getByTestId("ember-timer-cancel").getAttribute("aria-label")).toBe(`Cancel the timer: ${note}`);
    await act(async () => {
      fireEvent.click(within(once).getByTestId("ember-timer-cancel"));
      await Promise.resolve();
    });
    expect(runCommandForResult).toHaveBeenCalledWith("thread.unsubscribe", { subscription: "sub-once" }, { quiet: true });
    // The row goes with the board's next update.
    act(() => {
      world.removeTimer("sub-once");
    });
    expect(timers().map((t) => t.dataset.timer)).toEqual(["sub-ping"]);
    expect(counts()).toBe("3 in progress · 0 up next · 1 scheduled");
    act(() => {
      world.removeTimer("sub-ping");
    });
    expect(screen.queryByTestId("ember-section-scheduled")).toBeNull();
    expect(counts()).toBe("3 in progress · 0 up next");
  });

  it("the task a link asks for is marked; a piece marks its parent's card", () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<BoardSurface />);
    expect(board().querySelector("[data-focused]")).toBeNull();
    act(() => {
      focusEmberTask("t-9c0d1e2f");
    });
    expect(card("t-9c0d1e2f").dataset.focused).toBe("true");
    act(() => {
      focusEmberTask("t-2b3c4d5e");
    });
    expect(card("t-1a2b3c4d").dataset.focused).toBe("true");
    expect(card("t-9c0d1e2f").dataset.focused).toBeUndefined();
  });

  it("before the first board, and with nothing on it", () => {
    useEmberStore.setState({ board: null });
    render(<BoardSurface />);
    expect(board().textContent).toContain("Loading the board…");
    act(() => {
      world.tasks = [];
      world.publish();
    });
    expect(screen.getByTestId("ember-board-empty").textContent).toContain("Nothing on the board yet.");
  });
});
