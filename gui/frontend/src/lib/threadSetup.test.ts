import { describe, expect, it } from "vitest";
import type { ThreadSetupStepView, ThreadSetupView } from "@/api/threads";
import {
  hasSetupWork,
  isUnplaced,
  SETUP_RESTARTED,
  SETUP_REVEAL_MS,
  setupCurrentStep,
  setupFailure,
  setupFoldWarning,
  setupLabelText,
  setupLines,
  setupLineTime,
  setupNoteLine,
  setupRevealAt,
  setupRowPhase,
  setupUnfinished,
  setupView,
  setupWaitedFor,
  type SetupView,
} from "./threadSetup";

const NOW = 1_000_000;

function step(kind: ThreadSetupStepView["kind"], status: ThreadSetupStepView["status"], over: Partial<ThreadSetupStepView> = {}): ThreadSetupStepView {
  return { kind, projectId: "", projectName: "", ref: "", branch: "", status, startedAtMs: null, endedAtMs: null, error: "", warning: "", refAtMs: null, existing: false, ...over };
}

function setup(phase: ThreadSetupView["phase"], steps: ThreadSetupStepView[], over: Partial<ThreadSetupView> = {}): ThreadSetupView {
  return { phase, startedAtMs: NOW - 3000, endedAtMs: null, steps, error: "", background: true, ...over };
}

/** A step that ran from `ago` ms before NOW for `took` ms; `took` null: still running. */
function ran(kind: ThreadSetupStepView["kind"], ago: number, took: number | null, over: Partial<ThreadSetupStepView> = {}): ThreadSetupStepView {
  return step(kind, took === null ? "running" : "done", { startedAtMs: NOW - ago, endedAtMs: took === null ? null : NOW - ago + took, ...over });
}

const pending = (kind: ThreadSetupStepView["kind"], over: Partial<ThreadSetupStepView> = {}) => step(kind, "pending", over);
const texts = (v: SetupView) => ("lines" in v ? v.lines.map((l) => `${l.status} ${l.project ? `${l.project}: ` : ""}${setupLabelText(l.label)}`) : []);

describe("setupRevealAt", () => {
  const cases: [string, ThreadSetupStepView[], number | null][] = [
    ["no step started", [pending("name"), pending("start")], null],
    ["a step still running reaches the bar", [ran("fetch", 100, null)], NOW - 100 + SETUP_REVEAL_MS],
    ["a step that ended sooner never counts", [ran("name", 1000, 299)], null],
    ["a step that took as long counts", [ran("name", 1000, 300)], NOW - 1000 + SETUP_REVEAL_MS],
    ["the first of several", [ran("name", 2000, 100), ran("fetch", 1000, null), ran("worktree", 800, null)], NOW - 1000 + SETUP_REVEAL_MS],
    ["a warning shows whatever it took", [step("fetch", "warning", { startedAtMs: NOW - 1000, endedAtMs: NOW - 950 })], NOW - 950],
  ];
  it.each(cases)("%s", (_, steps, want) => {
    expect(setupRevealAt(setup("running", steps))).toBe(want);
  });
});

describe("setupRowPhase", () => {
  const slow = [ran("fetch", 2000, 1000), ran("start", 1000, 100)];
  const fast = [ran("name", 1000, 50), ran("worktree", 950, 100), ran("start", 850, 200)];
  const cases: [string, ThreadSetupView | null | undefined, string][] = [
    ["no setup", null, ""],
    ["absent", undefined, ""],
    ["running, with work", setup("running", [pending("worktree"), pending("start")]), "running"],
    ["running, only Claude's start", setup("running", [ran("start", 500, null)]), ""],
    ["done, slow", setup("done", slow), "done"],
    ["done, fast: no fold line", setup("done", fast), ""],
    ["done, only Claude's start, however long", setup("done", [ran("start", 5000, 4000)]), ""],
    ["done, a fast fetch that warned", setup("done", [step("fetch", "warning", { startedAtMs: NOW - 10, endedAtMs: NOW }), ran("start", 5, 1)]), "done"],
    ["failed", setup("failed", [pending("start")]), "stopped"],
    ["failed, only Claude's start", setup("failed", [step("start", "failed")]), "stopped"],
    ["cancelled", setup("cancelled", [pending("fetch")]), "stopped"],
  ];
  it.each(cases)("%s", (_, s, want) => {
    expect(setupRowPhase(s)).toBe(want);
  });
});

