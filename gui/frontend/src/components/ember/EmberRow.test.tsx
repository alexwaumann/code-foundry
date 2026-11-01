import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBER_THREAD, EmberWorld, putEmberThread, setEmberEnabled } from "@/test/emberBoard";

// The board stream is the store's; the test publishes boards itself.
vi.mock("@/stores/ember", async (orig) => ({ ...(await orig<typeof import("@/stores/ember")>()), holdEmberBoard: () => () => undefined }));

const { EmberRow } = await import("./EmberRow");
const { useEmberStore } = await import("@/stores/ember");
const { usePanelStore } = await import("@/stores/panel");
const { useUiStore } = await import("@/stores/ui");
const { useViewsStore } = await import("@/stores/views");

/**
 * Ember's pinned sidebar row (docs/notes/ember-3-gui.md, ember-fixes-2-gui.md,
 * ember-fixes-3-board.md) over the mock's seeded board: "<Status> · <task> · N threads
 * · N blocked · N scheduled", the flame, the click and the menu. The words' rules are
 * lib/ember.test.ts's; this is what the row shows of them.
 */

let world: EmberWorld;

const row = () => screen.getByTestId("sidebar-ember");
const part = (id: string) => screen.queryByTestId(id)?.textContent ?? null;
const status = () => screen.getByTestId("ember-row-status");

function live(f: () => void): void {
  act(f);
}

beforeEach(() => {
  setEmberEnabled(true);
  putEmberThread();
  useUiStore.setState({ selection: { kind: "home" } as never, cursorKey: null });
  usePanelStore.setState({ byKey: {} });
  world = new EmberWorld();
  world.publish();
});

afterEach(() => {
  cleanup();
  useEmberStore.setState({ board: null, error: null, focus: null });
});

describe("EmberRow", () => {
  it("shows only while Ember is on", () => {
    setEmberEnabled(false);
    render(<EmberRow />);
    expect(screen.queryByTestId("sidebar-ember")).toBeNull();
    live(() => {
      setEmberEnabled(true);
    });
    expect(row()).toBeTruthy();
    live(() => {
      setEmberEnabled(false);
    });
    expect(screen.queryByTestId("sidebar-ember")).toBeNull();
  });

  it("Working, the first doing task and the working threads; the flame works; the blocked task counted", () => {
    render(<EmberRow />);
    expect(part("ember-row-name")).toBe("Ember");
    expect(part("ember-row-status")).toBe("Working");
    expect(part("ember-row-task")).toBe("Add release notes for 0.20");
    // The notes worker, the lead (waiting on its team) and the team's two working threads.
    expect(part("ember-row-threads")).toBe("4 threads");
    expect(part("ember-row-blocked")).toBe("1 blocked");
    expect(part("ember-row-scheduled")).toBeNull();
    expect(row().dataset.flame).toBe("working");
    // A team member finishing leaves the count, live.
    live(() => {
      world.status("s-ember-team-post", "attention", "finished");
    });
    expect(part("ember-row-threads")).toBe("3 threads");
    // A timer Ember set counts too.
    live(() => {
      world.addTimer("sub-1", 30, { note: "check the notes draft" });
    });
    expect(part("ember-row-scheduled")).toBe("1 scheduled");
  });

  it("a worker waiting on the user: Needs input in amber naming its task, the attention flame; +1 for a second; answered, Working again", () => {
    render(<EmberRow />);
    live(() => {
      world.status("s-ember-team-put", "attention", "question: 404 or 422 for a bad id?");
    });
    expect(status().textContent).toBe("Needs input");
    expect(status().className).toContain("text-cf-warning-text");
    expect(part("ember-row-task")).toBe("Validate notes API input");
    expect(row().dataset.flame).toBe("attention");
    // A task whose own worker asks comes first, "+1" for the other.
    live(() => {
      world.status("s-ember-notes", "attention", "permission: Bash git push");
    });
    expect(part("ember-row-task")).toBe("Add release notes for 0.20 +1");
    live(() => {
      world.status("s-ember-notes", "busy", "working");
      world.status("s-ember-team-put", "busy", "working");
    });
    expect(status().textContent).toBe("Working");
    expect(row().dataset.flame).toBe("working");
  });

  it("a budget stop reads Stopped at budget, naming its task", () => {
    render(<EmberRow />);
    live(() => {
      world.status("s-ember-notes", "attention", "budget reached");
    });
    expect(status().textContent).toBe("Stopped at budget");
    expect(part("ember-row-task")).toBe("Add release notes for 0.20");
  });

  it("an idle worker on a doing task: Worker idle with no thread count; its report waits on Ember: To check; closed: Blocked", () => {
    render(<EmberRow />);
    live(() => {
      world.task("t-1a2b3c4d", { state: "done" });
      world.status("s-ember-notes", "attention", "finished");
    });
    expect(part("ember-row-threads")).toBe("3 threads");
    live(() => {
      for (const id of ["s-ember-team-post", "s-ember-team-put", "s-ember-lead"]) world.status(id, "attention", "finished");
    });
    expect(status().textContent).toBe("Worker idle");
    expect(part("ember-row-task")).toBe("Validate notes API input");
    expect(part("ember-row-threads")).toBeNull();
    expect(row().dataset.flame).toBe("idle");
    live(() => {
      world.report("s-ember-lead", "done", "POST and PUT /notes validated; pushed cf/notes-validation");
    });
    expect(status().textContent).toBe("To check");
    expect(status().className).toContain("text-cf-success-text");
    expect(row().dataset.flame).toBe("idle");
    live(() => {
      world.task("t-4c5d6e7f", { state: "done" });
    });
    expect(status().textContent).toBe("Blocked");
    // The one blocked task is the status: no "1 blocked" after it.
    expect(part("ember-row-blocked")).toBeNull();
  });

  it("a click opens the chat (selected); the keyboard cursor marks it", () => {
    render(<EmberRow />);
    expect(row().getAttribute("aria-selected")).toBe("false");
    fireEvent.click(row());
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: EMBER_THREAD });
    expect(row().getAttribute("aria-selected")).toBe("true");
    expect(row().dataset.cursor).toBeUndefined();
    live(() => {
      useUiStore.getState().setCursor("ember");
    });
    expect(row().dataset.cursor).toBe("true");
  });

  it("its menu: Open board and Settings only (no archive, snooze or rename)", () => {
    render(<EmberRow />);
    fireEvent.contextMenu(row());
    const menu = screen.getByTestId("ember-row-menu");
    expect([...menu.querySelectorAll("[role=menuitem]")].map((e) => e.textContent)).toEqual(["Open board", "Settings"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open board" }));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: EMBER_THREAD });
    const panel = usePanelStore.getState().byKey[`thread:${EMBER_THREAD}`];
    expect(panel?.open).toBe(true);
    expect(panel?.groups[0]?.tabs.map((t) => t.kind)).toEqual(["ember"]);
    fireEvent.contextMenu(row());
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "ember" });
  });
});
