import { describe, expect, it } from "vitest";
import type { SessionStateView, SessionStatusView } from "@/api/session";
import {
  attentionTier,
  disconnectCause,
  isThreadGroup,
  shortAge,
  statusDetail,
  statusKind,
  statusNote,
  threadGroup,
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

// Reasons as the daemon reported them: the stream's (permission, question, finished,
// error), the store's "interrupted", and the removed screen detector's (Claude Code
// 2.1.294 fixtures), which rows persisted before rendered-only threads still carry.
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

describe("shortAge (an archived row's age)", () => {
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);
  const MIN = 60_000;
  it.each<[string, number, string]>([
    ["just archived", 0, "0m"],
    ["59 s", 59_000, "0m"],
    ["1 min", MIN, "1m"],
    ["59 min 59 s", 60 * MIN - 1000, "59m"],
    ["1 h", 60 * MIN, "1h"],
    ["23 h 59 min", 24 * 60 * MIN - MIN, "23h"],
    ["1 d", 24 * 60 * MIN, "1d"],
    ["9 d 23 h", 10 * 24 * 60 * MIN - 60 * MIN, "9d"],
    ["400 d", 400 * 24 * 60 * MIN, "400d"],
    ["in the future (clock skew)", -5 * MIN, "0m"],
  ])("%s", (_name, age, want) => {
    expect(shortAge(now - age, now)).toBe(want);
  });
});
