import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadSetupStepView, ThreadSetupView, ThreadView } from "@/api/threads";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setupRowPhase, SETUP_FOLD_KEY } from "@/lib/threadSetup";
import { useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { FoldInPlaceContext, ThreadContext } from "./context";
import { TimelineRowView } from "./rows";

const NOW = Date.UTC(2026, 10, 5, 10, 0, 0);

function step(kind: ThreadSetupStepView["kind"], status: ThreadSetupStepView["status"], over: Partial<ThreadSetupStepView> = {}): ThreadSetupStepView {
  return { kind, projectId: "", projectName: "", ref: "", branch: "", status, startedAtMs: null, endedAtMs: null, error: "", warning: "", refAtMs: null, ...over };
}

function setup(phase: ThreadSetupView["phase"], steps: ThreadSetupStepView[], over: Partial<ThreadSetupView> = {}): ThreadSetupView {
  return { phase, startedAtMs: NOW - 3000, endedAtMs: null, steps, error: "", background: true, ...over };
}

function seed(s: ThreadSetupView): void {
  useThreadsStore.setState({ byId: { s: { id: "s", setup: s } as ThreadView }, order: ["s"] });
}

function View({ foldInPlace }: { foldInPlace?: (el: HTMLElement, change: () => void) => void }) {
  const folds = useThreadStore((st) => st.folds.s);
  return (
    <TooltipProvider>
      <ThreadContext.Provider value={{ threadId: "s", cwd: "" }}>
        <FoldInPlaceContext.Provider value={foldInPlace ?? ((_el, change) => { change(); })}>
          <TimelineRowView row={{ type: "setup", key: SETUP_FOLD_KEY, folded: folds?.[SETUP_FOLD_KEY] ?? true }} />
        </FoldInPlaceContext.Provider>
      </ThreadContext.Provider>
    </TooltipProvider>
  );
}

const lines = () => screen.queryAllByTestId("thread-setup-line").map((l) => `${l.dataset.status ?? ""}: ${l.textContent}`);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useThreadStore.setState({ folds: {} });
  useThreadsStore.setState({ byId: {}, order: [] });
});

