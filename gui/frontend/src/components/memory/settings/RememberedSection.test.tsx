import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryEntryView, MemorySnapshotView } from "@/api/memory";
import type { ThreadView } from "@/api/threads";
import { TooltipProvider } from "@/components/ui/tooltip";

const run = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
type RunOpts = { expected?: (err: unknown) => boolean };
const runForResult = vi.hoisted(() => vi.fn<(name: string, args: Record<string, string>, opts: RunOpts) => Promise<unknown>>(() => Promise.resolve({ message: "Forgot" })));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommand: run, runCommandForResult: runForResult }));
const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", async (orig) => {
  const mod = await orig<typeof import("sonner")>();
  return { ...mod, toast: Object.assign(mod.toast, { info: toastInfo }) };
});
const getMemory = vi.hoisted(() => vi.fn());
vi.mock("@/api/memory", async (orig) => ({ ...(await orig<typeof import("@/api/memory")>()), getMemory }));
const { ConnectError, Code } = await import("@connectrpc/connect");

const { RememberedSection } = await import("./RememberedSection");
const { applyMemoryEvent, resetMemory } = await import("@/stores/memory");
const { useThreadsStore } = await import("@/stores/threads");
const { HOME, useUiStore } = await import("@/stores/ui");
const { useViewsStore } = await import("@/stores/views");

const NOW = Date.now();
function entry(index: number, text: string, origin: MemoryEntryView["origin"], createdMs: number | null = NOW - 5 * 60_000, leftOut: MemoryEntryView["leftOut"] = ""): MemoryEntryView {
  return { file: `e${String(index)}.md`, id: `e${String(index)}`, index, text, createdMs, origin, injected: leftOut === "", leftOut };
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
  runForResult.mockClear();
  toastInfo.mockClear();
  getMemory.mockReset();
  useThreadsStore.setState({ byId: { "s-1": thread("s-1", "Renamed thread"), "s-7": thread("s-7", "Old work", 5) }, order: ["s-1", "s-7"] });
  useUiStore.setState({ selection: HOME });
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
    expect(screen.getByTestId("memory-footnote").textContent).toBe("Applies to new threads at once, and to open threads with their next message after a restart.");
    expect(screen.queryByTestId("memory-left-out")).toBeNull();
  });

  it("an entry threads do not get says why", () => {
    show([
      entry(1, "Use tabs", { kind: "user" }),
      entry(2, "x".repeat(700), { kind: "user" }, null, "too_long"),
      entry(3, "Past the cap", { kind: "user" }, NOW, "entries"),
      entry(4, "Past the bytes", { kind: "user" }, NOW, "bytes"),
    ]);
    const rows = screen.getAllByTestId("memory-row");
    expect(rows.map((r) => r.dataset.injected)).toEqual(["true", "false", "false", "false"]);
    expect(screen.getAllByTestId("memory-left-out").map((p) => p.textContent)).toEqual([
      "Not given to threads: longer than 500 characters. Forget it and say it shorter.",
      "Not given to threads: past the 40-entry limit.",
      "Not given to threads: past the 4 KiB limit.",
    ]);
  });

  it("the thread link opens it and leaves Settings", () => {
    show([entry(1, "Open PRs as drafts", { kind: "thread", threadId: "s-1", threadName: "" })]);
    fireEvent.click(screen.getByTestId("memory-by"));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });
    expect(useViewsStore.getState().settingsOpen).toBe(false);
  });

  it("Forget removes by id, never by position; Forget all clears", async () => {
    show([entry(1, "a", { kind: "user" }), entry(2, "b", { kind: "user" })]);
    const second = screen.getAllByTestId("memory-row")[1];
    if (!second) throw new Error("no row");
    fireEvent.click(within(second).getByTestId("memory-forget"));
    expect(runForResult).toHaveBeenCalledWith("memory.remove", { id: "e2" }, expect.anything());
    await vi.waitFor(() => {
      expect(within(second).getByTestId<HTMLButtonElement>("memory-forget").disabled).toBe(false);
    });
    expect(toastInfo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("memory-forget-all"));
    expect(run).toHaveBeenCalledWith("memory.clear");
  });

  it("an entry gone since the list was shown: says so and reads the memory again", async () => {
    runForResult.mockImplementationOnce((_n, _a, opts) => {
      const err = new ConnectError("there is no entry e2 now", Code.NotFound);
      return Promise.resolve(opts.expected?.(err) ? null : null);
    });
    getMemory.mockResolvedValue(snapshot([entry(1, "a", { kind: "user" })]));
    show([entry(1, "a", { kind: "user" }), entry(2, "b", { kind: "user" })]);
    const second = screen.getAllByTestId("memory-row")[1];
    if (!second) throw new Error("no row");
    fireEvent.click(within(second).getByTestId("memory-forget"));
    await vi.waitFor(() => {
      expect(screen.getAllByTestId("memory-row")).toHaveLength(1);
    });
    expect(toastInfo).toHaveBeenCalledWith("That entry is gone; the list was refreshed.");
    expect(getMemory).toHaveBeenCalledTimes(1);
  });

  it("another failure is not taken for a gone entry", async () => {
    runForResult.mockImplementationOnce((_n, _a, opts) => {
      expect(opts.expected?.(new ConnectError("denied", Code.PermissionDenied))).toBe(false);
      return Promise.resolve(null);
    });
    show([entry(1, "a", { kind: "user" })]);
    fireEvent.click(screen.getByTestId("memory-forget"));
    await vi.waitFor(() => {
      expect(runForResult).toHaveBeenCalled();
    });
    expect(toastInfo).not.toHaveBeenCalled();
    expect(getMemory).not.toHaveBeenCalled();
  });

  it("empty: the empty state, 0 of 40 and no Forget all", () => {
    show([]);
    expect(screen.getByTestId("memory-empty").textContent).toContain("Nothing remembered yet");
    expect(screen.getByTestId("memory-count").textContent).toBe("0 of 40");
    expect(screen.queryByTestId("memory-forget-all")).toBeNull();
    expect(screen.queryByTestId("memory-footnote")).toBeNull();
  });
});
