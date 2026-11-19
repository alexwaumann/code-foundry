/**
 * A lead's turns its own workers started, read as one turn (docs/notes/worker-card.md).
 *
 * A thread that created worker threads is woken each time one reports, asks or finishes,
 * and each wake is a full turn: a "Woken by …" note, a "Worked for …" header, a reply. Here
 * a **run** is the turns of this thread that its workers started (their wakes, a worker's
 * `thread ask`, a worker's `thread send`) after a turn the user started and up to the
 * user's next message. In place of each of those turns' note and header the run has one
 * card where it begins (right after the user's turn), and the replies stack under it:
 * a turn of the run that ended with a message leaves that message and its gutter (whose
 * steps count opens the turn's work); one with nothing for the user leaves nothing.
 *
 * The user's next message freezes the card: it keeps the lines as they were then and folds
 * to its title. A new run starts under the new turn, and its card shows every worker still
 * running plus any that did something since that message.
 *
 * Out of the card, rendered as before: turns other threads started (a creator, another
 * lead), and wakes that are not a thread's (a pull request, a timer, an action run, a
 * plugin, a restart notice). They sit among the stacked replies in order and neither end
 * nor join the run. A message from this thread's creator counts as the user's: the creator
 * gives this thread its tasks, as the user does.
 *
 * Pure: rows in, rows out (`workerRuns`), plus the sender descriptor a user message's
 * timeline item carries (`senderOf`) and a worker's state now (`workerNowOf`).
 */
