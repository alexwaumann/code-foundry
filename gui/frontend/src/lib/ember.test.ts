import { describe, expect, it } from "vitest";
import type { EmberTaskThreadView, EmberTaskView } from "@/api/ember";
import type { ThreadItemView } from "@/api/thread";
import {
  boardSections,
  buildEmberRows,
  cardMeta,
  emberStatusWords,
  firstDoingTitle,
  flameState,
  headerSummary,
  linkMeta,
  modelList,
  runMs,
  shortDuration,
  splitTaskLinks,
  toggleModel,
  turnEndAfter,
  waitingThreads,
  workerRows,
  workerWords,
  workingThreads,
  workMs,
  workSummary,
  type EmberRow,
} from "./ember";
import type { TimelineItem } from "./threadTimeline";

const NOW = new Date(2026, 9, 20, 15, 0).getTime();
const MIN = 60_000;

function thread(over: Partial<EmberTaskThreadView> = {}): EmberTaskThreadView {
  return {
    id: "s-w",
    name: "Worker",
    state: "connected",
    status: "busy",
    statusReason: "working",
    reportStatus: null,
    reportSummary: "",
    reportAtMs: null,
    createdAtMs: NOW - 30 * MIN,
    lastActivityAtMs: NOW - 2 * MIN,
    archived: false,
    removed: false,
    descendantsWorking: 0,
    descendantsWaiting: 0,
    descendantsTotal: 0,
    descendants: [],
    ...over,
  };
}

function task(id: string, over: Partial<EmberTaskView> = {}): EmberTaskView {
  return { id, title: id, detail: "", state: "todo", parentId: "", threadId: "", outcome: "", branch: "", position: 0, createdAtMs: NOW - 60 * MIN, updatedAtMs: NOW - 60 * MIN, doneAtMs: null, thread: null, ...over };
}

describe("flameState", () => {
  it.each([
    ["no thread, nothing doing", undefined, 0, "idle"],
    ["no thread, a task doing", undefined, 1, "working"],
    ["idle at its prompt", { state: "disconnected", status: "idle" }, 0, "idle"],
    ["idle with a task doing", { state: "disconnected", status: "idle" }, 2, "working"],
    ["busy", { state: "connected", status: "busy" }, 2, "thinking"],
    ["starting", { state: "starting", status: "idle" }, 0, "thinking"],
    ["a reply not seen", { state: "disconnected", status: "attention" }, 1, "attention"],
    ["a prompt while busy", { state: "connected", status: "attention" }, 0, "attention"],
  ] as const)("%s", (_n, t, doing, want) => {
    expect(flameState(t, doing)).toBe(want);
  });

  it("burns for the user while a worker waits on an answer, even while Ember thinks", () => {
    expect(flameState({ state: "connected", status: "busy" }, 1, 1)).toBe("attention");
    expect(flameState({ state: "disconnected", status: "idle" }, 1, 2)).toBe("attention");
  });
});

describe("splitTaskLinks", () => {
  it("keeps text without links whole", () => {
    expect(splitTaskLinks("Just text.\n\nMore.")).toEqual([{ kind: "md", text: "Just text.\n\nMore." }]);
  });

  it("splits links alone on their line, a bullet allowed", () => {
    expect(splitTaskLinks("On it.\n\n[Wait on threads](cf-task://t-1a2b3c4d)\n- [Same for read](cf-task://t-00ff00ff)\n\nBye.")).toEqual([
      { kind: "md", text: "On it.\n" },
      { kind: "task", title: "Wait on threads", id: "t-1a2b3c4d" },
      { kind: "task", title: "Same for read", id: "t-00ff00ff" },
      { kind: "md", text: "\nBye." },
    ]);
  });

  it("leaves inline links and fenced ones as markdown", () => {
    const text = "See [this](cf-task://t-1a2b3c4d) now.\n```\n[x](cf-task://t-00000000)\n```";
    expect(splitTaskLinks(text)).toEqual([{ kind: "md", text }]);
  });
});

