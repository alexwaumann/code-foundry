import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { SettingsSnapshotView } from "@/api/settings";
import {
  alertSettings,
  initialDockAlerts,
  startDockAlerts,
  stepDockAlerts,
  type AlertSettings,
  type DockAlertsDeps,
  type DockAlertsInput,
  type DockAlertsState,
  type DockEffect,
} from "./dockAlerts";
import { applyThreadListEvent, attentionIds, emptyThreads, replaceThreads, useThreadsStore } from "./threads";
import { useSettingsStore } from "./settings";

const on: AlertSettings = { dockBadge: true, bounce: true, sound: false, soundVolume: 50, cooldownMs: 60_000 };

/** Runs evaluations in order from the initial state; returns each step's effects and the final state. */
function run(steps: (Partial<DockAlertsInput> & { attention: readonly string[] })[]): { effects: DockEffect[][]; state: DockAlertsState } {
  let state = initialDockAlerts;
  const effects: DockEffect[][] = [];
  for (const s of steps) {
    const r = stepDockAlerts(state, { epoch: 1, attended: false, nowMs: 0, settings: on, ...s });
    state = r.state;
    effects.push(r.effects);
  }
  return { effects, state };
}

const alerts = (effects: DockEffect[][]) => effects.map((e) => e.filter((x) => x.kind === "alert").length);
const badges = (effects: DockEffect[][]) => effects.map((e) => e.find((x) => x.kind === "badge")?.count ?? null);
const bounce: DockEffect = { kind: "alert", bounce: true, sound: false, volume: 0 };

