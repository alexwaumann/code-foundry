// Plugins' flags on threads (docs/notes/plugins-3-events-flags-env.md): the effective
// attention / error the sidebar sort, line 2, the window title and the dock read.
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { toThreadView, type ThreadFlagView, type ThreadStateView, type ThreadStatusView, type ThreadView } from "@/api/threads";
import { ThreadFlagLevel, ThreadSchema } from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { initialDockAlerts, stepDockAlerts } from "@/stores/dockAlerts";
import { attentionIds, emptyThreads, isAttention, isRunning, replaceThreads, sameThread } from "@/stores/threads";
import { statusLine, statusText, statusTones, tipStatusTone, type StatusLineKind } from "@/lib/statusLine";
import { threadGroup, topFlag, type ThreadGroup } from "@/lib/thread";

const flag = (level: ThreadFlagView["level"], reason: string, pluginName = "GitHub Actions"): ThreadFlagView => ({
  plugin: pluginName.toLowerCase().replace(/ /g, "-"),
  pluginName,
  level,
  reason,
  setAtMs: 1,
  untilSeen: false,
});
const att = flag("attention", "deploy needs approval");
const err = flag("error", "deploy failed");

type Row = Pick<ThreadView, "state" | "status" | "statusReason" | "statusChangedAtMs" | "flags">;
const row = (state: ThreadStateView, status: ThreadStatusView, statusReason: string, flags: ThreadFlagView[]): Row => ({
  state,
  status,
  statusReason,
  statusChangedAtMs: null,
  flags,
});

describe("threadGroup with flags", () => {
  it.each<[string, Row, ThreadGroup]>([
    ["idle + attention flag", row("connected", "idle", "at prompt", [att]), "prompt"],
    ["idle + error flag", row("disconnected", "idle", "", [err]), "error"],
    ["busy + attention flag leaves Working", row("connected", "busy", "working", [att]), "prompt"],
    ["busy + error flag", row("connected", "busy", "working", [err]), "error"],
    ["finished turn + attention flag", row("connected", "attention", "finished", [att]), "prompt"],
    ["finished turn + error flag", row("connected", "attention", "finished", [err]), "error"],
    ["a prompt wins over an error flag", row("connected", "attention", "permission: Bash", [err]), "prompt"],
    ["interrupted wins over an attention flag", row("disconnected", "error", "interrupted", [att]), "error"],
    ["the error flag of two", row("connected", "idle", "", [att, err]), "error"],
    ["no flags: as before", row("connected", "busy", "working", []), "working"],
  ])("%s", (_, r, group) => {
    expect(threadGroup(r)).toBe(group);
  });
});

describe("statusLine with flags", () => {
  it.each<[string, Row, StatusLineKind, string]>([
    ["attention flag", row("connected", "idle", "at prompt", [att]), "flagAttention", "GitHub Actions: deploy needs approval"],
    ["error flag", row("disconnected", "idle", "", [err]), "flagError", "GitHub Actions: deploy failed"],
    ["busy with a flag shows the flag", row("connected", "busy", "working", [att]), "flagAttention", "GitHub Actions: deploy needs approval"],
    ["a flag over a finished turn", row("connected", "attention", "finished", [att]), "flagAttention", "GitHub Actions: deploy needs approval"],
    ["the error flag of two", row("connected", "idle", "", [att, flag("error", "tests red", "Test Watcher")]), "flagError", "Test Watcher: tests red"],
    ["Claude's prompt over a flag", row("connected", "attention", "question: Which?", [err]), "question", "Asked a question"],
    ["Claude's error over a flag", row("connected", "attention", "error: overloaded", [att]), "error", "Error · overloaded"],
    ["interrupted over a flag", row("disconnected", "error", "interrupted", [err]), "interrupted", "Interrupted while working"],
  ])("%s", (_, r, kind, text) => {
    const l = statusLine(r);
    expect(l.kind).toBe(kind);
    expect(statusText(l, 0)).toBe(text);
  });
  it("colours and tooltips: amber attention, red error, both in the tooltip", () => {
    expect(statusTones.flagAttention).toBe("amber");
    expect(statusTones.flagError).toBe("red");
    expect(tipStatusTone("flagAttention")).toBe("amber");
    expect(tipStatusTone("flagError")).toBe("red");
  });
  it("topFlag: the first error, else the first flag", () => {
    expect(topFlag({ flags: [att, err] })).toBe(err);
    expect(topFlag({ flags: [att] })).toBe(att);
    expect(topFlag({ flags: [] })).toBeNull();
    expect(topFlag({})).toBeNull();
  });
});