describe("setupView", () => {
  it("shows nothing before a step has run long enough, so a fast thread never flashes a checklist", () => {
    const s = setup("running", [ran("name", 200, null), ran("fetch", 200, null), pending("worktree"), pending("start")]);
    expect(setupView(s, NOW).kind).toBe("none");
    expect(setupView(s, NOW + 99).kind).toBe("none");
    expect(setupView(s, NOW + 100).kind).toBe("live");
  });

  it("says Setting up with the time since the setup started, then every line still to come", () => {
    const s = setup("running", [ran("name", 3000, 1200, { branch: "cf/x" }), ran("fetch", 3000, null, { ref: "origin/main" }), pending("worktree"), pending("start")]);
    const v = setupView(s, NOW);
    expect(v).toMatchObject({ kind: "live", elapsed: "3s" });
    expect(texts(v)).toEqual(["done Named the branch cf/x", "running Fetching origin/main", "pending Creating the worktree", "pending Starting Claude"]);
  });

  it("leaves out a step that was over before the checklist showed, and keeps one that was not", () => {
    const fast = ran("name", 3000, 50, { branch: "cf/x" });
    const s = setup("running", [fast, ran("fetch", 2900, 2000, { ref: "origin/main" }), ran("worktree", 900, 100), ran("start", 800, null)]);
    // The worktree took 100ms, but the rows were up by then: it stays where it was.
    expect(texts(setupView(s, NOW))).toEqual(["done Fetched origin/main", "done Created the worktree", "running Starting Claude"]);
  });

  it("keeps a warning however fast, and carries on with the rows after it", () => {
    const warned = step("fetch", "warning", { ref: "origin/main", startedAtMs: NOW - 2000, endedAtMs: NOW - 1990, warning: "Could not reach origin", refAtMs: NOW - 1990 - 2 * 3_600_000 });
    const s = setup("running", [warned, ran("worktree", 1000, null), pending("start")]);
    expect(texts(setupView(s, NOW))).toEqual(["warning Could not reach origin, using origin/main from 2h ago", "running Creating the worktree", "pending Starting Claude"]);
  });

  it("drops a step that left the list and moves nothing else", () => {
    const with_ = setup("running", [ran("name", 1000, null), pending("fetch", { ref: "origin/main" }), pending("worktree"), pending("start")]);
    const without = { ...with_, steps: with_.steps.filter((s) => s.kind !== "fetch") };
    expect(texts(setupView(with_, NOW))).toHaveLength(4);
    expect(texts(setupView(without, NOW))).toEqual(["running Naming the branch", "pending Creating the worktree", "pending Starting Claude"]);
  });

  it("reads only the latest setup: a retry back to pending, with a new branch", () => {
    const failed = setup("failed", [ran("name", 9000, 1000, { branch: "cf/old" }), step("worktree", "failed", { startedAtMs: NOW - 8000, endedAtMs: NOW - 7000, error: "fatal: no" }), pending("start")]);
    const retried = setup("running", [ran("name", 9000, 1000, { branch: "cf/new" }), ran("worktree", 100, null), pending("start")], { startedAtMs: NOW - 100 });
    expect(texts(setupView(failed, NOW))).toEqual(["done Named the branch cf/old", "failed Could not create the worktree", "pending Starting Claude"]);
    const v = setupView(retried, NOW);
    expect(v).toMatchObject({ kind: "live", elapsed: "0s" });
    expect(texts(v)).toEqual(["done Named the branch cf/new", "running Creating the worktree", "pending Starting Claude"]);
  });

  it("failed: no live line, every row as it ended, however fast, git's text on the failed one", () => {
    const s = setup("failed", [ran("name", 90, 10, { branch: "cf/x" }), step("worktree", "failed", { startedAtMs: NOW - 80, endedAtMs: NOW - 70, error: "fatal: cannot lock ref" }), pending("start")], { endedAtMs: NOW - 70 });
    const v = setupView(s, NOW);
    expect(v.kind).toBe("failed");
    expect(texts(v)).toEqual(["done Named the branch cf/x", "failed Could not create the worktree", "pending Starting Claude"]);
    expect("lines" in v && v.lines[1]?.error).toBe("fatal: cannot lock ref");
  });

  const cancels: [string, number, string][] = [
    ["whole seconds", 4300, "Setup cancelled after 4s"],
    ["inside the first second", 400, "Setup cancelled after 0.4s"],
    ["a minute in", 65_000, "Setup cancelled after 1m 5s"],
  ];
  it.each(cancels)("cancelled: one line, %s", (_, took, label) => {
    const s = setup("cancelled", [pending("fetch"), pending("start")], { startedAtMs: NOW - took, endedAtMs: NOW });
    expect(setupView(s, NOW)).toEqual({ kind: "cancelled", label });
  });

  it("cancelled without its times says so plainly", () => {
    expect(setupView(setup("cancelled", [], { startedAtMs: null }), NOW)).toEqual({ kind: "cancelled", label: "Setup cancelled" });
  });

  it("done: the fold line with how long it took, and every step behind it", () => {
    const s = setup("done", [ran("name", 6800, 40, { branch: "cf/x" }), ran("fetch", 6800, 3400, { ref: "origin/main" }), ran("worktree", 3400, 2400), ran("start", 1000, 1000)], { startedAtMs: NOW - 6800, endedAtMs: NOW });
    const v = setupView(s, NOW);
    expect(v).toMatchObject({ kind: "done", label: "Set up in 6.8s", warning: "" });
    expect(texts(v)).toEqual(["done Named the branch cf/x", "done Fetched origin/main", "done Created the worktree", "done Started Claude"]);
  });

  it("done with nothing to tell, or no setup, shows nothing", () => {
    expect(setupView(setup("done", [ran("start", 500, 100)]), NOW).kind).toBe("none");
    expect(setupView(null, NOW).kind).toBe("none");
  });
});

