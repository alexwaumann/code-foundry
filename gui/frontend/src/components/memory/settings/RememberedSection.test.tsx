import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntryView, MemorySnapshotView } from "@/api/memory";
import type { ThreadView } from "@/api/threads";
import { TooltipProvider } from "@/components/ui/tooltip";

const run = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommand: run }));

const { RememberedSection } = await import("./RememberedSection");
const { applyMemoryEvent, resetMemory } = await import("@/stores/memory");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");
const { useViewsStore } = await import("@/stores/views");

const NOW = Date.now();
function entry(index: number, text: string, origin: MemoryEntryView["origin"], createdMs: number | null = NOW - 5 * 60_000): MemoryEntryView {
  return { file: `e${String(index)}.md`, index, text, createdMs, origin, injected: true };
}
function snapshot(entries: MemoryEntryView[]): MemorySnapshotView {
  return { entries, injected: entries.length, injectedBytes: 0, maxEntries: 40, maxBytes: 4096, maxEntryChars: 500, dir: "/m", error: "", version: 1 };
}
const thread = (id: string, name: string, archivedAtMs: number | null = null) => ({ id, name, archivedAtMs }) as ThreadView;

function show(entries: MemoryEntryView[]) {
  applyMemoryEvent({ snapshot: snapshot(entries) });
  return render(
    <TooltipProvider>
      <RememberedSection />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  resetMemory();
  run.mockClear();
  useThreadsStore.setState({ byId: { "s-1": thread("s-1", "Renamed thread"), "s-7": thread("s-7", "Old work", 5) }, order: ["s-1", "s-7"] });
  useUiStore.setState({ selection: { kind: "view", name: "dashboard" } });
  useViewsStore.setState({ settingsOpen: true, settingsPage: "memory" });
});
afterEach(cleanup);

describe("RememberedSection", () => {
  it("lists entries with when and by which thread, by its current name", () => {
    show([
      entry(1, "Open PRs as drafts", { kind: "thread", threadId: "s-1", threadName: "Recorded" }),
      entry(2, "Keep answers short", { kind: "thread", threadId: "s-7", threadName: "Old work" }),
      entry(3, "Explain git terms", { kind: "thread", threadId: "s-gone", threadName: "Usage page polish" }),
      entry(4, "Use tabs", { kind: "user" }),
      entry(5, "By hand", { kind: "user" }, null),
    ]);
    const metas = screen.getAllByTestId("memory-meta").map((m) => m.textContent);
    expect(metas).toEqual([
      "Remembered 5 min ago · by Renamed thread",
      "Remembered 5 min ago · by Old work (archived)",
      "Remembered 5 min ago · by Usage page polish (removed)",
      "Remembered 5 min ago",
      "Added by hand",
    ]);
    const bys = screen.getAllByTestId("memory-by");
    expect(bys.map((b) => [b.tagName, b.dataset.state])).toEqual([
      ["BUTTON", "live"],
      ["BUTTON", "archived"],
      ["SPAN", "removed"],
    ]);
    expect(screen.getByTestId("memory-count").textContent).toBe("5 of 40");
    expect(screen.getByTestId("memory-footnote")).toBeTruthy();
  });

  it("the thread link opens it and leaves Settings", () => {
    show([entry(1, "Open PRs as drafts", { kind: "thread", threadId: "s-1", threadName: "" })]);
    fireEvent.click(screen.getByTestId("memory-by"));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    expect(useViewsStore.getState().settingsOpen).toBe(false);
  });

  it("Forget removes by index; Forget all clears", () => {
    show([entry(1, "a", { kind: "user" }), entry(2, "b", { kind: "user" })]);
    const second = screen.getAllByTestId("memory-row")[1];
    if (!second) throw new Error("no row");
    fireEvent.click(within(second).getByTestId("memory-forget"));
    expect(run).toHaveBeenCalledWith("memory.remove", { entry: "2" });
    fireEvent.click(screen.getByTestId("memory-forget-all"));
    expect(run).toHaveBeenCalledWith("memory.clear");
  });

  it("empty: the empty state, 0 of 40 and no Forget all", () => {
    show([]);
    expect(screen.getByTestId("memory-empty").textContent).toContain("Nothing remembered yet");
    expect(screen.getByTestId("memory-count").textContent).toBe("0 of 40");
    expect(screen.queryByTestId("memory-forget-all")).toBeNull();
    expect(screen.queryByTestId("memory-footnote")).toBeNull();
  });
});