describe("SetupRow", () => {
  const running = setup("running", [
    step("name", "done", { branch: "cf/fix-badge", startedAtMs: NOW - 3000, endedAtMs: NOW - 1800 }),
    step("fetch", "running", { ref: "origin/main", startedAtMs: NOW - 3000 }),
    step("worktree", "pending"),
    step("start", "pending"),
  ]);

  it("running: a live line, then a row per step with its time, the rest dim", () => {
    seed(running);
    render(<View />);
    expect(screen.getByTestId("thread-setup-live").textContent).toBe("Setting up·3s");
    expect(lines()).toEqual(["done: Named the branch cf/fix-badge1.2s", "running: Fetching origin/main3s", "pending: Creating the worktree", "pending: Starting Claude"]);
  });

  it("ticks every second while it runs", () => {
    seed(running);
    render(<View />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId("thread-setup-live").textContent).toBe("Setting up·5s");
  });

  it("takes no height at first, and shows its lines the moment a step reaches 300ms, not at the next second", () => {
    seed(setup("running", [step("fetch", "running", { ref: "origin/main", startedAtMs: NOW - 50 }), step("start", "pending")], { startedAtMs: NOW - 50 }));
    const { container } = render(<View />);
    expect(container.textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(container.textContent).toBe("");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId("thread-setup-live")).toBeTruthy();
    expect(lines()).toHaveLength(2);
  });

  it("a fast setup never shows", () => {
    seed(setup("running", [step("fetch", "running", { ref: "origin/main", startedAtMs: NOW - 50 }), step("start", "pending")], { startedAtMs: NOW - 50 }));
    const { container } = render(<View />);
    act(() => {
      vi.advanceTimersByTime(100);
      seed(setup("done", [step("fetch", "done", { ref: "origin/main", startedAtMs: NOW - 50, endedAtMs: NOW + 100 }), step("start", "done", { startedAtMs: NOW + 100, endedAtMs: NOW + 100 })], { startedAtMs: NOW - 50, endedAtMs: NOW + 100 }));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toBe("");
  });

  it("a step that leaves the list just goes, and the rest stay in order", () => {
    seed(running);
    render(<View />);
    act(() => {
      seed({ ...running, steps: running.steps.filter((s) => s.kind !== "fetch") });
    });
    expect(lines()).toEqual(["done: Named the branch cf/fix-badge1.2s", "pending: Creating the worktree", "pending: Starting Claude"]);
  });

  it("warned: an amber line, and the setup carries on", () => {
    seed(
      setup("running", [
        step("fetch", "warning", { ref: "origin/main", warning: "Could not reach origin", startedAtMs: NOW - 21_000, endedAtMs: NOW - 1000, refAtMs: NOW - 1000 - 2 * 3_600_000 }),
        step("worktree", "running", { startedAtMs: NOW - 1000 }),
      ]),
    );
    const { container } = render(<View />);
    expect(screen.getByTestId("thread-setup-live")).toBeTruthy();
    expect(lines()).toEqual(["warning: Could not reach origin, using origin/main from 2h ago20s", "running: Creating the worktree1s"]);
    expect(container.querySelector("[data-key='fetch:'] .ico svg")?.getAttribute("class")).toContain("t-amber");
  });

  it("failed: no live line, the failed row in bold with git's text under it, the rest as they ended", () => {
    seed(
      setup(
        "failed",
        [
          step("name", "done", { branch: "cf/x", startedAtMs: NOW - 3000, endedAtMs: NOW - 2000 }),
          step("worktree", "failed", { startedAtMs: NOW - 400, endedAtMs: NOW - 100, error: "fatal: cannot lock ref" }),
          step("start", "pending"),
        ],
        { endedAtMs: NOW - 100 },
      ),
    );
    const { container } = render(<View />);
    expect(screen.queryByTestId("thread-setup-live")).toBeNull();
    expect(lines()).toEqual(["done: Named the branch cf/x1.0s", "failed: Could not create the worktree0.3s", "pending: Starting Claude"]);
    expect(container.querySelector("[data-key='worktree:'] b")?.textContent).toBe("Could not create the worktree");
    expect(screen.getByTestId("thread-setup-error").textContent).toBe("fatal: cannot lock ref");
  });

  it("several projects: the name in bold, then the step", () => {
    const a = { projectId: "a", projectName: "alpha" };
    const b = { projectId: "b", projectName: "beta" };
    seed(setup("running", [step("worktree", "done", { ...a, startedAtMs: NOW - 3000, endedAtMs: NOW - 1000 }), step("worktree", "running", { ...b, startedAtMs: NOW - 1000 })]));
    const { container } = render(<View />);
    expect(lines()).toEqual(["done: alphaWorktree ready2.0s", "running: betaCreating the worktree1s"]);
    expect([...container.querySelectorAll(".setup-project")].map((x) => x.textContent)).toEqual(["alpha", "beta"]);
  });

  it("cancelled: one quiet line, no rows", () => {
    seed(setup("cancelled", [step("name", "done", { branch: "cf/x", startedAtMs: NOW - 4000, endedAtMs: NOW - 3000 }), step("worktree", "pending")], { startedAtMs: NOW - 4200, endedAtMs: NOW }));
    render(<View />);
    expect(screen.getByTestId("thread-setup").textContent).toBe("Setup cancelled after 4s");
    expect(lines()).toEqual([]);
  });

  const done = setup(
    "done",
    [step("name", "done", { branch: "cf/x", startedAtMs: NOW - 6800, endedAtMs: NOW - 5600 }), step("worktree", "done", { startedAtMs: NOW - 5600, endedAtMs: NOW - 1000 }), step("start", "done", { startedAtMs: NOW - 1000, endedAtMs: NOW })],
    { startedAtMs: NOW - 6800, endedAtMs: NOW },
  );

  it("done: folded to one line; a click opens the steps, keeping the line where it is, and closes them", () => {
    seed(done);
    const held: HTMLElement[] = [];
    render(
      <View
        foldInPlace={(el, change) => {
          held.push(el);
          change();
        }}
      />,
    );
    const fold = screen.getByTestId("thread-setup-fold");
    expect(fold.textContent).toBe("Set up in 6.8s");
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(lines()).toEqual([]);
    fireEvent.click(fold);
    expect(held[0]?.contains(fold)).toBe(true);
    expect(screen.getByTestId("thread-setup-fold").getAttribute("aria-expanded")).toBe("true");
    expect(lines()).toEqual(["done: Named the branch cf/x1.2s", "done: Created the worktree4.6s", "done: Started Claude1.0s"]);
    fireEvent.click(screen.getByTestId("thread-setup-fold"));
    expect(lines()).toEqual([]);
  });

  it("done with a stale base: the fold line keeps saying so, in amber", () => {
    seed({ ...done, steps: [step("fetch", "warning", { ref: "origin/main", warning: "Could not reach origin", startedAtMs: NOW - 6800, endedAtMs: NOW - 5000, refAtMs: NOW - 5000 - 2 * 3_600_000 }), ...done.steps] });
    render(<View />);
    const fold = screen.getByTestId("thread-setup-fold");
    expect(within(fold).getByTestId("thread-setup-fold-warning").textContent).toBe("using origin/main from 2h ago");
    expect(within(fold).getByTestId("thread-setup-fold-warning").className).toContain("t-amber");
  });

  it("follows a retry: from failed to running, with what the new run says", () => {
    const failed = setup("failed", [step("name", "done", { branch: "cf/old", startedAtMs: NOW - 9000, endedAtMs: NOW - 8000 }), step("worktree", "failed", { startedAtMs: NOW - 400, endedAtMs: NOW - 100, error: "fatal: no" }), step("start", "pending")]);
    seed(failed);
    render(<View />);
    expect(screen.getByTestId("thread-setup-error")).toBeTruthy();
    act(() => {
      seed(setup("running", [step("name", "done", { branch: "cf/new", startedAtMs: NOW - 9000, endedAtMs: NOW - 8000 }), step("worktree", "running", { startedAtMs: NOW }), step("start", "pending")], { startedAtMs: NOW }));
    });
    expect(screen.queryByTestId("thread-setup-error")).toBeNull();
    expect(lines()).toEqual(["done: Named the branch cf/new1.0s", "running: Creating the worktree0s", "pending: Starting Claude"]);
  });

  it("a row the model left out is no row: the phase says so before it renders", () => {
    expect(setupRowPhase(setup("done", [step("start", "done", { startedAtMs: NOW - 5000, endedAtMs: NOW })]))).toBe("");
  });
});