describe("labels", () => {
  const cases: [string, ThreadSetupStepView, string][] = [
    ["naming", step("name", "running"), "Naming the branch"],
    ["named", step("name", "done", { branch: "cf/x" }), "Named the branch cf/x"],
    ["named, no branch given", step("name", "done"), "Named the branch"],
    ["naming failed", step("name", "failed"), "Could not name the branch"],
    ["fetch pending", step("fetch", "pending", { ref: "origin/main" }), "Fetching origin/main"],
    ["fetching", step("fetch", "running", { ref: "origin/main" }), "Fetching origin/main"],
    ["fetched", step("fetch", "done", { ref: "origin/main" }), "Fetched origin/main"],
    ["fetch failed", step("fetch", "failed", { ref: "origin/main" }), "Could not fetch origin/main"],
    ["fetch with no ref yet", step("fetch", "running"), "Fetching the base"],
    ["warned, the ref's age", step("fetch", "warning", { ref: "origin/main", warning: "Could not reach origin", refAtMs: NOW - 3 * 86_400_000, endedAtMs: NOW }), "Could not reach origin, using origin/main from 3d ago"],
    ["warned, a fresh ref", step("fetch", "warning", { ref: "origin/main", warning: "Could not reach origin", refAtMs: NOW - 5000, endedAtMs: NOW }), "Could not reach origin, using origin/main from under a minute ago"],
    ["warned, no such ref", step("fetch", "warning", { ref: "origin/main", warning: "Could not reach origin" }), "Could not reach origin"],
    ["worktree pending", step("worktree", "pending"), "Creating the worktree"],
    ["worktree done", step("worktree", "done"), "Created the worktree"],
    ["worktree failed", step("worktree", "failed"), "Could not create the worktree"],
    ["start pending", step("start", "pending"), "Starting Claude"],
    ["started", step("start", "done"), "Started Claude"],
    ["start failed", step("start", "failed"), "Could not start Claude"],
  ];
  it.each(cases)("%s", (_, st, want) => {
    const line = setupLines(setup("failed", [st]), NOW)[0];
    expect(line && setupLabelText(line.label)).toBe(want);
  });

  it("puts only the ref or branch in mono", () => {
    expect(setupLines(setup("running", [step("fetch", "done", { ref: "origin/main" })]), NOW)[0]?.label).toEqual({ before: "Fetched ", code: "origin/main", after: "" });
  });

  it("dates a warning from when it happened, so a thread reopened later says the same", () => {
    const st = step("fetch", "warning", { ref: "origin/main", warning: "Could not reach origin", refAtMs: NOW - 2 * 3_600_000, endedAtMs: NOW });
    const later = NOW + 30 * 86_400_000;
    expect(setupLines(setup("done", [st]), later)[0]?.label.after).toBe(" from 2h ago");
  });
});

