import { beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { TerminalView } from "@/api/terminal";
import { formatAgo } from "@/lib/thread";
import { windowTitle } from "@/lib/title";
import { deriveContext, emptyContext } from "./context";
import { dispatchEvent } from "./events";
import { applyIntent } from "./intents";
import { emptyProjects, replaceProjects, useProjectsStore } from "./projects";
import { activeThreadIds, applyRetiredUsage, applyThreadListEvent, attentionIds, emptyThreads, replaceThreads, runningCount, useThreadsStore } from "./threads";
import { emptyTerminals, useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    claudeSessionId: "",
    projectId: "r1",
    worktreePath: "/src/app",
    name: id,
    autoNamed: true,
    nameProvisional: false,
    model: "opus",
    effort: "high",
    state: "connected",
    status: "idle",
    statusReason: "",
    statusChangedAtMs: null,
    createdAtMs: 10,
    lastActivityAtMs: null,
    parentId: "",
    permissionMode: "auto",
    baseRef: "",
    createdWorktree: false,
    workspaceId: "",
    pendingWorktreePath: "",
    pinned: false,
    archivedAtMs: null,
    snoozedUntilMs: null,
    effortPending: false,
    linkedPullRequests: [],
    usage: [],
    costUsd: 0,
    unpriced: false,
    agentRuns: [],
    contextTokens: 0,
    cacheExpiresAtMs: null,
    contextRereadUsd: 0,
    agentsRunning: 0,
    backgroundAgentsRunning: 0,
    backgroundShellsRunning: 0,
    backgroundWakePending: false,
    retry: null,
    createdBy: "",
    createdByName: "",
    brief: "",
    labels: [],
    report: null,
    budgetUsd: 0,
    ...over,
  };
}

