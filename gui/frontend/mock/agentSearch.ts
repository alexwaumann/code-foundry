/**
 * Mock SearchService (docs/notes/search-5-agent-daemon.md "For PR 6", search-6-agent-gui.md)
 * and the search.* commands: the history (50 entries, Find entries replaced by query) and
 * a scripted agent run over the world's threads. Watch follows the daemon's order: one
 * snapshot (version V), then step/hit/answer/status events with versions V+1…, the stream
 * ending after the status; a finished or Find entry sends its snapshot alone; a change
 * only a snapshot says (opened, seen, promoted) comes as another snapshot; a forgotten
 * entry ends the stream NOT_FOUND. WatchRecent sends the whole list now and after every
 * change. `unseen` turns true when a run ends on its own (not when stopped), false on
 * MarkSeen or Promote.
 *
 * The scripted run (stepMs apart): two searches start and end, a read, then the hits it
 * finds (each a candidate below whose thread exists and whose message has the quote), the
 * answer citing them, DONE. Controls (mock/server.ts):
 *   POST /__mock/search?stepMs=350&fail=1&hits=2   (the next runs' pace, a FAILED end, a hit cap)
 *   POST /__mock/search/seed                       (a history: an agent search 1h old, a Find 1 day old, one 3h old)
 *   GET  /__mock/search                            ({ entries, calls })
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import {
  AgentSearchStepKind,
  SearchMode,
  SearchStatus,
  type AgentSearchHitSchema,
  type AgentSearchStepSchema,
  type SearchEntrySchema,
  type SearchWatchEventSchema,
} from "../src/gen/codefoundry/v1/search_pb";
import type { ThreadItemSchema } from "../src/gen/codefoundry/v1/thread_pb";
import { SearchSpeaker } from "../src/gen/codefoundry/v1/thread_search_pb";
import { CommandError } from "./errors";
import type { InvokeOut } from "./gitops";
import { Hub } from "./hub";

type EntryInit = MessageInitShape<typeof SearchEntrySchema>;
type HitInit = MessageInitShape<typeof AgentSearchHitSchema>;
type StepInit = MessageInitShape<typeof AgentSearchStepSchema>;
type WatchEventInit = MessageInitShape<typeof SearchWatchEventSchema>;
type ItemInit = MessageInitShape<typeof ThreadItemSchema>;

const MAX_ENTRIES = 50;
const MODEL = "claude-sonnet-5-5[1m]";

interface Hit {
  n: number;
  threadId: string;
  itemId: string;
  ordinal: number;
  speaker: SearchSpeaker;
  itemAt: Date | null;
  quote: string;
  why: string;
  opened: boolean;
}

interface Step {
  index: number;
  kind: AgentSearchStepKind;
  done: boolean;
  failed: boolean;
  text: string;
  query: string;
  hits: number;
  threadId: string;
  threadName: string;
}

interface Entry {
  id: string;
  mode: SearchMode;
  query: string;
  createdAt: Date;
  finishedAt: Date | null;
  status: SearchStatus;
  error: string;
  answer: string;
  hits: Hit[];
  steps: Step[];
  model: string;
  costUsd: number;
  durationMs: number;
  unseen: boolean;
  version: number;
  promotedThreadId: string;
  findHits: number;
  /** The run's pending steps (a stop clears them). */
  timers: ReturnType<typeof setTimeout>[];
  events: Hub<WatchEventInit | "gone">;
}

/** A message the scripted run reports when its thread is in the world and its text has the quote. */
interface Candidate {
  threadId: string;
  quote: string;
  why: string;
}

const CANDIDATES: readonly Candidate[] = [
  { threadId: "s-r1", quote: "The fingerprint now includes the head SHA, which the batched GraphQL query already returns", why: "Where the badge fix was decided: the head SHA joined the fingerprint." },
  { threadId: "s-r1", quote: "The PR badge in the sidebar stays green after a force-push", why: "Your report of the stale badge that started it." },
  { threadId: "s-3", quote: "the actor applies a resize only after the pending writes drain", why: "The fix for the resize race." },
  { threadId: "s-1", quote: "The tree now flattens into rows; only the visible rows render.", why: "The sidebar tree became a virtualized list." },
];