describe("several projects", () => {
  const a = { projectId: "a", projectName: "alpha" };
  const b = { projectId: "b", projectName: "beta" };
  const c = { projectId: "c", projectName: "gamma" };

  it("has one line per project on its current step, the name and Claude lines single", () => {
    const s = setup("running", [
      ran("name", 4000, 1200, { branch: "cf/x" }),
      ran("fetch", 4000, 1200, { ...a, ref: "origin/main" }),
      ran("fetch", 4000, 3000, { ...b, ref: "origin/main" }),
      ran("fetch", 4000, null, { ...c, ref: "origin/main" }),
      ran("worktree", 2800, 2100, a),
      ran("worktree", 1000, null, b),
      pending("worktree", c),
      pending("start"),
    ]);
    expect(texts(setupView(s, NOW))).toEqual([
      "done Named the branch cf/x",
      "done alpha: Worktree ready",
      "running beta: Creating the worktree",
      "running gamma: Fetching origin/main",
      "pending Starting Claude",
    ]);
  });

  it("reads a fetch that ended with its worktree to come as that worktree under way", () => {
    const s = setup("running", [ran("fetch", 2000, 1000, { ...a, ref: "origin/main" }), ran("fetch", 2000, null, { ...b, ref: "origin/main" }), pending("worktree", a), pending("worktree", b), pending("start")]);
    expect(texts(setupView(s, NOW))[0]).toBe("running alpha: Creating the worktree");
    expect(setupLines(s, NOW)[0]?.startedAtMs).toBeNull();
  });

  it("lists a project nothing started yet dim, on its first step", () => {
    const s = setup("running", [ran("name", 1000, null), pending("fetch", { ...a, ref: "origin/main" }), pending("fetch", { ...b, ref: "origin/dev" }), pending("worktree", a), pending("worktree", b), pending("start")]);
    expect(texts(setupView(s, NOW)).slice(1, 3)).toEqual(["pending alpha: Fetching origin/main", "pending beta: Fetching origin/dev"]);
  });

  it("keeps a project's place when its fetch leaves the list", () => {
    const steps = [pending("fetch", { ...a, ref: "x" }), pending("fetch", { ...b, ref: "y" }), pending("worktree", a), pending("worktree", b), pending("start")];
    const keys = (list: ThreadSetupStepView[]) => setupLines(setup("running", list), NOW).map((l) => l.key);
    expect(keys(steps)).toEqual(["project:a", "project:b", "start:"]);
    expect(keys(steps.slice(1))).toEqual(["project:a", "project:b", "start:"]);
  });

  it("gives a warning its own line, which stays when the worktree moves on", () => {
    const warned = step("fetch", "warning", { ...a, ref: "origin/main", warning: "Could not reach origin", startedAtMs: NOW - 5000, endedAtMs: NOW - 1000, refAtMs: NOW - 7_200_000 });
    const s = setup("running", [warned, ran("fetch", 5000, 400, { ...b, ref: "origin/main" }), ran("worktree", 1000, null, a), ran("worktree", 4000, 300, b), pending("start")]);
    expect(texts(setupView(s, NOW))).toEqual([
      "warning alpha: Could not reach origin, using origin/main from 1h ago",
      "running alpha: Creating the worktree",
      "done beta: Worktree ready",
      "pending Starting Claude",
    ]);
  });

  it("failed: the project's failed step with git's text, the ones that never ran dim", () => {
    const s = setup("failed", [ran("fetch", 900, 100, { ...a, ref: "origin/main" }), ran("fetch", 900, 100, { ...b, ref: "origin/main" }), step("worktree", "failed", { ...a, startedAtMs: NOW - 800, endedAtMs: NOW - 700, error: "fatal: a" }), pending("worktree", b), pending("start")]);
    const v = setupView(s, NOW);
    expect(texts(v)).toEqual(["failed alpha: Could not create the worktree", "pending beta: Creating the worktree", "pending Starting Claude"]);
    expect("lines" in v && v.lines[0]?.error).toBe("fatal: a");
  });

  it("times a ready project from its fetch to its worktree", () => {
    const s = setup("done", [ran("fetch", 4000, 1000, { ...a, ref: "x" }), ran("fetch", 4000, 1000, { ...b, ref: "x" }), ran("worktree", 3000, 1500, a), ran("worktree", 3000, 1500, b), ran("start", 1000, 500)]);
    const line = setupLines(s, NOW)[0];
    expect(line && setupLineTime(line, NOW)).toBe("2.5s");
  });
});