/** Timeline items from short specs: "u:id", "w:id" (a wake), "t:id" (text), "b:id" (Bash), "r:id" (Read), "e:id" (turn end), "h:id" (thinking), "p:id:tool" (pending permission on a tool). */
function items(...specs: string[]): { list: TimelineItem[]; wakes: Set<string> } {
  const wakes = new Set<string>();
  const list = specs.flatMap((s): TimelineItem[] => {
    const [k = "", id = "", ref = ""] = s.split(":");
    const base = { id, name: "", parentToolUseId: "", toolUseId: "", toolStatus: "" as const, requestState: "" as const, streaming: false };
    switch (k) {
      case "u":
        return [{ ...base, kind: "user" }];
      case "w":
        wakes.add(id);
        return [{ ...base, kind: "user" }];
      case "t":
        return [{ ...base, kind: "text" }];
      case "b":
        return [{ ...base, kind: "tool", name: "Bash", toolUseId: id, toolStatus: "done" }];
      case "r":
        return [{ ...base, kind: "tool", name: "Read", toolUseId: id, toolStatus: "done" }];
      case "e":
        return [{ ...base, kind: "turnEnd" }];
      case "h":
        return [{ ...base, kind: "thinking" }];
      case "p":
        return [{ ...base, kind: "permission", name: "Bash", toolUseId: ref, requestState: "pending" }];
      default:
        return [];
    }
  });
  return { list, wakes };
}

function shape(rows: EmberRow[]): string[] {
  return rows.map((r) => (r.type === "work" ? `work(${r.ids.join(",")})${r.live ? " live" : ""}${r.expanded ? " open" : ""}` : `${r.type}:${"id" in r ? r.id : r.key}`));
}

describe("buildEmberRows", () => {
  const opts = (wakes: Set<string>, o: Partial<Parameters<typeof buildEmberRows>[1]> = {}) => ({ wake: (id: string) => wakes.has(id), expanded: () => undefined, showWork: false, working: false, ...o });

  it("folds every run between visible messages, wakes included; a reply's own turn end is no run", () => {
    const { list, wakes } = items("u:u1", "b:b1", "r:r1", "t:t1", "e:e1", "w:w1", "b:b2", "t:t2", "e:e2", "u:u2", "t:t3", "e:e3");
    expect(shape(buildEmberRows(list, opts(wakes)))).toEqual(["user:u1", "work(b1,r1)", "etext:t1", "work(e1,w1,b2)", "etext:t2", "user:u2", "etext:t3"]);
  });

  it("opens runs with Show work, the user's choice winning; open runs are followed by their rows", () => {
    const { list, wakes } = items("u:u1", "b:b1", "t:t1", "b:b2", "t:t2");
    const rows = buildEmberRows(list, opts(wakes, { showWork: true, expanded: (k) => (k === "w:b2" ? false : undefined) }));
    expect(shape(rows)).toEqual(["user:u1", "work(b1) open", "tool:b1", "etext:t1", "work(b2)", "etext:t2"]);
  });

  it("shows a tool waiting on a permission, splitting the run", () => {
    const { list, wakes } = items("u:u1", "b:b1", "b:b2", "p:x:b2");
    expect(shape(buildEmberRows(list, opts(wakes)))).toEqual(["user:u1", "work(b1)", "tool:b2"]);
  });

  it("makes the trailing run live while working, and a live row alone before any work", () => {
    const a = items("u:u1", "b:b1");
    expect(shape(buildEmberRows(a.list, opts(a.wakes, { working: true })))).toEqual(["user:u1", "work(b1) live"]);
    const b = items("u:u1");
    const rows = buildEmberRows(b.list, opts(b.wakes, { working: true }));
    expect(shape(rows)).toEqual(["user:u1", "work() live"]);
    expect(rows[1]?.key).toBe("w:live:u1");
  });

  it("draws no row for a wake Ember only thought about; thinking alone still is a run", () => {
    const { list, wakes } = items("u:u1", "h:h1", "t:t1", "e:e1", "w:w1", "h:h2", "t:t2", "e:e2", "w:w2", "b:b1", "t:t3");
    expect(shape(buildEmberRows(list, opts(wakes)))).toEqual(["user:u1", "work(h1)", "etext:t1", "etext:t2", "work(e2,w2,b1)", "etext:t3"]);
    // While it is live, the row stands: Ember may still run a tool.
    const live = items("u:u1", "t:t1", "e:e1", "w:w1", "h:h1");
    expect(shape(buildEmberRows(live.list, opts(live.wakes, { working: true })))).toEqual(["user:u1", "etext:t1", "work(e1,w1,h1) live"]);
  });

  it("keys a run by its first item, so it holds as the run grows", () => {
    const a = items("u:u1", "b:b1");
    const b = items("u:u1", "b:b1", "b:b2");
    expect(buildEmberRows(a.list, opts(a.wakes))[1]?.key).toBe("w:b1");
    expect(buildEmberRows(b.list, opts(b.wakes))[1]?.key).toBe("w:b1");
  });
});