import type { ThreadItemView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";
import { lineageStatus } from "./lineage";
import type { RowTone } from "./statusRegistry";
import { statusLine } from "./statusLine";
import { decodeSent, peerStart, peerWords, type PeerEvent } from "./peerLines";
import type { PeerRow, TimelineRow, WorkerLine, WorkerState, WorkersRow } from "./threadTimeline";
import { wakeLines } from "./wake";

/**
 * What a part of a wake says about a thread: `done` its turn ended, `fail` it failed,
 * `wait` it waits on someone (a permission prompt, a question, a blocked report), `ask` it
 * asked its creator something and keeps working.
 */
type PartState = "done" | "fail" | "wait" | "ask";

/** One thread a wake is about. `createdBy` is the payload's ("" when it has none, an ask's). */
interface WakePart {
  thread: string;
  state: PartState;
  createdBy: string;
}

/**
 * The whole last message of a turn another thread started that had nothing for the user
 * (internal/store/thread NothingNew): Claude Code asks the model again after a turn that
 * ends with no visible text, so the daemon tells a woken thread to end such a turn with this.
 */
export const NOTHING_NEW = "[nothing new]";

/** Whether a text is only the marker (case, spaces, a full stop and backticks aside). */
export function isNothingNew(text: string): boolean {
  return text.trim().replace(/^`|`$/g, "").replace(/\.$/, "").trim().toLowerCase() === NOTHING_NEW;
}

/** A user message's sender, decoded. `wanted`: a thread's message that wants a reply. */
type Sender = { kind: "user" } | { kind: "thread"; id: string; wanted: boolean } | { kind: "wake"; parts: WakePart[]; other: boolean };

/**
 * A user message's sender as one string for its timeline item (lib/threadTimeline
 * TimelineItem.from), so the timeline's structural key changes only when it does: "" the
 * user's own; "m:<id>" another thread's message, "m:<id>/w" one that wants a reply
 * (lib/peerLines); "w:" and the wake's parts, ";" between
 * them: "t/<thread>/<state>/<created_by>" for a thread's wake or ask, "x" for a wake that
 * is no thread's (a run, a pull request, a timer, a plugin, a restart notice).
 */
export function senderOf(it: ThreadItemView): string {
  if (it.kind !== "user") return "";
  if (it.wake) {
    return `w:${wakeLines(it.wake)
      .map((l) => (l.threadId ? `t/${l.threadId}/${partState(l.tone, l.detail)}/${l.createdBy}` : "x"))
      .join(";")}`;
  }
  return it.from ? `m:${it.from.threadId}${it.from.reply === "wanted" ? "/w" : ""}` : "";
}

function partState(tone: "ok" | "attention" | "fail", detail: string): PartState {
  if (detail === "asks" || detail === "answered" || detail === "skipped") return "ask"; // the user's answer to its passed-up question: it works on
  return tone === "ok" ? "done" : tone === "fail" ? "fail" : "wait";
}

const PART_STATES: ReadonlySet<string> = new Set<PartState>(["done", "fail", "wait", "ask"]);

function decodeSender(from: string | undefined): Sender {
  if (!from) return { kind: "user" };
  if (from.startsWith("m:")) {
    const [id = "", mark = ""] = from.slice(2).split("/");
    return { kind: "thread", id, wanted: mark === "w" };
  }
  if (!from.startsWith("w:")) return { kind: "user" };
  const parts: WakePart[] = [];
  let other = false;
  for (const p of from.slice(2).split(";")) {
    const [t, thread = "", state = "", createdBy = ""] = p.split("/");
    if (t === "t" && thread && PART_STATES.has(state)) parts.push({ thread, state: state as PartState, createdBy });
    else other = true;
  }
  return { kind: "wake", parts, other };
}

/** A worker as the threads store has it now: what a live card's line shows. */
export interface WorkerNow {
  id: string;
  createdAtMs: number | null;
  /** Its state now in a card's words; "working" also while it waits on its own children. */
  state: WorkerState;
  /** When that state began (the status change); null when unknown. */
  sinceMs: number | null;
}

/** A thread's state in a card line's terms (lineageStatus, with a question apart from other asks). */
export function workerNowOf(t: ThreadView): WorkerNow {
  const base = { id: t.id, createdAtMs: t.createdAtMs, sinceMs: t.statusChangedAtMs };
  if (t.archivedAtMs !== null) return { ...base, state: "archived" };
  const kind = statusLine(t).kind;
  switch (lineageStatus({ ...t, snoozedUntilMs: null, savedAtMs: null })) {
    case "working":
      return { ...base, state: "working" };
    case "input":
      return { ...base, state: kind === "question" ? "asks" : "needs" };
    case "error":
      return { ...base, state: kind === "interrupted" ? "stopped" : "failed" };
    default:
      return { ...base, state: "finished" };
  }
}

/** A line's state: its word, the dot's tone and whether the word takes the tone (it asks the user for something, or failed). */
export const WORKER_STATES: Readonly<Record<WorkerState, { word: string; tone: RowTone; toned: boolean }>> = {
  working: { word: "working", tone: "info", toned: false },
  needs: { word: "needs you", tone: "warning", toned: true },
  asks: { word: "asks you", tone: "warning", toned: true },
  finished: { word: "finished", tone: "success", toned: false },
  failed: { word: "failed", tone: "error", toned: true },
  stopped: { word: "stopped", tone: "error", toned: false },
  archived: { word: "archived", tone: "muted", toned: false },
};

/** A card's title: "Working with 3 threads" while it is the current one and any line is live, else "Worked with …". */
export function cardTitle(row: Pick<WorkersRow, "lines" | "live">): string {
  const n = row.lines.length;
  const working = row.live && row.lines.some((l) => isLive(l.state));
  return `${working ? "Working" : "Worked"} with ${String(n)} ${n === 1 ? "thread" : "threads"}`;
}

/** Whether a state is a worker still on its work (it counts as running and keeps a card "Working"). */
export function isLive(s: WorkerState): boolean {
  return s === "working" || s === "needs" || s === "asks";
}

export interface RunContext {
  /** This thread's id. */
  self: string;
  /** Its creator's id ("" when the user made it): its messages count as the user's. */
  creator: string;
  /** The threads this thread created, as the threads store has them now. */
  workers: ReadonlyMap<string, WorkerNow>;
  /** The user's fold choice for a frozen card, by its row key; undefined: folded. */
  fold: (key: string) => boolean | undefined;
}

/** A sender's role: the user's (or the creator's), a worker's, or another's (out of the card). */
type Role = "user" | "worker" | "other";

/** A run of rows of one turn (or between turns), with what decides its place. */
interface Block {
  /** The turn's key (its header's `turn`); "" for rows between turns. */
  turn: string;
  rows: TimelineRow[];
  role: Role;
  /** The time of its first message from the user (a user block's): a run's start, the one before's freeze. */
  userAt: number | null;
  ended: boolean;
}

/** A worker's event, from the timeline: a wake part, a message, its creation. */
interface WorkerEvent {
  at: number;
  what: PartState | "message" | "created";
}

/** A worker's line state while replaying its events. */
interface Replay {
  state: WorkerState | "none";
  since: number | null;
  until: number | null;
}

/**
 * The rows of a thread with the turns its workers started read as one card per run, and
 * the other threads it exchanged messages with as one line each (see the file's comment).
 */
export function workerRuns(rows: TimelineRow[], ctx: RunContext): TimelineRow[] {
  const known = new Set(ctx.workers.keys());
  // The answers to this thread's questions to other threads, by their item here.
  const answers = new Set<string>();
  let sent = false;
  for (const r of rows) {
    const s = r.type === "user" || r.type === "steer" ? decodeSender(r.from) : null;
    // A removed worker is no longer listed: its wakes still say who created it. Asks only ever go to the asker's creator.
    if (s?.kind === "wake") for (const p of s.parts) if (p.createdBy === ctx.self || p.state === "ask") known.add(p.thread);
    const d = r.type === "system" ? decodeSent(r.sent) : null;
    if (d) {
      sent = true;
      if (d.replyItem) answers.add(d.replyItem);
    }
  }
  const isWorker = (p: WakePart) => known.has(p.thread);
  const roleOf = (from: string | undefined): Role => {
    const s = decodeSender(from);
    switch (s.kind) {
      case "user":
        return "user";
      case "thread":
        if (s.id === ctx.self || (ctx.creator !== "" && s.id === ctx.creator)) return "user";
        return known.has(s.id) ? "worker" : "other";
      case "wake":
        return !s.other && s.parts.length > 0 && s.parts.every(isWorker) ? "worker" : "other";
    }
  };
  /** The other thread a message came from (not this thread, its creator or a worker); "" for none. */
  const peerOf = (r: TimelineRow): { id: string; wanted: boolean; at: number | null } | null => {
    if (r.type !== "user" && r.type !== "steer") return null;
    const s = decodeSender(r.from);
    return s.kind === "thread" && roleOf(r.from) === "other" ? { id: s.id, wanted: s.wanted, at: r.at ?? null } : null;
  };
  if (known.size === 0 && !sent) return rows;

  const blocks = splitBlocks(rows, roleOf);
  const events = workerEvents(rows, ctx, known);
  const lastBlock = blocks[blocks.length - 1];

  // Runs: from each user block (or the thread's start) to the next.
  const segments: { anchor: Block | null; blocks: Block[] }[] = [{ anchor: null, blocks: [] }];
  for (const b of blocks) {
    if (b.role === "user") segments.push({ anchor: b, blocks: [] });
    else segments.at(-1)?.blocks.push(b);
  }

  const out: TimelineRow[] = [];
  let droppedLatest = false;
  for (const [i, seg] of segments.entries()) {
    const start = seg.anchor?.userAt ?? null;
    const next = segments[i + 1];
    const end = next ? (next.anchor?.userAt ?? null) : null;
    const live = next === undefined;
    const ex = exchanges(seg, peerOf, roleOf, answers);
    const isRun = (b: Block) => b.role === "worker" || ex.run.has(b);
    const runs = seg.blocks.filter((b) => b.role === "worker");
    // Where the card goes: after the user's turn once it ended (or something came after it); with no user turn, at the run.
    const after = seg.anchor && (seg.anchor.ended || seg.blocks.length > 0) ? seg.anchor : null;
    const at = after ?? runs[0] ?? null;
    let card: WorkersRow | null = null;
    if (at) {
      const lines = cardLines(events, ctx.workers, known, start, live ? null : end, live);
      if (lines.length > 0) {
        const key = `w:${at.turn || (at.rows[0]?.key ?? "")}`;
        const ends = lines.flatMap((l) => (l.until !== null ? [l.until] : []));
        card = {
          type: "workers",
          key,
          lines,
          live,
          folded: !live && (ctx.fold(key) ?? true),
          start,
          end: live ? (lines.some((l) => isLive(l.state)) || ends.length === 0 ? null : Math.max(...ends)) : end,
        };
      }
    }
    // The other threads' lines: under the turn that first sent (once it ended, or something came after it), or above the turn an answer opened.
    const segKey = seg.anchor ? seg.anchor.turn || (seg.anchor.rows[0]?.key ?? "") : "";
    const peerRows = (b: Block, before: boolean): TimelineRow[] => {
      if (!before && !b.ended && b === lastBlock) return [];
      return ex.order.flatMap((id) => {
        const place = ex.place.get(id);
        if (place?.block !== b || place.before !== before) return [];
        const w = peerWords(ex.events.get(id) ?? [], live);
        if (!w) return [];
        const row: PeerRow = { type: "peer", key: `p:${segKey}:${id}`, id, ...w, live, start: peerStart(ex.events.get(id) ?? []), end: live ? null : end };
        return [row];
      });
    };
    const shown = (r: TimelineRow) => !ex.hidden.has(r);
    if (seg.anchor) out.push(...seg.anchor.rows.filter(shown));
    if (card && after) out.push(card);
    if (seg.anchor) out.push(...peerRows(seg.anchor, false));
    for (const b of seg.blocks) {
      if (card && !after && b === at) out.push(card);
      out.push(...peerRows(b, true));
      if (!isRun(b)) {
        out.push(...b.rows.filter(shown));
      } else {
        const kept = runRows(b, (r) => (r.type === "steer" && roleOf(r.from) === "worker") || ex.hidden.has(r));
        if (b.rows.some((r) => r.type === "gutter" && r.latest) && !kept.some((r) => r.type === "gutter")) droppedLatest = true;
        out.push(...kept);
      }
      out.push(...peerRows(b, false));
    }
  }
  if (droppedLatest) {
    // The latest turn left nothing: the latest gutter left shows at rest, unless a turn runs after it.
    let last = out.length - 1;
    while (last >= 0 && out[last]?.type !== "gutter") last--;
    const g = out[last];
    if (g?.type === "gutter" && !out.slice(last + 1).some((r) => r.type === "header" && r.id === "")) out[last] = { ...g, latest: true };
  }
  return out;
}

/** A run's exchanges with other threads (lib/peerLines). */
interface Exchanges {
  /** The other threads with a line, in the order their lines began. */
  order: string[];
  /** Each one's events in the run. */
  events: Map<string, PeerEvent[]>;
  /** Where each line goes: above a block (an answer opened it) or under one (it sent there). */
  place: Map<string, { block: Block; before: boolean }>;
  /** Rows a line stands for: the sent notes and the other threads' messages inside the exchange. */
  hidden: Set<TimelineRow>;
  /** Blocks opened only by messages inside an exchange (or a worker's): turns of the run. */
  run: Set<Block>;
}

/**
 * The run's exchanges, in order: a thread is in one from this thread's first message to it
 * in the run, or from the answer to a question this thread asked it earlier (`answers`).
 * Inside one, its messages are the line's and are not drawn; before one, a message from it
 * is drawn (rows.tsx FromRow) and opens a turn of its own, which is no turn of the run.
 */
function exchanges(
  seg: { anchor: Block | null; blocks: Block[] },
  peerOf: (r: TimelineRow) => { id: string; wanted: boolean; at: number | null } | null,
  roleOf: (from: string | undefined) => Role,
  answers: ReadonlySet<string>,
): Exchanges {
  const ex: Exchanges = { order: [], events: new Map(), place: new Map(), hidden: new Set(), run: new Set() };
  const push = (id: string, e: PeerEvent) => {
    const list = ex.events.get(id) ?? [];
    list.push(e);
    ex.events.set(id, list);
  };
  const begin = (id: string, block: Block, before: boolean) => {
    if (ex.place.has(id)) return;
    ex.place.set(id, { block, before });
    ex.order.push(id);
  };
  for (const b of seg.anchor ? [seg.anchor, ...seg.blocks] : seg.blocks) {
    let opening = true;
    let openers = 0;
    let inside = 0;
    for (const r of b.rows) {
      if (r.type !== "user") opening = false;
      const p = peerOf(r);
      if (p) {
        const answer = answers.has(r.key);
        if (answer && !ex.place.has(p.id)) begin(p.id, b, opening);
        push(p.id, { kind: "got", wanted: p.wanted, item: r.key, answer, at: p.at });
        if (ex.place.has(p.id)) {
          ex.hidden.add(r);
          if (opening) inside++;
        }
      }
      if (r.type === "user" && opening) openers++;
      const d = r.type === "system" ? decodeSent(r.sent) : null;
      if (d && r.type === "system") {
        begin(d.to, b, false);
        push(d.to, { kind: "sent", wanted: d.wanted, state: d.state, replyItem: d.replyItem, at: r.at ?? null });
        ex.hidden.add(r);
      }
    }
    // A turn opened by messages inside exchanges, and the rest its workers' (the card's), is a turn of the run.
    if (b.role === "other" && inside > 0) {
      const rest = b.rows.slice(0, openers).filter((r) => !ex.hidden.has(r));
      if (rest.every((r) => r.type === "user" && roleOf(r.from) === "worker")) ex.run.add(b);
    }
  }
  return ex;
}
/**
 * The rows in turns: a block per turn (its opening messages, the setup row, its header,
 * its work and its gutter) and one for the rows between turns (a note, a page shown, a
 * live header with no turn yet).
 */
function splitBlocks(rows: readonly TimelineRow[], roleOf: (from: string | undefined) => Role): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let openers = false;
  const open = (turn: string): Block => {
    const b: Block = { turn, rows: [], role: "other", userAt: null, ended: false };
    blocks.push(b);
    return b;
  };
  for (const r of rows) {
    let b: Block | null = cur;
    if (r.type === "user") {
      if (!b || !openers) b = open(r.id);
      openers = true;
    } else if (r.type === "header") {
      if (!b || b.turn !== r.turn || r.turn === "") b = open(r.turn);
      openers = false;
    } else if (r.type === "setup") {
      b ??= open("");
    } else {
      if (!b || b.ended) b = open("");
      openers = false;
    }
    b.rows.push(r);
    if (r.type === "gutter") b.ended = true;
    cur = b;
  }
  for (const b of blocks) {
    const opening = b.rows.filter((r): r is Extract<TimelineRow, { type: "user" }> => r.type === "user");
    const steers = b.rows.filter((r): r is Extract<TimelineRow, { type: "steer" }> => r.type === "steer");
    const userMsg = [...opening, ...steers].filter((r) => roleOf(r.from) === "user");
    const openRoles = opening.map((r) => roleOf(r.from));
    if (userMsg.length > 0) {
      b.role = "user";
      const times = userMsg.flatMap((r) => (r.at !== undefined ? [r.at] : []));
      b.userAt = times.length > 0 ? Math.min(...times) : null;
    } else if (openRoles.length > 0 && openRoles.every((x) => x === "worker")) b.role = "worker";
  }
  return blocks;
}

