import { describe, expect, it } from "vitest";
import type { EmberTaskThreadView, EmberTaskView, EmberTimerView } from "@/api/ember";
import type { ThreadItemView } from "@/api/thread";
import {
  blockedTasks,
  boardSections,
  budgetStop,
  buildEmberRows,
  cardMeta,
  clockTime,
  emberStatusWords,
  firstDoingTitle,
  flameState,
  headerSummary,
  linkMeta,
  modelList,
  restartCuts,
  rowTitle,
  runEndMs,
  runMs,
  shellSegments,
  shortDuration,
  splitTaskLinks,
  timerRows,
  toggleModel,
  turnEndAfter,
  unclosed,
  unclosedTasks,
  unclosedWords,
  updatedAgo,
  waitingThreads,
  waitingTitle,
  waitingWords,
  wakeLabel,
  withNames,
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
    ["no thread, no worker working", undefined, 0, "idle"],
    ["no thread, a worker working", undefined, 1, "working"],
    ["idle at its prompt", { state: "disconnected", status: "idle" }, 0, "idle"],
    ["idle with workers working", { state: "disconnected", status: "idle" }, 2, "working"],
    ["busy", { state: "connected", status: "busy" }, 2, "thinking"],
    ["starting", { state: "starting", status: "idle" }, 0, "thinking"],
    ["a reply not seen", { state: "disconnected", status: "attention" }, 1, "attention"],
    ["a prompt while busy", { state: "connected", status: "attention" }, 0, "attention"],
  ] as const)("%s", (_n, t, working, want) => {
    expect(flameState(t, working)).toBe(want);
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

/** Timeline items from short specs: "u:id", "w:id" (a wake), "t:id" (text), "b:id" (Bash), "r:id" (Read), "e:id" (turn end), "h:id" (thinking), "p:id:tool" (pending permission on a tool), "q:id" (pending question), "x:id" (inline page), "m:id" (theme card). */
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
      case "q":
        return [{ ...base, kind: "question", requestState: "pending" }];
      case "x":
        return [{ ...base, kind: "html" }];
      case "m":
        return [{ ...base, kind: "theme" }];
      default:
        return [];
    }
  });
  return { list, wakes };
}

function shape(rows: EmberRow[]): string[] {
  return rows.map((r) => (r.type === "work" ? `work(${r.ids.join(",")})${r.live ? " live" : ""}${r.expanded ? " open" : ""}` : `${r.type}:${"id" in r ? r.id : r.key}`));
}

describe("restartCuts", () => {
  const base = { ordinal: 0, parentToolUseId: "", streaming: false, createdAtMs: NOW, updatedAtMs: NOW };
  const user = (id: string, o: Partial<Extract<ThreadItemView, { kind: "user" }>> = {}): ThreadItemView => ({ ...base, id, kind: "user", text: "", attachments: [], composerText: "", ...o });
  const tool = (id: string, output: string): ThreadItemView => ({ ...base, id, kind: "tool", name: "Bash", inputJson: "{}", status: "error", output, isError: true, resultJson: "", toolUseId: id });
  const cutEnd = (id: string, at = NOW): ThreadItemView => ({ ...base, id, kind: "turnEnd", subtype: "process_ended", interrupted: true, durationMs: 1000, createdAtMs: at }) as unknown as ThreadItemView;
  const okEnd = (id: string): ThreadItemView => ({ ...base, id, kind: "turnEnd", subtype: "success", interrupted: false, durationMs: 1000 }) as unknown as ThreadItemView;
  const err = (id: string): ThreadItemView => ({ ...base, id, kind: "error", text: "Claude stopped unexpectedly (exit code 139)" });
  const log = (...its: ThreadItemView[]) => ({ byId: Object.fromEntries(its.map((i) => [i.id, i])), order: its.map((i) => i.id) });
  const restartWake = (at: string) => ({ title: "The app restarted at 01:26 CDT.", json: JSON.stringify({ kind: "batch", wakes: [{ kind: "restart", restarted_at: at, own_turn_interrupted: true }] }) });

  it("finds a cut by the tool the daemon stopped under", () => {
    expect([...restartCuts(log(user("u"), tool("b", "Interrupted: the daemon stopped."), cutEnd("e", 5)), false)]).toEqual([["e", 5]]);
  });

  it("finds a cut by the next message's resume note or a restart wake, the wake's time first", () => {
    const note = "[code-foundry] Your previous turn was stopped because the Code Foundry app restarted, not rejected by anyone; …";
    expect([...restartCuts(log(user("u"), cutEnd("e", 5), user("u2", { resumeNote: note })), false)]).toEqual([["e", 5]]);
    const at = "2026-10-21T06:26:00Z";
    expect([...restartCuts(log(user("u"), cutEnd("e", 5), user("w", { wake: restartWake(at) })), false)]).toEqual([["e", Date.parse(at)]]);
  });

  it("finds the last turn's cut by Ember's status only while it holds", () => {
    expect([...restartCuts(log(user("u"), cutEnd("e", 5)), true)]).toEqual([["e", 5]]);
    expect([...restartCuts(log(user("u"), cutEnd("e", 5)), false)]).toEqual([]);
    // An earlier cut with no mark is no restart (a close while busy).
    expect([...restartCuts(log(user("u"), cutEnd("e", 5), user("u2"), okEnd("e2")), true)]).toEqual([]);
  });

  it("leaves a crash out: its error says so", () => {
    expect([...restartCuts(log(user("u"), err("x"), cutEnd("e", 5)), true)]).toEqual([]);
    expect([...restartCuts(undefined, true)]).toEqual([]);
  });
});

