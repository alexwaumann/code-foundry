import { beforeEach, describe, expect, it } from "vitest";
import type { SessionView } from "@/api/session";
import type { TerminalView } from "@/api/terminal";
import { disconnectReason, formatAgo, sessionBadge } from "@/lib/session";
import { windowTitle } from "@/lib/title";
import { deriveContext } from "./context";
import { dispatchEvent } from "./events";
import { applyIntent } from "./intents";
import { emptyRepos, replaceRepos, useReposStore } from "./repos";
import { applySessionEvent, attentionIds, emptySessions, replaceSessions, sessionOfTerminal, useSessionsStore } from "./sessions";
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
    terminalId: `t-${id}`,
    state: "connected",
    status: "idle",
    createdAtMs: 10,
    lastActivityAtMs: null,
    exitCode: 0,
    disconnectReason: "",
    lastError: "",
    parentId: "",
    permissionMode: "auto",
    baseRef: "",
    createdWorktree: false,
    workspaceId: "",
    pendingWorktreePath: "",
    pinned: false,
    linkedPullRequests: [],
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
    ["snapshot replaces", { kind: "snapshot" as const, sessions: [session("z")] }, ["z"]],
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

  it("attentionIds ignores disconnected sessions", () => {
    const d = replaceSessions(emptySessions, [
      session("a", { status: "attention" }),
      session("b", { status: "attention", state: "disconnected", terminalId: "" }),
      session("c"),
    ]);
    expect(attentionIds(d)).toEqual(["a"]);
  });

  it("sessionOfTerminal matches labels.session, then terminal_id", () => {
    const d = replaceSessions(emptySessions, [session("a"), session("b", { terminalId: "tx" })]);
    expect(sessionOfTerminal(d, term("q", { session: "a" }))?.id).toBe("a");
    expect(sessionOfTerminal(d, term("tx"))?.id).toBe("b");
    expect(sessionOfTerminal(d, term("q", { session: "unknown" }))).toBeUndefined();
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
  it("carries session, its terminal, and its worktree", () => {
    const sessions = replaceSessions(emptySessions, [session("s1", { terminalId: "t9" })]);
    expect(deriveContext({ kind: "session", id: "s1" }, emptyTerminals, repos, sessions)).toEqual({
      activeSessionId: "s1",
      activeTerminalId: "t9",
      activeRepoId: "r1",
      activeWorktreePath: "/src/app",
      activeView: "session",
      activeWorkspaceId: "",
    });
  });
  it("a workspace thread carries its workspace (session.run-in's availability)", () => {
    const sessions = replaceSessions(emptySessions, [session("s1", { terminalId: "t9", workspaceId: "w-1" })]);
    expect(deriveContext({ kind: "session", id: "s1" }, emptyTerminals, repos, sessions).activeWorkspaceId).toBe("w-1");
    // Its terminal, selected directly, too.
    const terms = { byId: { t9: { id: "t9", argv: ["claude"], cwd: "/src/app", cols: 80, rows: 24, title: "", state: "running" as const, exitCode: 0, startedAtMs: 1, exitedAtMs: null, altScreen: false, labels: { session: "s1" } } }, order: ["t9"] };
    expect(deriveContext({ kind: "terminal", id: "t9" }, terms, repos, sessions).activeWorkspaceId).toBe("w-1");
    expect(deriveContext({ kind: "compose", repoId: "r1", workspaceId: "w-2" }, emptyTerminals, repos, sessions).activeWorkspaceId).toBe("w-2");
  });
  it("disconnected: no terminal; unknown session keeps the id", () => {
    const sessions = replaceSessions(emptySessions, [session("s1", { terminalId: "", state: "disconnected" })]);
    expect(deriveContext({ kind: "session", id: "s1" }, emptyTerminals, repos, sessions).activeTerminalId).toBe("");
    expect(deriveContext({ kind: "session", id: "gone" }, emptyTerminals, emptyRepos, sessions)).toMatchObject({ activeSessionId: "gone", activeView: "session" });
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
    dispatchEvent({ source: "session", event: { kind: "snapshot", sessions: [session("s1")] } });
    dispatchEvent({ source: "terminal", event: { kind: "updated", terminal: term("t1") } });
    dispatchEvent({ source: "repo", event: { kind: "snapshot", repos: [] } });
    dispatchEvent({ source: "gh", event: { kind: "viewer" } });
    dispatchEvent({ source: "ui", event: { kind: "focusSession", sessionId: "s1" } });
    expect(useSessionsStore.getState()).toMatchObject({ order: ["s1"], availability: "available" });
    expect(useTerminalsStore.getState().order).toEqual(["t1"]);
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
  });

  it("a terminal selection becomes its session once the session is known", () => {
    dispatchEvent({ source: "terminal", event: { kind: "updated", terminal: term("t1", { session: "s1" }) } });
    applyIntent({ kind: "focusTerminal", terminalId: "t1" });
    expect(useUiStore.getState().selection).toEqual({ kind: "terminal", id: "t1" });
    dispatchEvent({ source: "session", event: { kind: "updated", session: session("s1", { terminalId: "t1" }) } });
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
    // A later FocusTerminal on a session's terminal selects the session directly.
    useUiStore.setState({ selection: { kind: "none" } });
    applyIntent({ kind: "focusTerminal", terminalId: "t1" });
    expect(useUiStore.getState().selection).toEqual({ kind: "session", id: "s1" });
  });
});

describe("session presentation", () => {
  it.each([
    [{ state: "connected", status: "busy" }, "busy"],
    [{ state: "connected", status: "attention" }, "attention"],
    [{ state: "starting", status: "attention" }, "starting"],
    [{ state: "closing", status: "busy" }, "closing"],
    [{ state: "disconnected", status: "attention" }, "disconnected"],
    [{ state: "connected", status: "unknown" }, "unknown"],
  ] as const)("badge %#", (s, want) => {
    expect(sessionBadge(s)).toBe(want);
  });

  it.each([
    [{ disconnectReason: "closed", exitCode: 0, lastError: "" }, "Closed"],
    [{ disconnectReason: "exited", exitCode: 0, lastError: "" }, "Claude exited"],
    [{ disconnectReason: "exited", exitCode: 2, lastError: "" }, "Claude exited with code 2"],
    [{ disconnectReason: "crashed", exitCode: 139, lastError: "" }, "Crashed (exit code 139)"],
    [{ disconnectReason: "", exitCode: 0, lastError: "spawn failed" }, "Stopped: spawn failed"],
  ])("reason %#", (s, want) => {
    expect(disconnectReason(s)).toBe(want);
  });

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
