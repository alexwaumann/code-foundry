import { afterEach, describe, expect, it, vi } from "vitest";
import SRC from "../../../../internal/bridge/bridge.js?raw";

/*
 * The daemon's page bridge script (internal/bridge/bridge.js, served as /cf/bridge.js),
 * run against a fake window whose parent records what the page posts: the page side of
 * the page↔host contract (docs/notes/bridge-1-daemon.md).
 */

interface Msg {
  type: string;
  cf?: number;
  id?: string;
  [k: string]: unknown;
}

interface CfError {
  code: string;
  message: string;
}

interface Cf {
  version: number;
  ready: Promise<unknown>;
  thread: { id: string; name: string } | null;
  theme: { id: string; scheme: string; vars: Record<string, string> } | null;
  run(verb: unknown, args?: unknown, opts?: { timeout?: number }): Promise<{ text: string; json: unknown }>;
  on(source: string, fn: (event: unknown, source: string) => void, onError?: (e: CfError) => void): () => void;
  off(source: string, fn?: unknown): void;
  onTheme(fn: (t: unknown) => void): () => void;
  resize(height?: number): void;
  storage(prefix?: string): { get(k: string): unknown; set(k: string, v: unknown): void; remove(k: string): void; keys(): string[]; clear(): void };
}

function load(opts: { userActivation?: { isActive: boolean } | null; embedded?: boolean; stylesheet?: boolean } = {}) {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const posted: { m: Msg; origin: string }[] = [];
  const parent = {
    postMessage: (m: Msg, origin: string) => {
      posted.push({ m: structuredClone(m), origin });
    },
  };
  const win: Record<string, unknown> = {
    addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] ??= []).push(fn),
    getComputedStyle: () => ({ marginTop: "8px", marginBottom: "8px" }),
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
  };
  win.parent = opts.embedded === false ? win : parent;
  const rootStyle: Record<string, string> = {};
  const doc = {
    body: { scrollHeight: 120 },
    documentElement: {
      style: {
        setProperty: (k: string, v: string) => {
          rootStyle[k] = v;
        },
        set colorScheme(v: string) {
          rootStyle["color-scheme"] = v;
        },
      },
    },
    querySelector: () => (opts.stylesheet ? {} : null),
    addEventListener: () => {},
  };
  const nav = { userActivation: opts.userActivation === null ? undefined : (opts.userActivation ?? { isActive: false }) };
  const store = new Map<string, string>();
  const localStorage = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  const observed: (() => void)[] = [];
  class ResizeObserver {
    constructor(cb: () => void) {
      observed.push(cb);
    }
    observe() {}
  }
  // The script under test, as a page would run it, with these globals.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function("window", "navigator", "document", "localStorage", "ResizeObserver", SRC) as (...globals: unknown[]) => void;
  run(win, nav, doc, localStorage, ResizeObserver);
  const cf = win.cf as Cf;
  const send = (data: unknown, source: unknown = parent) => {
    for (const fn of listeners.message ?? []) fn({ data, source });
  };
  const fire = (type: string) => {
    for (const fn of listeners[type] ?? []) fn({});
  };
  const ready = (extra: Record<string, unknown> = {}) => {
    send({
      type: "cf:ready",
      cf: 1,
      thread: { id: "t-1", name: "Thread one" },
      theme: { id: "github-dark", scheme: "dark", vars: { "--cf-text": "#fff" } },
      readOnly: ["thread.get"],
      sources: ["thread-list", "thread"],
      ...extra,
    });
  };
  const sent = (type: string) => posted.filter((p) => p.m.type === type).map((p) => p.m);
  return { cf, posted, send, ready, sent, fire, nav, store, rootStyle, observed };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("bridge.js", () => {
  it("says hello to its parent with the protocol version, to any origin", () => {
    const h = load();
    expect(h.posted[0]).toEqual({ m: { type: "cf:hello", cf: 1 }, origin: "*" });
  });

  it("fills thread, theme and ready from cf:ready", async () => {
    const h = load({ stylesheet: true });
    h.ready();
    await expect(h.cf.ready).resolves.toBe(h.cf);
    expect(h.cf.thread).toEqual({ id: "t-1", name: "Thread one" });
    expect(h.cf.theme).toEqual({ id: "github-dark", scheme: "dark", vars: { "--cf-text": "#fff" } });
    expect(h.rootStyle).toEqual({ "--cf-text": "#fff", "color-scheme": "dark" });
  });

  it("runs a read-only verb without a gesture and resolves with text and parsed json", async () => {
    const h = load();
    h.ready();
    const p = h.cf.run("thread.get", { id: "t-2", json: true, last: 3, skip: undefined });
    await flush();
    const [run] = h.sent("cf:run");
    expect(run).toEqual({ type: "cf:run", cf: 1, id: run?.id, verb: "thread.get", args: { id: "t-2", json: "true", last: "3" } });
    h.send({ type: "cf:result", id: run?.id, ok: true, result: { text: "ok", json: '{"a":1}' } });
    await expect(p).resolves.toEqual({ text: "ok", json: { a: 1 } });
  });

  it("refuses a mutating verb outside a gesture, and runs it inside one", async () => {
    const h = load();
    h.ready();
    await expect(h.cf.run("thread.send", { message: "hi" })).rejects.toMatchObject({ code: "gesture" });
    expect(h.sent("cf:run")).toHaveLength(0);
    h.nav.userActivation = { isActive: true };
    const p = h.cf.run("thread.send", { message: "hi" });
    await flush();
    const [run] = h.sent("cf:run");
    expect(run?.verb).toBe("thread.send");
    h.send({ type: "cf:result", id: run?.id, ok: false, error: { code: "declined", message: "the user said no" } });
    await expect(p).rejects.toMatchObject({ code: "declined", message: "the user said no" });
  });

  it("decides the gesture when called, not after waiting for cf:ready", async () => {
    const h = load({ userActivation: { isActive: true } });
    const p = h.cf.run("thread.send");
    h.nav.userActivation = { isActive: false };
    h.ready();
    await flush();
    expect(h.sent("cf:run")).toHaveLength(1);
    h.send({ type: "cf:result", id: h.sent("cf:run")[0]?.id, ok: true, result: { text: "sent" } });
    await expect(p).resolves.toEqual({ text: "sent", json: null });
  });

  it("falls back to a 5 second window after a press without navigator.userActivation", async () => {
    vi.useFakeTimers();
    const h = load({ userActivation: null });
    h.ready();
    await expect(h.cf.run("thread.send")).rejects.toMatchObject({ code: "gesture" });
    h.fire("pointerdown");
    void h.cf.run("thread.send");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent("cf:run")).toHaveLength(1);
    vi.advanceTimersByTime(5001);
    await expect(h.cf.run("thread.send")).rejects.toMatchObject({ code: "gesture" });
  });

  it("rejects bad calls as invalid", async () => {
    const h = load();
    h.ready();
    await expect(h.cf.run("")).rejects.toMatchObject({ code: "invalid" });
    await expect(h.cf.run("thread.get", { x: { y: 1 } })).rejects.toMatchObject({ code: "invalid" });
    await expect(h.cf.run("thread.get", ["a"])).rejects.toMatchObject({ code: "invalid" });
  });

  it("times out a run nobody answers", async () => {
    vi.useFakeTimers();
    const h = load();
    h.ready();
    const p = h.cf.run("thread.get", {}, { timeout: 1000 });
    const check = expect(p).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(1001);
    await check;
  });

  it("is unavailable outside the app", async () => {
    const h = load({ embedded: false });
    expect(h.posted).toHaveLength(0);
    await expect(h.cf.ready).rejects.toMatchObject({ code: "unavailable" });
    await expect(h.cf.run("thread.get")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("ignores messages from anything but its parent", async () => {
    const h = load();
    h.send({ type: "cf:ready", thread: { id: "evil", name: "" }, readOnly: ["thread.send"] }, {});
    expect(h.cf.thread).toBeNull();
    h.ready();
    await h.cf.ready;
    expect(h.cf.thread?.id).toBe("t-1");
  });

  it("subscribes, delivers events, and unsubscribes", () => {
    const h = load();
    const got: unknown[] = [];
    const off = h.cf.on("thread-list", (e, source) => got.push([e, source]));
    const [on] = h.sent("cf:on");
    expect(on).toMatchObject({ type: "cf:on", cf: 1, source: "thread-list" });
    h.send({ type: "cf:event", id: on?.id, source: "thread-list", event: { threads: [] } });
    h.send({ type: "cf:event", id: "someone-else", source: "thread-list", event: 1 });
    expect(got).toEqual([[{ threads: [] }, "thread-list"]]);
    off();
    expect(h.sent("cf:off")).toEqual([{ type: "cf:off", cf: 1, id: on?.id }]);
    h.send({ type: "cf:event", id: on?.id, source: "thread-list", event: 2 });
    expect(got).toHaveLength(1);
  });

  it("drops a subscription the host refuses and tells its owner", () => {
    const h = load();
    const errs: CfError[] = [];
    h.cf.on("nope", () => {}, (e) => errs.push(e));
    const [on] = h.sent("cf:on");
    h.send({ type: "cf:result", id: on?.id, ok: false, error: { code: "invalid", message: "no source nope" } });
    expect(errs).toMatchObject([{ code: "invalid", message: "no source nope" }]);
  });

  it("ends its subscriptions as the page goes", () => {
    const h = load();
    h.cf.on("gh", () => {});
    h.cf.on("ui", () => {});
    h.fire("pagehide");
    expect(h.sent("cf:off")).toHaveLength(2);
  });

  it("applies cf:theme, tells onTheme, and acks it", () => {
    const h = load({ stylesheet: true });
    const seen: unknown[] = [];
    h.cf.onTheme((t) => seen.push(t));
    h.send({ type: "cf:theme", id: "github-light", scheme: "light", vars: { "--cf-text": "#000" } });
    expect(seen).toEqual([{ id: "github-light", scheme: "light", vars: { "--cf-text": "#000" } }]);
    expect(h.rootStyle).toEqual({ "--cf-text": "#000", "color-scheme": "light" });
    expect(h.sent("cf:theme:ack")).toEqual([{ type: "cf:theme:ack", cf: 1 }]);
  });

  it("leaves color-scheme alone on a page without the stylesheet", () => {
    const h = load();
    h.send({ type: "cf:theme", id: "github-light", scheme: "light", vars: { "--cf-text": "#000" } });
    expect(h.rootStyle).toEqual({ "--cf-text": "#000" });
  });

  it("posts its body's height when it changes, and on demand", async () => {
    const h = load();
    for (const cb of h.observed) cb();
    await flush();
    expect(h.sent("cf:resize")).toEqual([{ type: "cf:resize", cf: 1, height: 136 }]);
    for (const cb of h.observed) cb();
    await flush();
    expect(h.sent("cf:resize")).toHaveLength(1); // the same height is not posted again
    h.cf.resize(300.2);
    expect(h.sent("cf:resize").at(-1)).toEqual({ type: "cf:resize", cf: 1, height: 301 });
  });

  it("keeps storage under the thread's prefix", async () => {
    const h = load();
    expect(() => h.cf.storage()).toThrow(/await cf.ready/);
    h.ready();
    await h.cf.ready;
    const s = h.cf.storage("todo");
    s.set("items", [1, 2]);
    expect(h.store.get("cf:t-1:todo:items")).toBe("[1,2]");
    expect(s.get("items")).toEqual([1, 2]);
    h.store.set("other", "x");
    expect(s.keys()).toEqual(["items"]);
    s.clear();
    expect([...h.store.keys()]).toEqual(["other"]);
  });
});