/**
 * What a turn of the run leaves: no opening message (its wake or the message) and no
 * header; its work as its fold has it, with what `hide` says the card or a line stands for
 * left out (a worker's message mid-turn, a sent note, an exchange's message); and its
 * gutter, which carries the fold (its steps count is the toggle). A finished turn that
 * shows nothing else leaves nothing, not even its gutter.
 */
function runRows(b: Block, hide: (r: TimelineRow) => boolean): TimelineRow[] {
  const header = b.rows.find((r): r is Extract<TimelineRow, { type: "header" }> => r.type === "header");
  const body = b.rows.filter((r) => r.type !== "user" && r.type !== "header" && !hide(r) && !(r.type === "text" && r.quiet));
  const shown = body.filter((r) => r.type !== "gutter");
  if (b.ended && shown.length === 0) return [];
  const fold = !header?.foldable ? ("none" as const) : header.folded ? ("folded" as const) : ("open" as const);
  return body.map((r) => (r.type === "gutter" ? { ...r, fold } : r));
}

/** Each worker's events in time order: its creation, its wakes, its messages. */
function workerEvents(rows: readonly TimelineRow[], ctx: RunContext, known: ReadonlySet<string>): Map<string, WorkerEvent[]> {
  const ev = new Map<string, WorkerEvent[]>();
  const add = (id: string, e: WorkerEvent) => {
    const list = ev.get(id) ?? [];
    list.push(e);
    ev.set(id, list);
  };
  for (const w of ctx.workers.values()) if (w.createdAtMs !== null) add(w.id, { at: w.createdAtMs, what: "created" });
  for (const r of rows) {
    if ((r.type !== "user" && r.type !== "steer") || r.at === undefined) continue;
    const s = decodeSender(r.from);
    if (s.kind === "thread" && known.has(s.id)) add(s.id, { at: r.at, what: "message" });
    if (s.kind === "wake") for (const p of s.parts) if (known.has(p.thread)) add(p.thread, { at: r.at, what: p.state });
  }
  for (const list of ev.values()) list.sort((a, b) => a.at - b.at);
  return ev;
}

