import { describe, expect, it } from "vitest";
import {
  BellRing,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  ClipboardCheck,
  Flag,
  ShieldQuestionMark,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import type { ThreadFlagView, ThreadStateView, ThreadStatusView } from "@/api/threads";
import { statusLine, type StatusLineKind } from "./statusLine";
import { rowToneClasses, statusBadge, statusDetail, statusRegistry, statusTimeAt, type RowTone, type TimeMode } from "./statusRegistry";

function flag(level: ThreadFlagView["level"], reason: string, pluginName = "Lint"): ThreadFlagView {
  return { plugin: "lint", pluginName, level, reason, setAtMs: null, untilSeen: false };
}

interface Fixture {
  state: ThreadStateView;
  status: ThreadStatusView;
  statusReason: string;
  flags?: ThreadFlagView[];
  transcriptMissing?: true;
  busyTool?: string;
}

function thread(f: Fixture) {
  return { statusChangedAtMs: 1_000, lastActivityAtMs: 2_000, flags: [], ...f };
}

describe("statusRegistry", () => {
  it.each<[StatusLineKind, LucideIcon | null, string, RowTone, TimeMode]>([
    ["input", ShieldQuestionMark, "Permission", "warning", "none"],
    ["question", CircleQuestionMark, "Question", "warning", "none"],
    ["plan", ClipboardCheck, "Plan", "warning", "none"],
    ["flagAttention", Flag, "", "warning", "none"],
    ["flagError", Flag, "", "error", "none"],
    ["snoozeEnded", BellRing, "Woke", "warning", "none"],
    ["error", CircleAlert, "Error", "error", "none"],
    ["interrupted", Unplug, "Interrupted", "error", "none"],
    ["crashed", TriangleAlert, "Crashed", "error", "none"],
    ["transcriptDeleted", CircleAlert, "Error", "error", "none"],
    ["finished", CircleCheck, "Done", "success", "none"],
    ["working", CircleDashed, "Working", "info", "status"],
    ["waiting", CircleDashed, "Waiting", "muted", "status"],
    ["place", null, "", "muted", "activity"],
  ])("%s", (kind, icon, word, tone, timeMode) => {
    expect(statusRegistry[kind]).toEqual({ icon, word, tone, timeMode });
  });

  it("maps each tone to its cf text class", () => {
    expect(rowToneClasses).toEqual({
      warning: "text-cf-warning-text",
      error: "text-cf-error-text",
      success: "text-cf-success-text",
      info: "text-cf-info-text",
      muted: "text-cf-sidebar-muted-foreground",
    });
  });
});

describe("statusBadge / statusDetail / statusTimeAt", () => {
  it.each<[string, Fixture, StatusLineKind, string, string, number | null]>([
    ["permission", { state: "connected", status: "attention", statusReason: "permission: Bash zig build test" }, "input", "Permission", "Bash zig build test", null],
    ["permission without a screen", { state: "connected", status: "attention", statusReason: "waiting for approval: Bash" }, "input", "Permission", "Bash", null],
    ["bell", { state: "connected", status: "attention", statusReason: "bell" }, "input", "Permission", "", null],
    ["question", { state: "connected", status: "attention", statusReason: "question: Which colour?" }, "question", "Question", "Which colour?", null],
    ["question without a screen", { state: "connected", status: "attention", statusReason: "waiting for input" }, "question", "Question", "", null],
    ["plan", { state: "connected", status: "attention", statusReason: "plan: Claude has written up a plan" }, "plan", "Plan", "ready for review", null],
    ["attention flag", { state: "connected", status: "idle", statusReason: "", flags: [flag("attention", "3 warnings")] }, "flagAttention", "Lint", "3 warnings", null],
    ["error flag", { state: "connected", status: "idle", statusReason: "", flags: [flag("error", "tests red", "Test Watcher")] }, "flagError", "Test Watcher", "tests red", null],
    ["snooze ended", { state: "disconnected", status: "attention", statusReason: "snooze ended" }, "snoozeEnded", "Woke", "snooze ended", null],
    ["Claude error", { state: "connected", status: "attention", statusReason: "error: model_not_found" }, "error", "Error", "model_not_found", null],
    ["error status", { state: "disconnected", status: "error", statusReason: "daemon restarted" }, "error", "Error", "daemon restarted", null],
    ["interrupted", { state: "disconnected", status: "error", statusReason: "interrupted" }, "interrupted", "Interrupted", "resend to continue", null],
    ["crashed", { state: "disconnected", status: "error", statusReason: "crashed" }, "crashed", "Crashed", "resend to continue", null],
    ["transcript deleted", { state: "disconnected", status: "idle", statusReason: "", transcriptMissing: true }, "transcriptDeleted", "Error", "transcript deleted", null],
    ["finished", { state: "connected", status: "attention", statusReason: "finished" }, "finished", "Done", "", null],
    ["working on a tool", { state: "connected", status: "busy", statusReason: "working: Say hi", busyTool: "Bash make check" }, "working", "Working", "Bash make check", 1_000],
    ["working, no tool", { state: "connected", status: "busy", statusReason: "working: Say hi" }, "working", "Working", "", 1_000],
    ["compacting", { state: "connected", status: "busy", statusReason: "compacting", busyTool: "Bash" }, "working", "Working", "compacting", 1_000],
    ["starting", { state: "starting", status: "unknown", statusReason: "" }, "working", "Working", "", 1_000],
    // No detail: line 3 shows the branch, the badge the live count (lib/liveCount).
    ["waiting on two", { state: "connected", status: "idle", statusReason: "waiting on 2 child threads" }, "waiting", "Waiting", "", 1_000],
    ["waiting on one", { state: "connected", status: "idle", statusReason: "waiting on 1 child thread" }, "waiting", "Waiting", "", 1_000],
    ["waiting on children and a subagent", { state: "connected", status: "idle", statusReason: "waiting on 2 child threads and 1 subagent" }, "waiting", "Waiting", "", 1_000],
    ["waiting on a shell", { state: "connected", status: "idle", statusReason: "waiting on 1 shell" }, "waiting", "Waiting", "", 1_000],
    ["waiting on a wake", { state: "disconnected", status: "idle", statusReason: "waiting" }, "waiting", "Waiting", "", 1_000],
    ["idle", { state: "connected", status: "idle", statusReason: "at prompt" }, "place", "", "", 2_000],
    ["unknown", { state: "unknown", status: "unknown", statusReason: "" }, "place", "", "", 2_000],
  ])("%s", (_name, f, kind, word, detail, at) => {
    const t = thread(f);
    const line = statusLine(t);
    expect(line.kind).toBe(kind);
    const badge = statusBadge(line);
    expect(badge.word).toBe(word);
    expect(badge.toneClass).toBe(rowToneClasses[statusRegistry[kind].tone]);
    expect(statusDetail(line, t)).toBe(detail);
    expect(statusTimeAt(line, t)).toBe(at);
  });

  it("has no detail or time without the thread", () => {
    expect(statusDetail({ kind: "working", detail: "", at: null }, undefined)).toBe("");
    expect(statusDetail({ kind: "waiting", detail: "", at: null }, undefined)).toBe("");
    expect(statusTimeAt({ kind: "place", detail: "", at: null }, undefined)).toBeNull();
  });

  it("has no time when the thread's is unknown", () => {
    const line = statusLine(thread({ state: "connected", status: "busy", statusReason: "working" }));
    expect(statusTimeAt(line, { statusChangedAtMs: null, lastActivityAtMs: 5 })).toBeNull();
  });
});
