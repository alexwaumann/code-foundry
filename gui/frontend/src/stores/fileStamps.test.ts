import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileWatcher } from "./fileStamps";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A disk of stamps by path, a visibility flag and its listeners, and a watcher over them. */
function setup() {
  const disk = new Map<string, string>([["/h/p.html", "10:1"]]);
  const reads: string[] = [];
  let visible = true;
  const onVisible = new Set<() => void>();
  let fail = false;
  const w = createFileWatcher({
    stat: (abs) => {
      reads.push(abs);
      return fail ? Promise.reject(new Error("daemon away")) : Promise.resolve(disk.get(abs) ?? "");
    },
    every: 1000,
    visible: () => visible,
    onVisible: (cb) => {
      onVisible.add(cb);
      return () => onVisible.delete(cb);
    },
  });
  return {
    w,
    disk,
    reads,
    onVisible,
    setVisible(v: boolean) {
      visible = v;
      if (v) for (const cb of onVisible) cb();
    },
    setFail(v: boolean) {
      fail = v;
    },
  };
}

describe("createFileWatcher", () => {
  // Each write style a page gets: what it does to the stamp, and whether the view reloads.
  it.each([
    { name: "an editor's write in place (new size)", next: "12:2", fires: 1 },
    { name: "cp over the file (same size, new time)", next: "10:2", fires: 1 },
    { name: "touch (only the time)", next: "10:3", fires: 1 },
    { name: "nothing written", next: "10:1", fires: 0 },
    { name: "the file removed", next: undefined, fires: 0 },
  ])("$name", async ({ next, fires }) => {
    const s = setup();
    const onChange = vi.fn();
    s.w.watch("/h/p.html", onChange);
    await vi.advanceTimersByTimeAsync(0);
    if (next === undefined) s.disk.delete("/h/p.html");
    else s.disk.set("/h/p.html", next);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(fires);
    // The next poll with no write in between is quiet.
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(fires);
  });

  it("a removed file that comes back reloads once", async () => {
    const s = setup();
    const onChange = vi.fn();
    s.w.watch("/h/p.html", onChange);
    await vi.advanceTimersByTimeAsync(0);
    s.disk.delete("/h/p.html");
    await vi.advanceTimersByTimeAsync(1000);
    s.disk.set("/h/p.html", "11:5");
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("the first read is the baseline, not a change", async () => {
    const s = setup();
    const onChange = vi.fn();
    s.w.watch("/h/p.html", onChange);
    await vi.advanceTimersByTimeAsync(3000);
    expect(onChange).not.toHaveBeenCalled();
    expect(s.reads).toEqual(["/h/p.html", "/h/p.html", "/h/p.html", "/h/p.html"]);
  });

  it("views of one file share one watch and each hears a write; the last to go stops it", async () => {
    const s = setup();
    const a = vi.fn();
    const b = vi.fn();
    const stopA = s.w.watch("/h/p.html", a);
    const stopB = s.w.watch("/h/p.html", b);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.reads).toHaveLength(1);
    s.disk.set("/h/p.html", "10:9");
    await vi.advanceTimersByTimeAsync(1000);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
    stopA();
    s.disk.set("/h/p.html", "10:10");
    await vi.advanceTimersByTimeAsync(1000);
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 2]);
    stopB();
    expect(s.onVisible.size).toBe(0);
    const before = s.reads.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.reads).toHaveLength(before);
  });

  it("does not read while the window is hidden, and reads at once when it is back", async () => {
    const s = setup();
    const onChange = vi.fn();
    s.w.watch("/h/p.html", onChange);
    await vi.advanceTimersByTimeAsync(0);
    s.setVisible(false);
    s.disk.set("/h/p.html", "10:4");
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.reads).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
    s.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("check reads at once (a tool's edit), and once more when asked during a read", async () => {
    const s = setup();
    const onChange = vi.fn();
    s.w.watch("/h/p.html", onChange);
    await vi.advanceTimersByTimeAsync(0);
    s.disk.set("/h/p.html", "20:7");
    s.w.check("/h/p.html");
    s.w.check("/h/p.html");
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(s.reads).toHaveLength(3);
    // The poll then finds the same stamp: no second load for that edit.
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    // An unwatched path reads nothing.
    s.w.check("/h/other.html");
    expect(s.reads).not.toContain("/h/other.html");
  });

  it("a failed read keeps the last stamp", async () => {
    const s = setup();
    const onChange = vi.fn();
    s.w.watch("/h/p.html", onChange);
    await vi.advanceTimersByTimeAsync(0);
    s.setFail(true);
    await vi.advanceTimersByTimeAsync(2000);
    s.setFail(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).not.toHaveBeenCalled();
    s.disk.set("/h/p.html", "10:8");
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
