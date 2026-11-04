import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ list: [] as { key: string; finish: (fail?: boolean) => void; signal: AbortSignal }[] }));
vi.mock("@/api/gh", async (orig) => ({
  ...(await orig<typeof import("@/api/gh")>()),
  getPullRequestDetail: (slug: string, number: number, _refresh: boolean, _opts: unknown, signal: AbortSignal) =>
    new Promise((resolve, reject) => {
      reads.list.push({ key: `${slug}#${String(number)}`, signal, finish: (fail) => (fail ? reject(new Error("paused until 12:00: rate limit")) : resolve({ pullRequest: { number } })) });
    }),
}));

const { pullRequestDetailResource, usePollStore } = await import("./gh");
const { armPrefetch, disarmPrefetch, PREFETCH_BACKOFF_MS, PREFETCH_DWELL_MS, PREFETCH_MAX_CONCURRENT, PREFETCH_MAX_PER_WINDOW, PREFETCH_WINDOW_MS, resetPrefetch } = await import("./prPrefetch");

const key = (n: number) => `o/r#${String(n)}`;
const asked = () => reads.list.map((r) => r.key);

/** Lets a read's end reach the resource and the prefetch's own bookkeeping. */
async function finishAll(fail = false): Promise<void> {
  for (const r of reads.list) r.finish(fail);
  await vi.advanceTimersByTimeAsync(0);
}

/** Rests on row n for a full dwell. */
async function dwell(n: number, el: Element | null = null): Promise<void> {
  armPrefetch(key(n), el);
  await vi.advanceTimersByTimeAsync(PREFETCH_DWELL_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  reads.list = [];
  resetPrefetch();
  pullRequestDetailResource.store.setState({ entries: {} });
  usePollStore.setState({ lastError: "" });
});

afterEach(async () => {
  await finishAll(); // the resource is one for the file: no read may outlive its test
  vi.useRealTimers();
});

describe("the dwell", () => {
  it("reads after the dwell, not before; leaving the row first reads nothing", async () => {
    armPrefetch(key(1));
    await vi.advanceTimersByTimeAsync(PREFETCH_DWELL_MS - 1);
    expect(asked()).toEqual([]);
    disarmPrefetch(key(1));
    await vi.advanceTimersByTimeAsync(PREFETCH_DWELL_MS);
    expect(asked()).toEqual([]);
    await dwell(2);
    expect(asked()).toEqual([key(2)]);
  });

  it("a fast sweep across thirty rows reads only the row it stops on", async () => {
    for (let n = 1; n <= 30; n++) {
      armPrefetch(key(n));
      await vi.advanceTimersByTimeAsync(PREFETCH_DWELL_MS / 3);
      disarmPrefetch(key(n));
    }
    await dwell(31);
    expect(asked()).toEqual([key(31)]);
  });

  it("leaving a row does not end the dwell of the one after it", async () => {
    armPrefetch(key(1));
    armPrefetch(key(2));
    disarmPrefetch(key(1));
    await vi.advanceTimersByTimeAsync(PREFETCH_DWELL_MS);
    expect(asked()).toEqual([key(2)]);
  });
});

describe("scrolling", () => {
  const list = document.createElement("div");
  const row = document.createElement("div");
  list.append(row);
  const other = document.createElement("div");
  document.body.append(list, other);
  const scroll = (el: Element) => el.dispatchEvent(new Event("scroll"));

  it("rows passing under a still pointer read nothing; the one it stops on does", async () => {
    for (let n = 1; n <= 10; n++) {
      armPrefetch(key(n), row);
      await vi.advanceTimersByTimeAsync(PREFETCH_DWELL_MS / 2);
      scroll(list);
    }
    await vi.advanceTimersByTimeAsync(PREFETCH_DWELL_MS);
    expect(asked()).toEqual([]);
    await dwell(11, row);
    expect(asked()).toEqual([key(11)]);
  });

  it("a scroll elsewhere (a thread streaming beside the list) does not count", async () => {
    armPrefetch(key(1), row);
    scroll(other);
    await vi.advanceTimersByTimeAsync(PREFETCH_DWELL_MS);
    expect(asked()).toEqual([key(1)]);
  });

  it("the keyboard's cursor scrolls its own row into view: that does not end its dwell", async () => {
    armPrefetch(key(1));
    scroll(list);
    await vi.advanceTimersByTimeAsync(PREFETCH_DWELL_MS);
    expect(asked()).toEqual([key(1)]);
  });
});

describe("the caps", () => {
  it("runs a few at a time and drops the rest, without queueing them", async () => {
    for (let n = 1; n <= PREFETCH_MAX_CONCURRENT + 2; n++) await dwell(n);
    expect(asked()).toEqual([key(1), key(2)]);
    await finishAll();
    await vi.advanceTimersByTimeAsync(PREFETCH_DWELL_MS * 3);
    expect(reads.list).toHaveLength(PREFETCH_MAX_CONCURRENT);
    await dwell(9);
    expect(asked()).toEqual([key(1), key(2), key(9)]);
  });

  it("a slow sweep, dwelling on every row, stops at the window's cap until the window moves", async () => {
    for (let n = 1; n <= 30; n++) {
      await dwell(n);
      await finishAll();
    }
    expect(reads.list).toHaveLength(PREFETCH_MAX_PER_WINDOW);
    await vi.advanceTimersByTimeAsync(PREFETCH_WINDOW_MS);
    await dwell(31);
    expect(reads.list).toHaveLength(PREFETCH_MAX_PER_WINDOW + 1);
  });

  it("no repeat for a key with data or a read in flight", async () => {
    await dwell(1);
    await dwell(1);
    expect(reads.list).toHaveLength(1);
    await finishAll();
    await dwell(1);
    expect(reads.list).toHaveLength(1);
  });

  it("an open surface's read counts: nothing is sent beside it", async () => {
    const release = pullRequestDetailResource.watch(key(1));
    await dwell(1);
    expect(reads.list).toHaveLength(1);
    release();
  });
});

describe("a rate limit", () => {
  it("nothing while the poll is failing, and again once it recovers", async () => {
    usePollStore.setState({ lastError: "paused until 12:00: rate limit" });
    await dwell(1);
    expect(asked()).toEqual([]);
    usePollStore.setState({ lastError: "" });
    await dwell(1);
    expect(asked()).toEqual([key(1)]);
  });

  it("one failed prefetch stops them all for the backoff, the failed key too", async () => {
    await dwell(1);
    await finishAll(true);
    expect(pullRequestDetailResource.store.getState().entries[key(1)]?.error).toContain("rate limit");
    await dwell(2);
    await dwell(1);
    expect(asked()).toEqual([key(1)]);
    await vi.advanceTimersByTimeAsync(PREFETCH_BACKOFF_MS);
    await dwell(2);
    expect(asked()).toEqual([key(1), key(2)]);
  });
});

describe("a prefetch and the abort on release", () => {
  it("is not aborted by its own watch, and a surface opening on it joins the read and holds it past the prefetch's end", async () => {
    await dwell(1);
    expect(reads.list[0]?.signal.aborted).toBe(false);
    const release = pullRequestDetailResource.watch(key(1));
    expect(reads.list).toHaveLength(1);
    await finishAll();
    expect(pullRequestDetailResource.watched()).toEqual([key(1)]);
    release();
    expect(pullRequestDetailResource.watched()).toEqual([]);
  });

  it("a bare watch(key)() would abort: this is why nobody may use it on the detail", () => {
    pullRequestDetailResource.watch(key(1))();
    expect(reads.list[0]?.signal.aborted).toBe(true);
  });
});