describe("workSummary and workMs", () => {
  const at = (sec: number) => NOW + sec * 1000;
  const bash = (id: string, command: string, sec: number, secs = 1): ThreadItemView =>
    ({ id, kind: "tool", name: "Bash", inputJson: JSON.stringify({ command }), status: "done", output: "", isError: false, resultJson: "", toolUseId: id, ordinal: 0, parentToolUseId: "", createdAtMs: at(sec), updatedAtMs: at(sec + secs), streaming: false });
  const read = (id: string, sec: number): ThreadItemView =>
    ({ id, kind: "tool", name: "Read", inputJson: "{}", status: "done", output: "", isError: false, resultJson: "", toolUseId: id, ordinal: 0, parentToolUseId: "", createdAtMs: at(sec), updatedAtMs: at(sec + 1), streaming: false });
  const wake = (id: string, sec: number): ThreadItemView =>
    ({ id, kind: "user", text: "", attachments: [], composerText: "", wake: { title: "", json: "" }, ordinal: 0, parentToolUseId: "", createdAtMs: at(sec), updatedAtMs: at(sec), streaming: false });
  const end = (id: string, sec: number): ThreadItemView => ({ id, kind: "turnEnd", ordinal: 0, parentToolUseId: "", createdAtMs: at(sec), updatedAtMs: at(sec), streaming: false }) as unknown as ThreadItemView;

  it("says what the run did, in Ember's words", () => {
    const run = [
      bash("1", "code-foundry ember board", 0),
      read("2", 2),
      read("3", 3),
      bash("4", 'code-foundry thread new --project cf "x"', 4),
      bash("5", "code-foundry ember task update t-1 --state doing", 6),
      bash("6", "code-foundry thread new --project cf y", 7),
    ];
    expect(workSummary(run)).toBe("read 2 files, created 2 threads, updated the board");
    expect(workSummary([wake("w", 0), bash("1", "code-foundry thread read --id s-1", 1), bash("2", "cd /x && git log -3", 2)])).toBe("1 wake, read 1 thread, checked git");
    expect(workSummary([bash("1", "ls", 0), bash("2", "make check", 1)])).toBe("ran 2 commands");
  });

  it("sums its segments, a turn end and a wake closing one", () => {
    // 0..10 s, then a turn end; an hour later a wake and 5 s more.
    const run = [bash("1", "x", 0, 10), end("e", 10), wake("w", 3600), bash("2", "y", 3601, 4)];
    expect(workMs(run, null)).toBe(15_000);
    // Live: the last segment runs to now.
    expect(workMs([bash("1", "x", 0, 2)], at(30))).toBe(30_000);
  });

  it("takes a run without tools from its turn's duration", () => {
    const think = { id: "h", kind: "thinking", text: "", ordinal: 0, parentToolUseId: "", createdAtMs: at(0), updatedAtMs: at(0), streaming: false } as ThreadItemView;
    const text = { id: "t", kind: "text", text: "Done.", ordinal: 0, parentToolUseId: "", createdAtMs: at(1), updatedAtMs: at(1), streaming: false } as ThreadItemView;
    const e = { ...end("e", 1), durationMs: 42_000 } as ThreadItemView;
    const log = { byId: { h: think, t: text, e }, order: ["h", "t", "e"] };
    expect(turnEndAfter(log, "h")).toBe(42_000);
    expect(turnEndAfter(log, "missing")).toBeNull();
    expect(runMs([think], 42_000)).toBe(42_000);
    // With a tool, its spans; with no turn end yet, the span it has.
    expect(runMs([bash("1", "x", 0, 3)], 42_000)).toBe(3000);
    expect(runMs([think], null)).toBe(0);
  });

  it.each([
    [400, ""],
    [40_000, "40s"],
    [125_000, "2m"],
    [3_900_000, "1h 05m"],
  ])("shortDuration(%i) is %j", (ms, want) => {
    expect(shortDuration(ms)).toBe(want);
  });
});

