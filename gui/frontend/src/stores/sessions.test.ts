import { beforeEach, describe, expect, it } from "vitest";
import type { SessionView } from "@/api/session";
import type { TerminalView } from "@/api/terminal";
import { formatAgo } from "@/lib/session";
import { windowTitle } from "@/lib/title";
import { deriveContext, emptyContext } from "./context";
import { dispatchEvent } from "./events";
import { applyIntent } from "./intents";
import { emptyRepos, replaceRepos, useReposStore } from "./repos";
import { activeThreadIds, applyRetiredUsage, applySessionEvent, attentionIds, emptySessions, replaceSessions, runningCount, useSessionsStore } from "./sessions";
import { emptyTerminals, useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";

function session(id: string, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    claudeSessionId: "",
    repoId: "r1",
    worktreePath: "/src/app",
    name: id,
    autoNamed: true,
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
    retry: null,
    ...over,
  };
}

function term(id: string, labels: Record<string, string> = {}): TerminalView {
  return { id, argv: ["claude"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: 1, exitedAtMs: null, altScreen: false, labels };
}

describe("session reducers", () => {
  it("replace keeps identity for unchanged sessions and orders by creation", () => {
    const a = session("a", { createdAtMs: 2 });
    const b = session("b", { createdAtMs: 1 });
    const s1 = replaceSessions(emptySessions, [a, b]);
    expect(s1.order).toEqual(["b", "a"]);
    const s2 = replaceSessions(s1, [{ ...a }, { ...b }]);
    expect(s2).toBe(s1);
    const s3 = replaceSessions(s1, [{ ...a, name: "renamed" }, { ...b }]);
    expect(s3.byId.b).toBe(s1.byId.b);
    expect(s3.byId.a?.name).toBe("renamed");
  });

  it.each([
    ["snapshot replaces", { kind: "snapshot" as const, sessions: [session("z")], retiredUsage: [] }, ["z"]],
    ["updated appends", { kind: "updated" as const, session: session("c", { createdAtMs: 99 }) }, ["a", "b", "c"]],
    ["removed drops", { kind: "removed" as const, id: "a" }, ["b"]],
    ["unknown removal is a no-op", { kind: "removed" as const, id: "nope" }, ["a", "b"]],
  ])("%s", (_name, ev, order) => {
    const prev = replaceSessions(emptySessions, [session("a", { createdAtMs: 1 }), session("b", { createdAtMs: 2 })]);
    expect(applySessionEvent(prev, ev).order).toEqual(order);
  });

  it("an identical update returns the same state", () => {
    const prev = replaceSessions(emptySessions, [session("a")]);
    expect(applySessionEvent(prev, { kind: "updated", session: session("a") })).toBe(prev);
  });

  it("linked pull requests compare by content", () => {
    const pr = (n: number) => ({ slug: "o/r", number: n, url: `https://github.com/o/r/pull/${String(n)}`, linkedAt: 1000 });
    const prev = replaceSessions(emptySessions, [session("a", { linkedPullRequests: [pr(5)] })]);
    expect(applySessionEvent(prev, { kind: "updated", session: session("a", { linkedPullRequests: [pr(5)] }) })).toBe(prev);
    const next = applySessionEvent(prev, { kind: "updated", session: session("a", { linkedPullRequests: [pr(5), pr(6)] }) });
    expect(next).not.toBe(prev);
    expect(next.byId.a?.linkedPullRequests.map((l) => l.number)).toEqual([5, 6]);
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
    const prev = replaceSessions(emptySessions, [session("a", { usage: [bucket(1)] })]);
    expect(applySessionEvent(prev, { kind: "updated", session: session("a", { usage: [bucket(1)] }) })).toBe(prev);
    const next = applySessionEvent(prev, { kind: "updated", session: session("a", { usage: [bucket(2)] }) });
    expect(next.byId.a?.usage[0]?.requests).toBe(2);
    expect(applySessionEvent(prev, { kind: "retiredUsage", buckets: [bucket(1)] })).toBe(prev);

    const retired = [bucket(5)];
    expect(applyRetiredUsage([], { kind: "snapshot", sessions: [], retiredUsage: retired })).toBe(retired);
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
    const withRun = replaceSessions(emptySessions, [session("a", { agentRuns: [run("open", 1)] })]);
    expect(applySessionEvent(withRun, { kind: "updated", session: session("a", { agentRuns: [run("open", 1)] }) })).toBe(withRun);
    expect(applySessionEvent(withRun, { kind: "updated", session: session("a", { agentRuns: [run("closed", 1)] }) }).byId.a?.agentRuns[0]?.status).toBe("closed");
    expect(applySessionEvent(withRun, { kind: "updated", session: session("a", { agentRuns: [run("open", 2)] }) })).not.toBe(withRun);
  });

  it("attentionIds counts a stopped session's persisted attention, not an interrupted one", () => {
    const d = replaceSessions(emptySessions, [
      session("a", { status: "attention" }),
      session("b", { status: "attention", statusReason: "question: Which color do you prefer?", state: "disconnected" }),
      session("c"),
      session("d", { status: "error", statusReason: "interrupted", state: "disconnected" }),
      session("e", { status: "attention", statusReason: "finished", state: "disconnected", archivedAtMs: 7 }),
      session("f", { status: "attention", statusReason: "finished", state: "disconnected", snoozedUntilMs: 9 }),
      session("g", { status: "attention", statusReason: "snooze ended", state: "disconnected" }),
    ]);
    // e waits (a finished turn) but is archived, f is snoozed: not counted. g woke: counted.
    expect(attentionIds(d)).toEqual(["a", "b", "g"]);
  });

  it("start page counts and thread list: waiting first, then running (starting included); a stopped busy never", () => {
    const d = replaceSessions(emptySessions, [
      session("busy1", { status: "busy", createdAtMs: 1 }),
      session("idle", { createdAtMs: 2 }),
      session("wait1", { status: "attention", createdAtMs: 3 }),
      session("gone", { status: "busy", state: "disconnected", createdAtMs: 4 }),
      session("start", { status: "idle", state: "starting", createdAtMs: 5 }),
      session("wait2", { status: "attention", state: "closing", createdAtMs: 6 }),
      session("stopped", { status: "idle", state: "disconnected", createdAtMs: 7 }),
    ]);
    expect(runningCount(d)).toBe(2);
    expect(activeThreadIds(d)).toEqual(["wait1", "wait2", "busy1", "start"]);
    expect(activeThreadIds(emptySessions)).toEqual([]);
  });
});

describe("deriveContext for a session", () => {
  const repos = replaceRepos([
    {
      id: "r1",
      path: "/src/app",
      name: "app",
      defaultBranch: "main",
      githubSlug: "",
      remotes: [],
      git: true,
      worktrees: [{ repoId: "r1", path: "/src/app", branch: "main", head: "", detached: false, isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null } }],
    },
  ]);
  it("carries the session and its worktree; no terminal (a thread has none)", () => {
    const sessions = replaceSessions(emptySessions, [session("s1")]);
    expect(deriveContext({ kind: "session", id: "s1" }, repos, sessions)).toEqual({
      activeSessionId: "s1",
      activeTerminalId: "",
      activeRepoId: "r1",
      activeWorktreePath: "/src/app",
      activeView: "session",
      activeWorkspaceId: "",
    });
  });
  it("a workspace thread carries its workspace (session.run-in's availability)", () => {
    const sessions = replaceSessions(emptySessions, [session("s1", { workspaceId: "w-1" })]);
    expect(deriveContext({ kind: "session", id: "s1" }, repos, sessions).activeWorkspaceId).toBe("w-1");
    expect(deriveContext({ kind: "compose", repoId: "r1", workspaceId: "w-2" }, repos, sessions).activeWorkspaceId).toBe("w-2");
  });
  it("a thread without a project: no repo or worktree (home is none), so project commands and plain session.new are not offered", () => {
    const sessions = replaceSessions(emptySessions, [session("s1", { repoId: "", workspaceId: "", worktreePath: "/Users/dev" })]);
    expect(deriveContext({ kind: "session", id: "s1" }, repos, sessions)).toMatchObject({ activeSessionId: "s1", activeRepoId: "", activeWorktreePath: "", activeView: "session" });
  });
  it("an older thread without a repo id inside a project keeps its place", () => {
    const sessions = replaceSessions(emptySessions, [session("s1", { repoId: "", workspaceId: "", worktreePath: "/src/app/docs" })]);
    expect(deriveContext({ kind: "session", id: "s1" }, repos, sessions)).toMatchObject({ activeRepoId: "r1", activeWorktreePath: "/src/app" });
  });
  it("a composer without a project: the compose view alone", () => {
    expect(deriveContext({ kind: "compose", repoId: "", noProject: true }, repos)).toEqual({ ...emptyContext, activeView: "compose" });
  });
  it("an unknown session keeps the id", () => {
    const sessions = replaceSessions(emptySessions, [session("s1", { state: "disconnected" })]);
    expect(deriveContext({ kind: "session", id: "gone" }, emptyRepos, sessions)).toMatchObject({ activeSessionId: "gone", activeView: "session" });
  });
});

