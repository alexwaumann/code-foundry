import { describe, expect, it } from "vitest";
import type { ThreadStateView, ThreadStatusView } from "@/api/threads";
import { showsPlace, statusLine, statusText, statusTones, tipStatusTone, type StatusLineKind, type TipStatusTone } from "./statusLine";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIN = 60_000;

describe("statusLine / statusText", () => {
  it.each<[string, ThreadStateView, ThreadStatusView, string, number | null, StatusLineKind, string]>([
    ["busy", "connected", "busy", "working: Say hi", null, "working", "Working"],
    ["permission dialog", "connected", "attention", "permission: Do you want to create hello.txt?", 1, "input", "Needs input · Do you want to create hello.txt?"],
    ["permission without a screen", "connected", "attention", "waiting for approval: Bash", 1, "input", "Needs input · Bash"],
    ["question", "connected", "attention", "question: Which color do you prefer?", 1, "question", "Asked a question"],
    ["question without a screen", "connected", "attention", "waiting for input", 1, "question", "Asked a question"],
    ["plan", "connected", "attention", "plan: Claude has written up a plan", 1, "plan", "Plan ready for review"],
    ["trust", "connected", "attention", "trust: Do you trust the files in this folder?", 1, "input", "Needs input · Do you trust the files in this folder?"],
    ["notification", "connected", "attention", "notification: Claude needs your permission", 1, "input", "Needs input · Claude needs your permission"],
    ["bell", "connected", "attention", "bell", 1, "input", "Needs input"],
    ["other dialog", "connected", "attention", "blocked: hook", 1, "input", "Needs input · hook"],
    ["unclassified attention", "connected", "attention", "something new", 1, "input", "Needs input · something new"],
    ["finished", "connected", "attention", "finished", NOW - 3 * MIN, "finished", "Finished 3 min ago"],
    ["finished just now", "connected", "attention", "finished", NOW - 10_000, "finished", "Finished just now"],
    ["finished, time unknown", "connected", "attention", "finished", null, "finished", "Finished"],
    ["Claude error", "connected", "attention", "error: model_not_found", 1, "error", "Error · model_not_found"],
    ["interrupted", "disconnected", "error", "interrupted", NOW - 60 * MIN, "interrupted", "Interrupted while working · 1 h ago"],
    ["interrupted, time unknown", "disconnected", "error", "interrupted", null, "interrupted", "Interrupted while working"],
    ["other error status", "disconnected", "error", "daemon restarted", 1, "error", "Error · daemon restarted"],
    ["snooze ended", "disconnected", "attention", "snooze ended", NOW - 2 * MIN, "snoozeEnded", "Snooze ended · 2 min ago"],
    ["snooze ended just now", "disconnected", "attention", "snooze ended", NOW - 5_000, "snoozeEnded", "Snooze ended · just now"],
    ["snooze ended, time unknown", "disconnected", "attention", "snooze ended", null, "snoozeEnded", "Snooze ended"],
    ["question after a restart", "disconnected", "attention", "question: Which density?", 1, "question", "Asked a question"],
    ["idle", "connected", "idle", "at prompt", 1, "place", ""],
    ["unknown", "unknown", "unknown", "", null, "place", ""],
    // Whether Claude runs never shows: stopped reads as its status, starting as working,
    // stopping as the place (or its attention).
    ["stopped at its prompt", "disconnected", "idle", "at prompt", 1, "place", ""],
    ["stopped, status unknown", "disconnected", "unknown", "", null, "place", ""],
    ["legacy busy, stopped", "disconnected", "busy", "working: x", 1, "place", ""],
    ["finished, stopped", "disconnected", "attention", "finished", NOW - 3 * MIN, "finished", "Finished 3 min ago"],
    ["starting", "starting", "unknown", "", null, "working", "Working"],
    ["starting with a saved finished turn (an MCP check)", "starting", "attention", "finished", NOW - 3 * MIN, "finished", "Finished 3 min ago"],
    ["closing", "closing", "busy", "working: x", null, "place", ""],
    ["closing a finished turn", "closing", "attention", "finished", NOW - 3 * MIN, "finished", "Finished 3 min ago"],
  ])("%s", (_name, state, status, statusReason, statusChangedAtMs, kind, text) => {
    const l = statusLine({ state, status, statusReason, statusChangedAtMs });
    expect(l.kind).toBe(kind);
    expect(statusText(l, NOW)).toBe(text);
  });

  it("is place for an unknown thread", () => {
    expect(statusLine(undefined)).toEqual({ kind: "place", detail: "", at: null });
  });

  it("carries the time only for finished, interrupted and snooze ended", () => {
    expect(statusLine({ state: "connected", status: "attention", statusReason: "finished", statusChangedAtMs: 5 }).at).toBe(5);
    expect(statusLine({ state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: 6 }).at).toBe(6);
    expect(statusLine({ state: "connected", status: "attention", statusReason: "question: x", statusChangedAtMs: 5 }).at).toBeNull();
    expect(statusLine({ state: "connected", status: "busy", statusReason: "", statusChangedAtMs: 5 }).at).toBeNull();
  });

  it.each<[StatusLineKind, boolean, string]>([
    ["place", true, "muted"],
    ["working", true, "sky"],
    ["input", false, "amber"],
    ["question", false, "amber"],
    ["plan", false, "amber"],
    ["finished", false, "emerald"],
    ["error", false, "red"],
    ["interrupted", false, "red"],
    ["snoozeEnded", false, "amber"],
  ])("%s: place %s, tone %s", (kind, place, tone) => {
    expect(showsPlace(kind)).toBe(place);
    expect(statusTones[kind]).toBe(tone);
  });
});