/** A worker's line as its events have it just before `at` (all of them for null). */
function replay(events: readonly WorkerEvent[], at: number | null): Replay {
  let r: Replay = { state: "none", since: null, until: null };
  for (const e of events) {
    if (at !== null && e.at >= at) break;
    const running = r.state !== "none" && isLive(r.state);
    // It works again after a stop: when it was sent more is not in the timeline, so the stretch counts from its stop.
    const since = running ? r.since : (r.until ?? e.at);
    switch (e.what) {
      case "created":
        r = { state: "working", since: e.at, until: null };
        break;
      case "message":
      case "ask":
        r = { state: "working", since, until: null };
        break;
      case "wait":
        r = { state: "needs", since, until: null };
        break;
      case "done":
        r = { state: "finished", since, until: e.at };
        break;
      case "fail":
        r = { state: "failed", since, until: e.at };
        break;
    }
  }
  return r;
}

/**
 * A worker's line just before `at`, its events corrected by what the store says now: a
 * worker that stopped (now not live) at or before `at` was not running then, whatever the
 * last wake said (a worker that settled without waking this thread).
 */
function lineAt(events: readonly WorkerEvent[], now: WorkerNow | undefined, at: number): Replay {
  const r = replay(events, at);
  if (r.state !== "none" && isLive(r.state) && now && !isLive(now.state) && now.sinceMs !== null && now.sinceMs <= at) {
    return { state: now.state === "archived" ? "finished" : now.state, since: r.since, until: now.sinceMs };
  }
  return r;
}