describe("stepDockAlerts", () => {
  it("the first evaluation takes the baseline: a badge, no alert", () => {
    const { effects } = run([{ attention: ["a", "b"] }]);
    expect(effects).toEqual([[{ kind: "badge", count: 2 }]]);
  });

  it("a thread entering while unattended alerts once", () => {
    const { effects } = run([{ attention: [] }, { attention: ["a"], nowMs: 1000 }, { attention: ["a"], nowMs: 2000 }]);
    expect(effects[1]).toEqual([{ kind: "badge", count: 1 }, bounce]);
    expect(alerts(effects)).toEqual([0, 1, 0]);
  });

  it("a thread entering while attended does not alert; the badge still moves", () => {
    const { effects } = run([{ attention: [] }, { attention: ["a"], attended: true }]);
    expect(effects[1]).toEqual([{ kind: "badge", count: 1 }]);
  });

  it("a new epoch (reconnect, snapshot reload) re-takes the baseline", () => {
    const { effects } = run([{ attention: [] }, { attention: ["a", "b"], epoch: 2 }, { attention: ["a", "b", "c"], epoch: 2, nowMs: 5000 }]);
    expect(alerts(effects)).toEqual([0, 0, 1]);
    expect(badges(effects)).toEqual([0, 2, 3]);
  });

  it("leaving and entering again alerts again", () => {
    const { effects } = run([
      { attention: ["a"] },
      { attention: [], nowMs: 100_000 },
      { attention: ["a"], nowMs: 200_000 },
    ]);
    expect(alerts(effects)).toEqual([0, 0, 1]);
  });

  it("the cooldown drops triggers inside it and allows one at its end", () => {
    const { effects } = run([
      { attention: [] },
      { attention: ["a"], nowMs: 10_000 }, // fires
      { attention: ["a", "b"], nowMs: 30_000 }, // 20 s later: dropped
      { attention: ["a", "b"], nowMs: 50_000 }, // nothing entered: b was not queued
      { attention: ["a", "b", "c"], nowMs: 70_000 }, // exactly 60 s after the alert: fires
      { attention: ["a", "b", "c", "d"], nowMs: 100_000 }, // 30 s after that: dropped
    ]);
    expect(alerts(effects)).toEqual([0, 1, 0, 0, 1, 0]);
    expect(badges(effects)).toEqual([0, 1, 2, null, 3, 4]);
  });

  it("a dropped trigger does not extend the cooldown", () => {
    const { effects } = run([
      { attention: [] },
      { attention: ["a"], nowMs: 0 },
      { attention: ["a", "b"], nowMs: 59_000 },
      { attention: ["a", "b", "c"], nowMs: 60_000 },
    ]);
    expect(alerts(effects)).toEqual([0, 1, 0, 1]);
  });

  it("cooldown 0 alerts on every trigger", () => {
    const settings = { ...on, cooldownMs: 0 };
    const { effects } = run([
      { attention: [], settings },
      { attention: ["a"], nowMs: 1, settings },
      { attention: ["a", "b"], nowMs: 1, settings },
      { attention: ["a", "b", "c"], nowMs: 2, settings },
    ]);
    expect(alerts(effects)).toEqual([0, 1, 1, 1]);
  });

  it("an alert carries both parts with the sound's volume", () => {
    const both = { ...on, sound: true, soundVolume: 15 };
    expect(run([{ attention: [], settings: both }, { attention: ["a"], settings: both }]).effects[1]).toContainEqual({ kind: "alert", bounce: true, sound: true, volume: 15 });
  });

  it("sound alone (bounce off) still alerts and consumes the cooldown", () => {
    const sound = { ...on, bounce: false, sound: true, soundVolume: 80 };
    const { effects, state } = run([
      { attention: [], settings: sound },
      { attention: ["a"], nowMs: 1000, settings: sound },
      { attention: ["a", "b"], nowMs: 2000, settings: sound }, // inside the cooldown: dropped
    ]);
    expect(effects[1]).toContainEqual({ kind: "alert", bounce: false, sound: true, volume: 80 });
    expect(alerts(effects)).toEqual([0, 1, 0]);
    expect(state.lastAlertAtMs).toBe(1000);
  });

  it("a sound at volume 0 counts as off", () => {
    const silent = { ...on, sound: true, soundVolume: 0 };
    expect(run([{ attention: [], settings: silent }, { attention: ["a"], settings: silent }]).effects[1]).toContainEqual({ kind: "alert", bounce: true, sound: false, volume: 0 });
    // Bounce off too: nothing fires and the cooldown is not consumed.
    const quiet = { ...silent, bounce: false };
    const { effects, state } = run([{ attention: [], settings: quiet }, { attention: ["a"], nowMs: 1000, settings: quiet }]);
    expect(alerts(effects)).toEqual([0, 0]);
    expect(state.lastAlertAtMs).toBeNull();
  });

  it("bounce and sound off: nothing fires and the cooldown is not consumed", () => {
    const quiet = { ...on, bounce: false, sound: false };
    const { effects, state } = run([
      { attention: [], settings: quiet },
      { attention: ["a"], nowMs: 1000, settings: quiet },
      { attention: ["a", "b"], nowMs: 2000 }, // turned back on: fires at once
    ]);
    expect(alerts(effects)).toEqual([0, 0, 1]);
    expect(state.lastAlertAtMs).toBe(2000);
  });

  it("the badge off sends 0 once and keeps the alerts", () => {
    const noBadge = { ...on, dockBadge: false };
    const { effects } = run([
      { attention: ["a"] },
      { attention: ["a"], settings: noBadge },
      { attention: ["a", "b"], settings: noBadge },
      { attention: ["a", "b"] },
    ]);
    expect(badges(effects)).toEqual([1, 0, null, 2]);
    expect(alerts(effects)).toEqual([0, 0, 1, 0]);
  });

  it("before settings arrive nothing is sent, but the baseline is kept", () => {
    const { effects } = run([
      { attention: ["a"], settings: null },
      { attention: ["a", "b"], settings: null },
      { attention: ["a", "b"] },
    ]);
    expect(effects).toEqual([[], [], [{ kind: "badge", count: 2 }]]);
  });

  it("the badge count passes through above 99 (the host shows 99+)", () => {
    const many = Array.from({ length: 120 }, (_, i) => `t${String(i)}`);
    expect(badges(run([{ attention: many }]).effects)).toEqual([120]);
  });
});

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    createdAtMs: 1,
    state: "connected",
    status: "idle",
    statusReason: "",
    archivedAtMs: null,
    snoozedUntilMs: null,
    pinned: false,
    linkedPullRequests: [],
    usage: [],
    agentRuns: [],
    ...over,
  } as unknown as ThreadView;
}