describe("setupLineTime", () => {
  const cases: [string, Parameters<typeof setupLineTime>[0], string][] = [
    ["not started", { status: "pending", startedAtMs: null, endedAtMs: null }, ""],
    ["done", { status: "done", startedAtMs: NOW - 1200, endedAtMs: NOW }, "1.2s"],
    ["too quick to say", { status: "done", startedAtMs: NOW - 10, endedAtMs: NOW }, ""],
    ["running, whole seconds", { status: "running", startedAtMs: NOW - 3400, endedAtMs: null }, "3s"],
    ["running, just started", { status: "running", startedAtMs: NOW + 5, endedAtMs: null }, "0s"],
  ];
  it.each(cases)("%s", (_, line, want) => {
    expect(setupLineTime(line, NOW)).toBe(want);
  });
});

describe("setupFoldWarning", () => {
  const warned = (over: Partial<ThreadSetupStepView> = {}) => step("fetch", "warning", { ref: "origin/main", warning: "Could not reach origin", endedAtMs: NOW, refAtMs: NOW - 2 * 3_600_000, ...over });
  const cases: [string, ThreadSetupStepView[], string][] = [
    ["none", [step("fetch", "done")], ""],
    ["a stale base", [warned()], "using origin/main from 2h ago"],
    ["no such ref", [warned({ refAtMs: null })], "could not reach origin"],
    ["several", [warned({ projectId: "a" }), warned({ projectId: "b" })], "2 projects on an old base"],
  ];
  it.each(cases)("%s", (_, steps, want) => {
    expect(setupFoldWarning(setup("done", steps), NOW)).toBe(want);
  });
});

describe("the sidebar's words", () => {
  it("names the step a running setup is on, in the present", () => {
    expect(setupCurrentStep(setup("running", [ran("name", 1000, 500), ran("fetch", 500, null, { ref: "origin/main" }), pending("start")]))).toBe("Fetching origin/main");
  });

  it("names the next step in the moment between two", () => {
    expect(setupCurrentStep(setup("running", [ran("name", 1000, 500), pending("worktree"), pending("start")]))).toBe("Creating the worktree");
  });

  it("has nothing to say when every step ended", () => {
    expect(setupCurrentStep(setup("running", [ran("start", 1000, 500)]))).toBe("");
  });

  it("gives why a setup failed from its failed step, else its error's first line", () => {
    expect(setupFailure(setup("failed", [step("worktree", "failed")]))).toBe("Could not create the worktree");
    expect(setupFailure(setup("failed", [], { error: "Code Foundry restarted during setup\nmore" }))).toBe("Code Foundry restarted during setup");
  });
});

