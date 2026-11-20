import { describe, expect, it } from "vitest";
import { CHECK_ANSWER_MS, CHECK_PROBLEMS_MAX, CHECK_QUIET_MS, frameShapeOf, PageCheck, pageRefusalOf, scriptErrorOf, type PageCheckReport } from "./pageCheck";

/** A check on a fake clock: `run(ms)` moves time and fires the timers due. */
function harness(settleMs = 5000, maxHeight = 2400) {
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  const reports: PageCheckReport[] = [];
  const heights: number[] = [];
  const pings: number[] = [];
  const check = new PageCheck({
    now: () => now,
    later: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => {
        timers = timers.filter((x) => x !== t);
      };
    },
    settleMs,
    maxHeight,
    onHeight: (h) => heights.push(h),
    onDone: (r) => reports.push(r),
  });
  check.attach((seq) => pings.push(seq));
  const run = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = end;
  };
  /** Answers the check's last ping as a document would. */
  const answer = (shape: { height?: number; loader?: string } = {}) => {
    const seq = pings.at(-1);
    if (seq !== undefined) check.note({ seq, ...shape });
  };
  return { check, run, answer, reports, heights, pings };
}

/** A page that loaded and answered the frame's own first ping. */
function loaded(h: ReturnType<typeof harness>, shape: { height?: number; loader?: string } = {}) {
  h.check.start();
  h.check.loaded();
  h.check.note({ seq: 1, ...shape });
}

describe("PageCheck", () => {
  it("settles once quiet, pings for the height and reports clean", () => {
    const h = harness();
    loaded(h, { height: 200 });
    h.run(CHECK_QUIET_MS + 100);
    expect(h.pings).toHaveLength(1);
    expect(h.reports).toHaveLength(0);
    h.answer({ height: 312 });
    h.run(200);
    expect(h.reports).toEqual([
      expect.objectContaining({ loaded: true, settled: true, problems: [], pageHeight: 312, height: 420, resized: false, busy: 0, failure: "" }),
    ]);
  });

  it("waits while a call is in flight and while the loader runs", () => {
    const h = harness();
    loaded(h, { loader: "running" });
    h.check.busy(1);
    h.run(2000);
    expect(h.pings).toHaveLength(0);
    h.check.busy(-1);
    h.run(2000);
    expect(h.pings).toHaveLength(0);
    h.check.note({ loader: "ready" });
    h.run(CHECK_QUIET_MS + 100);
    h.answer();
    h.run(200);
    expect(h.reports[0]).toMatchObject({ settled: true, loader: "ready" });
    // Settled when the last thing happened: the loader's end, at 4 s.
    expect(h.reports[0]?.settleMs).toBe(4000);
  });

  it("does not settle on a ping answered after something new happened", () => {
    const h = harness();
    loaded(h);
    h.run(CHECK_QUIET_MS + 100);
    expect(h.pings).toHaveLength(1);
    h.check.resize(300);
    h.answer();
    h.run(200);
    expect(h.reports).toHaveLength(0);
    h.run(CHECK_QUIET_MS + 100);
    expect(h.pings).toHaveLength(2);
    h.answer();
    h.run(200);
    expect(h.reports[0]).toMatchObject({ settled: true, height: 300, resized: true });
  });

  it("gives up at the bound, saying what was still busy", () => {
    const h = harness(3000);
    loaded(h);
    h.check.busy(1);
    h.run(3000);
    h.run(CHECK_ANSWER_MS + 100);
    expect(h.reports[0]).toMatchObject({ settled: false, busy: 1, settleMs: 3000, loaded: true });
  });

  it("reports a page that never answered as not loaded", () => {
    const h = harness(1000);
    h.check.start();
    h.check.loaded();
    h.run(1000 + CHECK_ANSWER_MS + 200);
    expect(h.reports[0]).toMatchObject({ loaded: false, settled: false });
  });

  it("counts repeats, keeps the first problems, and counts calls and writes", () => {
    const h = harness();
    loaded(h);
    const p = { kind: "bridge" as const, call: "thraed.list", code: "unavailable", message: "no command thraed.list", where: "" };
    h.check.problem(p);
    h.check.problem(p);
    for (let i = 0; i < CHECK_PROBLEMS_MAX + 5; i++) h.check.problem({ kind: "script", call: "", code: "", message: `e${String(i)}`, where: "" });
    h.check.call();
    h.check.stored();
    h.check.stored();
    h.run(CHECK_QUIET_MS + 100);
    h.answer();
    h.run(200);
    const r = h.reports[0];
    expect(r?.problems).toHaveLength(CHECK_PROBLEMS_MAX);
    expect(r?.problems[0]).toEqual({ ...p, count: 2 });
    expect(r).toMatchObject({ calls: 1, storageWrites: 2 });
  });

  it("follows the page's height within the window, and says when it changes", () => {
    const h = harness(5000, 1000);
    loaded(h);
    h.check.resize(10);
    h.check.resize(5000);
    expect(h.heights).toEqual([48, 1000]);
    expect(h.check.height()).toBe(1000);
  });

  it("fails at once without a render, and a stopped check reports nothing", () => {
    const h = harness();
    h.check.start();
    h.check.fail("Could not render this page: not found");
    expect(h.reports[0]).toMatchObject({ loaded: false, failure: "Could not render this page: not found" });
    const s = harness();
    loaded(s);
    s.check.stop();
    s.run(10_000);
    expect(s.reports).toHaveLength(0);
  });
});

describe("frame messages", () => {
  it("reads a script error, the loader's end and a here answer", () => {
    expect(scriptErrorOf({ type: "cf:script-error", kind: "rejection", message: "boom", where: "p.html:3:1" })).toEqual({ kind: "rejection", call: "", code: "", message: "boom", where: "p.html:3:1" });
    expect(scriptErrorOf({ type: "cf:script-error", kind: "weird", message: "x" })).toMatchObject({ kind: "script", where: "" });
    expect(scriptErrorOf({ type: "cf:unsupported", what: "alert" })).toBeNull();
    expect(frameShapeOf({ type: "cf:loader", state: "error" })).toEqual({ loader: "error" });
    expect(frameShapeOf({ type: "cf:here", seq: 3, height: 120, loader: "" })).toEqual({ seq: 3, height: 120, loader: "" });
    expect(frameShapeOf({ type: "cf:here", seq: 3, height: "tall" })).toEqual({ seq: 3 });
    expect(frameShapeOf({ type: "cf:going" })).toBeNull();
    expect(pageRefusalOf({ type: "cf:refused", call: "ui.notify", code: "gesture", message: "no click" })).toEqual({ kind: "bridge", call: "ui.notify", code: "gesture", message: "no click", where: "" });
    expect(pageRefusalOf({ type: "cf:refused", call: 3, message: "x" })).toBeNull();
  });
});
