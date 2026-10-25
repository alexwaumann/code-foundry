import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView, ConfirmationView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { answerConfirm, useConfirmStore } from "./confirm";
import { useThreadsStore } from "./threads";

const invokeCommand = vi.hoisted(() => vi.fn());
const listCommands = vi.hoisted(() => vi.fn());
class NeedsConfirm extends Error {
  constructor(readonly confirm: ConfirmationView) {
    super(confirm.message);
  }
}
vi.mock("@/api/command", async (orig) => ({
  ...(await orig<typeof import("@/api/command")>()),
  invokeCommand,
  listCommands,
  confirmationOf: (err: unknown) => (err instanceof NeedsConfirm ? err.confirm : null),
}));
// The daemon's page storage, in memory; full past 3 keys.
const pageStore = vi.hoisted(() => ({ values: new Map<string, Record<string, string>>(), sets: [] as string[] }));
vi.mock("@/api/pageStorage", () => ({
  getPageStorage: (threadId: string) => Promise.resolve({ ...pageStore.values.get(threadId) }),
  setPageStorage: (threadId: string, key: string, value: string | null) => {
    pageStore.sets.push(`${threadId} ${key}`);
    const vals = Object.fromEntries(Object.entries({ ...pageStore.values.get(threadId) }).filter(([k]) => k !== key));
    if (value !== null) vals[key] = value;
    if (Object.keys(vals).length > 3) return Promise.reject(new ConnectError("page storage is full (256 KiB per thread)", Code.InvalidArgument));
    pageStore.values.set(threadId, vals);
    return Promise.resolve({ ...vals });
  },
}));
// The daemon's ProxyFetch: what each call asked, answered by the test.
const proxyFetch = vi.hoisted(() => vi.fn());
vi.mock("@/api/proxyFetch", () => ({ proxyFetch }));
const { createBridgeHost, BRIDGE_DEBOUNCE_MS } = await import("./bridgeHost");
const { EMBER_OFF_SCREEN } = await import("./bridgeSources");

const cmd = (name: string, over: Partial<CommandView> = {}): CommandView => ({ name, title: name, description: "", category: "Thread", args: [], keybindings: [], available: true, ...over });
const commands = [
  cmd("thread.list", { readOnly: true }),
  cmd("ui.notify"),
  cmd("thread.new", {
    args: [
      { name: "created-by", type: "string", required: false, description: "", enumValues: [], defaultValue: "", defaultToThreadEnv: true },
      { name: "focus", type: "bool", required: false, description: "", enumValues: [], defaultValue: "true" },
    ],
  }),
  cmd("workspace.members", { args: [{ name: "cwd", type: "path", required: false, description: "", enumValues: [], defaultValue: "", defaultToCwd: true }] }),
  cmd("thread.archive", { requiresConfirmation: true }),
];
const archiveConfirm = new NeedsConfirm({ command: "thread.archive", title: "Archive or Unarchive Thread", message: "Archive thread Fix? It is working." });

const thread = (id: string, name: string): ThreadView => ({ id, name, projectId: "", worktreePath: "", workspaceId: "" }) as ThreadView;

function host(threadId: string | null = "t-1") {
  const posts: Record<string, unknown>[] = [];
  const errors: { call: string; code: string; message: string }[] = [];
  const h = createBridgeHost({ threadId, pageName: "page.html", post: (m) => posts.push(m as unknown as Record<string, unknown>), onError: (e) => errors.push(e) });
  return { h, posts, errors };
}

const run = (id: string, verb: string, args: Record<string, string> = {}) => ({ cf: 1, type: "cf:run", id, verb, args });
const hello = { cf: 1, type: "cf:hello" };
/** invokeCommand's last two args for a page's call: the default connection and the call's abort signal. */
const signalled: unknown[] = [undefined, expect.objectContaining({ signal: expect.any(AbortSignal) as unknown })];
/** A call the daemon holds until its signal aborts, as a thread.wait does; resolves `aborted` then. */
function hanging() {
  let aborted!: () => void;
  const gone = new Promise<void>((r) => (aborted = r));
  invokeCommand.mockImplementation((_n: string, _c: unknown, _a: unknown, _conn: unknown, opts?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => {
        aborted();
        reject(new ConnectError("the operation was aborted", Code.Canceled));
      });
    }),
  );
  return gone;
}