describe("predicates", () => {
  const cases: [string, ThreadSetupView | null, boolean][] = [
    ["none", null, false],
    ["running", setup("running", []), true],
    ["done", setup("done", []), false],
    ["failed", setup("failed", []), true],
    ["cancelled", setup("cancelled", []), true],
  ];
  it.each(cases)("%s", (_, s, unfinished) => {
    expect(setupUnfinished(s)).toBe(unfinished);
  });

  it("is unplaced only while a setup that did not finish left no cwd", () => {
    expect(isUnplaced({ setup: setup("running", []), worktreePath: "" })).toBe(true);
    expect(isUnplaced({ setup: setup("failed", []), worktreePath: "/w" })).toBe(false);
    expect(isUnplaced({ setup: setup("done", []), worktreePath: "" })).toBe(false);
    expect(isUnplaced({ setup: null, worktreePath: "" })).toBe(false);
    expect(isUnplaced(undefined)).toBe(false);
  });

  it("counts a setup as work when it does more than start Claude", () => {
    expect(hasSetupWork(setup("running", [pending("start")]))).toBe(false);
    expect(hasSetupWork(setup("running", [pending("worktree"), pending("start")]))).toBe(true);
  });
});

describe("what has been shown stays", () => {
  const fast = (ended: number) => step("fetch", "done", { ref: "origin/main", startedAtMs: NOW - 400, endedAtMs: NOW - 400 + ended });

  it("a snapshot saying a step ended before its 300ms were up keeps the row it showed", () => {
    const shown = new Set(["fetch:"]);
    const late = setup("running", [fast(290), step("start", "pending")]);
    expect(setupView(late, NOW).kind).toBe("none");
    const view = setupView(late, NOW, shown);
    expect(view.kind === "live" && view.lines.map((l) => l.key)).toEqual(["fetch:", "start:"]);
  });

  it("a retry keeps the failed rows, though nothing has run its 300ms yet", () => {
    const retried = setup("running", [step("fetch", "pending", { ref: "origin/main" }), step("worktree", "pending"), step("start", "pending")]);
    expect(setupView(retried, NOW).kind).toBe("none");
    const view = setupView(retried, NOW, new Set(["fetch:", "worktree:", "start:"]));
    expect(view.kind === "live" && view.lines.map((l) => l.status)).toEqual(["pending", "pending", "pending"]);
  });

  it("a step that was never shown still stays out", () => {
    const later = setup("running", [step("name", "done", { startedAtMs: NOW - 2000, endedAtMs: NOW - 1900 }), step("fetch", "running", { startedAtMs: NOW - 1000 }), step("start", "pending")]);
    const view = setupView(later, NOW, new Set(["fetch:"]));
    expect(view.kind === "live" && view.lines.map((l) => l.key)).toEqual(["fetch:", "start:"]);
  });

  it("gives a setup that showed its rows a fold line, however fast it turned out", () => {
    const done = setup("done", [fast(100), step("start", "done", { startedAtMs: NOW - 300, endedAtMs: NOW - 200 })], { endedAtMs: NOW - 200 });
    expect(setupRowPhase(done)).toBe("");
    expect(setupRowPhase(done, true)).toBe("done");
    expect(setupView(done, NOW, new Set(["fetch:"])).kind).toBe("done");
  });

  it("keeps the row of a setup whose work left the list", () => {
    const left = setup("running", [step("start", "running", { startedAtMs: NOW })]);
    expect(setupRowPhase(left)).toBe("");
    expect(setupRowPhase(left, true)).toBe("running");
  });
});