describe("the board", () => {
  const parent = task("t-p", { title: "Wait on threads", state: "doing", threadId: "s-a", thread: thread({ id: "s-a", name: "Daemon side", reportSummary: "Wait takes ids" }) });
  const subDone = task("t-s1", { title: "Daemon", state: "done", parentId: "t-p", doneAtMs: NOW - 5 * MIN });
  const subDoing = task("t-s2", { title: "CLI", state: "doing", parentId: "t-p", threadId: "s-b", thread: thread({ id: "s-b", reportSummary: "fixing a test" }) });
  const subTodo = task("t-s3", { title: "Skill", state: "todo", parentId: "t-p" });
  const blocked = task("t-b", { title: "Bump", state: "blocked", outcome: "needs Go 1.27", threadId: "s-c", thread: thread({ id: "s-c", status: "attention", statusReason: "finished", state: "disconnected", reportStatus: "blocked" }) });
  const next = task("t-n", { title: "Same for read" });
  const doneToday = task("t-d", { state: "done", doneAtMs: NOW - 60 * MIN, outcome: "merged" });
  const doneYesterday = task("t-y", { state: "done", doneAtMs: NOW - 24 * 60 * MIN });
  const all = [parent, subDone, subDoing, subTodo, blocked, next, doneToday, doneYesterday];

  it("sorts cards into sections, subtasks under their parent, earlier done left out", () => {
    const s = boardSections(all, NOW);
    expect(s.inProgress.map((c) => [c.task.id, c.subtasks.map((x) => x.id)])).toEqual([
      ["t-p", ["t-s1", "t-s2", "t-s3"]],
      ["t-b", []],
    ]);
    expect(s.upNext.map((c) => c.task.id)).toEqual(["t-n"]);
    expect(s.doneToday.map((c) => c.task.id)).toEqual(["t-d"]);
  });

  it("gives a card its right side and its worker rows", () => {
    const [p, b] = boardSections(all, NOW).inProgress;
    expect(p && cardMeta(p)).toEqual({ text: "1 of 3", tone: "muted" });
    expect(b && cardMeta(b)).toEqual({ text: "blocked", tone: "amber" });
    expect(
      (p ? workerRows(p) : []).map((r) => [r.title, r.dot, r.meta.text, r.threadId]),
    ).toEqual([
      ["Daemon side", "doing", "Wait takes ids", "s-a"],
      ["Daemon", "done", "done", ""],
      ["CLI", "doing", "fixing a test", "s-b"],
      ["Skill", "open", "queued", ""],
    ]);
    expect((b ? workerRows(b) : []).map((r) => r.meta)).toEqual([{ text: "Blocked", tone: "amber" }]);
  });

  it("words the header, the pinned row and a task link", () => {
    expect(headerSummary(all)).toBe("2 threads working · 2 queued");
    expect(firstDoingTitle(all)).toBe("Wait on threads");
    expect(linkMeta(all, "t-p")).toEqual(["in progress", "3 pieces", "2 working"]);
    expect(linkMeta(all, "t-n")).toEqual(["up next"]);
    expect(linkMeta(all, "t-gone")).toEqual([]);
    expect(emberStatusWords({ state: "disconnected", status: "idle", statusReason: "at prompt", statusChangedAtMs: null }, 1)).toEqual({ text: "Working", tone: "sky" });
    expect(emberStatusWords({ state: "disconnected", status: "idle", statusReason: "at prompt", statusChangedAtMs: null }, 0)).toEqual({ text: "Idle", tone: "muted" });
    expect(emberStatusWords({ state: "connected", status: "attention", statusReason: "permission: Bash", statusChangedAtMs: null }, 0)).toEqual({ text: "Needs input", tone: "amber" });
  });
});

