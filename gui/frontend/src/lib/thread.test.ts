import { describe, expect, it } from "vitest";
import type { ThreadStateView, ThreadStatusView } from "@/api/threads";
import {
  attentionTier,
  badgeLabels,
  isThreadGroup,
  restartCutsOff,
  threadBadge,
  shortAge,
  statusDetail,
  statusKind,
  statusNote,
  threadGroup,
  type CutOff,
  type ThreadBadge,
  type StatusKind,
  type ThreadGroup,
} from "./thread";

describe("threadGroup (the sidebar group of an unpinned thread)", () => {
  it.each<[ThreadStateView, ThreadStatusView, string, ThreadGroup]>([
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
    // A start that keeps a saved status (an MCP check; a message makes the daemon say busy): attention and error win.
    ["starting", "attention", "finished", "done"],
    ["starting", "error", "interrupted", "error"],
    ["closing", "busy", "working: Say hi", "idle"],
    ["closing", "attention", "finished", "done"],
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
  it.each<[ThreadStatusView, string, StatusKind, string]>([
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
    ["attention", "snooze ended", "snoozeEnded", ""],
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

// The badge never tells whether Claude's process runs: a stopped thread reads as its
// status (idle when that would be idle, unknown or a stale busy), starting reads as busy.
describe("threadBadge", () => {
  it.each<[ThreadStateView, ThreadStatusView, ThreadBadge]>([
    ["connected", "busy", "busy"],
    ["connected", "idle", "idle"],
    ["connected", "attention", "attention"],
    ["connected", "error", "error"],
    ["connected", "unknown", "unknown"],
    ["unknown", "busy", "busy"],
    ["unknown", "unknown", "unknown"],
    ["starting", "idle", "busy"],
    ["starting", "unknown", "busy"],
    ["starting", "attention", "attention"],
    ["starting", "error", "error"],
    ["closing", "busy", "idle"],
    ["closing", "idle", "idle"],
    ["closing", "attention", "attention"],
    ["disconnected", "idle", "idle"],
    ["disconnected", "unknown", "idle"],
    ["disconnected", "busy", "idle"],
    ["disconnected", "attention", "attention"],
    ["disconnected", "error", "error"],
  ])("%s %s", (state, status, want) => {
    expect(threadBadge({ state, status })).toBe(want);
  });
  it("is unknown without a session", () => {
    expect(threadBadge(undefined)).toBe("unknown");
  });
  it("has no lifecycle badges", () => {
    expect(Object.keys(badgeLabels).sort()).toEqual(["attention", "busy", "error", "idle", "unknown"]);
  });
});

// The daemon's command.ActiveThread: what a restart cuts off.
describe("restartCutsOff", () => {
  it.each<[ThreadStateView, ThreadStatusView, string, CutOff | null]>([
    ["starting", "idle", "", "working"],
    ["starting", "attention", "finished", "working"],
    ["connected", "busy", "working", "working"],
    ["connected", "attention", "permission: Bash git push", "waiting"],
    ["connected", "attention", "question: Which one?", "waiting"],
    ["connected", "attention", "finished", null],
    ["connected", "attention", "error: overloaded", null],
    ["connected", "idle", "at prompt", null],
    ["closing", "busy", "working", null],
    ["disconnected", "busy", "", null],
    ["disconnected", "attention", "question: Which one?", null],
    ["unknown", "busy", "", null],
  ])("%s %s %j", (state, status, statusReason, want) => {
    expect(restartCutsOff({ state, status, statusReason, backgroundAgentsRunning: 0, backgroundShellsRunning: 0, backgroundWakePending: false })).toBe(want);
  });

  // Background work counts like the daemon's archiveInterrupts, after mid-turn, only with a process.
  it.each<[ThreadStateView, ThreadStatusView, number, number, boolean, CutOff | null]>([
    ["connected", "idle", 1, 0, false, "background"],
    ["connected", "attention", 0, 2, false, "background"],
    ["connected", "idle", 0, 0, true, "reporting"],
    ["connected", "busy", 1, 1, true, "working"],
    ["disconnected", "idle", 1, 1, true, null],
    ["closing", "idle", 1, 0, false, null],
  ])("%s %s agents %i shells %i wake %s", (state, status, agents, shells, wake, want) => {
    expect(restartCutsOff({ state, status, statusReason: "", backgroundAgentsRunning: agents, backgroundShellsRunning: shells, backgroundWakePending: wake })).toBe(want);
  });
});

describe("statusNote / attentionTier", () => {
  it.each<[ThreadStatusView, string, string, string]>([
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
    ["attention", "snooze ended", "", "prompt"],
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
