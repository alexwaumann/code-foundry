import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SRC from "../../../../internal/bridge/bridge.js?raw";
import { useThreadsStore } from "./threads";

/*
 * A page's copies kept in step (docs/notes/page-storage-change-event.md): the daemon's
 * bridge.js, run against a fake window, wired to this window's bridge host as HtmlFrame wires
 * them, over a fake PageService. A card and a tab of one page file are two such frames.
 * The script's own rules are in lib/cfBridgeScript.test.ts, the host's in bridgeHost.test.ts.
 */

// PageService's per-file storage (and the thread's own, for an older daemon), in memory.
const daemon = vi.hoisted(() => ({ files: new Map<string, Record<string, string>>(), threads: new Map<string, Record<string, string>>(), full: false }));
function put(store: Map<string, Record<string, string>>, at: string, key: string, value: string | null) {
  const vals = Object.fromEntries(Object.entries({ ...store.get(at) }).filter(([k]) => k !== key));
  if (value !== null) vals[key] = value;
  store.set(at, vals);
  return Promise.resolve({ ...vals });
}
vi.mock("@/api/page", async (orig) => ({
  ...(await orig<typeof import("@/api/page")>()),
  getPageFileStorage: (path: string) => Promise.resolve({ ...daemon.files.get(path) }),
  setPageFileStorage: (path: string, key: string, value: string | null) => {
    if (daemon.full && value !== null) return Promise.reject(new Error("page storage is full (256 KiB per page); remove something first"));
    return put(daemon.files, path, key, value);
  },
}));
vi.mock("@/api/pageStorage", () => ({
  getPageStorage: (id: string) => Promise.resolve({ ...daemon.threads.get(id) }),
  setPageStorage: (id: string, key: string, value: string | null) => put(daemon.threads, id, key, value),
}));
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  listCommands: () => Promise.resolve([]),
}));

const { createBridgeHost, applyPageStorageEvent } = await import("./bridgeHost");
type PageBridge = import("./bridgeHost").PageBridge;

interface Store {
  get(k: string): unknown;
  set(k: string, v: unknown): Promise<void>;
  keys(): string[];
  onChange(fn: (keys: string[]) => void): () => void;
}
interface Cf {
  ready: Promise<unknown>;
  storage(prefix?: string): Store;
}

const FILE = "/Users/me/p/counter.html";
const hosts: { dispose(): void }[] = [];

/** One frame: bridge.js in a fake window whose parent is a bridge host for `frame`. */
async function frame(threadId: string | null, opts: { storagePath?: string; page?: PageBridge } = {}) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const parent = {
    postMessage: (m: unknown) => {
      queueMicrotask(() => {
        h.receive(structuredClone(m));
      });
    },
  };
  const win: Record<string, unknown> = {
    addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] ??= []).push(fn),
    getComputedStyle: () => ({}),
    requestAnimationFrame: () => 0,
    console,
    parent,
  };
  const h = createBridgeHost({
    threadId,
    ...opts,
    pageName: "counter.html",
    pagePath: FILE,
    userPresent: () => true,
    post: (m) => {
      const data = structuredClone(m);
      queueMicrotask(() => {
        for (const fn of listeners.message ?? []) fn({ data, source: parent });
      });
    },
  });
  hosts.push(h);
  // oxlint-disable-next-line typescript/no-implied-eval
  const run = new Function("window", "navigator", "document", "ResizeObserver", "location", SRC) as (...g: unknown[]) => void;
  run(win, {}, { body: null, addEventListener: () => {}, querySelector: () => null }, undefined, { search: "?cf-nonce=n" });
  const cf = win.cf as Cf;
  await cf.ready;
  return cf;
}

/** A copy of the page drawing `c:n` in onChange, as the skill tells Claude to. */
function counter(cf: Cf) {
  const s = cf.storage("c");
  const heard: string[][] = [];
  const shown = { n: 0 };
  const stop = s.onChange((keys) => {
    heard.push(keys);
    shown.n = (s.get("n") as number | null) ?? 0;
  });
  return { s, heard, shown, stop };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  daemon.files.clear();
  daemon.threads.clear();
  daemon.full = false;
  useThreadsStore.setState({ byId: {}, order: [] });
});
afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
});