describe("buildEmberRows", () => {
  const opts = (wakes: Set<string>, o: Partial<Parameters<typeof buildEmberRows>[1]> = {}) => ({ wake: (id: string) => wakes.has(id), expanded: () => undefined, showWork: false, working: false, ...o });

  it("folds every run between visible messages, wakes included; a reply's own turn end is no run", () => {
    const { list, wakes } = items("u:u1", "b:b1", "r:r1", "t:t1", "e:e1", "w:w1", "b:b2", "t:t2", "e:e2", "u:u2", "t:t3", "e:e3");
    expect(shape(buildEmberRows(list, opts(wakes)))).toEqual(["user:u1", "work(b1,r1)", "text:t1", "work(e1,w1,b2)", "text:t2", "user:u2", "text:t3"]);
  });

  it("opens runs with Show work, the user's choice winning; open runs are followed by their rows", () => {
    const { list, wakes } = items("u:u1", "b:b1", "t:t1", "e:e1", "u:u2", "b:b2", "t:t2", "e:e2");
    const rows = buildEmberRows(list, opts(wakes, { showWork: true, expanded: (k) => (k === "w:b2" ? false : undefined) }));
    expect(shape(rows)).toEqual(["user:u1", "work(b1) open", "tool:b1", "text:t1", "user:u2", "work(b2)", "text:t2"]);
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

  it("draws no row for a wake Ember only thought about; one it replied to keeps its row; thinking alone still is a run", () => {
    const { list, wakes } = items("u:u1", "h:h1", "t:t1", "e:e1", "w:w1", "h:h2", "t:t2", "e:e2", "w:w2", "b:b1", "t:t3", "e:e3", "w:w3", "h:h3", "e:e4", "u:u2");
    expect(shape(buildEmberRows(list, opts(wakes)))).toEqual(["user:u1", "work(h1)", "text:t1", "work(e1,w1,h2)", "text:t2", "work(e2,w2,b1)", "text:t3", "user:u2"]);
    // While it is live, the row stands: Ember may still run a tool.
    const live = items("u:u1", "t:t1", "e:e1", "w:w1", "h:h1");
    expect(shape(buildEmberRows(live.list, opts(live.wakes, { working: true })))).toEqual(["user:u1", "text:t1", "work(e1,w1,h1) live"]);
  });

  it("ends a run where the app's restart cut it, with a restart line", () => {
    const { list, wakes } = items("u:u1", "h:h1", "b:b1", "e:e1", "u:u2", "t:t1", "e:e2");
    const rows = buildEmberRows(list, opts(wakes, { cuts: new Map([["e1", 1234]]) }));
    expect(shape(rows)).toEqual(["user:u1", "work(h1,b1,e1)", "restart:r:e1", "user:u2", "text:t1"]);
    expect(rows[2]).toEqual({ type: "restart", key: "r:e1", atMs: 1234 });
    // A cut with nothing run before it still says so.
    const bare = items("u:u1", "e:e1");
    expect(shape(buildEmberRows(bare.list, opts(bare.wakes, { cuts: new Map([["e1", null]]) })))).toEqual(["user:u1", "restart:r:e1"]);
  });

  it("shows only a turn's last text, once the turn ended or waits on the user; the rest is work", () => {
    const cases: { name: string; specs: string[]; working?: boolean; want: string[] }[] = [
      { name: "text, tool, final text", specs: ["u:u1", "t:t1", "b:b1", "t:t2", "e:e1"], want: ["user:u1", "work(t1,b1)", "text:t2"] },
      { name: "a live turn's trailing text", specs: ["u:u1", "b:b1", "t:t1"], working: true, want: ["user:u1", "work(b1,t1) live"] },
      { name: "a trailing text with no turn end, not working", specs: ["u:u1", "b:b1", "t:t1"], want: ["user:u1", "work(b1,t1)"] },
      { name: "text before a pending question", specs: ["u:u1", "b:b1", "t:t1", "q:q1"], want: ["user:u1", "work(b1)", "text:t1", "question:q1"] },
      { name: "text before a tool waiting on a permission", specs: ["u:u1", "t:t1", "b:b1", "p:x:b1"], want: ["user:u1", "text:t1", "tool:b1"] },
      { name: "two texts before a turn end", specs: ["u:u1", "t:t1", "t:t2", "e:e1"], want: ["user:u1", "work(t1)", "text:t2"] },
      { name: "a reply, its turn end, then a wake", specs: ["u:u1", "b:b1", "t:t1", "e:e1", "w:w1", "b:b2"], want: ["user:u1", "work(b1)", "text:t1", "work(e1,w1,b2)"] },
      { name: "a text a later message follows before any turn end", specs: ["u:u1", "t:t1", "u:u2", "t:t2", "e:e1"], want: ["user:u1", "work(t1)", "user:u2", "text:t2"] },
      { name: "a page shows and closes the run", specs: ["u:u1", "b:b1", "x:x1", "b:b2", "t:t1", "e:e1"], want: ["user:u1", "work(b1)", "html:x1", "work(b2)", "text:t1"] },
      { name: "a page after the reply leaves it the reply", specs: ["u:u1", "b:b1", "t:t1", "x:x1", "e:e1"], want: ["user:u1", "work(b1)", "text:t1", "html:x1"] },
      { name: "a theme card shows; the text after it stays the reply", specs: ["u:u1", "t:t1", "m:m1", "t:t2", "e:e1"], want: ["user:u1", "work(t1)", "theme:m1", "text:t2"] },
    ];
    for (const c of cases) {
      const { list, wakes } = items(...c.specs);
      expect(shape(buildEmberRows(list, opts(wakes, { working: c.working ?? false }))), c.name).toEqual(c.want);
    }
  });

  it("draws the reply as the thread's text row and a page open", () => {
    const { list, wakes } = items("u:u1", "x:x1", "t:t1", "e:e1");
    const rows = buildEmberRows(list, opts(wakes));
    expect(rows[1]).toEqual({ type: "html", key: "x1", id: "x1", folded: false });
    expect(rows[2]).toEqual({ type: "text", key: "t1", id: "t1", final: true, answer: "t1" });
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
    expect(workSummary([bash("1", "make check", 0), bash("2", "pnpm build", 1)])).toBe("ran 2 commands");
  });

  // Commands Ember ran in the round-2 battle test (/tmp/ember-r2, e1, e4, e11).
  it.each([
    [
      "a request turn: reads chained, then the board",
      ["cd /Users/alex/m && git log --oneline -5 && git ls-files | head -80 && cat package.json", 'cd /Users/alex/m && git remote -v; cat src/types/index.ts; sed -n 1,200p src/store/useStore.ts; grep -n "" src/routes/habits.tsx | head -60; code-foundry thread list --project 20236aea7a4d'],
      "read 3 files, searched once, read 1 thread, checked git",
    ],
    [
      "three workers started in one call, prompts in heredocs",
      [
        "P=20236aea7a4d; T=t-39cd46bb\nCOMMON='Verify with `pnpm build`; stage only your files && push.'\n\ncode-foundry ember task start \"Habit colour\" --project $P --parent $T --prompt - <<'EOF'\nAdd a colour; then run tests && lint.\ngit log is yours\nEOF\ncode-foundry ember task start \"Sort select\" --project $P --parent $T --prompt - <<'EOF'\nSort; done.\nEOF\ncode-foundry ember task start \"About route\" --project $P --parent $T --prompt - <<EOF\nAbout.\nEOF",
      ],
      "started 3 workers",
    ],
    [
      "a wake's branch check with a variable",
      ["W=/private/tmp/wt/feat-habit-colour-picker; git -C $W log --oneline -2 origin/feat/habit-colour-picker; git -C $W diff origin/main...origin/feat/habit-colour-picker --stat", 'code-foundry ember task done t-628cf6a5 "Pushed feat/habit-colour-picker (597a804), no PR; build passes; lint ok." --branch feat/habit-colour-picker'],
      "closed 1 task, checked 1 branch",
    ],
    [
      "the merge checks over two checkouts and a loop",
      [
        'W=/tmp/wt/sort; git -C $W fetch -q origin; git -C $W log --oneline -2 origin/feat/habits-sort-select; for a in x y; do for b in x y; do [ "$a" \\< "$b" ] && { git -C $W merge-tree --write-tree origin/$a origin/$b >/dev/null && echo ok || echo CONFLICT; }; done; done',
        "git -C /tmp/wt/about log -1 origin/feat/about-route",
      ],
      "checked 2 branches",
    ],
    [
      "a steer: a change sent and the board updated, in one call",
      ['code-foundry thread send --id s-ember-notes "Use a markdown description, not notes" && code-foundry thread rename --id s-ember-notes "Markdown description"; code-foundry ember task update t-e44e62e6 --title "Add markdown description field"'],
      "sent a change to Release notes for 0.20, updated the board, ran 1 command",
    ],
    [
      "the post-merge turn",
      ["code-foundry ember task update t-1 --state done; code-foundry thread archive --id s-1 --yes; code-foundry project worktree cleanup --project m"],
      "updated the board, archived 1 thread, cleaned up worktrees",
    ],
    ["changes to two workers", ['code-foundry thread send s-a "x"', "code-foundry thread send --id s-b - <<'EOF'\ny; z\nEOF"], "sent changes to 2 workers"],
  ])("%s", (_name, commands, want) => {
    const names: Record<string, string> = { "s-ember-notes": "Release notes for 0.20" };
    expect(workSummary(commands.map((c, i) => bash(String(i), c, i)), (id) => names[id] ?? "")).toBe(want);
  });

  it("splits a command into simple commands outside quotes and heredocs", () => {
    expect(shellSegments("a && b; c || d\ne | f")).toEqual(["a", "b", "c", "d", "e | f"]);
    expect(shellSegments(`echo "x; y && z" ; b`)).toEqual([`echo "x; y && z"`, "b"]);
    expect(shellSegments("cat <<'EOF' | x\nbody; not && this\nEOF\nafter")).toEqual(["cat <<'EOF' | x", "after"]);
    expect(shellSegments(`echo "a << b"\nc`)).toEqual([`echo "a << b"`, "c"]);
    expect(shellSegments("a \\\n  --flag; # note\nb")).toEqual(["a    --flag", "b"]);
  });

  it.each([
    ["a thread wake", { title: 'Thread "Notes" (s-1) is idle: finished.', json: JSON.stringify({ kind: "thread", thread: { id: "s-1", name: "Notes" } }) }, "wake from Notes"],
    ["a thread wake without JSON", { title: 'Thread "Lead: notes API" (s-l) reported progress.', json: "{}" }, "wake from Lead: notes API"],
    ["a timer", { title: "Timer sub-1 fired at 09:30 CDT.", json: JSON.stringify({ kind: "timer", subscription_id: "sub-1" }) }, "timer"],
    ["a timer with a note", { title: "Timer sub-1 fired.", json: JSON.stringify({ kind: "timer", note: "review reminder" }) }, "timer: review reminder"],
    ["a batch from one thread", { title: "", json: JSON.stringify({ kind: "batch", wakes: [{ kind: "thread", thread: { name: "A" } }, { kind: "thread", thread: { name: "A" } }] }) }, "wake from A"],
    ["a batch from two", { title: "", json: JSON.stringify({ kind: "batch", wakes: [{ kind: "thread", thread: { name: "A" } }, { kind: "thread", thread: { name: "B" } }] }) }, "2 wakes"],
    ["a restart notice", { title: "The app restarted at 10:45 CDT.", json: JSON.stringify({ kind: "batch", wakes: [{ kind: "restart" }, { kind: "thread", thread: { name: "A" } }] }) }, "restart, wake from A"],
    ["anything else", { title: "", json: "not json" }, "1 wake"],
  ])("labels %s", (_n, w, want) => {
    expect(wakeLabel(w)).toBe(want);
  });

  it("leads a wake run with what woke it", () => {
    const from = (id: string, name: string, sec: number): ThreadItemView => ({ ...wake(id, sec), wake: { title: "", json: JSON.stringify({ kind: "thread", thread: { name } }) } }) as ThreadItemView;
    expect(workSummary([from("w", "Habit colour", 0), bash("1", "code-foundry ember task done t-1 x --branch b", 1)])).toBe("wake from Habit colour, closed 1 task");
    expect(workSummary([from("w1", "A", 0), from("w2", "A", 1)])).toBe("2 wakes from A");
    expect(workSummary([from("w1", "A", 0), from("w2", "B", 1)])).toBe("2 wakes");
  });

  it("ends a run at its last item", () => {
    expect(runEndMs([bash("1", "x", 0, 3), end("e", 10)])).toBe(at(10));
    expect(runEndMs([])).toBeNull();
    const time = new Date(at(0)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    expect(clockTime(at(0), at(0))).toBe(time);
    // Another day's carries its date.
    expect(clockTime(at(0), at(0) + 2 * 24 * 3600_000)).toMatch(new RegExp(`.+ ${time}$`));
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
    expect(headerSummary(all)).toEqual({ text: "2 threads working · 1 blocked · 2 queued", dot: "amber" });
    expect(headerSummary(all, 1).text).toBe("2 threads working · 1 blocked · 2 queued · 1 scheduled");
    expect(firstDoingTitle(all)).toBe("Wait on threads");
    expect(rowTitle(all)).toBe("Wait on threads");
    expect(linkMeta(all, "t-p")).toEqual({ parts: ["in progress", "3 pieces", "2 working"], waiting: false });
    expect(linkMeta(all, "t-n").parts).toEqual(["up next"]);
    expect(linkMeta(all, "t-gone").parts).toEqual([]);
    expect(emberStatusWords({ state: "disconnected", status: "idle", statusReason: "at prompt", statusChangedAtMs: null }, { working: 1, doing: 1 })).toEqual({ text: "Working", tone: "sky" });
    expect(emberStatusWords({ state: "disconnected", status: "idle", statusReason: "at prompt", statusChangedAtMs: null }, { working: 0, doing: 0 })).toEqual({ text: "Idle", tone: "muted" });
    expect(emberStatusWords({ state: "connected", status: "attention", statusReason: "permission: Bash", statusChangedAtMs: null }, { working: 0, doing: 0 })).toEqual({ text: "Needs input", tone: "amber" });
  });

  it("says needs you on a link while one of its workers waits on the user", () => {
    const asks = task("t-s2", { title: "CLI", state: "doing", parentId: "t-p", threadId: "s-b", thread: thread({ id: "s-b", status: "attention", statusReason: "question: which flag?" }) });
    expect(linkMeta([parent, subDone, asks], "t-p")).toEqual({ parts: ["needs you", "2 pieces", "1 working"], waiting: true });
    expect(linkMeta([parent, subDone, asks], "t-s2")).toEqual({ parts: ["needs you"], waiting: true });
  });

  it("lists a done subtask's outcome and branch, names the worker row only when it says more than the title", () => {
    const own = thread({ id: "s-o", name: "Bump wails to v3.1", state: "disconnected", status: "attention", statusReason: "finished" });
    const doneParent = task("t-dp", { title: "Bump Wails to v3.1!", state: "done", doneAtMs: NOW - MIN, threadId: "s-o", thread: own });
    const piece = task("t-dp1", { title: "Go side", state: "done", parentId: "t-dp", outcome: "Bumped; tests pass", branch: "cf/wails-go", doneAtMs: NOW - MIN });
    const dropped = task("t-dp2", { title: "Docs", state: "cancelled", parentId: "t-dp" });
    const [card] = boardSections([doneParent, piece, dropped], NOW).doneToday;
    expect((card ? workerRows(card) : []).map((r) => [r.title, r.meta.text, r.branch, r.outcome])).toEqual([
      ["Worker", "Finished", "", ""],
      ["Go side", "done", "cf/wails-go", "Bumped; tests pass"],
      ["Docs", "cancelled", "", ""],
    ]);
  });

  it("puts names for the thread ids a lead's report gives", () => {
    const team = [
      { id: "s-b9fb31a8c2d1", name: "Habit colour", state: "connected" as const, status: "busy" as const, statusReason: "working", reportStatus: null, reportSummary: "", lastActivityAtMs: NOW, depth: 1 },
      { id: "s-0a1b2c3d4e5f", name: "", state: "connected" as const, status: "busy" as const, statusReason: "working", reportStatus: null, reportSummary: "", lastActivityAtMs: NOW, depth: 1 },
    ];
    const lead = task("t-ld", { title: "Six pieces", state: "doing", threadId: "s-ld", thread: thread({ id: "s-ld", name: "Lead for six pieces", status: "idle", statusReason: "waiting on 2 child threads", reportStatus: "progress", reportSummary: "2 workers started: s-b9fb31a8c2d1, s-0a1b2c3d4e5f", descendants: team, descendantsTotal: 2, descendantsWorking: 2 }) });
    const [card] = boardSections([lead], NOW).inProgress;
    expect(card && workerRows(card)[0]?.meta.text).toBe("2 workers started: Habit colour, s-0a1b2c3d4e5f");
    expect(withNames("see s-zz", new Map())).toBe("see s-zz");
  });

  it.each([
    [NOW - 20_000, "updated just now"],
    [NOW - 4 * MIN, "updated 4m ago"],
    [NOW - 125 * MIN, "updated 2h ago"],
    [NOW - 50 * 60 * MIN, "updated 2d ago"],
  ])("labels a worker's age (%i)", (at, want) => {
    expect(updatedAgo(at, NOW)).toBe(want);
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
    expect(headerSummary([lead, sub])).toEqual({ text: "1 needs you · 4 threads working", dot: "amber" });
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
    expect(emberStatusWords(idle, { working: 1, doing: 1, waiting: 1 })).toEqual({ text: "Needs input", tone: "amber" });
    expect(emberStatusWords({ ...idle, state: "connected", status: "busy", statusReason: "working" }, { working: 1, doing: 1, waiting: 1 })).toEqual({ text: "Needs input", tone: "amber" });
    expect(emberStatusWords({ ...idle, status: "attention", statusReason: "finished" }, { working: 1, doing: 1, waiting: 1 })).toEqual({ text: "Needs input", tone: "amber" });
    expect(emberStatusWords({ ...idle, status: "error", statusReason: "crashed" }, { working: 1, doing: 1, waiting: 1 }).tone).toBe("red");
    expect(emberStatusWords({ ...idle, status: "attention", statusReason: "finished" }, { working: 1, doing: 1, waiting: 0 })).toEqual({ text: "Finished", tone: "emerald" });
    // A budget stop says so, with the amount when the reason has one.
    expect(emberStatusWords(idle, { working: 1, doing: 1, waiting: 1, waitingWords: { text: "Stopped at budget", tone: "amber" } })).toEqual({ text: "Stopped at budget", tone: "amber" });
  });

  it("names the waiting worker's task on the row, +N for more", () => {
    // s-2 (the lead's team) asks: the lead's task.
    expect(waitingTitle([lead, sub])).toBe("Lead the API work");
    expect(rowTitle([lead, sub])).toBe("Lead the API work");
    // A subtask's own worker asking is named before a lead whose team asks.
    const asks = task("t-q", { title: "Translate /profile", state: "doing", parentId: "t-l", threadId: "s-q", thread: thread({ id: "s-q", status: "attention", statusReason: "question: es or es-MX?" }) });
    expect(waitingTitle([lead, sub, asks])).toBe("Translate /profile +1");
    expect(waitingTitle([sub])).toBe("");
    expect(rowTitle([sub])).toBe("Subtask");
    expect(waitingWords([lead, sub])).toEqual({ text: "Needs input", tone: "amber" });
    expect(waitingWords([sub])).toBeNull();
  });
});

describe("blocked tasks, timers and budget stops", () => {
  const blockedLeaf = task("t-b", { title: "Bump wails", state: "blocked", threadId: "s-b", thread: thread({ id: "s-b", state: "disconnected", status: "attention", statusReason: "finished" }) });
  const parent = task("t-p", { title: "Two pieces", state: "blocked" });
  const piece = task("t-p1", { title: "Piece one", state: "blocked", parentId: "t-p" });
  const asking = task("t-a", { title: "Asks", state: "blocked", threadId: "s-a", thread: thread({ id: "s-a", status: "attention", statusReason: "question: which?" }) });

  it("counts blocked pieces, not their rolled-up parent nor one whose worker asks", () => {
    expect(blockedTasks([blockedLeaf])).toBe(1);
    expect(blockedTasks([parent, piece])).toBe(1);
    expect(blockedTasks([asking])).toBe(0);
    expect(rowTitle([parent, piece])).toBe("Piece one");
  });

  it("says Nothing in progress only when nothing waits, works, is blocked, queued or scheduled", () => {
    expect(headerSummary([blockedLeaf])).toEqual({ text: "1 blocked", dot: "amber" });
    expect(headerSummary([asking])).toEqual({ text: "1 needs you", dot: "amber" });
    expect(headerSummary([], 2)).toEqual({ text: "2 scheduled", dot: "" });
    // A doing task whose worker finished (Ember has not closed it yet) is still in progress.
    const finished = task("t-f", { state: "doing", threadId: "s-f", thread: thread({ id: "s-f", state: "disconnected", status: "attention", statusReason: "finished" }) });
    expect(headerSummary([finished])).toEqual({ text: "1 in progress", dot: "" });
    expect(headerSummary([task("t-d", { state: "done" })])).toEqual({ text: "", dot: "" });
  });

  it("reads Blocked on the row below Ember's own words and a doing task's Working", () => {
    const idle = { state: "disconnected" as const, status: "idle" as const, statusReason: "at prompt", statusChangedAtMs: null };
    expect(emberStatusWords(idle, { working: 0, doing: 0, blocked: 1 })).toEqual({ text: "Blocked", tone: "amber" });
    expect(emberStatusWords(idle, { working: 2, doing: 2, blocked: 1 })).toEqual({ text: "Working", tone: "sky" });
    expect(emberStatusWords({ ...idle, state: "connected", status: "busy", statusReason: "working" }, { working: 0, doing: 0, blocked: 1 })).toEqual({ text: "Working", tone: "sky" });
    // A turn the app's restart cut: amber, not a bare red Error.
    expect(emberStatusWords({ ...idle, status: "error", statusReason: "interrupted" }, { working: 0, doing: 0 })).toEqual({ text: "Interrupted", tone: "amber" });
  });

  it.each([
    ["budget reached", "Stopped at budget"],
    ["budget reached: $0.21 of $0.20", "Stopped at budget · $0.21 of $0.20"],
    ["budget reached ($1.50)", "Stopped at budget · $1.50"],
  ])("words a budget stop (%s)", (reason, want) => {
    const th = thread({ status: "attention", statusReason: reason, state: "connected" });
    expect(budgetStop(th)).not.toBeNull();
    expect(workerWords(th)).toEqual({ text: want, tone: "amber" });
    expect(waitingWords([task("t-x", { state: "doing", threadId: th.id, thread: th })])).toEqual({ text: want, tone: "amber" });
  });

  it("is no budget stop for another reason", () => {
    expect(budgetStop(thread({ status: "attention", statusReason: "question: budget?" }))).toBeNull();
    expect(budgetStop(thread({ status: "busy", statusReason: "budget reached" }))).toBeNull();
  });
});

describe("idle workers and tasks waiting on Ember", () => {
  const ember = { state: "disconnected" as const, status: "idle" as const, statusReason: "at prompt", statusChangedAtMs: null };
  const reported = (over: Partial<EmberTaskThreadView> = {}) =>
    thread({ id: "s-r", state: "connected", status: "attention", statusReason: "finished", reportStatus: "done", reportSummary: "pushed cf/notes", reportAtMs: NOW - MIN, ...over });
  const toCheck = task("t-r", { title: "Notes field", state: "doing", threadId: "s-r", thread: reported() });
  const idleNoReport = task("t-i", { title: "Idle worker", state: "doing", threadId: "s-i", thread: thread({ id: "s-i", state: "disconnected", status: "idle", statusReason: "at prompt" }) });
  const busy = task("t-w", { title: "Busy worker", state: "doing", threadId: "s-w", thread: thread() });

  // What the flame and the row derive from a board: the threads working, the tasks waiting on Ember alone, the row's words and title.
  it.each([
    ["a worker on a turn", [busy], 1, 0, "working", "Working", "Busy worker"],
    ["a worker that reported done and is idle", [toCheck], 0, 1, "idle", "To check", "Notes field"],
    ["the same, its process stopped", [task("t-r", { ...toCheck, thread: reported({ state: "disconnected" }) })], 0, 1, "idle", "To check", "Notes field"],
    ["a stale bare waiting reason", [task("t-r", { ...toCheck, thread: reported({ status: "idle", statusReason: "waiting" }) })], 0, 1, "idle", "To check", "Notes field"],
    ["a worker idle without a report", [idleNoReport], 0, 0, "idle", "Worker idle", "Idle worker"],
    ["a lead waiting on its running children", [task("t-l", { title: "Lead", state: "doing", threadId: "s-l", thread: thread({ id: "s-l", status: "idle", statusReason: "waiting on 2 child threads", descendantsWorking: 2, descendantsTotal: 2 }) })], 3, 0, "working", "Working", "Lead"],
    ["a reported worker whose team still works", [task("t-l", { title: "Lead", state: "doing", threadId: "s-l", thread: reported({ id: "s-l", descendantsWorking: 1, descendantsTotal: 1 }) })], 1, 0, "working", "Working", "Lead"],
    ["one working, one to check: Working names the working one", [toCheck, busy], 1, 1, "working", "Working", "Busy worker"],
    ["a parent whose pieces all closed", [task("t-p", { title: "Two pieces", state: "doing" }), task("t-p1", { state: "done", parentId: "t-p" }), task("t-p2", { state: "cancelled", parentId: "t-p" })], 0, 1, "idle", "To check", "Two pieces"],
  ] as const)("%s", (_n, tasks, working, check, flame, words, title) => {
    expect(workingThreads(tasks)).toBe(working);
    expect(unclosedTasks(tasks)).toBe(check);
    expect(flameState(ember, workingThreads(tasks), waitingThreads(tasks))).toBe(flame);
    const doing = tasks.filter((t) => t.state === "doing").length;
    expect(emberStatusWords(ember, { working, toCheck: check, doing }).text).toBe(words);
    expect(rowTitle(tasks)).toBe(title);
  });

  it.each([
    ["reported done, idle", toCheck, "report"],
    ["reported failed, still doing", task("t-r", { ...toCheck, thread: reported({ reportStatus: "failed" }) }), "report"],
    ["archived after its report", task("t-r", { ...toCheck, thread: reported({ archived: true }) }), "report"],
    ["busy again after its report", task("t-r", { ...toCheck, thread: reported({ status: "busy", statusReason: "working" }) }), null],
    ["asking the user after its report", task("t-r", { ...toCheck, thread: reported({ statusReason: "question: which flag?" }) }), null],
    ["a team member asking", task("t-r", { ...toCheck, thread: reported({ descendantsWaiting: 1, descendantsTotal: 1 }) }), null],
    ["a progress report", task("t-r", { ...toCheck, thread: reported({ reportStatus: "progress" }) }), null],
    ["no report (or a stale one: the daemon leaves it out)", idleNoReport, null],
    ["removed", task("t-r", { ...toCheck, thread: reported({ removed: true }) }), null],
    ["blocked", task("t-r", { ...toCheck, state: "blocked" }), null],
    ["done", task("t-r", { ...toCheck, state: "done" }), null],
  ] as const)("unclosed: %s", (_n, t, want) => {
    expect(unclosed(t, [t])).toBe(want);
  });

  it("words the card, its worker row, the header and a link", () => {
    const [card] = boardSections([toCheck], NOW).inProgress;
    expect(card && cardMeta(card)).toEqual({ text: "reported done", tone: "emerald" });
    expect(unclosedWords(toCheck, [toCheck])).toBe("Worker reported done, waiting for Ember to check");
    // The worker's row: an emerald dot, not the doing task's sky.
    expect((card ? workerRows(card) : []).map((r) => [r.dot, r.meta.text])).toEqual([["done", "pushed cf/notes"]]);
    const [idleCard] = boardSections([idleNoReport], NOW).inProgress;
    expect((idleCard ? workerRows(idleCard) : []).map((r) => r.dot)).toEqual(["open"]);
    expect(headerSummary([toCheck, busy])).toEqual({ text: "1 thread working · 1 to check", dot: "sky" });
    expect(headerSummary([toCheck])).toEqual({ text: "1 to check", dot: "" });
    expect(linkMeta([toCheck], "t-r").parts).toEqual(["worker reported done, waiting for Ember to check"]);
    const parent = task("t-p", { title: "Two pieces", state: "doing" });
    const piece = task("t-p1", { ...toCheck, id: "t-p1", parentId: "t-p" });
    expect(linkMeta([parent, piece, task("t-p2", { state: "done", parentId: "t-p" })], "t-p").parts).toEqual(["in progress", "2 pieces", "1 to check"]);
    expect(linkMeta([parent, task("t-p2", { state: "done", parentId: "t-p" })], "t-p").parts).toEqual(["all pieces closed, waiting for Ember to close it", "1 piece"]);
  });

  it("reads a bare waiting reason as idle, a lead's as working", () => {
    expect(workerWords(thread({ status: "idle", statusReason: "waiting" }))).toEqual({ text: "Idle", tone: "muted" });
    expect(workerWords(thread({ status: "idle", statusReason: "waiting on 1 child thread" }))).toEqual({ text: "Working", tone: "sky" });
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

describe("the Scheduled section", () => {
  const timer = (id: string, at: number | null, every = "", note = ""): EmberTimerView => ({ id, nextAtMs: at, every, note });

  it.each([
    ["a one-shot today with a note", timer("sub-1", NOW + 32 * MIN, "", "Remind the user to review the PWA branch (t-aa39dec3)"),
      { id: "sub-1", when: "3:32 PM", every: "", title: "Remind the user to review the PWA branch (t-aa39dec3)", noted: true }],
    ["a repeating one", timer("sub-2", NOW + 2 * MIN, "2m", "ping"), { id: "sub-2", when: "3:02 PM", every: "every 2m", title: "ping", noted: true }],
    ["no note", timer("sub-3", NOW + 60 * MIN), { id: "sub-3", when: "4:00 PM", every: "", title: "Reminder", noted: false }],
    ["tomorrow", timer("sub-4", NOW + 24 * 60 * MIN), { id: "sub-4", when: "Wed 3:00 PM", every: "", title: "Reminder", noted: false }],
    ["no time", timer("sub-5", null), { id: "sub-5", when: "", every: "", title: "Reminder", noted: false }],
  ])("%s", (_name, t, want) => {
    expect(timerRows([t], NOW)).toEqual([want]);
  });

  it("puts the soonest first and one without a time last", () => {
    const rows = timerRows([timer("sub-c", null), timer("sub-b", NOW + 60 * MIN), timer("sub-a", NOW + 5 * MIN)], NOW);
    expect(rows.map((r) => r.id)).toEqual(["sub-a", "sub-b", "sub-c"]);
    expect(timerRows([], NOW)).toEqual([]);
  });
});
