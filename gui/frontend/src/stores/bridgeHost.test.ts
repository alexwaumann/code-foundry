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

beforeEach(() => {
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
  it("says ready with the thread and its read-only verbs on load", async () => {
    const { h, posts } = host();
    h.loaded();
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
    expect(invokeCommand).toHaveBeenCalledWith("thread.new", expect.objectContaining({ activeThreadId: "t-1" }), { prompt: "hi", "created-by": "t-1", focus: "false" });
  });

  it("sends the thread's checkout for an arg that defaults to the CLI's cwd", async () => {
    invokeCommand.mockResolvedValue({ message: "", resultJson: "" });
    useThreadsStore.setState({ byId: { "t-1": { ...thread("t-1", "Fix"), worktreePath: "/wt/app" } } });
    const { h, posts } = host();
    h.receive(run("r1", "workspace.members"));
    await vi.waitFor(() => {
      expect(posts.find((p) => p.type === "cf:result")).toMatchObject({ ok: true });
    });
    expect(invokeCommand).toHaveBeenCalledWith("workspace.members", expect.anything(), { cwd: "/wt/app" });
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
    one.h.loaded();
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
    h.loaded();
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

  it("a new document drops the last one's subscriptions; an unknown source is invalid", () => {
    vi.useFakeTimers();
    const { h, posts } = host();
    h.receive({ cf: 1, type: "cf:on", id: "s", source: "nope" });
    expect(posts).toEqual([{ type: "cf:result", id: "s", ok: false, error: { code: "invalid", message: "no source nope" } }]);
    h.receive({ cf: 1, type: "cf:on", id: "s", source: "thread" });
    expect(posts.at(-1)).toMatchObject({ type: "cf:event", source: "thread", event: { thread: { id: "t-1" }, pending: [] } });
    h.loaded();
    const n = posts.length;
    useThreadsStore.setState({ byId: { "t-1": thread("t-1", "Renamed") }, order: ["t-1"] });
    vi.advanceTimersByTime(BRIDGE_DEBOUNCE_MS);
    expect(posts.slice(n).filter((p) => p.type === "cf:event")).toEqual([]);
  });
});