describe("a setup a restart cut off", () => {
  const restarted = (st: ReturnType<typeof step>) => setup("failed", [step("name", "done", { branch: "cf/x", startedAtMs: NOW - 900, endedAtMs: NOW - 800 }), st, step("start", "pending")], { error: SETUP_RESTARTED, endedAtMs: NOW });

  it("says so on the step it was on, with no box repeating it", () => {
    const view = setupView(restarted(step("fetch", "failed", { ref: "origin/main", error: SETUP_RESTARTED, startedAtMs: NOW - 900, endedAtMs: NOW })), NOW);
    expect(view.kind === "failed" && view.lines.map((l) => [l.status, setupLabelText(l.label), l.error])).toEqual([
      ["done", "Named the branch cf/x", ""],
      ["failed", "Setup stopped when Code Foundry restarted", ""],
      ["pending", "Starting Claude", ""],
    ]);
  });

  it("titles the sidebar and the note with it", () => {
    const s = restarted(step("worktree", "failed", { error: SETUP_RESTARTED }));
    expect(setupFailure(s)).toBe("Setup stopped when Code Foundry restarted");
    expect(setupNoteLine(s)).toBe("Setup stopped when Code Foundry restarted, so your message was not sent.");
  });

  it("a real failure beside it keeps its own words", () => {
    const s = restarted(step("worktree", "failed", { error: "fatal: nope" }));
    expect(setupFailure(s)).toBe("Could not create the worktree");
  });

  it("shows the setup's error where no step explains it, before the steps that never ran", () => {
    const s = setup("failed", [step("name", "done", { startedAtMs: NOW - 900, endedAtMs: NOW - 800 }), step("start", "pending")], { error: SETUP_RESTARTED });
    const view = setupView(s, NOW);
    expect(view.kind === "failed" && view.lines.map((l) => setupLabelText(l.label))).toEqual(["Named the branch", "Setup stopped when Code Foundry restarted", "Starting Claude"]);
    expect(setupFailure(s)).toBe("Setup stopped when Code Foundry restarted");
  });

  it("any other error with no step behind it shows in the box", () => {
    const view = setupView(setup("failed", [step("start", "pending")], { error: "the disk is full" }), NOW);
    expect(view.kind === "failed" && view.lines[0]).toMatchObject({ status: "failed", error: "the disk is full", label: { before: "Setup failed" } });
  });
});

describe("wording", () => {
  it("says Using for a branch that was there, Named for one that was made", () => {
    const line = (existing: boolean) => setupLabelText(setupLines(setup("running", [step("name", "done", { branch: "dev", existing })]), NOW)[0]?.label ?? { before: "", code: "", after: "" });
    expect(line(true)).toBe("Using the branch dev");
    expect(line(false)).toBe("Named the branch dev");
  });

  it.each<[string, (number | null)[], string]>([
    ["every project on an old base", [NOW - 3_600_000, NOW - 7_200_000], "2 projects on an old base"],
    ["no ref on disk anywhere: no old base was used", [null, null], "2 projects could not fetch"],
    ["some with one and some without", [NOW - 3_600_000, null], "2 projects could not fetch"],
  ])("the fold's warning: %s", (_n, ages, want) => {
    const warned = ages.map((refAtMs, i) => step("fetch", "warning", { projectId: `p${String(i)}`, ref: "origin/main", warning: "Could not reach origin", refAtMs, endedAtMs: NOW }));
    expect(setupFoldWarning(setup("done", warned), NOW)).toBe(want);
  });
});

describe("setupNoteLine", () => {
  it.each<[string, ThreadSetupView | null, string | null]>([
    ["failed", setup("failed", [step("worktree", "failed")]), "Could not create the worktree, so your message was not sent."],
    ["failed with nothing to say why", setup("failed", []), "Setup failed, so your message was not sent."],
    ["cancelled", setup("cancelled", []), "Setup cancelled, so your message was not sent."],
    ["running", setup("running", []), null],
    ["done", setup("done", []), null],
    ["no setup", null, null],
  ])("%s", (_n, s, want) => {
    expect(setupNoteLine(s)).toBe(want);
  });
});

describe("setupWaitedFor", () => {
  it("is a setup running with its creator waiting on it", () => {
    expect(setupWaitedFor(setup("running", [], { background: false }))).toBe(true);
    expect(setupWaitedFor(setup("running", []))).toBe(false);
    expect(setupWaitedFor(setup("failed", [], { background: false }))).toBe(false);
    expect(setupWaitedFor(null)).toBe(false);
  });
});
