import { afterEach, describe, expect, it, vi } from "vitest";
import SRC from "../../../../internal/bridge/bridge.js?raw";
import { BRIDGE_LIMITS, parsePageMessage } from "./bridge";

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
  sources: string[];
  fetch(url: unknown, init?: unknown): Promise<{ status: number; statusText: string; ok: boolean; url: string; headers: Record<string, string>; text(): string; json(): unknown }>;
  storage(prefix?: string): { get(k: string): unknown; set(k: string, v: unknown): Promise<void>; remove(k: string): Promise<void>; keys(): string[]; clear(): Promise<unknown> };
}

/** The nonce the fake frame's URL carries (HtmlFrame's `?cf-nonce=<nonce>`). */
const N = "n0nce";

function load(opts: { userActivation?: { isActive: boolean } | null; embedded?: boolean; stylesheet?: boolean; search?: string; hash?: string; url?: string; navigation?: object; origin?: string } = {}) {
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
    console,
  };
  win.parent = opts.embedded === false ? win : parent;
  if (opts.navigation) win.navigation = opts.navigation;
  if (opts.origin !== undefined) win.origin = opts.origin;
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
  // oxlint-disable-next-line typescript/no-implied-eval
  const run = new Function("window", "navigator", "document", "localStorage", "ResizeObserver", "location", SRC) as (...globals: unknown[]) => void;
  const where = opts.url === undefined ? null : new URL(opts.url);
  const went: string[] = [];
  const loc = where
    ? {
        href: where.href,
        origin: where.origin,
        pathname: where.pathname,
        search: where.search,
        hash: where.hash,
        assign: (u: string) => went.push(`assign ${u}`),
        replace: (u: string) => went.push(`replace ${u}`),
      }
    : { search: opts.search ?? `?cf-nonce=${N}`, hash: opts.hash ?? "" };
  run(win, nav, doc, localStorage, ResizeObserver, loc);
  const cf = win.cf as Cf;
  const send = (data: unknown, source: unknown = parent) => {
    for (const fn of listeners.message ?? []) fn({ data, source });
  };
  const fire = (type: string, ev: object = {}) => {
    for (const fn of listeners[type] ?? []) fn(ev);
  };
  const ready = (extra: Record<string, unknown> = {}) => {
    send({
      type: "cf:ready",
      cf: 1, nonce: N,
      thread: { id: "t-1", name: "Thread one" },
      theme: { id: "github-dark", scheme: "dark", vars: { "--cf-text": "#fff" } },
      readOnly: ["thread.get"],
      sources: ["thread-list", "thread"],
      ...extra,
    });
  };
  const sent = (type: string) => posted.filter((p) => p.m.type === type).map((p) => p.m);
  return { cf, posted, send, ready, sent, fire, nav, store, rootStyle, observed, went };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("bridge.js", () => {
  it("says hello to its parent with the protocol version and its frame's nonce, to any origin", () => {
    const h = load();
    expect(h.posted[0]).toEqual({ m: { type: "cf:hello", cf: 1, nonce: N }, origin: "*" });
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
    expect(run).toEqual({ type: "cf:run", cf: 1, nonce: N, id: run?.id, verb: "thread.get", args: { id: "t-2", json: "true", last: "3" } });
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

  it("says how long a gesture lasts, and what to do, when a call comes too late", async () => {
    const h = load();
    h.ready({ verbs: ["thread.get", "thread.send"] });
    await expect(h.cf.run("thread.send")).rejects.toMatchObject({
      code: "gesture",
      message: "thread.send changes something, so it runs only within 5 s of a click or key press in the page: start it in the handler, before slow awaits",
    });
  });

  it("sends a name that is no command on to the app, which says so, instead of asking for a click", async () => {
    const h = load();
    h.ready({ verbs: ["thread.get", "thread.send"] });
    const p = h.cf.run("thread.lst");
    await flush();
    const [run] = h.sent("cf:run");
    expect(run?.verb).toBe("thread.lst");
    h.send({ type: "cf:result", id: run?.id, ok: false, error: { code: "unavailable", message: 'unknown command "thread.lst"' } });
    await expect(p).rejects.toMatchObject({ code: "unavailable" });
    // An app from before `verbs`, or one that could not list them: every name not read-only
    // needs the click, as before.
    for (const extra of [{}, { verbs: [] }]) {
      const old = load();
      old.ready(extra);
      await expect(old.cf.run("thread.lst")).rejects.toMatchObject({ code: "gesture" });
      expect(old.sent("cf:run")).toHaveLength(0);
    }
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

  it("takes a recent real press even when navigator.userActivation says inactive (the side panel's WebKit)", async () => {
    vi.useFakeTimers();
    const h = load({ userActivation: { isActive: false } });
    h.ready();
    await expect(h.cf.run("thread.send")).rejects.toMatchObject({ code: "gesture" });
    h.fire("click", { isTrusted: true });
    void h.cf.run("thread.send");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent("cf:run")).toHaveLength(1);
    vi.advanceTimersByTime(5001);
    await expect(h.cf.run("thread.send")).rejects.toMatchObject({ code: "gesture" });
  });

  it("does not take a page's own synthetic click as a gesture", async () => {
    const h = load({ userActivation: { isActive: false } });
    h.ready();
    h.fire("click", { isTrusted: false });
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
    const check = expect(p).rejects.toMatchObject({ code: "timeout", message: "thread.get did not answer in 1 s" });
    await vi.advanceTimersByTimeAsync(1001);
    await check;
  });

  it.each([
    [1500, "1.5 s"],
    [400, "0.4 s"],
    [60_000, "60 s"],
  ])("says a timeout of %d ms as %s", async (ms, said) => {
    vi.useFakeTimers();
    const h = load();
    h.ready();
    const check = expect(h.cf.run("thread.get", {}, { timeout: ms })).rejects.toMatchObject({ message: `thread.get did not answer in ${said}` });
    await vi.advanceTimersByTimeAsync(ms + 1);
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
    expect(on).toMatchObject({ type: "cf:on", cf: 1, nonce: N, source: "thread-list" });
    h.send({ type: "cf:event", id: on?.id, source: "thread-list", event: { threads: [] } });
    h.send({ type: "cf:event", id: "someone-else", source: "thread-list", event: 1 });
    expect(got).toEqual([[{ threads: [] }, "thread-list"]]);
    off();
    expect(h.sent("cf:off")).toEqual([{ type: "cf:off", cf: 1, nonce: N, id: on?.id }]);
    h.send({ type: "cf:event", id: on?.id, source: "thread-list", event: 2 });
    expect(got).toHaveLength(1);
  });

  it("drops a subscription the host refuses and tells its owner, else the console as an error", () => {
    const h = load();
    const errs: CfError[] = [];
    h.cf.on("gh", () => {}, (e) => errs.push(e));
    const [on] = h.sent("cf:on");
    h.send({ type: "cf:result", id: on?.id, ok: false, error: { code: "unavailable", message: "this page is not shown in a thread" } });
    expect(errs).toMatchObject([{ code: "unavailable", message: "this page is not shown in a thread" }]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.cf.on("ui", () => {});
    h.send({ type: "cf:result", id: h.sent("cf:on")[1]?.id, ok: false, error: { code: "unavailable", message: "gone" } });
    expect(error).toHaveBeenCalledWith("cf.on(ui): gone");
    error.mockRestore();
  });

  it("throws at once for a source that is not one, before and after cf:ready", () => {
    const h = load();
    expect(() => h.cf.on("threads", () => {})).toThrow(/no source threads; the sources are thread-list, thread, gh/);
    h.ready();
    expect(() => h.cf.on("gh", () => {})).toThrow(/no source gh; the sources are thread-list, thread$/);
    expect(h.sent("cf:on")).toEqual([]);
    h.cf.on("thread", () => {});
    expect(h.sent("cf:on")).toHaveLength(1);
  });

  it("stops a run's clock while the app asks the user, and gives up out loud", async () => {
    vi.useFakeTimers();
    const h = load({ userActivation: { isActive: true } });
    h.ready();
    const p = h.cf.run("thread.archive", {}, { timeout: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    const id = h.sent("cf:run")[0]?.id;
    await vi.advanceTimersByTimeAsync(400);
    h.send({ type: "cf:pending", id, reason: "confirm" });
    // The dialog stays open far longer than the timeout.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sent("cf:cancel")).toEqual([]);
    h.send({ type: "cf:resume", id });
    // What was left of it: 600 ms.
    await vi.advanceTimersByTimeAsync(599);
    expect(h.sent("cf:cancel")).toEqual([]);
    const check = expect(p).rejects.toMatchObject({ code: "timeout", message: "thread.archive did not answer in 1 s" });
    await vi.advanceTimersByTimeAsync(2);
    await check;
    // The app hears the page gave up, so a question still waiting is never asked.
    expect(h.sent("cf:cancel")).toEqual([{ type: "cf:cancel", cf: 1, nonce: N, id }]);
  });

  it("settles a run that was waiting on the user when its result comes", async () => {
    const h = load({ userActivation: { isActive: true } });
    h.ready();
    const p = h.cf.run("thread.archive");
    await flush();
    const id = h.sent("cf:run")[0]?.id;
    h.send({ type: "cf:pending", id, reason: "confirm" });
    h.send({ type: "cf:result", id, ok: true, result: { text: "archived" } });
    await expect(p).resolves.toEqual({ text: "archived", json: null });
  });

  it("says bye as the page goes, and hears no event after", () => {
    const h = load();
    const got: unknown[] = [];
    h.cf.on("gh", (e) => got.push(e));
    const [on] = h.sent("cf:on");
    h.fire("pagehide");
    expect(h.sent("cf:bye")).toEqual([{ type: "cf:bye", cf: 1, nonce: N }]);
    h.send({ type: "cf:event", id: on?.id, source: "gh", event: 1 });
    expect(got).toEqual([]);
  });

  it.each([
    ["no query", "", ""],
    ["a query of the page's own", "?tab=2", ""],
    ["an empty nonce", "?cf-nonce=", ""],
    ["a nonce in the fragment, as the app once put it", "", `#cf=${N}`],
  ])("has no bridge in a frame whose URL carries no nonce (%s): only its height and theme ack go out", async (_name, search, hash) => {
    const h = load({ search, hash });
    await expect(h.cf.ready).rejects.toMatchObject({ code: "unavailable", message: /not opened by Code Foundry in this frame/ });
    await expect(h.cf.run("thread.get")).rejects.toMatchObject({ code: "unavailable" });
    h.cf.on("gh", () => {});
    h.cf.resize(200);
    h.send({ type: "cf:theme", id: "github-light", scheme: "light", vars: {} });
    expect(h.posted.map((p) => p.m)).toEqual([
      { type: "cf:resize", cf: 1, height: 200 },
      { type: "cf:theme:ack", cf: 1 },
    ]);
  });

  it("finds its nonce after the page's own parameters, and leaves the fragment to the page", () => {
    const h = load({ search: `?tab=2&cf-nonce=${N}`, hash: "#/about" });
    expect(h.posted[0]?.m).toEqual({ type: "cf:hello", cf: 1, nonce: N });
  });

  it("keeps at most 32 runs at the app, the rest waiting here with their clocks running", async () => {
    vi.useFakeTimers();
    const h = load();
    h.ready();
    const runs = Array.from({ length: 34 }, (_, i) => h.cf.run("thread.get", { n: String(i) }, { timeout: i === 33 ? 500 : 0 }));
    const late = expect(runs[33]).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent("cf:run")).toHaveLength(32);
    // The last one gives up while it waits: the app never heard of it, so no cancel.
    await vi.advanceTimersByTimeAsync(501);
    await late;
    expect(h.sent("cf:cancel")).toEqual([]);
    h.send({ type: "cf:result", id: h.sent("cf:run")[0]?.id, ok: true, result: { text: "0" } });
    await expect(runs[0]).resolves.toMatchObject({ text: "0" });
    expect(h.sent("cf:run")).toHaveLength(33);
    expect(h.sent("cf:run").at(-1)?.args).toEqual({ n: "32" });
  });

  it("fetches through the app: the request as sent, any status resolves with text() and json()", async () => {
    const h = load();
    h.ready();
    const p = h.cf.fetch("https://tracker.example.com/api/issues?state=open", { method: "post", headers: { Authorization: "Bearer t" }, body: { q: 1 }, timeout: 5000 });
    await flush();
    const [f] = h.sent("cf:fetch");
    expect(f).toEqual({
      type: "cf:fetch", cf: 1, nonce: N, id: f?.id, url: "https://tracker.example.com/api/issues?state=open", method: "POST",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json" }, body: '{"q":1}', timeout: 5000,
    });
    h.send({ type: "cf:result", id: f?.id, ok: true, result: { status: 404, statusText: "Not Found", url: "https://tracker.example.com/x", headers: { "content-type": "application/json" }, body: '{"error":"no"}' } });
    const res = await p;
    expect(res).toMatchObject({ status: 404, statusText: "Not Found", ok: false, headers: { "content-type": "application/json" } });
    expect(res.text()).toBe('{"error":"no"}');
    expect(res.json()).toEqual({ error: "no" });
  });

  it("sends a GET by default, keeps a page's own content-type, and sends URLSearchParams as a form", async () => {
    const h = load();
    h.ready();
    void h.cf.fetch(new URL("https://a.example/x"));
    void h.cf.fetch("https://a.example/y", { method: "PUT", headers: [["content-type", "text/plain"]], body: { a: 1 } });
    void h.cf.fetch("https://a.example/z", { method: "POST", body: new URLSearchParams({ a: "1 2" }) });
    await flush();
    const [a, b, c] = h.sent("cf:fetch");
    expect(a).toMatchObject({ method: "GET", headers: {}, body: "", timeout: 30000 });
    expect(b).toMatchObject({ method: "PUT", headers: { "content-type": "text/plain" }, body: '{"a":1}' });
    expect(c).toMatchObject({ headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: "a=1+2" });
  });

  it("answers a json() that is not JSON with a SyntaxError naming the host", async () => {
    const h = load();
    h.ready();
    const p = h.cf.fetch("https://a.example/");
    await flush();
    h.send({ type: "cf:result", id: h.sent("cf:fetch")[0]?.id, ok: true, result: { status: 502, body: "<html>Bad gateway</html>" } });
    const res = await p;
    expect(() => res.json()).toThrow(/a\.example's answer \(502\) is not JSON: <html>/);
  });

  it("refuses a bad fetch as invalid without sending it, and a page given no fetch as unavailable", async () => {
    const h = load();
    h.ready();
    for (const [url, init] of [
      ["/api/issues", undefined],
      ["ftp://a.example/", undefined],
      ["https://a.example/", { body: "x" }],
      ["https://a.example/", { method: "POST", body: "é".repeat(512 * 1024 + 1) }],
      ["https://a.example/", { method: "POST", body: new Uint8Array(2) }],
      [42, undefined],
    ] as const) {
      await expect(h.cf.fetch(url, init)).rejects.toMatchObject({ code: "invalid" });
    }
    expect(h.sent("cf:fetch")).toHaveLength(0);
    const lone = load();
    lone.ready({ thread: null });
    await expect(lone.cf.fetch("https://a.example/")).rejects.toMatchObject({ code: "unavailable" });
    expect(lone.sent("cf:fetch")).toHaveLength(0);
  });

  it("rejects with the app's error, and gives up (cf:cancel) a while after its own timeout", async () => {
    vi.useFakeTimers();
    const h = load();
    h.ready();
    const failed = h.cf.fetch("https://a.example/1");
    const silent = h.cf.fetch("https://a.example/2", { timeout: 1000 });
    const check = expect(silent).rejects.toMatchObject({ code: "timeout", message: "cf.fetch a.example did not answer in 1 s" });
    await vi.advanceTimersByTimeAsync(0);
    const [one, two] = h.sent("cf:fetch");
    h.send({ type: "cf:result", id: one?.id, ok: false, error: { code: "failed", message: "GET a.example failed: no such host" } });
    await expect(failed).rejects.toMatchObject({ code: "failed", message: "GET a.example failed: no such host" });
    // The app's own timeout answers first; the page's clock is the backstop.
    await vi.advanceTimersByTimeAsync(1001);
    expect(h.sent("cf:cancel")).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    await check;
    expect(h.sent("cf:cancel")).toEqual([expect.objectContaining({ id: two?.id })]);
  });

  it("counts fetches with runs against the 32 at the app", async () => {
    vi.useFakeTimers();
    const h = load();
    h.ready();
    for (let i = 0; i < 32; i++) void h.cf.run("thread.get", { n: String(i) }, { timeout: 0 });
    const f = h.cf.fetch("https://a.example/");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent("cf:fetch")).toHaveLength(0);
    h.send({ type: "cf:result", id: h.sent("cf:run")[0]?.id, ok: true, result: { text: "" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent("cf:fetch")).toHaveLength(1);
    h.send({ type: "cf:result", id: h.sent("cf:fetch")[0]?.id, ok: true, result: { status: 200, body: "ok" } });
    await expect(f).resolves.toMatchObject({ status: 200, ok: true });
  });

  it("refuses a call or a stored value past 256 KiB without sending it", async () => {
    const h = load();
    h.ready();
    await h.cf.ready;
    const big = "x".repeat(256 * 1024);
    await expect(h.cf.run("thread.get", { body: big })).rejects.toMatchObject({ code: "invalid", message: /too large: 256 KiB of text at most, all together \(base64/ });
    await expect(h.cf.storage().set("k", big)).rejects.toMatchObject({ code: "invalid", message: /too large/ });
    expect(h.cf.storage().get("k")).toBeNull();
    expect(h.sent("cf:run")).toEqual([]);
    expect(h.sent("cf:store")).toEqual([]);
  });

  it("counts a call as the app does (type and id too), so what it sends the app hears", async () => {
    const h = load();
    h.ready();
    await h.cf.ready;
    const max = BRIDGE_LIMITS.messageChars;
    await expect(h.cf.run("thread.get", { body: "x".repeat(max - "thread.getbody".length) })).rejects.toMatchObject({ code: "invalid", message: /too large/ });
    await expect(h.cf.storage().set("k", "x".repeat(max - 10))).rejects.toMatchObject({ code: "invalid", message: /too large/ });
    expect(h.sent("cf:run")).toEqual([]);
    expect(h.sent("cf:store")).toEqual([]);
    void h.cf.run("thread.get", { body: "x".repeat(max - 64) });
    void h.cf.storage().set("k", "x".repeat(max - 64));
    await flush();
    expect(h.sent("cf:run").map(parsePageMessage)).toEqual([expect.objectContaining({ kind: "run" })]);
    expect(h.sent("cf:store").map(parsePageMessage)).toEqual([expect.objectContaining({ kind: "store" })]);
  });

  it("applies cf:theme, tells onTheme, and acks it", () => {
    const h = load({ stylesheet: true });
    const seen: unknown[] = [];
    h.cf.onTheme((t) => seen.push(t));
    h.send({ type: "cf:theme", id: "github-light", scheme: "light", vars: { "--cf-text": "#000" } });
    expect(seen).toEqual([{ id: "github-light", scheme: "light", vars: { "--cf-text": "#000" } }]);
    expect(h.rootStyle).toEqual({ "--cf-text": "#000", "color-scheme": "light" });
    expect(h.sent("cf:theme:ack")).toEqual([{ type: "cf:theme:ack", cf: 1, nonce: N }]);
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
    expect(h.sent("cf:resize")).toEqual([{ type: "cf:resize", cf: 1, nonce: N, height: 136 }]);
    for (const cb of h.observed) cb();
    await flush();
    expect(h.sent("cf:resize")).toHaveLength(1); // the same height is not posted again
    h.cf.resize(300.2);
    expect(h.sent("cf:resize").at(-1)).toEqual({ type: "cf:resize", cf: 1, nonce: N, height: 301 });
  });

  it("reads storage from cf:ready and writes it through to the app, under a prefix", async () => {
    const h = load();
    expect(() => h.cf.storage()).toThrow(/await cf.ready/);
    h.ready({ storage: { "todo:items": "[1,2]", visits: "4", odd: "not json" } });
    await h.cf.ready;
    const s = h.cf.storage("todo");
    expect(s.get("items")).toEqual([1, 2]);
    expect(h.cf.storage().get("visits")).toBe(4);
    expect(h.cf.storage().get("odd")).toBe("not json");
    expect(s.get("missing")).toBeNull();
    const done = s.set("items", [1, 2, 3]);
    expect(s.get("items")).toEqual([1, 2, 3]);
    const [w] = h.sent("cf:store");
    expect(w).toEqual({ type: "cf:store", cf: 1, nonce: N, id: w?.id, key: "todo:items", value: "[1,2,3]" });
    h.send({ type: "cf:result", id: w?.id, ok: true, result: { text: "" } });
    await expect(done).resolves.toBeUndefined();
    expect(s.keys()).toEqual(["items"]);
    void s.clear();
    expect(h.sent("cf:store").at(-1)).toMatchObject({ key: "todo:items", value: null });
    expect(s.keys()).toEqual([]);
    expect(h.cf.storage().keys().sort()).toEqual(["odd", "visits"]);
    // Raw localStorage is the page's own, untouched.
    expect(h.store.size).toBe(0);
  });

  it("takes another frame's writes, but not over its own still on the way, and puts back a refused one", async () => {
    const h = load();
    h.ready({ storage: { a: "1", b: "2" } });
    await h.cf.ready;
    const s = h.cf.storage();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = s.set("a", "x".repeat(10));
    h.send({ type: "cf:storage", values: { a: "9", c: "3" } });
    expect(s.get("a")).toBe("xxxxxxxxxx");
    expect(s.get("b")).toBeNull();
    expect(s.get("c")).toBe(3);
    const [w] = h.sent("cf:store");
    h.send({ type: "cf:result", id: w?.id, ok: false, error: { code: "invalid", message: "page storage is full (256 KiB per thread)" } });
    await expect(refused).rejects.toMatchObject({ code: "invalid", message: /full/ });
    expect(error).toHaveBeenCalledWith("cf.storage: page storage is full (256 KiB per thread)");
    error.mockRestore();
    h.send({ type: "cf:storage", values: { a: "1", c: "3" } });
    expect(s.get("a")).toBe(1);
  });
});

describe("bridge.js: a refused write", () => {
  it("leaves no refused key behind at once, so keys() and clear() right after it work", async () => {
    const h = load();
    h.ready({ storage: { a: "1" } });
    await h.cf.ready;
    const s = h.cf.storage("p");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const long = "k".repeat(1025);
    const refused = s.set(long, 1);
    const changed = h.cf.storage().set("a", 2);
    expect(s.keys()).toEqual([long]);
    const [w, v] = h.sent("cf:store");
    for (const m of [w, v]) h.send({ type: "cf:result", id: m?.id, ok: false, error: { code: "invalid", message: "keys are at most 1024 bytes" } });
    await expect(refused).rejects.toMatchObject({ code: "invalid" });
    await expect(changed).rejects.toMatchObject({ code: "invalid" });
    error.mockRestore();
    expect(s.keys()).toEqual([]);
    expect(h.cf.storage().get("a")).toBe(1);
  });

  it("keeps a later write of the same key still on the way", async () => {
    const h = load();
    h.ready({ storage: {} });
    await h.cf.ready;
    const s = h.cf.storage();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = s.set("k", 1);
    void s.set("k", 2);
    const [w] = h.sent("cf:store");
    h.send({ type: "cf:result", id: w?.id, ok: false, error: { code: "invalid", message: "full" } });
    await expect(first).rejects.toMatchObject({ code: "invalid" });
    error.mockRestore();
    expect(s.get("k")).toBe(2);
  });
});

describe("bridge.js: a page no thread owns (docs/notes/page-ownership-gui.md)", () => {
  it("allowed: storage and fetch work with cf.thread null", async () => {
    const h = load();
    h.ready({ thread: null, storage: { visits: "2" }, can: { storage: true, fetch: true }, refusal: "" });
    await h.cf.ready;
    expect(h.cf.thread).toBeNull();
    expect(h.cf.storage().get("visits")).toBe(2);
    void h.cf.storage().set("visits", 3);
    expect(h.sent("cf:store")).toHaveLength(1);
    void h.cf.fetch("https://a.example/x");
    await flush();
    expect(h.sent("cf:fetch")).toHaveLength(1);
  });

  it("refused: storage and fetch say why, and never that the page should await cf.ready", async () => {
    const why = "the user has not allowed this page to use Code Foundry";
    const h = load();
    h.ready({ thread: null, readOnly: [], sources: [], storage: {}, can: { storage: false, fetch: false }, refusal: why });
    await h.cf.ready;
    expect(() => h.cf.storage()).toThrow(`cf.storage: ${why}`);
    await expect(h.cf.fetch("https://a.example/")).rejects.toMatchObject({ code: "unavailable", message: `cf.fetch: ${why}` });
    expect(h.sent("cf:fetch")).toHaveLength(0);
    // A subscription still goes to the app, which refuses it saying why (no "no source" here).
    expect(() => h.cf.on("thread-list", () => {})).not.toThrow();
    expect(h.sent("cf:on")).toHaveLength(1);
  });

  it("refused: a run goes to the app, which says the page is not allowed, never that it needs a click", async () => {
    const why = "the user has not allowed this page to use Code Foundry";
    const h = load();
    h.ready({ thread: null, readOnly: [], verbs: [], sources: [], storage: {}, can: { storage: false, fetch: false }, refusal: why });
    await h.cf.ready;
    const p = h.cf.run("thread.list");
    await flush();
    const [run] = h.sent("cf:run");
    expect(run?.verb).toBe("thread.list");
    h.send({ type: "cf:result", id: run?.id, ok: false, error: { code: "unavailable", message: why } });
    await expect(p).rejects.toMatchObject({ code: "unavailable", message: why });
  });

  it("an app from before `can`: storage and fetch only with a thread, refused as not shown in one", async () => {
    const h = load();
    h.ready({ thread: null, sources: [] });
    await h.cf.ready;
    expect(() => h.cf.storage()).toThrow("cf.storage: this page is not shown in a thread");
    const t = load();
    t.ready();
    await t.cf.ready;
    expect(() => t.cf.storage()).not.toThrow();
  });

  it("cf:asking: cf.ready and a run wait for the user's answer however long it takes, then go on", async () => {
    vi.useFakeTimers();
    const h = load();
    const run = h.cf.run("thread.get");
    let settled = false;
    void h.cf.ready.then(() => (settled = true));
    h.send({ type: "cf:asking", cf: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    expect(h.sent("cf:run")).toHaveLength(0);
    // A run made while the user is asked waits too.
    const later = h.cf.run("thread.get");
    await vi.advanceTimersByTimeAsync(60_000);
    h.ready({ thread: null, can: { storage: true, fetch: true }, refusal: "" });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(h.sent("cf:run")).toHaveLength(2);
    for (const m of h.sent("cf:run")) h.send({ type: "cf:result", id: m.id, ok: true, result: { text: "ok" } });
    await expect(run).resolves.toMatchObject({ text: "ok" });
    await expect(later).resolves.toMatchObject({ text: "ok" });
  });

  it("without cf:asking, cf.ready still gives up after 10 s", async () => {
    vi.useFakeTimers();
    const h = load();
    const check = expect(h.cf.ready).rejects.toMatchObject({ code: "unavailable", message: "Code Foundry did not answer this page" });
    await vi.advanceTimersByTimeAsync(10_001);
    await check;
  });
});

describe("bridge.js: a page's own next document", () => {
  const PAGE = `http://127.0.0.1:9246/preview/g1/docs/page.html?cf-nonce=${N}`;

  /** A fake Navigation API: the script's navigate listener, and a navigate event it can cancel. */
  function navigation() {
    const fns: ((e: unknown) => void)[] = [];
    const navigate = (url: string, over: Record<string, unknown> = {}) => {
      const e = { cancelable: true, navigationType: "push", destination: { url, sameDocument: false }, formData: null, downloadRequest: null, prevented: false, preventDefault: () => (e.prevented = true), ...over };
      for (const fn of fns) fn(e);
      return e.prevented;
    };
    return { api: { addEventListener: (t: string, fn: (e: unknown) => void) => t === "navigate" && fns.push(fn) }, navigate, fns };
  }

  it("sends a navigation to another file under its grant on with the frame's nonce in its query, its fragment left alone", () => {
    const n = navigation();
    const h = load({ url: PAGE, navigation: n.api });
    expect(n.navigate("http://127.0.0.1:9246/preview/g1/docs/detail.html")).toBe(true);
    expect(n.navigate("http://127.0.0.1:9246/preview/g1/other/rows.html?x=1#top", { navigationType: "replace" })).toBe(true);
    expect(h.went).toEqual([`assign http://127.0.0.1:9246/preview/g1/docs/detail.html?cf-nonce=${N}`, `replace http://127.0.0.1:9246/preview/g1/other/rows.html?x=1&cf-nonce=${N}#top`]);
  });

  it.each([
    ["another grant", "http://127.0.0.1:9246/preview/g2/docs/page.html", {}],
    ["another site", "https://example.com/preview/g1/docs/page.html", {}],
    ["another port", "http://127.0.0.1:9999/preview/g1/docs/page.html", {}],
    ["outside the previews", "http://127.0.0.1:9246/cf/theme.json", {}],
    ["a URL with a nonce already", `http://127.0.0.1:9246/preview/g1/docs/detail.html?cf-nonce=${N}`, {}],
    ["the same document", "http://127.0.0.1:9246/preview/g1/docs/page.html#part", { destination: { url: "http://127.0.0.1:9246/preview/g1/docs/page.html#part", sameDocument: true } }],
    ["a form's POST", "http://127.0.0.1:9246/preview/g1/docs/detail.html", { formData: {} }],
    ["a download", "http://127.0.0.1:9246/preview/g1/docs/rows.csv", { downloadRequest: "rows.csv" }],
    ["a reload", "http://127.0.0.1:9246/preview/g1/docs/page.html", { navigationType: "reload" }],
    ["a step back", "http://127.0.0.1:9246/preview/g1/docs/detail.html", { navigationType: "traverse" }],
    ["one it may not cancel", "http://127.0.0.1:9246/preview/g1/docs/detail.html", { cancelable: false }],
  ])("lets a navigation go as it is: %s", (_name, url, over) => {
    const n = navigation();
    const h = load({ url: PAGE, navigation: n.api });
    expect(n.navigate(url, over)).toBe(false);
    expect(h.went).toEqual([]);
  });

  it.each([
    ["no nonce", "http://127.0.0.1:9246/preview/g1/docs/page.html"],
    ["no grant", `http://127.0.0.1:9246/page.html?cf-nonce=${N}`],
  ])("carries nothing from a page with %s", (_name, url) => {
    const n = navigation();
    load({ url, navigation: n.api });
    expect(n.fns).toHaveLength(0);
  });

  /** A click on a link to href, as WebKit without the Navigation API dispatches it. */
  function click(href: string, attrs: Record<string, string> = {}, over: Record<string, unknown> = {}) {
    const a = { href: new URL(href, PAGE).href, hasAttribute: (k: string) => k in attrs, getAttribute: (k: string) => attrs[k] ?? null };
    const target = { closest: (sel: string) => (sel.includes("a[href]") ? a : null) };
    const e = { target, button: 0, isTrusted: true, defaultPrevented: false, prevented: false, preventDefault: () => (e.prevented = true), ...over };
    return e;
  }

  it("in an opaque frame (a page no thread owns), whose navigate events never come, follows a click on a link with the nonce", () => {
    const n = navigation();
    const h = load({ url: PAGE, navigation: n.api, origin: "null" });
    expect(n.fns).toHaveLength(0);
    const e = click("detail.html");
    h.fire("click", e);
    expect(e.prevented).toBe(true);
    expect(h.went).toEqual([`assign http://127.0.0.1:9246/preview/g1/docs/detail.html?cf-nonce=${N}`]);
  });

  it("without the Navigation API, follows a plain click on a link to another file of its own with the nonce", () => {
    const h = load({ url: PAGE });
    const e = click("detail.html#rows");
    h.fire("click", e);
    expect(e.prevented).toBe(true);
    expect(h.went).toEqual([`assign http://127.0.0.1:9246/preview/g1/docs/detail.html?cf-nonce=${N}#rows`]);
  });

  it.each([
    ["another grant", click("/preview/g2/page.html")],
    ["another site", click("https://example.com/")],
    ["a new window", click("detail.html", { target: "_blank" })],
    ["a download", click("rows.csv", { download: "" })],
    ["a click the page took", click("detail.html", {}, { defaultPrevented: true })],
    ["a click with a modifier", click("detail.html", {}, { metaKey: true })],
    ["a middle click", click("detail.html", {}, { button: 1 })],
  ])("without the Navigation API, leaves a click alone: %s", (_name, e) => {
    const h = load({ url: PAGE });
    h.fire("click", e);
    expect(e.prevented).toBe(false);
    expect(h.went).toEqual([]);
  });
});