describe("tipStatusTone", () => {
  // The tooltip's status row: the full line-2 text, only when the thread needs the user or failed.
  it.each<[string, ThreadStateView, ThreadStatusView, string, number | null, TipStatusTone | null, string]>([
    ["permission dialog", "connected", "attention", "permission: Do you want to create hello.txt and then run the whole test suite?", 1, "amber", "Needs input · Do you want to create hello.txt and then run the whole test suite?"],
    ["permission without a screen", "connected", "attention", "waiting for approval: Bash", 1, "amber", "Needs input · Bash"],
    ["question", "connected", "attention", "question: Which color do you prefer?", 1, "amber", "Asked a question"],
    ["plan", "connected", "attention", "plan: Claude has written up a plan", 1, "amber", "Plan ready for review"],
    ["trust", "connected", "attention", "trust: Do you trust the files in this folder?", 1, "amber", "Needs input · Do you trust the files in this folder?"],
    ["bell", "connected", "attention", "bell", 1, "amber", "Needs input"],
    ["question after a restart", "disconnected", "attention", "question: Which density?", 1, "amber", "Asked a question"],
    ["Claude error", "connected", "attention", "error: rate_limit", 1, "red", "Error · rate_limit"],
    ["interrupted", "disconnected", "error", "interrupted", NOW - 60 * MIN, "red", "Interrupted while working · 1 h ago"],
    ["interrupted, time unknown", "disconnected", "error", "interrupted", null, "red", "Interrupted while working"],
    ["other error status", "disconnected", "error", "daemon restarted", 1, "red", "Error · daemon restarted"],
    ["snooze ended", "disconnected", "attention", "snooze ended", NOW - 2 * MIN, "amber", "Snooze ended · 2 min ago"],
    ["finished", "connected", "attention", "finished", NOW - 3 * MIN, null, "Finished 3 min ago"],
    ["busy", "connected", "busy", "working: Say hi", null, null, "Working"],
    ["idle", "connected", "idle", "at prompt", 1, null, ""],
    ["stopped at its prompt", "disconnected", "idle", "at prompt", 1, null, ""],
    ["unknown", "unknown", "unknown", "", null, null, ""],
    ["starting", "starting", "unknown", "", null, null, "Working"],
    ["closing", "closing", "busy", "working: x", null, null, ""],
  ])("%s", (_name, state, status, statusReason, statusChangedAtMs, tone, text) => {
    const l = statusLine({ state, status, statusReason, statusChangedAtMs });
    expect(tipStatusTone(l.kind)).toBe(tone);
    expect(statusText(l, NOW)).toBe(text);
  });
});
