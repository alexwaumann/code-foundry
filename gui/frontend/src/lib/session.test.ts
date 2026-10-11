import { describe, expect, it } from "vitest";
import type { SessionStateView, SessionStatusView } from "@/api/session";
import {
  attentionTier,
  disconnectCause,
  disconnectedPill,
  isThreadGroup,
  modelEffortLabel,
  sessionLocation,
  statusDetail,
  statusKind,
  statusNote,
  threadGroup,
  type LocationRepos,
  type PillKind,
  type StatusKind,
  type ThreadGroup,
} from "./session";

describe("threadGroup (the sidebar group of an unpinned thread)", () => {
  it.each<[SessionStateView, SessionStatusView, string, ThreadGroup]>([
    ["connected", "attention", "permission: Do you want to proceed?", "prompt"],
    ["connected", "attention", "question: Which?", "prompt"],
    ["connected", "attention", "error: overloaded", "prompt"],
    ["disconnected", "attention", "question: Which?", "prompt"],
    ["connected", "attention", "finished", "done"],
    ["disconnected", "attention", "finished", "done"],
    ["disconnected", "error", "interrupted", "error"],
    ["disconnected", "error", "daemon restarted", "error"],
    ["connected", "busy", "working: Say hi", "working"],
    ["unknown", "busy", "running Bash", "working"],
    ["starting", "unknown", "", "working"],
    ["starting", "idle", "", "working"],
    ["closing", "busy", "working: Say hi", "idle"],
    ["closing", "idle", "", "idle"],
    ["disconnected", "busy", "", "idle"],
    ["disconnected", "idle", "", "idle"],
    ["connected", "idle", "at prompt", "idle"],
    ["connected", "unknown", "", "idle"],
    ["unknown", "unknown", "", "idle"],
  ])("%s %s %j", (state, status, statusReason, group) => {
    expect(threadGroup({ state, status, statusReason })).toBe(group);
    expect(isThreadGroup(group)).toBe(true);
  });
  it("isThreadGroup rejects anything else", () => {
    expect(isThreadGroup("")).toBe(false);
    expect(isThreadGroup("threads")).toBe(false);
  });
});

// Reasons as the daemon reported them: replays of the internal/claudestatus fixtures
// (Claude Code 2.1.294; CLAUDESTATUS_TRACE=<fixture>, noscreen for "waiting for approval")
// and the session store's "interrupted".
describe("statusKind / statusDetail", () => {
  it.each<[SessionStatusView, string, StatusKind, string]>([
    ["attention", "finished", "done", ""],
    ["attention", "permission: Do you want to proceed?", "permission", "Do you want to proceed?"],
    ["attention", "waiting for approval: Bash", "permission", "Bash"],
    ["attention", "question: Which color do you prefer?", "question", "Which color do you prefer?"],
    ["attention", "waiting for input", "question", ""],
    ["attention", "plan: Claude has written up a plan and is ready to execute. Would you like to proceed?", "plan", "Claude has written up a plan and is ready to execute. Would you like to proceed?"],
    ["attention", "error: model_not_found", "error", "model_not_found"],
    ["attention", "trust: trust this folder?", "trust", "trust this folder?"],
    ["attention", "notification: Claude needs your permission", "notification", "Claude needs your permission"],
    ["attention", "bell", "notification", ""],
    ["attention", "blocked: permission", "other", "permission"],
    ["error", "interrupted", "interrupted", ""],
    ["error", "", "error", ""],
    ["busy", "working: Say hi", "other", "Say hi"],
    ["busy", "running Bash", "other", ""],
    ["idle", "at prompt", "other", ""],
    ["unknown", "no prompt visible", "other", ""],
    ["unknown", "", "other", ""],
  ])("%s %j", (status, statusReason, kind, detail) => {
    expect(statusKind({ status, statusReason })).toBe(kind);
    expect(statusDetail({ statusReason })).toBe(detail);
  });
});

describe("disconnectedPill", () => {
  it.each<[SessionStatusView, string, PillKind, string]>([
    ["error", "interrupted", "interrupted", "Interrupted"],
    ["error", "", "interrupted", "Interrupted"],
    ["attention", "permission: Do you want to proceed?", "attention", "Was waiting on you"],
    ["attention", "finished", "attention", "Was waiting on you"],
    ["idle", "finished", "idle", "Finished"],
    ["idle", "at prompt", "idle", "At prompt"],
    ["idle", "", "idle", "At prompt"],
    ["busy", "working", "none", ""],
    ["unknown", "", "none", ""],
  ])("%s %j", (status, statusReason, kind, label) => {
    expect(disconnectedPill({ status, statusReason })).toEqual({ kind, label });
  });
});

