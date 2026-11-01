import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useEmberStore } from "@/stores/ember";
import { usePanelStore } from "@/stores/panel";
import { useUiStore } from "@/stores/ui";
import { EMBER_THREAD, EmberWorld, putEmberThread, setEmberEnabled } from "@/test/emberBoard";
import { tooltipText } from "@/test/tooltip";
import { EmberMarkdown, TaskPointer } from "./EmberTimeline";

/**
 * A task link in Ember's chat as a pointer line (docs/notes/ember-3-gui.md,
 * ember-fixes-2-gui.md, ember-fixes-3-board.md): the board's title, where the task is, a
 * done task's branch, live; a click opens the Board at it. splitTaskLinks (the markdown
 * to links) is lib/ember.test.ts's.
 */

let world: EmberWorld;

function link(id: string, name: string) {
  render(<TaskPointer id={id} name={name} />);
  const el = screen.getByTestId("ember-task-link");
  return { el, part: (p: string) => within(el).queryByTestId(p)?.textContent ?? null, meta: () => within(el).getByTestId("ember-task-link-meta") };
}

beforeEach(() => {
  setEmberEnabled(true);
  putEmberThread();
  useUiStore.setState({ selection: { kind: "thread", id: EMBER_THREAD } });
  usePanelStore.setState({ byKey: {} });
  world = new EmberWorld();
  world.publish();
});

afterEach(() => {
  cleanup();
  useEmberStore.setState({ board: null, error: null, focus: null });
});

describe("TaskPointer", () => {
  it("a blocked task: its title and state; a click opens the board at it; the state follows the board", () => {
    const { el, part } = link("t-9c0d1e2f", "Bump wails to v3.1");
    expect(el.dataset.task).toBe("t-9c0d1e2f");
    expect(part("ember-task-link-title")).toBe("Bump wails to v3.1");
    expect(part("ember-task-link-meta")).toBe("· blocked");
    expect(within(el).getByTestId("ember-task-link-glyph")).toBeTruthy();
    fireEvent.click(el);
    const panel = usePanelStore.getState().byKey[`thread:${EMBER_THREAD}`];
    expect(panel?.open).toBe(true);
    expect(panel?.groups[0]?.tabs.map((t) => t.kind)).toEqual(["ember"]);
    expect(useEmberStore.getState().focus?.id).toBe("t-9c0d1e2f");
    act(() => {
      world.task("t-9c0d1e2f", { state: "done", outcome: "Pinned" });
    });
    expect(part("ember-task-link-meta")).toBe("· done");
  });

  it("the board's title over the link's, a done task's branch, a rename live; the tooltip says where a click goes", () => {
    const { el, part } = link("t-3a4b5c6d", "Fix flaky TestSendSpawnFailure");
    expect(part("ember-task-link-title")).toBe("Fix the flaky TestSendSpawnFailure");
    expect(part("ember-task-link-meta")).toBe("· done");
    expect(part("ember-task-link-branch")).toBe("·cf/spawn-timeout-race");
    expect(tooltipText(el)).toBe("Open on the board");
    act(() => {
      world.task("t-3a4b5c6d", { title: "Pin the spawn timeout" });
    });
    expect(part("ember-task-link-title")).toBe("Pin the spawn timeout");
  });

  it("a task not on the board keeps the link's words and no state", () => {
    const { part } = link("t-00000000", "Gone task");
    expect(part("ember-task-link-title")).toBe("Gone task");
    expect(part("ember-task-link-meta")).toBeNull();
  });

  it("a worker waiting on the user: needs you, in amber; a lead's report waits on Ember's check", () => {
    const { meta } = link("t-4c5d6e7f", "Validate notes API input");
    expect(meta().className).not.toContain("text-cf-warning-text");
    act(() => {
      world.status("s-ember-team-put", "attention", "question: 404 or 422 for a bad id?");
    });
    expect(meta().textContent).toContain("· needs you");
    expect(meta().className).toContain("text-cf-warning-text");
    act(() => {
      for (const id of ["s-ember-team-post", "s-ember-team-put", "s-ember-lead"]) world.status(id, "attention", "finished");
      world.report("s-ember-lead", "done", "POST and PUT /notes validated; pushed cf/notes-validation");
    });
    expect(meta().textContent).toContain("worker reported done, waiting for Ember to check");
  });

  it("Ember's markdown: a link alone on its line is a pointer line, no raw link left; a rename reaches every link to the task", () => {
    render(
      <>
        <EmberMarkdown text={"On it. Two pieces, each in its own thread.\n\n[Add release notes for 0.20](cf-task://t-1a2b3c4d)\n[Bump wails to v3.1](cf-task://t-9c0d1e2f)\n\nI'll tell you when the notes are up."} />
        <EmberMarkdown text={"The wails bump is blocked.\n\n[Bump wails to v3.1](cf-task://t-9c0d1e2f)"} />
      </>,
    );
    const links = () => screen.getAllByTestId("ember-task-link");
    expect(links().map((l) => l.dataset.task)).toEqual(["t-1a2b3c4d", "t-9c0d1e2f", "t-9c0d1e2f"]);
    expect(document.body.textContent).not.toContain("cf-task://");
    expect(document.body.textContent).toContain("I'll tell you when the notes are up.");
    act(() => {
      world.task("t-9c0d1e2f", { state: "blocked", title: "Pin wails at 3.0" });
    });
    const wails = links().filter((l) => l.dataset.task === "t-9c0d1e2f");
    expect(wails.map((l) => within(l).getByTestId("ember-task-link-title").textContent)).toEqual(["Pin wails at 3.0", "Pin wails at 3.0"]);
  });
});