describe("a lead's team", () => {
  const member = (id: string, over: Partial<EmberTaskThreadView["descendants"][number]> = {}) => ({
    id,
    name: `Worker ${id}`,
    state: "connected" as const,
    status: "busy" as const,
    statusReason: "working",
    reportStatus: null,
    reportSummary: "",
    lastActivityAtMs: NOW - MIN,
    depth: 1,
    ...over,
  });
  const leadThread = thread({
    id: "s-lead",
    name: "Lead",
    status: "idle",
    statusReason: "waiting on 3 child threads",
    state: "connected",
    descendantsWorking: 2,
    descendantsWaiting: 1,
    descendantsTotal: 13,
    descendants: [
      member("s-1"),
      member("s-2", { status: "attention", statusReason: "question: which port?" }),
      member("s-3", { depth: 2, reportSummary: "half done" }),
      member("s-sub"),
    ],
  });
  const lead = task("t-l", { title: "Lead the API work", state: "doing", threadId: "s-lead", thread: leadThread });
  const sub = task("t-sub", { title: "Subtask", state: "doing", parentId: "t-l", threadId: "s-sub", thread: thread({ id: "s-sub" }) });

  it("counts a lead waiting on its team as working", () => {
    expect(workerWords(leadThread)).toEqual({ text: "Working", tone: "sky" });
  });

  it("draws the team under the lead, indented, a subtask's own worker once, the rest as +N more", () => {
    const [card] = boardSections([lead, sub], NOW).inProgress;
    expect((card ? workerRows(card) : []).map((r) => [r.key, r.title, r.dot, r.meta.text, r.depth, r.threadId])).toEqual([
      ["w:t-l", "Lead", "doing", "Working", 0, "s-lead"],
      ["d:t-l:s-1", "Worker s-1", "doing", "Working", 1, "s-1"],
      ["d:t-l:s-2", "Worker s-2", "blocked", "Needs input", 1, "s-2"],
      ["d:t-l:s-3", "Worker s-3", "doing", "half done", 2, "s-3"],
      ["d:t-l:more", "+9 more threads", "open", "", 1, ""],
      ["s:t-sub", "Subtask", "doing", "Working", 0, "s-sub"],
    ]);
  });

  it("says Needs input on a lead's card while one of its team asks", () => {
    const [card] = boardSections([lead], NOW).inProgress;
    expect(card && cardMeta(card)).toEqual({ text: "Needs input", tone: "amber" });
    const calm = task("t-l", { state: "doing", threadId: "s-lead", thread: { ...leadThread, descendantsWaiting: 0 } });
    const [c2] = boardSections([calm], NOW).inProgress;
    expect(c2 && cardMeta(c2)).toEqual({ text: "Working", tone: "sky" });
  });

  it("leaves a done task's team out", () => {
    const done = task("t-l", { state: "done", threadId: "s-lead", thread: leadThread });
    const [card] = boardSections([done], NOW).doneToday;
    expect((card ? workerRows(card) : []).map((r) => r.key)).toEqual(["w:t-l"]);
  });

  it("counts the team in the threads working, once each, and the unlisted ones by the daemon's count", () => {
    // The lead, s-1, s-3, s-sub listed (s-sub also a subtask's worker), and 2 - 3 listed = none unlisted.
    expect(workingThreads([lead, sub])).toBe(4);
    expect(headerSummary([lead, sub])).toBe("4 threads working");
    const big = task("t-big", { state: "doing", threadId: "s-big", thread: thread({ id: "s-big", descendantsWorking: 12, descendantsTotal: 12, descendants: [member("s-a"), member("s-b")] }) });
    expect(workingThreads([big])).toBe(13);
  });

  it("finds the workers waiting on the user, doing and blocked tasks only", () => {
    expect(waitingThreads([lead, sub])).toBe(1);
    const asks = thread({ id: "s-q", status: "attention", statusReason: "permission: Bash npm test" });
    expect(waitingThreads([task("t-q", { state: "doing", threadId: "s-q", thread: asks })])).toBe(1);
    expect(waitingThreads([task("t-q", { state: "blocked", threadId: "s-q", thread: asks })])).toBe(1);
    expect(waitingThreads([task("t-q", { state: "done", threadId: "s-q", thread: asks })])).toBe(0);
    // A finished worker is attention too, but asks nothing.
    expect(waitingThreads([task("t-f", { state: "doing", threadId: "s-f", thread: thread({ id: "s-f", status: "attention", statusReason: "finished" }) })])).toBe(0);
    // Unlisted waiters count from the daemon's number.
    expect(waitingThreads([task("t-u", { state: "doing", threadId: "s-u", thread: thread({ id: "s-u", descendantsWaiting: 2, descendantsTotal: 14 }) })])).toBe(2);
  });

  it("says Needs input on the pinned row while a worker waits, under Ember's own prompt or error", () => {
    const idle = { state: "disconnected" as const, status: "idle" as const, statusReason: "at prompt", statusChangedAtMs: null };
    expect(emberStatusWords(idle, 1, 1)).toEqual({ text: "Needs input", tone: "amber" });
    expect(emberStatusWords({ ...idle, state: "connected", status: "busy", statusReason: "working" }, 1, 1)).toEqual({ text: "Needs input", tone: "amber" });
    expect(emberStatusWords({ ...idle, status: "attention", statusReason: "finished" }, 1, 1)).toEqual({ text: "Needs input", tone: "amber" });
    expect(emberStatusWords({ ...idle, status: "error", statusReason: "crashed" }, 1, 1).tone).toBe("red");
    expect(emberStatusWords({ ...idle, status: "attention", statusReason: "finished" }, 1, 0)).toEqual({ text: "Finished", tone: "emerald" });
  });
});

describe("worker models", () => {
  it("toggles a model, keeping the last one", () => {
    expect(modelList(" a, b ,,c")).toEqual(["a", "b", "c"]);
    expect(toggleModel(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(toggleModel(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleModel(["a"], "a")).toEqual(["a"]);
  });
});
