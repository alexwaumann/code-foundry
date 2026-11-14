import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutNodeView } from "@/api/layout";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

/**
 * The direction keys' presenters (docs/notes/shell-25b-audits.md): which neighbour a key goes to
 * (the most recently focused of the panes touching that side), from which frame (the one the
 * layout draws now, not the one last drawn), and a move waiting for the one before it.
 */

const ran: [string, Record<string, string>][] = [];
/** Each pane.move's answer, resolved by the test: the daemon's reply. */
const replies: ((rev: number) => void)[] = [];
vi.mock("@/shell/commands", () => ({
  focusPaneNow: () => Promise.resolve(true),
  focusTabNow: () => Promise.resolve(true),
  runLayoutCommand: (name: string, args: Record<string, string>) => {
    ran.push([name, args]);
    // A focus the daemon has not confirmed yet: later than any layout a test seeds.
    if (!name.startsWith("pane.move.")) return Promise.resolve({ rev: 100 });
    return new Promise((resolve) => {
      replies.push((rev) => {
        resolve({ rev });
      });
    });
  },
  afterRev: () => Promise.resolve(),
  closeTabNow: () => Promise.resolve(null),
}));

const { MOVE_HOLD_MS, presentShellCommand, resetKeyPresenters } = await import("./keyPresenters");
const { geoTree, resetLayout, useLayoutStore } = await import("@/stores/layout");
const { resetShellView, setShellFrame } = await import("@/stores/shellView");
const { shellFrame } = await import("./geometry/rails");
const { neighbour } = await import("./geometry/neighbours");

const col = (id: string, kids: LayoutNodeView[], sizes: number[]): LayoutNodeView => ({ t: "split", id, dir: "col", kids, sizes });

/** Seeds the layout and draws its frame as the grid would, `w` x `h`. */
async function seed(root: LayoutNodeView, focus: string, mru: string[], w = 1200, h = 1000, rev = 1): Promise<void> {
  await seedLayout(layoutOf([space(root, focus, { mru })], rev));
  const s = useLayoutStore.getState();
  setShellFrame(shellFrame({ root: geoTree(s, "sp-a"), w, h, focus, mru }));
}

const focus = () => useLayoutStore.getState().spaces["sp-a"]?.focus;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  // A move a test left on its way lands, so the next test's keys are not held behind it.
  for (const r of replies) r(1);
  await flush();
  await flush();
  ran.length = 0;
  replies.length = 0;
  resetKeyPresenters();
  resetLayout();
  resetShellView();
});

afterEach(() => {
  resetLayout();
  resetShellView();
});

