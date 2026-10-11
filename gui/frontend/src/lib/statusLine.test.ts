import { describe, expect, it } from "vitest";
import type { SessionStateView, SessionStatusView } from "@/api/session";
import { showsPlace, statusLine, statusText, statusTones, type StatusLineKind } from "./statusLine";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIN = 60_000;

describe("statusLine / statusText", () => {
  it.each<[string, SessionStateView, SessionStatusView, string, number | null, StatusLineKind, string]>([
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
    ["question after a restart", "disconnected", "attention", "question: Which density?", 1, "question", "Asked a question"],
    ["idle", "connected", "idle", "at prompt", 1, "place", ""],
    ["unknown", "unknown", "unknown", "", null, "place", ""],
    ["plain disconnected", "disconnected", "idle", "at prompt", 1, "place", ""],
    ["legacy busy disconnected", "disconnected", "busy", "working: x", 1, "place", ""],
    ["starting", "starting", "unknown", "", null, "starting", "Starting"],
    ["closing", "closing", "busy", "working: x", null, "closing", "Closing"],
  ])("%s", (_name, state, status, statusReason, statusChangedAtMs, kind, text) => {
    const l = statusLine({ state, status, statusReason, statusChangedAtMs });
    expect(l.kind).toBe(kind);
    expect(statusText(l, NOW)).toBe(text);
  });

  it("is place for an unknown session", () => {
    expect(statusLine(undefined)).toEqual({ kind: "place", detail: "", at: null });
  });

  it("carries the time only for finished and interrupted", () => {
    expect(statusLine({ state: "connected", status: "attention", statusReason: "finished", statusChangedAtMs: 5 }).at).toBe(5);
    expect(statusLine({ state: "connected", status: "attention", statusReason: "question: x", statusChangedAtMs: 5 }).at).toBeNull();
    expect(statusLine({ state: "connected", status: "busy", statusReason: "", statusChangedAtMs: 5 }).at).toBeNull();
  });

  it.each<[StatusLineKind, boolean, string]>([
    ["place", true, "muted"],
    ["starting", true, "muted"],
    ["closing", true, "muted"],
    ["working", true, "sky"],
    ["input", false, "amber"],
    ["question", false, "amber"],
    ["plan", false, "amber"],
    ["finished", false, "emerald"],
    ["error", false, "red"],
    ["interrupted", false, "red"],
  ])("%s: place %s, tone %s", (kind, place, tone) => {
    expect(showsPlace(kind)).toBe(place);
    expect(statusTones[kind]).toBe(tone);
  });
});