describe("disconnectCause", () => {
  it.each([
    [{ disconnectReason: "closed", exitCode: 0, lastError: "" }, "closed"],
    [{ disconnectReason: "crashed", exitCode: 1, lastError: "" }, "crashed (exit code 1)"],
    [{ disconnectReason: "exited", exitCode: 0, lastError: "" }, "Claude exited"],
    [{ disconnectReason: "exited", exitCode: 2, lastError: "" }, "Claude exited with code 2"],
    [{ disconnectReason: "daemon stopped", exitCode: 0, lastError: "" }, "daemon stopped"],
    [{ disconnectReason: "", exitCode: 0, lastError: "" }, "not running"],
    [{ disconnectReason: "", exitCode: 0, lastError: "Worktree is missing" }, "stopped: Worktree is missing"],
  ])("%j", (s, want) => {
    expect(disconnectCause(s)).toBe(want);
  });
});

describe("modelEffortLabel", () => {
  const models = [
    { value: "opus", label: "Opus" },
    { value: "claude-opus-4-8", label: "Opus 4.8" },
    { value: "haiku", label: "Haiku" },
  ];
  it.each([
    ["opus", "high", "Opus (high)"],
    ["claude-opus-4-8", "max", "Opus 4.8 (max)"],
    ["haiku", "", "Haiku"],
    ["claude-opus-5-5", "max", "claude-opus-5-5 (max)"],
    ["", "high", ""],
    ["", "", ""],
  ])("%j %j", (model, effort, want) => {
    expect(modelEffortLabel({ model, effort }, models)).toBe(want);
  });
});

describe("sessionLocation", () => {
  const repos: LocationRepos = {
    order: ["cf", "notes"],
    byId: {
      cf: {
        name: "code-foundry",
        git: true,
        worktrees: [
          { path: "/u/cf", branch: "main", head: "3c3c4651aa", detached: false },
          { path: "/u/cf.worktrees/fix", branch: "fix/resize", head: "1f2e3d4c55", detached: false },
          { path: "/u/cf.worktrees/bisect", branch: "", head: "9a8b7c6d44", detached: true },
        ],
      },
      notes: { name: "notes", git: false, worktrees: [{ path: "/u/notes", branch: "", head: "", detached: false }] },
    },
  };
  it.each([
    ["git, on a branch", "/u/cf.worktrees/fix", { project: "code-foundry", branch: "fix/resize" }],
    ["git, main worktree", "/u/cf", { project: "code-foundry", branch: "main" }],
    ["git, detached", "/u/cf.worktrees/bisect", { project: "code-foundry", branch: "9a8b7c6" }],
    ["git, a subdirectory of a worktree", "/u/cf/gui", { project: "code-foundry", branch: "main" }],
    ["no git", "/u/notes", { project: "notes", branch: "" }],
    ["unplaceable", "/tmp/elsewhere/scratch", { project: "scratch", branch: "" }],
  ])("%s", (_, worktreePath, want) => {
    expect(sessionLocation({ worktreePath }, repos)).toEqual(want);
  });
});

describe("statusNote / attentionTier", () => {
  it.each<[SessionStatusView, string, string, string]>([
    ["attention", "permission: Do you want to proceed?", "Do you want to proceed?", "prompt"],
    ["attention", "waiting for approval: Bash", "Bash", "prompt"],
    ["attention", "question: Which?", "Which?", "prompt"],
    ["attention", "waiting for input", "", "prompt"],
    ["attention", "plan: ready", "ready", "prompt"],
    ["attention", "trust: folder", "folder", "prompt"],
    ["attention", "bell", "", "prompt"],
    ["attention", "error: overloaded", "overloaded", "prompt"],
    ["attention", "something new", "something new", "prompt"],
    ["attention", "finished", "", "done"],
    ["error", "interrupted", "", ""],
    ["error", "daemon restarted", "daemon restarted", ""],
    ["busy", "working: Say hi", "Say hi", ""],
    ["idle", "at prompt", "at prompt", ""],
    ["unknown", "", "", ""],
  ])("%s %j", (status, statusReason, note, tier) => {
    expect(statusNote({ statusReason })).toBe(note);
    expect(attentionTier({ status, statusReason })).toBe(tier);
  });
});
