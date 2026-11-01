import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBER_THREAD, EmberWorld, putEmberThread, setEmberEnabled } from "@/test/emberBoard";

// The board stream is the store's; the test publishes boards itself. The chat's rows, its
// composer and its cite layer are their own components' (and ember.spec.ts's): stand-ins
// here, the composer saying which prompt it shows.
vi.mock("@/stores/ember", async (orig) => ({ ...(await orig<typeof import("@/stores/ember")>()), holdEmberBoard: () => () => undefined }));
vi.mock("./EmberTimeline", () => ({ EmberTimeline: () => <div data-testid="ember-timeline" /> }));
vi.mock("@/components/thread/ThreadComposer", () => ({
  ThreadComposer: ({ placeholder, busyPlaceholder }: { placeholder: string; busyPlaceholder: string }) => <div data-testid="thread-composer" data-placeholder={placeholder} data-busy-placeholder={busyPlaceholder} />,
}));
vi.mock("@/components/thread/cite/CiteLayer", () => ({ CiteLayer: () => null }));
vi.mock("@/components/thread/AgentsStrip", () => ({ AgentsStrip: () => null }));

const { EmberBody } = await import("./EmberPane");
const { useEmberStore } = await import("@/stores/ember");
const { openEmberBoard } = await import("@/stores/emberPanel");
const { usePanelStore } = await import("@/stores/panel");
const { useThreadStore } = await import("@/stores/thread");
const { useUiStore } = await import("@/stores/ui");

/**
 * Ember's chat header (docs/notes/ember-3-gui.md, ember-fixes-2-gui.md,
 * ember-fixes-3-board.md): the flame and "Ember", the board's summary with its dot, Board
 * and Show work, no thread buttons, and Ember's prompt.
 */

let world: EmberWorld;

const header = () => screen.getByTestId("thread-header");
const summary = () => screen.getByTestId("ember-header-status");
const dot = () => summary().querySelector("[data-dot]")?.getAttribute("data-dot") ?? null;

beforeEach(() => {
  setEmberEnabled(true);
  putEmberThread();
  useUiStore.setState({ selection: { kind: "thread", id: EMBER_THREAD }, emberShowWork: false });
  usePanelStore.setState({ byKey: {} });
  world = new EmberWorld();
  world.publish();
});

afterEach(() => {
  cleanup();
  useEmberStore.setState({ board: null, error: null, focus: null });
});

describe("EmberBody's header", () => {
  it("the flame and Ember, the board's summary, Board and Show work; no archive; Ember's prompt", () => {
    render(<EmberBody threadId={EMBER_THREAD} />);
    expect(screen.getByTestId("ember-title").textContent).toBe("Ember");
    expect(summary().textContent).toBe("4 threads working · 1 blocked · 1 queued");
    // The blocked wails task: amber.
    expect(dot()).toBe("amber");
    expect(screen.getByTestId("ember-board-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("ember-show-work").getAttribute("aria-pressed")).toBe("false");
    expect(header().querySelector('[data-command-button="thread.archive"]')).toBeNull();
    expect(screen.getByTestId("thread-composer").dataset.placeholder).toBe("Tell Ember what you want done…");
    expect(screen.getByTestId("thread-composer").dataset.busyPlaceholder).toBe("Tell Ember more; it reads it mid-turn…");
  });

  it("the summary follows the board: workers waiting on the user first, then timers", () => {
    render(<EmberBody threadId={EMBER_THREAD} />);
    // A team member finishing leaves the count.
    act(() => {
      world.status("s-ember-team-post", "attention", "finished");
    });
    expect(summary().textContent).toBe("3 threads working · 1 blocked · 1 queued");
    act(() => {
      world.status("s-ember-team-post", "busy", "working");
    });
    act(() => {
      world.status("s-ember-team-put", "attention", "question: 404 or 422 for a bad id?");
    });
    expect(summary().textContent).toBe("1 needs you · 3 threads working · 1 blocked · 1 queued");
    act(() => {
      world.status("s-ember-notes", "attention", "permission: Bash git push");
    });
    expect(summary().textContent).toBe("2 need you · 2 threads working · 1 blocked · 1 queued");
    expect(dot()).toBe("amber");
    act(() => {
      world.addTimer("sub-1", 30, { note: "check the notes draft" });
    });
    expect(summary().textContent).toBe("2 need you · 2 threads working · 1 blocked · 1 queued · 1 scheduled");
  });

  it("nothing working: no thread count and no sky dot; a lead's report to check counts; closed, gone", () => {
    render(<EmberBody threadId={EMBER_THREAD} />);
    act(() => {
      world.task("t-1a2b3c4d", { state: "done" });
      for (const id of ["s-ember-notes", "s-ember-team-post", "s-ember-team-put", "s-ember-lead"]) world.status(id, "attention", "finished");
    });
    expect(summary().textContent).toBe("1 blocked · 1 queued");
    act(() => {
      world.report("s-ember-lead", "done", "POST and PUT /notes validated; pushed cf/notes-validation");
    });
    expect(summary().textContent).toBe("1 to check · 1 blocked · 1 queued");
    expect(summary().querySelector('[data-dot="sky"]')).toBeNull();
    act(() => {
      world.task("t-4c5d6e7f", { state: "done" });
    });
    expect(summary().textContent).toBe("1 blocked · 1 queued");
  });

  it("Board opens the board in the chat's panel and hides it again", () => {
    render(<EmberBody threadId={EMBER_THREAD} />);
    const toggle = screen.getByTestId("ember-board-toggle");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const panel = () => usePanelStore.getState().byKey[`thread:${EMBER_THREAD}`];
    expect(panel()?.open).toBe(true);
    expect(panel()?.groups[0]?.tabs.map((t) => t.kind)).toEqual(["ember"]);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(panel()?.open).toBe(false);
    // A task link's click (TaskPointer) opens it too, pressed.
    act(() => {
      openEmberBoard("t-9c0d1e2f");
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("Show work opens every work row and drops the user's own choices on them", () => {
    useThreadStore.setState({ expanded: { [EMBER_THREAD]: { "w:run-1": true, "w:run-2": false, "t:tool-1": true } } });
    render(<EmberBody threadId={EMBER_THREAD} />);
    const show = screen.getByTestId("ember-show-work");
    fireEvent.click(show);
    expect(show.getAttribute("aria-pressed")).toBe("true");
    expect(useUiStore.getState().emberShowWork).toBe(true);
    expect(useThreadStore.getState().expanded[EMBER_THREAD]).toEqual({ "t:tool-1": true });
    fireEvent.click(show);
    expect(useUiStore.getState().emberShowWork).toBe(false);
  });
});