export interface SearchDeps {
  /** A thread's name and whether it is archived; undefined when it is not in the world. */
  thread: (id: string) => { name: string; archived: boolean } | undefined;
  items: (id: string) => ItemInit[];
  /** Promote: a thread without a project that starts with the question; its id. */
  promote: (question: string, firstMessage: string) => string;
}

function itemText(it: ItemInit): { text: string; speaker: SearchSpeaker } | null {
  const p = it.payload;
  if (p?.case === "userMessage") return { text: p.value.text ?? "", speaker: SearchSpeaker.USER };
  if (p?.case === "assistantText") return { text: p.value.text ?? "", speaker: SearchSpeaker.ASSISTANT };
  return null;
}

/** Markdown markers out, as the GUI's rendered text reads them (enough for the candidates). */
function rendered(md: string): string {
  return md.replace(/\*\*|`|\[([^\]]*)\]\([^)]*\)/g, (_m, text: string | undefined) => text ?? "").replace(/\s+/g, " ");
}

export class MockSearches {
  private entries = new Map<string, Entry>();
  private readonly recent = new Hub<void>();
  private seq = 0;
  private stepMs = 350;
  private fail = false;
  private hitCap = 8;
  readonly calls: string[] = [];

  constructor(private readonly deps: SearchDeps) {}

  reset(): void {
    for (const e of this.entries.values()) this.cancel(e);
    for (const e of this.entries.values()) e.events.publish("gone");
    this.entries.clear();
    this.stepMs = 350;
    this.fail = false;
    this.hitCap = 8;
    this.calls.length = 0;
    this.recent.publish();
  }

  private newEntry(mode: SearchMode, query: string, createdAt = new Date()): Entry {
    this.seq++;
    return {
      id: `q-${this.seq.toString(16).padStart(12, "0")}`,
      mode,
      query,
      createdAt,
      finishedAt: null,
      status: mode === SearchMode.AGENT ? SearchStatus.RUNNING : SearchStatus.UNSPECIFIED,
      error: "",
      answer: "",
      hits: [],
      steps: [],
      model: mode === SearchMode.AGENT ? MODEL : "",
      costUsd: 0,
      durationMs: 0,
      unseen: false,
      version: 1,
      promotedThreadId: "",
      findHits: 0,
      timers: [],
      events: new Hub(),
    };
  }

  private hitMsg(h: Hit): HitInit {
    const t = this.deps.thread(h.threadId);
    return {
      n: h.n,
      threadId: h.threadId,
      threadName: t?.name ?? "",
      archived: t?.archived ?? false,
      itemId: h.itemId,
      ordinal: BigInt(h.ordinal),
      speaker: h.speaker,
      ...(h.itemAt ? { itemCreatedAt: timestampFromDate(h.itemAt) } : {}),
      quote: h.quote,
      why: h.why,
      opened: h.opened,
    };
  }

  private stepMsg(s: Step): StepInit {
    return { index: s.index, kind: s.kind, done: s.done, failed: s.failed, text: s.text, query: s.query, hits: s.hits, threadId: s.threadId, threadName: s.threadName };
  }

  /** The entry as the daemon sends it: hits whose thread is gone left out, names now. */
  entryMsg(e: Entry): EntryInit {
    const hits = e.hits.filter((h) => this.deps.thread(h.threadId));
    const reads = new Set(e.steps.filter((s) => s.kind === AgentSearchStepKind.READ && s.threadId).map((s) => s.threadId));
    return {
      id: e.id,
      mode: e.mode,
      query: e.query,
      createdAt: timestampFromDate(e.createdAt),
      ...(e.finishedAt ? { finishedAt: timestampFromDate(e.finishedAt) } : {}),
      status: e.status,
      error: e.error,
      answer: e.answer,
      hits: hits.map((h) => this.hitMsg(h)),
      steps: e.steps.map((s) => this.stepMsg(s)),
      searches: e.steps.filter((s) => s.kind === AgentSearchStepKind.SEARCH).length,
      threadsRead: reads.size,
      claudeSessionId: e.mode === SearchMode.AGENT ? "00000000-0000-4000-8000-000000000000" : "",
      model: e.model,
      costUsd: e.costUsd,
      durationMs: BigInt(e.durationMs),
      unseen: e.unseen,
      version: BigInt(e.version),
      promotedThreadId: e.promotedThreadId,
      findHits: e.findHits,
    };
  }

  list(): EntryInit[] {
    return [...this.entries.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)).map((e) => this.entryMsg(e));
  }

  /** Get: one entry as List has it. */
  getMsg(id: string): EntryInit {
    return this.entryMsg(this.get(id));
  }

  private get(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new CommandError("notfound", `no search ${id}`);
    return e;
  }

  private add(e: Entry): void {
    this.entries.set(e.id, e);
    // The oldest go past the cap; a running search never does.
    const old = [...this.entries.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const o of old) {
      if (this.entries.size <= MAX_ENTRIES) break;
      if (o.status === SearchStatus.RUNNING) continue;
      this.drop(o);
    }
    this.recent.publish();
  }

  private drop(e: Entry): void {
    this.cancel(e);
    this.entries.delete(e.id);
    e.events.publish("gone");
  }

  private cancel(e: Entry): void {
    for (const t of e.timers) clearTimeout(t);
    e.timers = [];
  }

  /** A change: version + 1, the event to watchers (a snapshot when none is given), the list to WatchRecent. */
  private changed(e: Entry, ev?: WatchEventInit["event"]): void {
    e.version++;
    e.events.publish({ version: BigInt(e.version), event: ev ?? { case: "snapshot", value: this.entryMsg(e) } });
    this.recent.publish();
  }

  startAgent(question: string): EntryInit {
    const q = question.trim();
    if (q === "") throw new CommandError("invalid", "a question is required");
    this.calls.push(`start ${q}`);
    const e = this.newEntry(SearchMode.AGENT, q);
    this.add(e);
    this.script(e);
    return this.entryMsg(e);
  }

  /** The scripted run: steps, hits, answer, status, stepMs apart. */
  private script(e: Entry): void {
    const found: Hit[] = [];
    for (const c of CANDIDATES) {
      if (found.length >= this.hitCap) break;
      const t = this.deps.thread(c.threadId);
      if (!t) continue;
      for (const it of this.deps.items(c.threadId)) {
        const x = itemText(it);
        if (!x || !rendered(x.text).includes(c.quote)) continue;
        found.push({
          n: found.length + 1,
          threadId: c.threadId,
          itemId: it.id ?? "",
          ordinal: Number(it.ordinal ?? 0),
          speaker: x.speaker,
          itemAt: it.createdAt ? new Date(Number(it.createdAt.seconds ?? 0) * 1000) : null,
          quote: c.quote,
          why: c.why,
          opened: false,
        });
        break;
      }
    }
    const read = found[0] ? this.deps.thread(found[0].threadId) : undefined;
    const search = (index: number, query: string): Step => ({ index, kind: AgentSearchStepKind.SEARCH, done: false, failed: false, text: `Searching ${query}…`, query, hits: 0, threadId: "", threadName: "" });
    const plan: (() => void)[] = [];
    const s0 = search(0, "fingerprint force-push");
    const s1 = search(1, "stale badge");
    const step = (s: Step) => {
      const i = e.steps.findIndex((x) => x.index === s.index);
      if (i >= 0) e.steps[i] = { ...s };
      else e.steps.push({ ...s });
      this.changed(e, { case: "step", value: this.stepMsg(s) });
    };
    plan.push(() => {
      step(s0);
    });
    plan.push(() => {
      step(s1);
    });
    plan.push(() => {
      step({ ...s0, done: true, hits: 6, text: "Searched fingerprint force-push · 6 hits" });
    });
    plan.push(() => {
      step({ ...s1, done: true, hits: 3, text: "Searched stale badge · 3 hits" });
    });
    if (read && found[0]) {
      const r: Step = { index: 2, kind: AgentSearchStepKind.READ, done: false, failed: false, text: `Reading ${read.name}…`, query: "", hits: 0, threadId: found[0].threadId, threadName: read.name };
      plan.push(() => {
        step(r);
      });
      plan.push(() => {
        step({ ...r, done: true, text: `Read ${read.name} · #1–#4` });
      });
    }
    for (const h of found) {
      plan.push(() => {
        e.hits.push(h);
        this.changed(e, { case: "hit", value: this.hitMsg(h) });
      });
    }
    plan.push(() => {
      if (this.fail) return;
      const refs = found.map((h) => `[${String(h.n)}]`);
      e.answer =
        found.length === 0
          ? "None of your threads talk about it."
          : `The fingerprint now includes the head SHA, so a force-push refreshes the badge ${refs[0] ?? ""}.${refs[1] ? ` You reported the stale badge first ${refs[1]}.` : ""}${refs.length > 2 ? ` Related: ${refs.slice(2).join("")}.` : ""}`;
      this.changed(e, { case: "answer", value: { text: e.answer } });
    });
    plan.push(() => {
      this.finish(e, this.fail ? SearchStatus.FAILED : SearchStatus.DONE, this.fail ? "Claude ended the run with an API error" : "");
    });
    plan.forEach((f, i) => {
      e.timers.push(setTimeout(f, this.stepMs * (i + 1)));
    });
  }

  private finish(e: Entry, status: SearchStatus, error: string): void {
    this.cancel(e);
    e.status = status;
    e.error = error;
    e.finishedAt = new Date();
    e.durationMs = e.finishedAt.getTime() - e.createdAt.getTime();
    e.costUsd = status === SearchStatus.STOPPED && e.hits.length === 0 ? 0 : 0.02;
    // Unseen only when it ended on its own: the user who stopped it saw it.
    e.unseen = status !== SearchStatus.STOPPED;
    this.changed(e, {
      case: "status",
      value: { status, error, finishedAt: timestampFromDate(e.finishedAt), costUsd: e.costUsd, durationMs: BigInt(e.durationMs), unseen: e.unseen },
    });
  }

  /** Watch: the snapshot, then the run's events; the end after its status (NOT_FOUND once forgotten). */
  async *watch(id: string, signal: AbortSignal): AsyncGenerator<WatchEventInit> {
    const e = this.get(id);
    const snapshot: WatchEventInit = { version: BigInt(e.version), event: { case: "snapshot", value: this.entryMsg(e) } };
    if (e.status !== SearchStatus.RUNNING) {
      yield snapshot;
      return;
    }
    // Subscribed before the snapshot goes (a generator starts on its first next()), so no event falls between.
    const sub = e.events.subscribe(signal);
    let next = sub.next();
    yield snapshot;
    for (let r = await next; !r.done; r = await next) {
      const ev = r.value;
      if (ev === "gone") throw new CommandError("notfound", `no search ${id}`);
      yield ev;
      if (ev.event?.case === "status") return;
      next = sub.next();
    }
  }

  async *watchRecent(signal: AbortSignal): AsyncGenerator<{ entries: EntryInit[] }> {
    const sub = this.recent.subscribe(signal);
    let next = sub.next();
    yield { entries: this.list() };
    for (let r = await next; !r.done; r = await next) {
      yield { entries: this.list() };
      next = sub.next();
    }
  }

  stop(id: string): EntryInit {
    const e = this.get(id);
    this.calls.push(`stop ${id}`);
    if (e.status === SearchStatus.RUNNING) this.finish(e, SearchStatus.STOPPED, "stopped");
    return this.entryMsg(e);
  }

  openHit(id: string, n: number): EntryInit {
    const e = this.get(id);
    const h = e.hits.find((x) => x.n === n);
    if (!h) throw new CommandError("notfound", `search ${id} has no hit ${String(n)}`);
    this.calls.push(`open-hit ${id} ${String(n)}`);
    if (!h.opened) {
      h.opened = true;
      this.changed(e);
    }
    return this.entryMsg(e);
  }

  markSeen(id: string): EntryInit {
    const e = this.get(id);
    this.calls.push(`seen ${id}`);
    if (e.unseen) {
      e.unseen = false;
      this.changed(e);
    }
    return this.entryMsg(e);
  }

  recordFind(query: string, hits: number): EntryInit {
    const q = query.trim();
    if (q === "") throw new CommandError("invalid", "a query is required");
    this.calls.push(`find ${q} ${String(hits)}`);
    for (const o of [...this.entries.values()]) if (o.mode === SearchMode.FIND && o.query === q) this.drop(o);
    const e = this.newEntry(SearchMode.FIND, q);
    e.findHits = Math.max(0, hits);
    this.add(e);
    return this.entryMsg(e);
  }

  forget(id: string): void {
    const e = this.entries.get(id);
    this.calls.push(`forget ${id}`);
    if (!e) return;
    this.drop(e);
    this.recent.publish();
  }

  clear(): number {
    const n = this.entries.size;
    this.calls.push("clear");
    for (const e of [...this.entries.values()]) this.drop(e);
    this.recent.publish();
    return n;
  }

  promote(id: string): string {
    const e = this.get(id);
    if (e.mode !== SearchMode.AGENT) throw new CommandError("unavailable", "only an agent search can be continued as a thread");
    if (e.status === SearchStatus.RUNNING) throw new CommandError("unavailable", "the search is still running");
    this.calls.push(`promote ${id}`);
    if (e.promotedThreadId && this.deps.thread(e.promotedThreadId)) return e.promotedThreadId;
    const cites = e.hits.map((h) => `${String(h.n)}. “${h.quote}” in ${this.deps.thread(h.threadId)?.name ?? h.threadId} (#${String(h.ordinal)})`).join("\n");
    e.promotedThreadId = this.deps.promote(e.query, `${e.query}\n\n${cites}\n\nYour answer: ${e.answer}`);
    e.unseen = false;
    this.changed(e);
    return e.promotedThreadId;
  }

  /** POST /__mock/search: the next runs' pace, failure and hit cap. */
  control(q: URLSearchParams): Record<string, unknown> {
    if (q.has("stepMs")) this.stepMs = Math.max(10, Number(q.get("stepMs")) || 350);
    if (q.has("fail")) this.fail = q.get("fail") === "1" || q.get("fail") === "true";
    if (q.has("hits")) this.hitCap = Math.max(0, Number(q.get("hits")) || 0);
    return { stepMs: this.stepMs, fail: this.fail, hits: this.hitCap };
  }

  /** POST /__mock/search/seed: a history for Recent searches (an agent search with its hits, Find entries). */
  seed(): Record<string, unknown> {
    const now = Date.now();
    const agent = (query: string, agoMs: number, answer: string, hits: Candidate[]) => {
      const e = this.newEntry(SearchMode.AGENT, query, new Date(now - agoMs));
      for (const c of hits) {
        for (const it of this.deps.thread(c.threadId) ? this.deps.items(c.threadId) : []) {
          const x = itemText(it);
          if (!x || !rendered(x.text).includes(c.quote)) continue;
          e.hits.push({ n: e.hits.length + 1, threadId: c.threadId, itemId: it.id ?? "", ordinal: Number(it.ordinal ?? 0), speaker: x.speaker, itemAt: null, quote: c.quote, why: c.why, opened: false });
          break;
        }
      }
      e.steps = [
        { index: 0, kind: AgentSearchStepKind.SEARCH, done: true, failed: false, text: "Searched resize race · 2 hits", query: "resize race", hits: 2, threadId: "", threadName: "" },
        { index: 1, kind: AgentSearchStepKind.SEARCH, done: true, failed: false, text: "Searched sidebar virtualized · 1 hit", query: "sidebar virtualized", hits: 1, threadId: "", threadName: "" },
      ];
      e.answer = answer;
      e.status = SearchStatus.DONE;
      e.finishedAt = new Date(now - agoMs + 21_000);
      e.durationMs = 21_000;
      e.costUsd = 0.03;
      this.add(e);
    };
    const find = (query: string, agoMs: number, hits: number) => {
      const e = this.newEntry(SearchMode.FIND, query, new Date(now - agoMs));
      e.findHits = hits;
      this.add(e);
    };
    find("the thread where we picked the update dialog copy", 4 * 24 * 3_600_000, 1);
    find("fingerprint", 26 * 3_600_000, 14);
    agent("why did the terminal resize race?", 3 * 3_600_000, "A resize was applied while writes were still pending; the actor now waits for them to drain [1].", [CANDIDATES[2] as Candidate]);
    agent("when did the sidebar tree become a virtualized list?", 3_600_000, "In Refactor sidebar tree: the tree flattens into rows and only the visible ones render [1].", [CANDIDATES[3] as Candidate]);
    return { entries: this.entries.size };
  }

  json(): Record<string, unknown> {
    return { entries: this.list().map((e) => ({ id: e.id, query: e.query, status: e.status, hits: e.hits?.length ?? 0, unseen: e.unseen, findHits: e.findHits })), calls: [...this.calls] };
  }

  /** search.* (internal/command commands_search.go), category Search; only search.clear in the palette. */
  commands(): { cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; noPalette?: boolean; args: { name: string; type: ArgType; required: boolean; description: string }[]; confirm?: (ctx: UiContext | undefined, args: Record<string, string>) => string; confirmLabel?: string }; when: (ctx: UiContext | undefined) => boolean; run: (ctx: UiContext | undefined, args: Record<string, string>) => string | Promise<InvokeOut> }[] {
    const always = () => true;
    const id = { name: "id", type: ArgType.STRING, required: true, description: "The search's id (q-…; search.recent lists them)" };
    const out = (message: string, json: unknown): InvokeOut => ({ message, resultJson: JSON.stringify(json) });
    const cmd = (name: string, title: string, description: string, args: { name: string; type: ArgType; required: boolean; description: string }[], noPalette = true) => ({ name, title, category: "Search", description, keybindings: [], args, ...(noPalette ? { noPalette } : {}) });
    return [
      {
        cmd: cmd("search.agent", "Agent Search", "Ask a question about your earlier threads in your own words.", [{ name: "question", type: ArgType.STRING, required: true, description: "The question" }]),
        when: always,
        run: (_c, a) => Promise.resolve(out("started", this.startAgent(a.question ?? ""))),
      },
      { cmd: cmd("search.stop", "Stop Agent Search", "Stop a running agent search; it keeps the hits it reported.", [id]), when: always, run: (_c, a) => Promise.resolve(out("stopped", this.stop(a.id ?? ""))) },
      { cmd: cmd("search.recent", "Recent Searches", "List the search history, newest first.", []), when: always, run: () => Promise.resolve(out(`${String(this.entries.size)} searches`, { entries: this.list() })) },
      { cmd: cmd("search.get", "Show Search", "Show one search of the history.", [id]), when: always, run: (_c, a) => Promise.resolve(out("", this.getMsg(a.id ?? ""))) },
      {
        cmd: cmd("search.open-hit", "Mark Search Hit Opened", "Mark an agent search's hit opened.", [id, { name: "hit", type: ArgType.INT, required: true, description: "The hit's number ([n])" }]),
        when: always,
        run: (_c, a) => Promise.resolve(out(`hit [${a.hit ?? ""}] of ${a.id ?? ""} opened`, this.openHit(a.id ?? "", Number(a.hit)))),
      },
      { cmd: cmd("search.seen", "Mark Search Seen", "Mark a finished agent search's result seen.", [id]), when: always, run: (_c, a) => Promise.resolve(out(`${a.id ?? ""} seen`, this.markSeen(a.id ?? ""))) },
      {
        cmd: cmd("search.find", "Record Find Search", "Record a Find search in the history.", [
          { name: "query", type: ArgType.STRING, required: true, description: "The query" },
          { name: "hits", type: ArgType.INT, required: false, description: "How many results it found" },
        ]),
        when: always,
        run: (_c, a) => {
          const e = this.recordFind(a.query ?? "", Number(a.hits ?? 0) || 0);
          return Promise.resolve(out(`recorded ${e.id ?? ""}`, e));
        },
      },
      {
        cmd: cmd("search.forget", "Forget Search", "Remove a search from the history.", [id]),
        when: always,
        run: (_c, a) => {
          this.forget(a.id ?? "");
          return `forgot ${a.id ?? ""}`;
        },
      },
      {
        cmd: { ...cmd("search.clear", "Clear Search History", "Forget every search of the history.", [], false), confirm: () => "Clear the search history? Every agent search's transcript is deleted too.", confirmLabel: "Clear history" },
        when: always,
        run: () => {
          const n = this.clear();
          return Promise.resolve(out(`forgot ${String(n)} searches`, { removed: n }));
        },
      },
      {
        cmd: cmd("search.promote", "Continue Search as Thread", "Continue a finished agent search as a thread without a project.", [id]),
        when: always,
        run: (_c, a) => {
          const threadId = this.promote(a.id ?? "");
          return Promise.resolve(out(`continued as thread ${threadId}`, { threadId }));
        },
      },
    ];
  }
}