/**
 * A card's lines, in the order the workers were created: every worker that did something
 * in [start, end) (created, a wake, a message), plus every one still running at its start;
 * the current card (end null) also every one running now. A frozen card's lines are as
 * they were at its end; the current card's as the store has them now.
 */
function cardLines(
  events: ReadonlyMap<string, WorkerEvent[]>,
  workers: ReadonlyMap<string, WorkerNow>,
  known: ReadonlySet<string>,
  start: number | null,
  end: number | null,
  live: boolean,
): WorkerLine[] {
  const lines: { line: WorkerLine; order: number }[] = [];
  for (const id of known) {
    const ev = events.get(id) ?? [];
    const now = workers.get(id);
    const inSpan = (t: number) => (start === null || t >= start) && (end === null || t < end);
    const touched = ev.some((e) => inSpan(e.at));
    const carried = start !== null && (() => {
      const r = lineAt(ev, now, start);
      return r.state !== "none" && isLive(r.state);
    })();
    const runningNow = live && now !== undefined && isLive(now.state);
    if (!touched && !carried && !runningNow) continue;
    const order = now?.createdAtMs ?? ev[0]?.at ?? 0;
    if (!live && end !== null) {
      const r = lineAt(ev, now, end);
      if (r.state === "none") continue;
      const state = r.state;
      lines.push({ line: { id, state, since: r.since, until: isLive(state) ? end : r.until }, order });
      continue;
    }
    const r = replay(ev, null);
    if (!now) {
      // Removed: its wakes are all that is left of it.
      if (r.state === "none") continue;
      lines.push({ line: { id, state: r.state, since: r.since, until: r.until }, order });
      continue;
    }
    if (now.state === "working") {
      lines.push({ line: { id, state: "working", since: now.sinceMs ?? r.since, until: null }, order });
    } else if (isLive(now.state)) {
      lines.push({ line: { id, state: now.state, since: r.since ?? now.createdAtMs, until: null }, order });
    } else {
      const ran = r.state !== "none" && !isLive(r.state);
      lines.push({ line: { id, state: now.state, since: r.since ?? now.createdAtMs, until: ran ? r.until : now.sinceMs }, order });
    }
  }
  return lines.sort((a, b) => a.order - b.order || a.line.id.localeCompare(b.line.id)).map((l) => l.line);
}

const STATES: ReadonlySet<string> = new Set<WorkerState>(["working", "needs", "asks", "finished", "failed", "stopped", "archived"]);

/**
 * The threads `self` created, as one string (a line per worker: id, created, state, since),
 * so a selector over the whole threads store changes only when one of them does.
 */
export function workersKey(byId: Readonly<Record<string, ThreadView>>, self: string): string {
  const out: string[] = [];
  for (const t of Object.values(byId)) {
    if (t.createdBy !== self || t.id === self) continue;
    const w = workerNowOf(t);
    out.push([w.id, w.createdAtMs ?? "", w.state, w.sinceMs ?? ""].join("|"));
  }
  return out.sort().join("\n");
}

/** workersKey's string back as the workers by id. */
export function decodeWorkers(key: string): Map<string, WorkerNow> {
  const out = new Map<string, WorkerNow>();
  if (key === "") return out;
  for (const line of key.split("\n")) {
    const [id = "", created = "", state = "", since = ""] = line.split("|");
    if (!id || !STATES.has(state)) continue;
    out.set(id, { id, createdAtMs: created ? Number(created) : null, state: state as WorkerState, sinceMs: since ? Number(since) : null });
  }
  return out;
}
