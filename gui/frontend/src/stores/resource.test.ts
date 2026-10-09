import { afterEach, describe, expect, it, vi } from "vitest";
import { createResource } from "./resource";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("createResource", () => {
  it("fetches watched keys only, once per invalidation, keeping data on error", async () => {
    const calls: string[] = [];
    let fail = false;
    const r = createResource((key) => {
      calls.push(key);
      return fail ? Promise.reject(new Error("down")) : Promise.resolve(`v-${key}-${String(calls.length)}`);
    });
    r.invalidate("a"); // nobody watches: no fetch
    expect(calls).toEqual([]);
    const release = r.watch("a");
    const release2 = r.watch("a"); // second watcher: no extra fetch
    await flush();
    expect(calls).toEqual(["a"]);
    expect(r.store.getState().entries.a).toEqual({ data: "v-a-1", error: null, loading: false });
    fail = true;
    r.invalidate((k) => k.startsWith("a"));
    await flush();
    expect(r.store.getState().entries.a).toMatchObject({ data: "v-a-1", error: "down", loading: false });
    release();
    expect(r.watched()).toEqual(["a"]);
    release2();
    release2(); // idempotent
    expect(r.watched()).toEqual([]);
    r.invalidate("a");
    expect(calls).toHaveLength(2);
  });

  it("coalesces invalidations during a fetch into one rerun", async () => {
    const pending: ReturnType<typeof deferred<string>>[] = [];
    const r = createResource(() => {
      const d = deferred<string>();
      pending.push(d);
      return d.promise;
    });
    r.watch("k");
    r.invalidate("k");
    r.invalidate("k");
    expect(pending).toHaveLength(1);
    pending[0]?.resolve("one");
    await flush();
    expect(pending).toHaveLength(2);
    pending[1]?.resolve("two");
    await flush();
    expect(pending).toHaveLength(2);
    expect(r.store.getState().entries.k?.data).toBe("two");
  });

  it("re-fetches watched keys every keepAliveMs until released", async () => {
    vi.useFakeTimers();
    let n = 0;
    const r = createResource(() => Promise.resolve(++n), { keepAliveMs: 1000 });
    const release = r.watch("k");
    await vi.advanceTimersByTimeAsync(2500);
    expect(n).toBe(3);
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(n).toBe(3);
  });

  it("set writes data or an error, and supersedes a fetch in flight", async () => {
    const pending: ReturnType<typeof deferred<string>>[] = [];
    const r = createResource(() => {
      const d = deferred<string>();
      pending.push(d);
      return d.promise;
    });
    r.watch("k");
    expect(r.store.getState().entries.k?.loading).toBe(true);
    r.set("k", { data: "refreshed" });
    expect(r.store.getState().entries.k).toEqual({ data: "refreshed", error: null, loading: false });
    // The read that started before the set answers late: dropped.
    pending[0]?.resolve("older");
    await flush();
    expect(r.store.getState().entries.k).toEqual({ data: "refreshed", error: null, loading: false });
    // An error keeps the data.
    r.set("k", { error: "boom" });
    expect(r.store.getState().entries.k).toEqual({ data: "refreshed", error: "boom", loading: false });
    // Reads started after a set apply as usual.
    r.invalidate("k");
    pending[1]?.resolve("newer");
    await flush();
    expect(r.store.getState().entries.k).toEqual({ data: "newer", error: null, loading: false });
    // A set for a key nobody watches still records it (a later watch shows it while fetching).
    r.set("other", { data: "x" });
    expect(r.store.getState().entries.other?.data).toBe("x");
  });
});