function view(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return { ...toThreadView(create(ThreadSchema, { id })), state: "connected", status: "idle", statusReason: "at prompt", ...over };
}

describe("attention with flags", () => {
  it("a flagged thread needs attention and is not running", () => {
    expect(isAttention({ state: "connected", status: "idle", flags: [att] })).toBe(true);
    expect(isAttention({ state: "connected", status: "idle", flags: [err] })).toBe(true);
    expect(isAttention({ state: "connected", status: "idle", flags: [] })).toBe(false);
    expect(isRunning({ state: "connected", status: "busy", flags: [att] })).toBe(false);
    expect(isRunning({ state: "connected", status: "busy", flags: [] })).toBe(true);
  });
  it("attentionIds counts flagged threads, never archived or snoozed ones", () => {
    const data = replaceThreads(emptyThreads, [
      view("a", { flags: [att] }),
      view("b", { flags: [err], archivedAtMs: 1 }),
      view("c", { flags: [err], snoozedUntilMs: 2 }),
      view("d"),
    ]);
    expect(attentionIds(data)).toEqual(["a"]);
  });
  it("a new flag rings the dock like a prompt, within the shared cooldown", () => {
    const settings = { dockBadge: true, bounce: true, sound: false, soundVolume: 50, cooldownMs: 60_000 };
    const before = replaceThreads(emptyThreads, [view("a"), view("b")]);
    let s = stepDockAlerts(initialDockAlerts, { epoch: 1, attention: attentionIds(before), attended: false, nowMs: 0, settings }).state;
    const flagged = replaceThreads(before, [view("a", { flags: [att] }), view("b")]);
    let step = stepDockAlerts(s, { epoch: 1, attention: attentionIds(flagged), attended: false, nowMs: 1000, settings });
    expect(step.effects).toEqual([
      { kind: "badge", count: 1 },
      { kind: "alert", bounce: true, sound: false, volume: 0 },
    ]);
    s = step.state;
    const both = replaceThreads(flagged, [view("a", { flags: [att] }), view("b", { flags: [err] })]);
    step = stepDockAlerts(s, { epoch: 1, attention: attentionIds(both), attended: false, nowMs: 2000, settings });
    expect(step.effects).toEqual([{ kind: "badge", count: 2 }]); // inside the cooldown: no second alert
  });
  it("sameThread compares flags by value", () => {
    const a = view("a", { flags: [att] });
    expect(sameThread(a, view("a", { flags: [{ ...att }] }))).toBe(true);
    expect(sameThread(a, view("a", { flags: [{ ...att, reason: "other" }] }))).toBe(false);
    expect(sameThread(a, view("a"))).toBe(false);
  });
});

describe("toThreadView flags", () => {
  it("maps the daemon's flags and drops unknown levels", () => {
    const v = toThreadView(
      create(ThreadSchema, {
        id: "s",
        flags: [
          { plugin: "gh-actions", pluginDisplayName: "GitHub Actions", level: ThreadFlagLevel.ERROR, reason: "deploy failed", untilSeen: true },
          { plugin: "bare", level: ThreadFlagLevel.ATTENTION, reason: "x" },
          { plugin: "future", level: ThreadFlagLevel.UNSPECIFIED, reason: "?" },
        ],
      }),
    );
    expect(v.flags).toEqual([
      { plugin: "gh-actions", pluginName: "GitHub Actions", level: "error", reason: "deploy failed", setAtMs: null, untilSeen: true },
      { plugin: "bare", pluginName: "bare", level: "attention", reason: "x", setAtMs: null, untilSeen: false },
    ]);
  });
});