describe("attentionIds (the badge count)", () => {
  it("counts prompts and finished turns, pinned or not, never errors, archived, snoozed or working ones", () => {
    const data = replaceThreads(emptyThreads, [
      thread("prompt", { status: "attention", statusReason: "permission: Bash" }),
      thread("done", { status: "attention", statusReason: "finished" }),
      thread("error", { state: "disconnected", status: "error", statusReason: "interrupted" }),
      thread("pinned", { status: "attention", statusReason: "question: Which?", pinned: true }),
      thread("offline-prompt", { state: "disconnected", status: "attention", statusReason: "finished" }),
      thread("archived", { status: "attention", statusReason: "finished", archivedAtMs: 5 }),
      thread("snoozed", { state: "disconnected", status: "attention", statusReason: "finished", snoozedUntilMs: 9 }),
      thread("woken", { state: "disconnected", status: "attention", statusReason: "snooze ended" }),
      thread("busy", { status: "busy" }),
      thread("idle"),
      thread("starting", { state: "starting", status: "unknown" }),
      thread("waiting", { status: "idle", statusReason: "waiting on 2 child threads" }),
      thread("waiting-wake", { state: "disconnected", status: "idle", statusReason: "waiting" }),
    ]);
    expect(attentionIds(data).sort()).toEqual(["done", "offline-prompt", "pinned", "prompt", "woken"]);
  });

  // Threads another thread created (lib/inSidebar.ts): only the ones the sidebar shows count,
  // that is those whose creator was removed.
  const kid = (id: string, over: Partial<ThreadView>) => thread(id, { createdAtMs: 2, createdBy: "lead", status: "attention", statusReason: "finished", ...over });
  it.each<[string, Partial<ThreadView>, boolean]>([
    ["of a present creator", {}, false],
    ["of a present creator, asking for a permission", { statusReason: "permission: Bash" }, false],
    ["whose creator was removed", { createdBy: "gone" }, true],
    ["whose creator was removed, but archived", { createdBy: "gone", archivedAtMs: 5 }, false],
  ])("a child thread %s: counts %s", (_name, over, counts) => {
    const data = replaceThreads(emptyThreads, [thread("lead", { status: "attention", statusReason: "finished" }), kid("kid", over)]);
    expect(attentionIds(data)).toEqual(counts ? ["lead", "kid"] : ["lead"]);
  });
});

describe("alertSettings", () => {
  const snap = (values: Record<string, string>): SettingsSnapshotView => ({ values, path: "", revision: 1, loadError: "", issues: [], restartPending: [] });
  it.each<[Record<string, string>, AlertSettings]>([
    [
      { "notifications.dock_badge": "true", "notifications.bounce": "true", "notifications.sound": "false", "notifications.sound_volume": "50", "notifications.cooldown_seconds": "60" },
      { dockBadge: true, bounce: true, sound: false, soundVolume: 50, cooldownMs: 60_000 },
    ],
    [
      { "notifications.dock_badge": "false", "notifications.bounce": "false", "notifications.sound": "true", "notifications.sound_volume": "0", "notifications.cooldown_seconds": "0" },
      { dockBadge: false, bounce: false, sound: true, soundVolume: 0, cooldownMs: 0 },
    ],
    // An older daemon without the keys: the schema's defaults.
    [{}, { dockBadge: true, bounce: true, sound: false, soundVolume: 50, cooldownMs: 60_000 }],
    // Out of range or not a number (a hand-edited file): clamped, else the default.
    [{ "notifications.sound_volume": "250" }, { dockBadge: true, bounce: true, sound: false, soundVolume: 100, cooldownMs: 60_000 }],
    [{ "notifications.sound_volume": "-3" }, { dockBadge: true, bounce: true, sound: false, soundVolume: 0, cooldownMs: 60_000 }],
    [{ "notifications.sound_volume": "loud" }, { dockBadge: true, bounce: true, sound: false, soundVolume: 50, cooldownMs: 60_000 }],
  ])("%j", (values, want) => {
    expect(alertSettings(snap(values))).toEqual(want);
  });
  it("is null before the first snapshot", () => {
    expect(alertSettings(null)).toBeNull();
  });
});