describe("event dispatch", () => {
  beforeEach(() => {
    useSessionsStore.setState({ ...emptySessions, availability: "unknown", error: null });
    useTerminalsStore.setState({ ...emptyTerminals });
    useReposStore.setState({ ...emptyRepos });
    useUiStore.setState({ selection: { kind: "none" } });
  });

  it("routes each source to its slice", () => {
    dispatchEvent({ source: "session", event: { kind: "snapshot", sessions: [session("s1")], retiredUsage: [] } });
    dispatchEvent({ source: "terminal", event: { kind: "updated", terminal: term("t1") } });
    dispatchEvent({ source: "repo", event: { kind: "snapshot", repos: [] } });
    dispatchEvent({ source: "gh", event: { kind: "viewer" } });
    dispatchEvent({ source: "ui", event: { kind: "focusSession", sessionId: "s1" } });
    expect(useSessionsStore.getState()).toMatchObject({ order: ["s1"], availability: "available" });
    expect(useTerminalsStore.getState().order).toEqual(["t1"]);
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
  });

  it("a session snapshot bumps the epoch; updates and removals do not", () => {
    const start = useSessionsStore.getState().epoch;
    dispatchEvent({ source: "session", event: { kind: "snapshot", sessions: [session("s1")], retiredUsage: [] } });
    expect(useSessionsStore.getState().epoch).toBe(start + 1);
    dispatchEvent({ source: "session", event: { kind: "updated", session: session("s2") } });
    dispatchEvent({ source: "session", event: { kind: "removed", id: "s1" } });
    expect(useSessionsStore.getState().epoch).toBe(start + 1);
    dispatchEvent({ source: "session", event: { kind: "snapshot", sessions: [], retiredUsage: [] } });
    expect(useSessionsStore.getState().epoch).toBe(start + 2);
  });

  it("a FocusTerminal that races its shell reveals the shell once it arrives", () => {
    useSessionsStore.setState({ ...replaceSessions(emptySessions, [session("s1")]), availability: "available" });
    useTerminalsStore.setState({ ...emptyTerminals, loaded: true });
    applyIntent({ kind: "focusTerminal", terminalId: "t1" });
    expect(useUiStore.getState().selection).toEqual({ kind: "none" });
    dispatchEvent({ source: "terminal", event: { kind: "updated", terminal: term("t1", { session: "s1", kind: "shell" }) } });
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
  });
});

describe("session presentation", () => {
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