describe("a page's copies in one window", () => {
  it("a card and a tab of the page: a write in one reaches the other's onChange with the key; the writer is not told", async () => {
    daemon.files.set(FILE, { "c:n": "1", other: "1" });
    const card = counter(await frame("t-1", { storagePath: FILE }));
    const tab = counter(await frame("t-2", { storagePath: FILE }));
    await settle();
    expect([card.heard, tab.heard]).toEqual([[["n"]], [["n"]]]);
    expect(tab.shown.n).toBe(1);
    await card.s.set("n", 2);
    await vi.waitFor(() => {
      expect(tab.shown.n).toBe(2);
    });
    expect(tab.heard).toEqual([["n"], ["n"]]);
    expect(card.heard).toEqual([["n"]]);
    // The daemon's news of that write reaches this window too: it changes nothing.
    applyPageStorageEvent({ storagePaths: [FILE], all: false });
    await settle();
    await settle();
    expect([card.heard.length, tab.heard.length]).toEqual([1, 2]);
  });

  it("a prefix hears only its own keys", async () => {
    const a = await frame("t-1", { storagePath: FILE });
    const b = await frame("t-1", { storagePath: FILE });
    const board = vi.fn();
    b.storage("board").onChange(board);
    await settle();
    board.mockClear();
    await a.storage("todo").set("n", 1);
    await a.storage("board").set("cards", ["x"]);
    await vi.waitFor(() => {
      expect(board).toHaveBeenCalledWith(["cards"]);
    });
    expect(board).toHaveBeenCalledTimes(1);
  });

  it("a page no thread owns that the user allowed, in two tabs", async () => {
    const page: PageBridge = { kind: "allowed", path: FILE };
    const one = counter(await frame(null, { page }));
    const two = counter(await frame(null, { page }));
    await one.s.set("n", 7);
    await vi.waitFor(() => {
      expect(two.shown.n).toBe(7);
    });
  });

  it("a refused write: the writer hears its value put back", async () => {
    daemon.files.set(FILE, { "c:n": "1" });
    const card = counter(await frame("t-1", { storagePath: FILE }));
    await settle();
    daemon.full = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(card.s.set("n", 2)).rejects.toMatchObject({ code: "failed" });
    error.mockRestore();
    expect(card.heard).toEqual([["n"], ["n"]]);
    expect(card.shown.n).toBe(1);
  });

  it("an unsubscribed copy hears nothing more", async () => {
    const card = counter(await frame("t-1", { storagePath: FILE }));
    const tab = counter(await frame("t-1", { storagePath: FILE }));
    await settle();
    tab.stop();
    await card.s.set("n", 3);
    await settle();
    await settle();
    expect(tab.heard).toEqual([[]]);
  });
});

describe("another window's write (the daemon's page source)", () => {
  it("every copy here reads the page again and hears the keys that changed", async () => {
    const card = counter(await frame("t-1", { storagePath: FILE }));
    const tab = counter(await frame("t-2", { storagePath: FILE }));
    await settle();
    // Another window (or a GUI on another machine's browser) wrote through the daemon.
    daemon.files.set(FILE, { "c:n": "9" });
    applyPageStorageEvent({ storagePaths: [FILE], all: false });
    await vi.waitFor(() => {
      expect([card.shown.n, tab.shown.n]).toEqual([9, 9]);
    });
    expect(card.heard.at(-1)).toEqual(["n"]);
    // Another page's news, or none at all, reads nothing here.
    daemon.files.set(FILE, { "c:n": "10" });
    applyPageStorageEvent({ storagePaths: ["/Users/me/p/other.html"], all: false });
    await settle();
    await settle();
    expect(card.shown.n).toBe(9);
    // A reconnect (the source's snapshot) reads every page shown again.
    applyPageStorageEvent({ storagePaths: [], all: true });
    await vi.waitFor(() => {
      expect(card.shown.n).toBe(10);
    });
  });

  it("an older daemon keeps a thread's own storage: a reconnect reads it again too", async () => {
    const card = counter(await frame("t-1"));
    await settle();
    daemon.threads.set("t-1", { "c:n": "4" });
    applyPageStorageEvent({ storagePaths: [], all: true });
    await vi.waitFor(() => {
      expect(card.shown.n).toBe(4);
    });
  });
});