describe("direction keys", () => {
  // a | (b over d): b the shorter, so it shares less of a's edge.
  const SPLIT = row("s-r", [pane("p-a", [tab("t-a", "prs")]), col("s-c", [pane("p-b", [tab("t-b", "prs")]), pane("p-d", [tab("t-d", "prs")])], [0.3, 0.7])]);

  it("go to the pane touching that side that was focused last, so a key and its opposite come back", async () => {
    await seed(SPLIT, "p-b", ["t-b", "t-d"]);
    presentShellCommand("pane.focus.left");
    expect(focus()).toBe("p-a");
    // Back right: b, where the key came from, though d shares more of a's edge.
    presentShellCommand("pane.focus.right");
    expect(focus()).toBe("p-b");
    expect(ran.map(([n, a]) => `${n} ${a.to ?? ""}`)).toEqual(["pane.focus.left p-a", "pane.focus.right p-b"]);
  });

  it("back to the pane the key left even when the MRU does not hold it (a focus no one touched)", async () => {
    // b took the focus without a touch (its neighbour closed, or the layout as stored): MRU empty.
    await seed(SPLIT, "p-b", []);
    presentShellCommand("pane.focus.left");
    presentShellCommand("pane.focus.right");
    expect(focus()).toBe("p-b");
  });

  it("the pane a key left counts no longer once something else took the focus", async () => {
    await seed(SPLIT, "p-b", []);
    presentShellCommand("pane.focus.left");
    expect(focus()).toBe("p-a");
    // A click on d, then on a: right from a is d now, the last focused of b and d.
    const { focusPane } = await import("@/stores/layout");
    void focusPane("p-d", () => Promise.resolve(100));
    void focusPane("p-a", () => Promise.resolve(100));
    presentShellCommand("pane.focus.right");
    expect(focus()).toBe("p-d");
  });

  it("with no history, the one sharing the longest stretch of edge", async () => {
    await seed(SPLIT, "p-a", []);
    presentShellCommand("pane.focus.right");
    expect(focus()).toBe("p-d");
  });

  it("a second key before the grid redraws goes from the layout as the new focus draws it", async () => {
    // In a small area the focus decides what folds: (a over b) | (c over d), d focused.
    const root = row(
      "s-r",
      [
        col("s-l", [pane("p-a", [tab("t-a", "thread", "th-a")]), pane("p-b", [tab("t-b", "prs")])], [0.2, 0.8]),
        col("s-k", [pane("p-c", [tab("t-c", "thread", "th-c")]), pane("p-d", [tab("t-d", "projects")])], [0.25, 0.75]),
      ],
      [0.32, 0.68],
    );
    await seed(root, "p-d", ["t-d"], 900, 800);
    presentShellCommand("pane.focus.up");
    expect(focus()).toBe("p-c");
    // The frame last drawn (d focused) and the one c's focus draws send left to different panes.
    const s = useLayoutStore.getState();
    const geo = geoTree(s, "sp-a");
    const mru = s.spaces["sp-a"]?.mru ?? [];
    const stale = neighbour(shellFrame({ root: geo, w: 900, h: 800, focus: "p-d", mru: ["t-d"] }), "p-c", "left", { root: geo, mru });
    const fresh = neighbour(shellFrame({ root: geo, w: 900, h: 800, focus: "p-c", mru }), "p-c", "left", { root: geo, mru });
    expect(stale).not.toBe(fresh);
    // Pressed before the grid drew c's frame: the key goes where the screen will show.
    presentShellCommand("pane.focus.left");
    expect(focus()).toBe(fresh);
  });

  it("a move waits for the move before it to land, then moves from where the pane is", async () => {
    // a | b | c, b focused: move right twice.
    const three = (order: string[]) => row("s-r", order.map((id) => pane(id, [tab(`t-${id.slice(2)}`, "prs")])));
    await seed(three(["p-a", "p-b", "p-c"]), "p-b", ["t-b"]);
    presentShellCommand("pane.move.right");
    presentShellCommand("pane.move.right");
    await flush();
    // Only the first is sent: the second would swap b back from the old tree.
    expect(ran).toEqual([["pane.move.right", { pane: "p-b", to: "p-c" }]]);
    // The daemon swapped b and c.
    await seed(three(["p-a", "p-c", "p-b"]), "p-b", ["t-b"], 1200, 800, 2);
    replies[0]?.(2);
    await flush();
    await flush();
    // b is at the right edge now: nothing more to its right, nothing sent.
    expect(ran).toEqual([["pane.move.right", { pane: "p-b", to: "p-c" }]]);
    presentShellCommand("pane.move.left");
    await flush();
    expect(ran.at(-1)).toEqual(["pane.move.left", { pane: "p-b", to: "p-c" }]);
  });

  it("a move the daemon never answers holds the keys back no longer than MOVE_HOLD_MS", async () => {
    vi.useFakeTimers();
    try {
      await seed(SPLIT, "p-a", []);
      presentShellCommand("pane.move.right");
      presentShellCommand("pane.focus.right");
      await vi.advanceTimersByTimeAsync(MOVE_HOLD_MS - 1);
      expect(ran.map(([n]) => n)).toEqual(["pane.move.right"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(ran.map(([n]) => n)).toEqual(["pane.move.right", "pane.focus.right"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a focus key waits for a move on its way, and takes the moved layout", async () => {
    const three = (order: string[]) => row("s-r", order.map((id) => pane(id, [tab(`t-${id.slice(2)}`, "prs")])));
    await seed(three(["p-a", "p-b", "p-c"]), "p-b", ["t-b"]);
    presentShellCommand("pane.move.left");
    presentShellCommand("pane.focus.right");
    await flush();
    expect(ran.map(([n]) => n)).toEqual(["pane.move.left"]);
    await seed(three(["p-b", "p-a", "p-c"]), "p-b", ["t-b"], 1200, 800, 2);
    replies[0]?.(2);
    await flush();
    await flush();
    // From b's new place, right is a (in the old tree it was c).
    expect(focus()).toBe("p-a");
  });
});