describe("startDockAlerts", () => {
  let stop: () => void;
  let calls: string[];
  let attended: boolean;
  let now: number;
  const settings = (values: Record<string, string>) => {
    useSettingsStore.setState({ snapshot: { values, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
  };
  beforeEach(() => {
    calls = [];
    attended = false;
    now = 0;
    useThreadsStore.setState({ ...emptyThreads, epoch: 0 });
    useSettingsStore.setState({ snapshot: null });
    const deps: DockAlertsDeps = {
      setBadge: (n) => calls.push(`badge ${String(n)}`),
      bounce: () => calls.push("bounce"),
      playSound: (v) => calls.push(`sound ${String(v)}`),
      attended: () => attended,
      now: () => now,
    };
    stop = startDockAlerts(deps);
  });
  afterEach(() => {
    stop();
  });

  it("badges once settings arrive, re-baselines on the List, then bounces on a transition while unattended", () => {
    settings({ "notifications.cooldown_seconds": "60" });
    expect(calls).toEqual(["badge 0"]);
    // The (re)connect's List: two threads already waiting. A new epoch, so no alert.
    useThreadsStore.setState((s) => ({
      ...replaceThreads(s, [thread("a", { status: "attention", statusReason: "finished" }), thread("b", { status: "attention", statusReason: "finished" }), thread("c", { status: "busy" })]),
      epoch: s.epoch + 1,
    }));
    expect(calls).toEqual(["badge 0", "badge 2"]);
    now = 1000;
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("c", { status: "attention", statusReason: "finished" }) }));
    expect(calls).toEqual(["badge 0", "badge 2", "badge 3", "bounce"]);
  });

  it("does not bounce while attended, and turning the badge off clears it", () => {
    settings({ "notifications.sound": "true" });
    useThreadsStore.setState((s) => ({ ...replaceThreads(s, [thread("a", { status: "busy" })]), epoch: s.epoch + 1 }));
    attended = true;
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a", { status: "attention", statusReason: "permission: Bash" }) }));
    expect(calls).toEqual(["badge 0", "badge 1"]);
    settings({ "notifications.sound": "true", "notifications.dock_badge": "false" });
    expect(calls).toEqual(["badge 0", "badge 1", "badge 0"]);
  });

  it("an alert plays the sound with the bounce when both are on", () => {
    settings({ "notifications.sound": "true" });
    useThreadsStore.setState((s) => ({ ...replaceThreads(s, [thread("a", { status: "busy" })]), epoch: s.epoch + 1 }));
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a", { status: "attention", statusReason: "finished" }) }));
    expect(calls).toEqual(["badge 0", "badge 1", "bounce", "sound 50"]);
  });

  it("snoozing a waiting thread drops it from the badge; its wake badges and bounces", () => {
    settings({});
    useThreadsStore.setState((s) => ({ ...replaceThreads(s, [thread("a", { status: "attention", statusReason: "finished" })]), epoch: s.epoch + 1 }));
    expect(calls).toEqual(["badge 0", "badge 1"]);
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a", { state: "disconnected", status: "attention", statusReason: "finished", snoozedUntilMs: 5 }) }));
    expect(calls).toEqual(["badge 0", "badge 1", "badge 0"]);
    now = 120_000;
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a", { state: "disconnected", status: "attention", statusReason: "snooze ended", statusChangedAtMs: now }) }));
    expect(calls).toEqual(["badge 0", "badge 1", "badge 0", "badge 1", "bounce"]);
  });

  // A review loop's round (docs/notes/orch-waiting-status.md): the lead's turn ends while
  // its child works, the child settles, the wake's turn runs; only the last turn's end,
  // with nothing left to wait on, badges and bounces.
  it("a turn waiting on its child threads neither badges nor bounces", () => {
    settings({});
    useThreadsStore.setState((s) => ({ ...replaceThreads(s, [thread("lead", { status: "busy" })]), epoch: s.epoch + 1 }));
    now = 1000;
    for (const over of [
      { status: "idle", statusReason: "waiting on 1 child thread" },
      { status: "idle", statusReason: "waiting" },
      { status: "busy", statusReason: "working" },
      { status: "idle", statusReason: "waiting on 1 child thread" },
      { status: "busy", statusReason: "working" },
    ] as const) {
      useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("lead", over) }));
    }
    expect(calls).toEqual(["badge 0"]);
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("lead", { status: "attention", statusReason: "finished" }) }));
    expect(calls).toEqual(["badge 0", "badge 1", "bounce"]);
  });

  it("plays the sound alone at the volume setting with the bounce off", () => {
    settings({ "notifications.sound": "true", "notifications.bounce": "false", "notifications.sound_volume": "15" });
    useThreadsStore.setState((s) => ({ ...replaceThreads(s, [thread("a", { status: "busy" })]), epoch: s.epoch + 1 }));
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread("a", { status: "attention", statusReason: "finished" }) }));
    expect(calls).toEqual(["badge 0", "badge 1", "sound 15"]);
  });

  it("a hidden child never badges or bounces; once its creator is removed it does", () => {
    settings({ "notifications.cooldown_seconds": "0" });
    const kid = (over: Partial<ThreadView>) => thread("kid", { createdBy: "lead", status: "busy", ...over });
    useThreadsStore.setState((s) => ({ ...replaceThreads(s, [thread("lead", { status: "busy" }), kid({})]), epoch: s.epoch + 1 }));
    // The hidden child finishes and asks: nothing.
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: kid({ status: "attention", statusReason: "permission: Bash" }) }));
    expect(calls).toEqual(["badge 0"]);
    // Its creator is removed: the child is the user's now, and it is new to the set.
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "removed", id: "lead" }));
    expect(calls).toEqual(["badge 0", "badge 1", "bounce"]);
  });
});
