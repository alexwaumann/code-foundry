import { describe, expect, it } from "vitest";
import type { SessionStatusView } from "@/api/session";
import { statusDetail, statusKind, type StatusKind } from "./session";

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
