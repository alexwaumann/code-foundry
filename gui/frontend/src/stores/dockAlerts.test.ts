import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionView } from "@/api/session";
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
import { applySessionEvent, attentionIds, emptySessions, replaceSessions, useSessionsStore } from "./sessions";
import { useSettingsStore } from "./settings";

const on: AlertSettings = { dockBadge: true, bounce: true, sound: false, cooldownMs: 60_000 };

/** Runs evaluations in order from the initial state; returns each step's effects and the final state. */
function run(steps: (Partial<DockAlertsInput> & { attention: readonly string[] })[]): { effects: DockEffect[][]; state: DockAlertsState } {
  let state = initialDockAlerts;
  const effects: DockEffect[][] = [];
  for (const s of steps) {
    const r = stepDockAlerts(state, { epoch: 1, focused: false, nowMs: 0, settings: on, ...s });
    state = r.state;
    effects.push(r.effects);
  }
  return { effects, state };
}

const alerts = (effects: DockEffect[][]) => effects.map((e) => e.filter((x) => x.kind === "alert").length);
const badges = (effects: DockEffect[][]) => effects.map((e) => e.find((x) => x.kind === "badge")?.count ?? null);
const bounce: DockEffect = { kind: "alert", bounce: true, sound: false };

describe("stepDockAlerts", () => {
  it("the first evaluation takes the baseline: a badge, no alert", () => {
    const { effects } = run([{ attention: ["a", "b"] }]);
    expect(effects).toEqual([[{ kind: "badge", count: 2 }]]);
  });

  it("a thread entering while unfocused alerts once", () => {
    const { effects } = run([{ attention: [] }, { attention: ["a"], nowMs: 1000 }, { attention: ["a"], nowMs: 2000 }]);
    expect(effects[1]).toEqual([{ kind: "badge", count: 1 }, bounce]);
    expect(alerts(effects)).toEqual([0, 1, 0]);
  });

  it("a thread entering while focused does not alert; the badge still moves", () => {
    const { effects } = run([{ attention: [] }, { attention: ["a"], focused: true }]);
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

  it("an alert carries both parts; sound alone still alerts", () => {
    const both = { ...on, sound: true };
    expect(run([{ attention: [], settings: both }, { attention: ["a"], settings: both }]).effects[1]).toContainEqual({ kind: "alert", bounce: true, sound: true });
    const sound = { ...on, bounce: false, sound: true };
    expect(run([{ attention: [], settings: sound }, { attention: ["a"], settings: sound }]).effects[1]).toContainEqual({ kind: "alert", bounce: false, sound: true });
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

function thread(id: string, over: Partial<SessionView> = {}): SessionView {
  return {
    id,
    createdAtMs: 1,
    state: "connected",
    status: "idle",
    statusReason: "",
    archivedAtMs: null,
    pinned: false,
    linkedPullRequests: [],
    usage: [],
    agentRuns: [],
    ...over,
  } as unknown as SessionView;
}

describe("attentionIds (the badge count)", () => {
  it("counts prompts and finished turns, pinned or not, never errors, archived or working ones", () => {
    const data = replaceSessions(emptySessions, [
      thread("prompt", { status: "attention", statusReason: "permission: Bash" }),
      thread("done", { status: "attention", statusReason: "finished" }),
      thread("error", { state: "disconnected", status: "error", statusReason: "interrupted" }),
      thread("pinned", { status: "attention", statusReason: "question: Which?", pinned: true }),
      thread("offline-prompt", { state: "disconnected", status: "attention", statusReason: "finished" }),
      thread("archived", { status: "attention", statusReason: "finished", archivedAtMs: 5 }),
      thread("busy", { status: "busy" }),
      thread("idle"),
      thread("starting", { state: "starting", status: "unknown" }),
    ]);
    expect(attentionIds(data).sort()).toEqual(["done", "offline-prompt", "pinned", "prompt"]);
  });
});

describe("alertSettings", () => {
  const snap = (values: Record<string, string>): SettingsSnapshotView => ({ values, path: "", revision: 1, loadError: "", issues: [], restartPending: [] });
  it.each<[Record<string, string>, AlertSettings]>([
    [
      { "notifications.dock_badge": "true", "notifications.bounce": "true", "notifications.sound": "false", "notifications.cooldown_seconds": "60" },
      { dockBadge: true, bounce: true, sound: false, cooldownMs: 60_000 },
    ],
    [
      { "notifications.dock_badge": "false", "notifications.bounce": "false", "notifications.sound": "true", "notifications.cooldown_seconds": "0" },
      { dockBadge: false, bounce: false, sound: true, cooldownMs: 0 },
    ],
    // An older daemon without the keys: the schema's defaults.
    [{}, { dockBadge: true, bounce: true, sound: false, cooldownMs: 60_000 }],
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
  let focused: boolean;
  let now: number;
  const settings = (values: Record<string, string>) => {
    useSettingsStore.setState({ snapshot: { values, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
  };
  beforeEach(() => {
    calls = [];
    focused = false;
    now = 0;
    useSessionsStore.setState({ ...emptySessions, epoch: 0 });
    useSettingsStore.setState({ snapshot: null });
    const deps: DockAlertsDeps = {
      setBadge: (n) => calls.push(`badge ${String(n)}`),
      bounce: () => calls.push("bounce"),
      playSound: () => calls.push("sound"),
      focused: () => focused,
      now: () => now,
    };
    stop = startDockAlerts(deps);
  });
  afterEach(() => {
    stop();
  });

  it("badges once settings arrive, re-baselines on the List, then bounces on a transition while unfocused", () => {
    settings({ "notifications.cooldown_seconds": "60" });
    expect(calls).toEqual(["badge 0"]);
    // The (re)connect's List: two threads already waiting. A new epoch, so no alert.
    useSessionsStore.setState((s) => ({
      ...replaceSessions(s, [thread("a", { status: "attention", statusReason: "finished" }), thread("b", { status: "attention", statusReason: "finished" }), thread("c", { status: "busy" })]),
      epoch: s.epoch + 1,
    }));
    expect(calls).toEqual(["badge 0", "badge 2"]);
    now = 1000;
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: thread("c", { status: "attention", statusReason: "finished" }) }));
    expect(calls).toEqual(["badge 0", "badge 2", "badge 3", "bounce"]);
  });

  it("does not bounce while focused, and turning the badge off clears it", () => {
    settings({ "notifications.sound": "true" });
    useSessionsStore.setState((s) => ({ ...replaceSessions(s, [thread("a", { status: "busy" })]), epoch: s.epoch + 1 }));
    focused = true;
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: thread("a", { status: "attention", statusReason: "permission: Bash" }) }));
    expect(calls).toEqual(["badge 0", "badge 1"]);
    settings({ "notifications.sound": "true", "notifications.dock_badge": "false" });
    expect(calls).toEqual(["badge 0", "badge 1", "badge 0"]);
  });

  it("an alert plays the sound with the bounce when both are on", () => {
    settings({ "notifications.sound": "true" });
    useSessionsStore.setState((s) => ({ ...replaceSessions(s, [thread("a", { status: "busy" })]), epoch: s.epoch + 1 }));
    useSessionsStore.setState((s) => applySessionEvent(s, { kind: "updated", session: thread("a", { status: "attention", statusReason: "finished" }) }));
    expect(calls).toEqual(["badge 0", "badge 1", "bounce", "sound"]);
  });
});