beforeEach(() => {
  proxyFetch.mockReset();
  invokeCommand.mockReset();
  listCommands.mockReset();
  listCommands.mockResolvedValue(commands);
  pageStore.values.clear();
  pageStore.sets = [];
  useThreadsStore.setState({ byId: { "t-1": thread("t-1", "Fix stale badge") }, order: ["t-1"] });
});

afterEach(() => {
  vi.useRealTimers();
  answerConfirm(false);
});

describe("bridge host", () => {
  it("says ready with the thread and its read-only verbs in reply to hello, not on a bare load", async () => {
    const { h, posts } = host();
    h.loaded();
    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toEqual([]);
    h.receive(hello);
    await vi.waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    expect(posts[0]).toMatchObject({ type: "cf:ready", cf: 1, thread: { id: "t-1", name: "Fix stale badge" }, readOnly: ["thread.list"] });
    expect(listCommands).toHaveBeenCalledWith({ activeTerminalId: "", activeThreadId: "t-1", activeProjectId: "", activeWorktreePath: "", activeView: "", activeWorkspaceId: "" }, { includeUnavailable: true });
  });

  it("runs a verb in the thread's context, filling the args that default to the thread", async () => {
    invokeCommand.mockResolvedValue({ message: "started", resultJson: '{"id":"t-2"}' });
    const { h, posts } = host();
    h.loaded();
    h.receive(run("r1", "thread.new", { prompt: "hi" }));
    await vi.waitFor(() => {
      expect(posts.find((p) => p.type === "cf:result")).toEqual({ type: "cf:result", id: "r1", ok: true, result: { text: "started", json: { id: "t-2" } } });
    });
    // focus=false: a page's thread.new does not move the view (unless the page passes focus).
    expect(invokeCommand).toHaveBeenCalledWith("thread.new", expect.objectContaining({ activeThreadId: "t-1" }), { prompt: "hi", "created-by": "t-1", focus: "false" }, ...signalled);
  });

  it("sends the thread's checkout for an arg that defaults to the CLI's cwd", async () => {
    invokeCommand.mockResolvedValue({ message: "", resultJson: "" });
    useThreadsStore.setState({ byId: { "t-1": { ...thread("t-1", "Fix"), worktreePath: "/wt/app" } } });
    const { h, posts } = host();
    h.receive(run("r1", "workspace.members"));
    await vi.waitFor(() => {
      expect(posts.find((p) => p.type === "cf:result")).toMatchObject({ ok: true });
    });
    expect(invokeCommand).toHaveBeenCalledWith("workspace.members", expect.anything(), { cwd: "/wt/app" }, ...signalled);
  });

  it("reports the errors the strip counts, not a decline", async () => {
    invokeCommand.mockRejectedValueOnce(new ConnectError('unknown argument "headSha"', Code.InvalidArgument));
    const { h, posts, errors } = host();
    h.receive(run("r1", "ui.notify", { headSha: "x" }));
    h.receive({ cf: 1, type: "cf:on", id: "s1", source: "nope" });
    await vi.waitFor(() => {
      expect(errors).toHaveLength(2);
    });
    expect(errors[0]).toMatchObject({ call: 'cf.on("nope")', code: "invalid", message: "no source nope" });
    expect(errors[1]).toMatchObject({ call: "ui.notify", code: "invalid" });
    invokeCommand.mockRejectedValueOnce(archiveConfirm);
    h.receive(run("a", "thread.archive"));
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    answerConfirm(false);
    await vi.waitFor(() => {
      expect(posts.at(-1)).toMatchObject({ id: "a", error: { code: "declined" } });
    });
    expect(errors).toHaveLength(2);
  });

  it("refuses ember while nothing on screen holds the board", () => {
    const { h, posts, errors } = host();
    h.receive({ cf: 1, type: "cf:on", id: "e1", source: "ember" });
    expect(posts).toEqual([{ type: "cf:result", id: "e1", ok: false, error: { code: "unavailable", message: EMBER_OFF_SCREEN } }]);
    expect(errors).toHaveLength(1);
  });

  it("maps the daemon's errors", async () => {
    const cases: [Code, string][] = [
      [Code.NotFound, "unavailable"],
      [Code.FailedPrecondition, "unavailable"],
      [Code.InvalidArgument, "invalid"],
      [Code.Internal, "failed"],
    ];
    for (const [code, want] of cases) {
      invokeCommand.mockRejectedValueOnce(new ConnectError("nope", code));
      const { h, posts } = host();
      h.loaded();
      h.receive(run("r", "ui.notify"));
      await vi.waitFor(() => {
        expect(posts.find((p) => p.type === "cf:result")).toMatchObject({ ok: false, error: { code: want } });
      });
    }
  });

  it("answers a malformed call invalid", () => {
    const { h, posts } = host();
    h.receive({ cf: 1, type: "cf:run", id: "r", verb: "x", args: { n: 1 } });
    expect(posts).toEqual([{ type: "cf:result", id: "r", ok: false, error: { code: "invalid", message: "cf:run arg n must be a string" } }]);
  });

  it("asks before a verb that wants it, as the page; no is declined, yes runs it confirmed", async () => {
    invokeCommand.mockImplementation((_n: string, _c: unknown, _a: unknown, _conn: unknown, opts?: { confirmed?: boolean }) =>
      opts?.confirmed ? Promise.resolve({ message: "archived", resultJson: "" }) : Promise.reject(archiveConfirm),
    );
    const { h, posts } = host();
    h.receive(run("a", "thread.archive"));
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending?.caller).toBe("page.html, a page in Fix stale badge");
    });
    answerConfirm(false);
    await vi.waitFor(() => {
      expect(posts.at(-1)).toMatchObject({ type: "cf:result", id: "a", ok: false, error: { code: "declined" } });
    });
    h.receive(run("b", "thread.archive"));
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    answerConfirm(true);
    await vi.waitFor(() => {
      expect(posts.at(-1)).toEqual({ type: "cf:result", id: "b", ok: true, result: { text: "archived", json: null } });
    });
  });

  it("asks one question at a time per frame", async () => {
    invokeCommand.mockImplementation((_n: string, _c: unknown, _a: unknown, _conn: unknown, opts?: { confirmed?: boolean }) =>
      opts?.confirmed ? Promise.resolve({ message: "ok", resultJson: "" }) : Promise.reject(archiveConfirm),
    );
    const { h, posts } = host();
    h.receive(run("a", "thread.archive"));
    h.receive(run("b", "thread.archive"));
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    const first = useConfirmStore.getState().pending;
    answerConfirm(true);
    await vi.waitFor(() => {
      expect(posts.filter((p) => p.type === "cf:result").map((p) => p.id)).toEqual(["a"]);
    });
    // The second asks only after the first was answered (requestConfirm would have cancelled it).
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBe(first);
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    answerConfirm(true);
    await vi.waitFor(() => {
      expect(posts.filter((p) => p.type === "cf:result").map((p) => [p.id, p.ok])).toEqual([
        ["a", true],
        ["b", true],
      ]);
    });
  });

  it("cancels its open question and drops every answer once disposed", async () => {
    invokeCommand.mockRejectedValue(archiveConfirm);
    const { h, posts } = host();
    h.receive(run("a", "thread.archive"));
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending).not.toBeNull();
    });
    h.dispose();
    expect(useConfirmStore.getState().pending).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toEqual([{ type: "cf:pending", id: "a", reason: "confirm" }]);
  });

  it("tells the page a call waits on the user, open or queued, and when it was answered", async () => {
    invokeCommand.mockImplementation((_n: string, _c: unknown, _a: unknown, _conn: unknown, opts?: { confirmed?: boolean }) =>
      opts?.confirmed ? Promise.resolve({ message: "ok", resultJson: "" }) : Promise.reject(archiveConfirm),
    );
    const { h, posts } = host();
    h.receive(run("a", "thread.archive"));
    h.receive(run("b", "thread.archive"));
    // Both pending at once: a's dialog is open, b's is queued behind it.
    await vi.waitFor(() => {
      expect(posts.filter((p) => p.type === "cf:pending")).toEqual([
        { type: "cf:pending", id: "a", reason: "confirm" },
        { type: "cf:pending", id: "b", reason: "confirm" },
      ]);
    });
    answerConfirm(true);
    await vi.waitFor(() => {
      expect(posts.filter((p) => p.type !== "cf:pending").map((p) => [p.type, p.id])).toEqual([
        ["cf:resume", "a"],
        ["cf:result", "a"],
      ]);
    });
  });

  it("declines a question the page gave up on, open or queued, and never runs its command", async () => {
    invokeCommand.mockImplementation((_n: string, _c: unknown, _a: unknown, _conn: unknown, opts?: { confirmed?: boolean }) =>
      opts?.confirmed ? Promise.resolve({ message: "ok", resultJson: "" }) : Promise.reject(archiveConfirm),
    );
    const { h, posts } = host();
    h.receive(run("a", "thread.archive", { id: "x" }));
    h.receive(run("b", "thread.archive", { id: "y" }));
    h.receive(run("c", "thread.archive", { id: "z" }));
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending?.args).toMatchObject({ id: "x" });
    });
    // b gives up while queued, then a while its dialog is open.
    h.receive({ cf: 1, type: "cf:cancel", id: "b" });
    h.receive({ cf: 1, type: "cf:cancel", id: "a" });
    // a's dialog went; b is skipped; c asks.
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending?.args).toMatchObject({ id: "z" });
    });
    answerConfirm(true);
    await vi.waitFor(() => {
      expect(posts.filter((p) => p.type === "cf:result").map((p) => [p.id, p.ok])).toEqual([
        ["a", false],
        ["b", false],
        ["c", true],
      ]);
    });
    const confirmed = invokeCommand.mock.calls.filter((c) => (c[4] as { confirmed?: boolean } | undefined)?.confirmed).map((c) => (c[2] as Record<string, string>).id);
    expect(confirmed).toEqual(["z"]);
  });

  it("hands a page its thread's storage in ready and writes through, telling the thread's other frames", async () => {
    pageStore.values.set("t-1", { visits: "2" });
    const one = host();
    const two = host();
    const other = host("t-2");
    one.h.receive(hello);
    await vi.waitFor(() => {
      expect(one.posts.find((p) => p.type === "cf:ready")).toMatchObject({ storage: { visits: "2" } });
    });
    one.h.receive({ cf: 1, type: "cf:store", id: "w1", key: "visits", value: "3" });
    one.h.receive({ cf: 1, type: "cf:store", id: "w2", key: "note", value: '"hi"' });
    await vi.waitFor(() => {
      expect(one.posts.filter((p) => p.type === "cf:result").map((p) => [p.id, p.ok])).toEqual([
        ["w1", true],
        ["w2", true],
      ]);
    });
    // In the order sent.
    expect(pageStore.sets).toEqual(["t-1 visits", "t-1 note"]);
    expect(two.posts.filter((p) => p.type === "cf:storage").at(-1)).toEqual({ type: "cf:storage", values: { visits: "3", note: '"hi"' } });
    expect(one.posts.filter((p) => p.type === "cf:storage")).toEqual([]);
    expect(other.posts).toEqual([]);
    const heard = two.posts.length;
    two.h.dispose();
    one.h.receive({ cf: 1, type: "cf:store", id: "w3", key: "note", value: null });
    await vi.waitFor(() => {
      expect(pageStore.values.get("t-1")).toEqual({ visits: "3" });
    });
    expect(two.posts).toHaveLength(heard);
  });

  it("answers a refused write with the error and the storage as it is", async () => {
    pageStore.values.set("t-1", { a: "1", b: "2", c: "3" });
    const { h, posts } = host();
    h.receive({ cf: 1, type: "cf:store", id: "w", key: "d", value: "4" });
    await vi.waitFor(() => {
      expect(posts).toEqual([
        { type: "cf:result", id: "w", ok: false, error: { code: "invalid", message: expect.stringMatching(/page storage is full/) as unknown } },
        { type: "cf:storage", values: { a: "1", b: "2", c: "3" } },
      ]);
    });
  });

  it("refuses every call without a thread", async () => {
    const { h, posts } = host(null);
    h.receive(hello);
    h.receive(run("r", "thread.list"));
    h.receive({ cf: 1, type: "cf:on", id: "s", source: "thread-list" });
    await vi.waitFor(() => {
      expect(posts).toHaveLength(3);
    });
    expect(posts).toContainEqual({ type: "cf:ready", cf: 1, thread: null, theme: expect.anything() as unknown, readOnly: [], sources: [], storage: {} });
    const refusal = { ok: false, error: { code: "unavailable", message: "this page is not shown in a thread" } };
    expect(posts).toContainEqual({ type: "cf:result", id: "r", ...refusal });
    expect(posts).toContainEqual({ type: "cf:result", id: "s", ...refusal });
    expect(invokeCommand).not.toHaveBeenCalled();
    expect(listCommands).not.toHaveBeenCalled();
  });

  it("subscribes: the snapshot at once, a burst of changes as one event, nothing after off", () => {
    vi.useFakeTimers();
    const { h, posts } = host();
    h.receive({ cf: 1, type: "cf:on", id: "s", source: "thread-list" });
    expect(posts).toEqual([{ type: "cf:event", id: "s", source: "thread-list", event: [{ id: "t-1", name: "Fix stale badge", projectId: "", worktreePath: "", workspaceId: "" }] }]);
    useThreadsStore.setState({ byId: { "t-1": thread("t-1", "Fix"), "t-2": thread("t-2", "Two") }, order: ["t-1", "t-2"] });
    useThreadsStore.setState({ byId: { "t-1": thread("t-1", "Fix it"), "t-2": thread("t-2", "Two") }, order: ["t-1", "t-2"] });
    expect(posts).toHaveLength(1);
    vi.advanceTimersByTime(BRIDGE_DEBOUNCE_MS);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ event: [{ name: "Fix it" }, { name: "Two" }] });
    // A change that leaves the view model as it was posts nothing.
    useThreadsStore.setState({ loaded: true });
    vi.advanceTimersByTime(BRIDGE_DEBOUNCE_MS);
    expect(posts).toHaveLength(2);
    h.receive({ cf: 1, type: "cf:off", id: "s" });
    useThreadsStore.setState({ byId: {}, order: [] });
    vi.advanceTimersByTime(BRIDGE_DEBOUNCE_MS);
    expect(posts).toHaveLength(2);
  });

  it("an unknown source is invalid", () => {
    const { h, posts } = host();
    h.receive({ cf: 1, type: "cf:on", id: "s", source: "nope" });
    expect(posts).toEqual([{ type: "cf:result", id: "s", ok: false, error: { code: "invalid", message: "no source nope" } }]);
  });

  // How each new document announces itself: a hello, the last one's bye, or a load with no hello since the one before.
  it.each([
    ["the next document's hello", (h: ReturnType<typeof host>["h"]) => {
      h.receive(hello);
    }],
    ["this document's bye", (h: ReturnType<typeof host>["h"]) => {
      h.receive({ cf: 1, type: "cf:bye" });
    }],
    ["a load with no hello since the last", (h: ReturnType<typeof host>["h"]) => {
      h.loaded();
      h.loaded();
    }],
  ])("a new document (%s) drops the last one's subscriptions and aborts its calls", async (_name, next) => {
    const gone = hanging();
    const { h, posts } = host();
    h.receive(hello);
    h.receive(run("w", "thread.wait"));
    h.receive({ cf: 1, type: "cf:on", id: "s", source: "thread" });
    expect(posts.at(-1)).toMatchObject({ type: "cf:event", source: "thread", event: { thread: { id: "t-1" }, pending: [] } });
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalled();
    });
    next(h);
    await gone;
    const n = posts.length;
    useThreadsStore.setState({ byId: { "t-1": thread("t-1", "Renamed") }, order: ["t-1"] });
    await new Promise((r) => setTimeout(r, BRIDGE_DEBOUNCE_MS + 10));
    expect(posts.slice(n).filter((p) => p.type !== "cf:ready")).toEqual([]);
  });

  it("keeps the document that said hello across its own load", () => {
    vi.useFakeTimers();
    const { h, posts } = host();
    h.receive(hello);
    h.receive({ cf: 1, type: "cf:on", id: "s", source: "thread" });
    h.loaded();
    const n = posts.length;
    useThreadsStore.setState({ byId: { "t-1": thread("t-1", "Renamed") }, order: ["t-1"] });
    vi.advanceTimersByTime(BRIDGE_DEBOUNCE_MS);
    expect(posts.slice(n)).toMatchObject([{ type: "cf:event", event: { thread: { name: "Renamed" } } }]);
  });

  it("aborts a run the page gave up on, and answers nothing for it", async () => {
    const gone = hanging();
    const { h, posts, errors } = host();
    h.receive(run("w", "thread.wait", { id: "t-2" }));
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledWith("thread.wait", expect.anything(), { id: "t-2" }, ...signalled);
    });
    h.receive({ cf: 1, type: "cf:cancel", id: "w" });
    await gone;
    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("aborts every run in flight once disposed", async () => {
    const gone = hanging();
    const { h } = host();
    h.receive(run("w", "thread.wait"));
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalled();
    });
    h.dispose();
    await gone;
  });

  it("refuses a run whose id is in flight, and takes it again once that one is answered", async () => {
    let answer!: (v: unknown) => void;
    invokeCommand.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const { h, posts } = host();
    h.receive(run("r", "thread.list"));
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledTimes(1);
    });
    h.receive(run("r", "thread.list"));
    await vi.waitFor(() => {
      expect(posts).toEqual([{ type: "cf:result", id: "r", ok: false, error: { code: "invalid", message: "a call with id r is already running" } }]);
    });
    answer({ message: "one", resultJson: "" });
    await vi.waitFor(() => {
      expect(posts).toHaveLength(2);
    });
    invokeCommand.mockResolvedValueOnce({ message: "two", resultJson: "" });
    h.receive(run("r", "thread.list"));
    await vi.waitFor(() => {
      expect(posts.at(-1)).toMatchObject({ id: "r", ok: true, result: { text: "two" } });
    });
    expect(invokeCommand).toHaveBeenCalledTimes(2);
  });

  it("holds at most 32 runs and 16 subscriptions per document", async () => {
    void hanging();
    const { h, posts } = host();
    for (let i = 0; i < 33; i++) h.receive(run(`r${String(i)}`, "thread.wait"));
    await vi.waitFor(() => {
      expect(posts).toEqual([{ type: "cf:result", id: "r32", ok: false, error: { code: "invalid", message: "too many calls at once (32); wait for one to finish" } }]);
    });
    await vi.waitFor(() => {
      expect(invokeCommand).toHaveBeenCalledTimes(32);
    });
    posts.length = 0;
    for (let i = 0; i < 17; i++) h.receive({ cf: 1, type: "cf:on", id: `s${String(i)}`, source: "thread" });
    // The same id again replaces its subscription, so it is not one more.
    h.receive({ cf: 1, type: "cf:on", id: "s0", source: "thread-list" });
    const refused = posts.filter((p) => p.type === "cf:result");
    expect(refused).toEqual([{ type: "cf:result", id: "s16", ok: false, error: { code: "invalid", message: "too many subscriptions (16); end one with cf.off first" } }]);
    h.dispose();
  });

  it("sends a fetch to the daemon under the page's thread and answers what came back, any status", async () => {
    proxyFetch.mockResolvedValue({ status: 404, statusText: "Not Found", headers: { "content-type": "text/plain" }, body: "nope", url: "https://a.example/x" });
    const { h, posts, errors } = host();
    h.receive({ cf: 1, type: "cf:fetch", id: "f", url: "https://a.example/x?token=s", method: "GET", headers: { Authorization: "t" }, body: "", timeout: 5000 });
    await vi.waitFor(() => {
      expect(posts).toEqual([{ type: "cf:result", id: "f", ok: true, result: { status: 404, statusText: "Not Found", headers: { "content-type": "text/plain" }, body: "nope", url: "https://a.example/x" } }]);
    });
    expect(proxyFetch).toHaveBeenCalledWith("t-1", { url: "https://a.example/x?token=s", method: "GET", headers: { Authorization: "t" }, body: "", timeoutMs: 5000 }, { signal: expect.any(AbortSignal) as unknown });
    expect(errors).toEqual([]);
  });

  it("maps a fetch's errors, and reports invalid, failed and timeout only, by host", async () => {
    const { h, posts, errors } = host();
    const cases: [ConnectError, string][] = [
      [new ConnectError("127.0.0.1 is a loopback address", Code.InvalidArgument), "invalid"],
      [new ConnectError("GET a.example failed: no such host", Code.Unavailable), "failed"],
      [new ConnectError("a.example answered more than 8 MiB", Code.ResourceExhausted), "failed"],
      [new ConnectError("a.example did not answer in 30 s", Code.DeadlineExceeded), "timeout"],
      [new ConnectError("no thread t-1", Code.NotFound), "unavailable"],
    ];
    for (const [i, [err]] of cases.entries()) {
      proxyFetch.mockRejectedValueOnce(err);
      h.receive({ cf: 1, type: "cf:fetch", id: `f${String(i)}`, url: "https://a.example/secret/path" });
      await vi.waitFor(() => {
        expect(posts).toHaveLength(i + 1);
      });
    }
    expect(posts.map((p) => (p.error as { code: string }).code)).toEqual(cases.map(([, c]) => c));
    expect(errors.map((e) => [e.call, e.code])).toEqual([
      ["cf.fetch a.example", "invalid"],
      ["cf.fetch a.example", "failed"],
      ["cf.fetch a.example", "failed"],
      ["cf.fetch a.example", "timeout"],
    ]);
  });

  it("aborts a fetch the page gave up on, or whose page went, and answers nothing for it", async () => {
    const aborted: string[] = [];
    proxyFetch.mockImplementation((_t: string, call: { url: string }, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          aborted.push(call.url);
          reject(new ConnectError("the operation was aborted", Code.Canceled));
        });
      }),
    );
    const { h, posts, errors } = host();
    h.receive({ cf: 1, type: "cf:fetch", id: "a", url: "https://a.example/1" });
    h.receive({ cf: 1, type: "cf:fetch", id: "a", url: "https://a.example/dup" });
    h.receive({ cf: 1, type: "cf:fetch", id: "b", url: "https://a.example/2" });
    await vi.waitFor(() => {
      expect(proxyFetch).toHaveBeenCalledTimes(2);
    });
    // The duplicate id is refused, as for a run.
    expect(posts).toEqual([{ type: "cf:result", id: "a", ok: false, error: { code: "invalid", message: "a call with id a is already running" } }]);
    h.receive({ cf: 1, type: "cf:cancel", id: "a" });
    h.receive({ cf: 1, type: "cf:bye" });
    await vi.waitFor(() => {
      expect(aborted).toEqual(["https://a.example/1", "https://a.example/2"]);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("refuses a fetch without a thread, unreported", async () => {
    const { h, posts, errors } = host(null);
    h.receive({ cf: 1, type: "cf:fetch", id: "f", url: "https://a.example/" });
    await vi.waitFor(() => {
      expect(posts).toEqual([{ type: "cf:result", id: "f", ok: false, error: { code: "unavailable", message: "this page is not shown in a thread" } }]);
    });
    expect(proxyFetch).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("ignores a message past 256 KiB", async () => {
    const { h, posts } = host();
    h.receive(run("r", "ui.notify", { body: "x".repeat(256 * 1024) }));
    h.receive({ cf: 1, type: "cf:store", id: "w", key: "k", value: "y".repeat(256 * 1024 + 1) });
    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toEqual([]);
    expect(invokeCommand).not.toHaveBeenCalled();
    expect(pageStore.sets).toEqual([]);
  });
});