function term(id: string, labels: Record<string, string> = {}): TerminalView {
  return { id, argv: ["claude"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: 1, exitedAtMs: null, altScreen: false, labels };
}

describe("thread reducers", () => {
  it("replace keeps identity for unchanged threads and orders by creation", () => {
    const a = thread("a", { createdAtMs: 2 });
    const b = thread("b", { createdAtMs: 1 });
    const s1 = replaceThreads(emptyThreads, [a, b]);
    expect(s1.order).toEqual(["b", "a"]);
    const s2 = replaceThreads(s1, [{ ...a }, { ...b }]);
    expect(s2).toBe(s1);
    const s3 = replaceThreads(s1, [{ ...a, name: "renamed" }, { ...b }]);
    expect(s3.byId.b).toBe(s1.byId.b);
    expect(s3.byId.a?.name).toBe("renamed");
  });

  it.each([
    ["snapshot replaces", { kind: "snapshot" as const, threads: [thread("z")], retiredUsage: [] }, ["z"]],
    ["updated appends", { kind: "updated" as const, thread: thread("c", { createdAtMs: 99 }) }, ["a", "b", "c"]],
    ["removed drops", { kind: "removed" as const, id: "a" }, ["b"]],
    ["unknown removal is a no-op", { kind: "removed" as const, id: "nope" }, ["a", "b"]],
  ])("%s", (_name, ev, order) => {
    const prev = replaceThreads(emptyThreads, [thread("a", { createdAtMs: 1 }), thread("b", { createdAtMs: 2 })]);
    expect(applyThreadListEvent(prev, ev).order).toEqual(order);
  });

  it("an identical update returns the same state", () => {
    const prev = replaceThreads(emptyThreads, [thread("a")]);
    expect(applyThreadListEvent(prev, { kind: "updated", thread: thread("a") })).toBe(prev);
  });

  it("linked pull requests compare by content", () => {
    const pr = (n: number) => ({ slug: "o/r", number: n, url: `https://github.com/o/r/pull/${String(n)}`, linkedAt: 1000 });
    const prev = replaceThreads(emptyThreads, [thread("a", { linkedPullRequests: [pr(5)] })]);
    expect(applyThreadListEvent(prev, { kind: "updated", thread: thread("a", { linkedPullRequests: [pr(5)] }) })).toBe(prev);
    const next = applyThreadListEvent(prev, { kind: "updated", thread: thread("a", { linkedPullRequests: [pr(5), pr(6)] }) });
    expect(next).not.toBe(prev);
    expect(next.byId.a?.linkedPullRequests.map((l) => l.number)).toEqual([5, 6]);
  });

  it("labels and the report compare by content", () => {
    const report = (summary: string) => ({ status: "done" as const, summary, data: "", atMs: 1000 });
    const prev = replaceThreads(emptyThreads, [thread("a", { labels: ["x"], report: report("ok") })]);
    expect(applyThreadListEvent(prev, { kind: "updated", thread: thread("a", { labels: ["x"], report: report("ok") }) })).toBe(prev);
    expect(applyThreadListEvent(prev, { kind: "updated", thread: thread("a", { labels: ["x", "y"], report: report("ok") }) })).not.toBe(prev);
    expect(applyThreadListEvent(prev, { kind: "updated", thread: thread("a", { labels: ["x"], report: report("later") }) })).not.toBe(prev);
    expect(applyThreadListEvent(prev, { kind: "updated", thread: thread("a", { labels: ["x"], report: null }) })).not.toBe(prev);
  });

  it("usage compares by content; the retired ledger follows snapshots and retiredUsage events", () => {
    const bucket = (requests: number) => ({
      model: "claude-haiku-5-5",
      tier: "",
      speed: "",
      day: "2026-10-10",
      requests,
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite5m: 0,
      cacheWrite1h: 4,
      costUsd: 0.001,
      unpriced: false,
      inputCostUsd: 0,
      outputCostUsd: 0,
      cacheReadCostUsd: 0,
      cacheWrite5mCostUsd: 0,
      cacheWrite1hCostUsd: 0.001,
      cacheSavingsUsd: 0,
    });
    const prev = replaceThreads(emptyThreads, [thread("a", { usage: [bucket(1)] })]);
    expect(applyThreadListEvent(prev, { kind: "updated", thread: thread("a", { usage: [bucket(1)] }) })).toBe(prev);
    const next = applyThreadListEvent(prev, { kind: "updated", thread: thread("a", { usage: [bucket(2)] }) });
    expect(next.byId.a?.usage[0]?.requests).toBe(2);
    expect(applyThreadListEvent(prev, { kind: "retiredUsage", buckets: [bucket(1)] })).toBe(prev);

    const retired = [bucket(5)];
    expect(applyRetiredUsage([], { kind: "snapshot", threads: [], retiredUsage: retired })).toBe(retired);
    expect(applyRetiredUsage(retired, { kind: "retiredUsage", buckets: [bucket(5)] })).toBe(retired);
    expect(applyRetiredUsage(retired, { kind: "retiredUsage", buckets: [bucket(6)] })[0]?.requests).toBe(6);
    expect(applyRetiredUsage(retired, { kind: "removed", id: "a" })).toBe(retired);

    // Agent runs compare by content too, their usage included.
    const run = (status: "open" | "closed", requests: number) => ({
      id: "r1",
      description: "say ok",
      agentType: "general-purpose",
      model: "haiku",
      effort: "",
      background: false,
      status,
      spawnDepth: 1,
      startedAtMs: 5,
      usage: [bucket(requests)],
      costUsd: 0,
      unpriced: false,
    });
    const withRun = replaceThreads(emptyThreads, [thread("a", { agentRuns: [run("open", 1)] })]);
    expect(applyThreadListEvent(withRun, { kind: "updated", thread: thread("a", { agentRuns: [run("open", 1)] }) })).toBe(withRun);
    expect(applyThreadListEvent(withRun, { kind: "updated", thread: thread("a", { agentRuns: [run("closed", 1)] }) }).byId.a?.agentRuns[0]?.status).toBe("closed");
    expect(applyThreadListEvent(withRun, { kind: "updated", thread: thread("a", { agentRuns: [run("open", 2)] }) })).not.toBe(withRun);
  });

  it("attentionIds counts a stopped thread's persisted attention, not an interrupted one", () => {
    const d = replaceThreads(emptyThreads, [
      thread("a", { status: "attention" }),
      thread("b", { status: "attention", statusReason: "question: Which color do you prefer?", state: "disconnected" }),
      thread("c"),
      thread("d", { status: "error", statusReason: "interrupted", state: "disconnected" }),
      thread("e", { status: "attention", statusReason: "finished", state: "disconnected", archivedAtMs: 7 }),
      thread("f", { status: "attention", statusReason: "finished", state: "disconnected", snoozedUntilMs: 9 }),
      thread("g", { status: "attention", statusReason: "snooze ended", state: "disconnected" }),
    ]);
    // e waits (a finished turn) but is archived, f is snoozed: not counted. g woke: counted.
    expect(attentionIds(d)).toEqual(["a", "b", "g"]);
  });

  it("start page counts and thread list: waiting first, then running (starting included); a stopped busy never", () => {
    const d = replaceThreads(emptyThreads, [
      thread("busy1", { status: "busy", createdAtMs: 1 }),
      thread("idle", { createdAtMs: 2 }),
      thread("wait1", { status: "attention", createdAtMs: 3 }),
      thread("gone", { status: "busy", state: "disconnected", createdAtMs: 4 }),
      thread("start", { status: "idle", state: "starting", createdAtMs: 5 }),
      thread("wait2", { status: "attention", state: "closing", createdAtMs: 6 }),
      thread("stopped", { status: "idle", state: "disconnected", createdAtMs: 7 }),
    ]);
    expect(runningCount(d)).toBe(2);
    expect(activeThreadIds(d)).toEqual(["wait1", "wait2", "busy1", "start"]);
  });

  it("a thread is never both waiting and running: attention wins (an MCP start keeps a saved finished turn)", () => {
    const d = replaceThreads(emptyThreads, [
      thread("mcp", { status: "attention", statusReason: "finished", state: "starting", createdAtMs: 1 }),
      thread("busy", { status: "busy", createdAtMs: 2 }),
      thread("asking", { status: "attention", statusReason: "question: Which?", state: "starting", createdAtMs: 3 }),
    ]);
    expect(attentionIds(d)).toEqual(["mcp", "asking"]);
    expect(runningCount(d)).toBe(1);
    const ids = activeThreadIds(d);
    expect(ids).toEqual(["mcp", "asking", "busy"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(activeThreadIds(emptyThreads)).toEqual([]);
  });
});

describe("deriveContext for a thread", () => {
  const projects = replaceProjects([
    {
      id: "r1",
      path: "/src/app",
      name: "app",
      defaultBranch: "main",
      githubSlug: "",
      remotes: [],
      git: true,
      worktrees: [{ projectId: "r1", path: "/src/app", branch: "main", head: "", detached: false, isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null } }],
    },
  ]);
  it("carries the thread and its worktree; no terminal (a thread has none)", () => {
    const threads = replaceThreads(emptyThreads, [thread("s1")]);
    expect(deriveContext({ kind: "thread", id: "s1" }, projects, threads)).toEqual({
      activeThreadId: "s1",
      activeTerminalId: "",
      activeProjectId: "r1",
      activeWorktreePath: "/src/app",
      activeView: "thread",
      activeWorkspaceId: "",
    });
  });
  it("a workspace thread carries its workspace (thread.run-in's availability)", () => {
    const threads = replaceThreads(emptyThreads, [thread("s1", { workspaceId: "w-1" })]);
    expect(deriveContext({ kind: "thread", id: "s1" }, projects, threads).activeWorkspaceId).toBe("w-1");
    expect(deriveContext({ kind: "compose", projectId: "r1", workspaceId: "w-2" }, projects, threads).activeWorkspaceId).toBe("w-2");
  });
  it("a thread without a project: no project or worktree (home is none), so project commands and plain thread.new are not offered", () => {
    const threads = replaceThreads(emptyThreads, [thread("s1", { projectId: "", workspaceId: "", worktreePath: "/Users/dev" })]);
    expect(deriveContext({ kind: "thread", id: "s1" }, projects, threads)).toMatchObject({ activeThreadId: "s1", activeProjectId: "", activeWorktreePath: "", activeView: "thread" });
  });
  it("an older thread without a project id inside a project keeps its place", () => {
    const threads = replaceThreads(emptyThreads, [thread("s1", { projectId: "", workspaceId: "", worktreePath: "/src/app/docs" })]);
    expect(deriveContext({ kind: "thread", id: "s1" }, projects, threads)).toMatchObject({ activeProjectId: "r1", activeWorktreePath: "/src/app" });
  });
  it("a composer without a project: the compose view alone", () => {
    expect(deriveContext({ kind: "compose", projectId: "", noProject: true }, projects)).toEqual({ ...emptyContext, activeView: "compose" });
  });
  it("an unknown thread keeps the id", () => {
    const threads = replaceThreads(emptyThreads, [thread("s1", { state: "disconnected" })]);
    expect(deriveContext({ kind: "thread", id: "gone" }, emptyProjects, threads)).toMatchObject({ activeThreadId: "gone", activeView: "thread" });
  });
});

describe("event dispatch", () => {
  beforeEach(() => {
    useThreadsStore.setState({ ...emptyThreads, availability: "unknown", error: null });
    useTerminalsStore.setState({ ...emptyTerminals });
    useProjectsStore.setState({ ...emptyProjects });
    useUiStore.setState({ selection: { kind: "none" } });
  });

  it("routes each source to its slice", () => {
    dispatchEvent({ source: "threadList", event: { kind: "snapshot", threads: [thread("s1")], retiredUsage: [] } });
    dispatchEvent({ source: "terminal", event: { kind: "updated", terminal: term("t1") } });
    dispatchEvent({ source: "project", event: { kind: "snapshot", projects: [] } });
    dispatchEvent({ source: "gh", event: { kind: "viewer" } });
    dispatchEvent({ source: "ui", event: { kind: "focusThread", threadId: "s1" } });
    expect(useThreadsStore.getState()).toMatchObject({ order: ["s1"], availability: "available" });
    expect(useTerminalsStore.getState().order).toEqual(["t1"]);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s1" });
  });

  it("a thread snapshot bumps the epoch; updates and removals do not", () => {
    const start = useThreadsStore.getState().epoch;
    dispatchEvent({ source: "threadList", event: { kind: "snapshot", threads: [thread("s1")], retiredUsage: [] } });
    expect(useThreadsStore.getState().epoch).toBe(start + 1);
    dispatchEvent({ source: "threadList", event: { kind: "updated", thread: thread("s2") } });
    dispatchEvent({ source: "threadList", event: { kind: "removed", id: "s1" } });
    expect(useThreadsStore.getState().epoch).toBe(start + 1);
    dispatchEvent({ source: "threadList", event: { kind: "snapshot", threads: [], retiredUsage: [] } });
    expect(useThreadsStore.getState().epoch).toBe(start + 2);
  });

  it("a FocusTerminal that races its shell reveals the shell once it arrives", () => {
    useThreadsStore.setState({ ...replaceThreads(emptyThreads, [thread("s1")]), availability: "available" });
    useTerminalsStore.setState({ ...emptyTerminals, loaded: true });
    applyIntent({ kind: "focusTerminal", terminalId: "t1" });
    expect(useUiStore.getState().selection).toEqual({ kind: "none" });
    dispatchEvent({ source: "terminal", event: { kind: "updated", terminal: term("t1", { thread: "s1", kind: "shell" }) } });
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s1" });
  });
});

describe("thread presentation", () => {
  it.each([
    [null, "never"],
    [1_000_000 - 10_000, "just now"],
    [1_000_000 - 5 * 60_000, "5 min ago"],
    [1_000_000 - 3 * 3_600_000, "3 h ago"],
  ])("ago %#", (ms, want) => {
    expect(formatAgo(ms, 1_000_000)).toBe(want);
  });

  it("window title carries the attention count", () => {
    expect(windowTitle(0)).toBe("Code Foundry");
    expect(windowTitle(3)).toBe("Code Foundry (3)");
  });
});
