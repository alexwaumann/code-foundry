/**
 * The thread's timeline as rows (docs/notes/rendered-threads-2-gui.md): pure
 * functions over a structural view of the items (no text), so text deltas never rebuild
 * it. The design is the sketch's variant A (docs/sketches/rendered-thread):
 *
 * - a turn is a user message and what follows it up to its turn_end; a message the
 *   user sends while the turn runs (a steer: Claude picks it up mid-turn, and the turn ends
 *   with one turn_end) stays inside it as a steer row, which never folds. A message Claude
 *   has not read yet (queued) is drawn last, under anything that arrives while it waits,
 *   which is where the daemon places it once read, so the read moves nothing. A turn with
 *   steers of the user's that Claude read (and the daemon says when) is split at each:
 *   "Worked for 3m 10s", the steer, "Continued for 5m 58s", each header folding its own
 *   stretch of work (`segments`, docs/notes/steer-segments.md);
 * - consecutive reads and searches fold into one group row ("Read 3 files, searched code
 *   2 times"); thinking between them is absorbed; consecutive thinking items merge;
 * - a subagent's items (parent_tool_use_id) nest under its Agent tool row;
 * - AskUserQuestion's tool call is hidden (the question item stands for it), and a
 *   permission request annotates its tool call (pending: "waiting for you");
 * - every finished turn has a header under its user message, at the top of its work
 *   (how long it took) that folds it, and a gutter under its last row (Copy, then steps,
 *   cost, model and the time it ended); every finished turn, the latest included, folds by
 *   default: only the user message, the header, the turn's reply (its final text, else its
 *   last text), notes, steers, inline pages and the gutter show; the fold hides the work
 *   (tools, groups, Agent rows, thinking) and the text before the reply
 *   (docs/notes/turn-gutter.md). A turn that ends while the
 *   user reads scrolled up stays open until the list is at the bottom again (`deferred`,
 *   docs/notes/thread-fold-4-pinned-fold.md). The running turn has the same
 *   header in its live form ("Working · 3 steps · 1m 12s"), under the same row key, so it
 *   turns into the finished one in place (docs/notes/thread-fold-3-header.md); it has no
 *   gutter until it ends;
 * - a system note (the daemon's, e.g. a fork's "Forked from …" where the copied history
 *   ends) stands alone between turns: it closes the turn before it and never folds;
 * - while the thread is on a turn, each run of work between two texts (steers, notes,
 *   permission requests and questions) collapses into one strip row showing the latest
 *   step and the run's step count (`stripRuns`, docs/notes/live-tool-strip.md). Finished
 *   turns are unaffected;
 * - a thread's setup (lib/threadSetup) is one row under its first user message, above the
 *   turn: its checklist while it runs, and once done a fold line like a turn's. A setup that
 *   did not finish has a synthetic turn end after the message: the turn never ran, so it has
 *   no header (docs/notes/instant-threads-3-gui.md).
 */
import type { RequestStateView, ThreadItemKind, ToolStatusView } from "@/api/thread";
import { SETUP_FOLD_KEY, type SetupRowPhase } from "./threadSetup";

/** What the timeline needs to know about an item; text and inputs are read by the rows. */
export interface TimelineItem {
  id: string;
  kind: ThreadItemKind;
  /** Tool name for "tool" items, the requested tool for permissions; "" otherwise. */
  name: string;
  parentToolUseId: string;
  /** The tool_use id of a tool call, permission or question; "" otherwise. */
  toolUseId: string;
  toolStatus: ToolStatusView | "";
  requestState: RequestStateView | "";
  streaming: boolean;
  /** An html item's page, resolved to its absolute path (lib/inlinePage); "" or absent otherwise. */
  page?: string;
  /**
   * A user message's sender (lib/workerRuns senderOf): "" the user; a wake's or another
   * thread's descriptor. "" or absent for other kinds.
   */
  from?: string;
  /** A user message's time (epoch ms); absent for other kinds or when unknown. */
  at?: number;
  /**
   * What became of a user message that waited in Claude Code's queue (api/thread
   * DeliveryView): "queued" until Claude reads it, "read", "unsent" when it never did.
   * Absent for one taken in at once and for other kinds.
   */
  delivery?: Delivery;
  /** A read message's time of reading (epoch ms); absent when unknown (an older daemon's). */
  readAt?: number;
  /** A text that is only the "nothing for the user" marker (lib/workerRuns isNothingNew). */
  quiet?: boolean;
  /**
   * A note recording a message this thread sent another thread that is neither its lead
   * nor its worker (lib/peerLines sentDescOf): "<to>/<mark>/<state>/<reply item>". Absent
   * for every other item. Its `at` is the note's time.
   */
  sent?: string;
}

/** What became of a queued user message (api/thread DeliveryView). */
export type Delivery = "queued" | "read" | "unsent";

/** Tools whose consecutive calls fold into one "Read 3 files, searched code 2 times" row. */
export const EXPLORE_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
/** Tools that are searches (the rest of EXPLORE_TOOLS are reads). */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob"]);
/** Subagent tools: their items nest under them. */
export const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/** A row in a turn's work log (top level or nested under an Agent row). */
export type WorkNode =
  | { type: "tool"; key: string; id: string; name: string; permissionId: string; children: WorkNode[] }
  | { type: "group"; key: string; ids: string[]; names: string[] }
  | { type: "thinking"; key: string; ids: string[] }
  /**
   * Claude's text. `final`: one of the turn's trailing texts (its answer). `answer`, when
   * set, gives the row its own copy action copying those ids (joined by "\n"): Ember's
   * reply only (lib/ember); a thread's turn copies from its gutter, so "" here.
   */
  | { type: "text"; key: string; id: string; final: boolean; answer: string; quiet?: boolean }
  | { type: "question"; key: string; id: string }
  | { type: "permission"; key: string; id: string }
  | { type: "note"; key: string; id: string; kind: "error" | "compaction" | "commandOutput" }
  /**
   * A user message sent while the turn ran (a steer); it stays visible when the turn folds.
   * `from` and `at`: its sender and time, as TimelineItem's (lib/workerRuns). `delivery`
   * and `readAt` as TimelineItem's. `since`: the item the turn's time counts from (as the
   * header's), for "+3m 10s" in a read steer's caption; set by buildRows.
   */
  | { type: "steer"; key: string; id: string; from?: string; at?: number; delivery?: Delivery; readAt?: number; since?: string }
  /**
   * A system note (an item of kind "note"): on its own line between turns, or in the open
   * turn it arrived in. `sent` and `at`: a sent-message note's, as TimelineItem's
   * (lib/peerLines), which the grouping reads as an exchange's line.
   */
  | { type: "system"; key: string; id: string; sent?: string; at?: number }
  /**
   * An HTML page the model showed inline (code-foundry view.inline): its "Showed <file>" row
   * and, while open, its card with the page. The turn's fold never touches it: its row and
   * card stay as they are, folded or not (only the row opens and closes the card). It is no
   * step and breaks a strip's run (docs/notes/inline-html.md, thread-fold-5-text-and-html.md).
   * `page` is its absolute path. `later` is the row key of the latest show of the same page
   * when this is an older one (linkRepeatShows): it renders as a one-line link to that card,
   * with no card and no frame; "" for the latest show (docs/notes/inline-page-shows.md).
   */
  | { type: "html"; key: string; id: string; page: string; later: string }
  /**
   * A theme the thread saved (code-foundry theme save; docs/notes/theme-model-flow.md): its
   * card. Like a page it stays in a folded turn, is no step and breaks a strip's run.
   */
  | { type: "theme"; key: string; id: string }
  /**
   * A run of work in the live turn collapsed into one row (stripRuns): its nodes in order
   * (thinking included), the latest step (never thinking) and the step count. Its row key
   * is its first node's, so when the turn ends that node's row takes the strip's place
   * (the list's anchor keeps a reader's place). Its expanded state is under `expandKey`,
   * `strip:<the run's first item>`, which holds while the run grows.
   */
  | { type: "strip"; key: string; expandKey: string; nodes: WorkNode[]; latest: StripStep; steps: number };

/** A strip's latest step: a tool row (an Agent included) or an explore group. */
export type StripStep = Extract<WorkNode, { type: "tool" } | { type: "group" }>;

/** One row of the timeline (what the virtualizer lays out). */
export type TimelineRow =
  /** A turn's opening message; `from` and `at` as TimelineItem's (lib/workerRuns). */
  | { type: "user"; key: string; id: string; from?: string; at?: number }
  | WorkNode
  /**
   * The thread's setup, under its first user message (lib/threadSetup): one row, so a step
   * changing rebuilds nothing. `folded` is the done fold line's, under SETUP_FOLD_KEY.
   */
  | { type: "setup"; key: string; folded: boolean }
  | {
      /**
       * A turn's header, under its user message(s) and above its work. Finished: "Worked
       * for 4m 8s", the turn's fold toggle. Live (no turn_end yet, the thread works):
       * "Working · 3 steps · 1m 12s", always open. Its key is `h:<turn key>` in both forms,
       * so the live row becomes the finished one in place.
       */
      type: "header";
      key: string;
      /** The turn_end item; "" for the live header. */
      id: string;
      /** The turn the header folds (TimelineTurn.key); "" for a live header with no turn yet. */
      turn: string;
      folded: boolean;
      /** The turn's work rows (a group or Agent row counts as one; text is none). */
      steps: number;
      /** Folding the turn hides something (work, or text before its reply): the header is a toggle. */
      foldable: boolean;
      /** The turn's final text items. */
      finals: string[];
      /** Live: the item the elapsed time counts from (the turn's last opening message, else its first item); "" when none. */
      since: string;
      /** The running form ("Working · 3 steps · 1m 12s"); of a split turn, only its last stretch's header. */
      live: boolean;
      /**
       * One stretch of a turn split at its read steers (docs/notes/steer-segments.md); absent
       * for a turn that is not split. `fold`: its fold key (the turn's key for the first, so
       * the find bar and a fork keep working on it). `from`: when the steer above it was read
       * (null for the first: the turn's start, `since`). `to`: when the next steer was read
       * (null for the last: the turn's end, or now while it runs).
       */
      seg?: { index: number; fold: string; from: number | null; to: number | null };
    }
  | {
      /**
       * A finished turn's gutter, under its last row (docs/notes/turn-gutter.md): Copy (the
       * reply), then steps · cost · model · the time it ended. One row of fixed height that
       * is always laid out, so showing its contents moves nothing. Its key is `f:<turn key>`.
       */
      type: "gutter";
      key: string;
      /** The turn_end item. */
      id: string;
      /** The turn (TimelineTurn.key). */
      turn: string;
      /** As the header's. */
      steps: number;
      /** The reply's text ids joined by "\n" (what Copy copies; a string, so the memoized row stays equal); "" with no reply: no Copy. */
      reply: string;
      /** The thread's latest turn: its contents show at rest; an older turn's only while it is hovered or has the keyboard. */
      latest: boolean;
      /** The turn was split at steers: the gutter says its whole length ("9m 08s total"). */
      split?: true;
      /**
       * A turn of a run this thread's workers started (lib/workerRuns), whose header is not
       * shown: its fold state, the steps count being its toggle ("none": nothing to fold).
       * Absent for every other turn.
       */
      fold?: "folded" | "open" | "none";
    }
  /**
   * The card for a run of turns this thread's own workers started (lib/workerRuns,
   * docs/notes/worker-card.md), where the run begins. Its key is `w:<the anchoring turn's
   * key>`, so it updates in place.
   */
  | WorkersRow
  /**
   * One line per other thread (not this thread's lead, not its worker) this thread
   * exchanged messages with in a run (lib/peerLines, docs/notes/other-thread-lines.md).
   * Its key is `p:<the run's anchoring turn key>:<the other thread>`, so it changes in place.
   */
  | PeerRow;

/** One other thread's line (lib/peerLines). */
export interface PeerRow {
  type: "peer";
  key: string;
  /** The other thread's id. */
  id: string;
  /** What happened, in a few words ("asked · waiting for a reply", "replied · then asked 1 question, answered"). */
  words: string;
  /** The dot's tone. */
  tone: "info" | "warning" | "success" | "muted";
  /** The current run's line: its time ticks. A frozen one stopped at the user's next message. */
  live: boolean;
  /** When the exchange began (epoch ms); null when unknown. */
  start: number | null;
  /** Frozen: the user's next message's time; null while live. */
  end: number | null;
}

/** A worker's state in a card line (lib/workerRuns). */
export type WorkerState = "working" | "needs" | "asks" | "finished" | "failed" | "stopped" | "archived";

/** One worker's line in a card. */
export interface WorkerLine {
  /** The worker thread's id. */
  id: string;
  state: WorkerState;
  /** When its current (or last) stretch of work started (epoch ms); null when unknown. */
  since: number | null;
  /** When that stretch ended (epoch ms): set for a stopped worker and in a frozen card; null while it runs. */
  until: number | null;
}

export interface WorkersRow {
  type: "workers";
  key: string;
  lines: WorkerLine[];
  /** The current card: it updates and never folds. A frozen one stopped at the user's next message. */
  live: boolean;
  /** A frozen card shows only its title line (the user opens it; not kept across visits). */
  folded: boolean;
  /** When the run's stretch began (the user's message; epoch ms); null when unknown. */
  start: number | null;
  /** Frozen: the user's next message's time. Live: when its last worker stopped, null while any runs. */
  end: number | null;
}

/** A turn: from a user message (or the thread's start) to its turn_end, inclusive. */
export interface TimelineTurn {
  /** The first item's id. */
  key: string;
  user: string[];
  /** The opening messages' senders and times, by item id, for those that have them (lib/workerRuns). */
  senders?: Readonly<Record<string, { from?: string; at?: number }>>;
  body: WorkNode[];
  /** The turn_end item; "" while the turn runs. */
  end: string;
  /**
   * Its opening messages all wait in Claude Code's queue (sent as the previous turn ended:
   * Claude starts them as this turn once it reads them): no header yet, not live.
   */
  waiting?: true;
}

function isWorkTool(it: TimelineItem): boolean {
  return it.kind === "tool" && it.name !== "AskUserQuestion";
}

/**
 * Work nodes for a run of items of one parent: groups, merged thinking, nested subagents.
 * `children` maps an Agent's tool_use id to its items; `permissions` a tool_use id to the
 * permission item that is about it.
 */
export function workNodes(list: readonly TimelineItem[], children: ReadonlyMap<string, TimelineItem[]>, permissions: ReadonlyMap<string, TimelineItem>): WorkNode[] {
  const out: WorkNode[] = [];
  let i = 0;
  while (i < list.length) {
    const it = list[i];
    if (!it) break;
    if (it.kind === "tool" && EXPLORE_TOOLS.has(it.name) && !permissions.has(it.toolUseId)) {
      // A run of explore tools, thinking in between absorbed (a trailing thinking is not).
      const ids: string[] = [];
      const names: string[] = [];
      let j = i;
      let end = i;
      while (j < list.length) {
        const x = list[j];
        if (!x) break;
        if (x.kind === "tool" && EXPLORE_TOOLS.has(x.name) && !permissions.has(x.toolUseId)) {
          ids.push(x.id);
          names.push(x.name);
          end = j + 1;
        } else if (x.kind !== "thinking") break;
        j++;
      }
      if (ids.length >= 2) {
        out.push({ type: "group", key: `g:${ids[0] ?? ""}`, ids, names });
        i = end;
        continue;
      }
    }
    if (it.kind === "thinking") {
      const ids = [it.id];
      let j = i + 1;
      for (let x = list[j]; x?.kind === "thinking"; x = list[++j]) ids.push(x.id);
      out.push({ type: "thinking", key: `th:${it.id}`, ids });
      i = j;
      continue;
    }
    i++;
    switch (it.kind) {
      case "tool": {
        if (!isWorkTool(it)) break;
        const perm = permissions.get(it.toolUseId);
        const kids = AGENT_TOOLS.has(it.name) ? (children.get(it.toolUseId) ?? []) : [];
        out.push({ type: "tool", key: it.id, id: it.id, name: it.name, permissionId: perm?.id ?? "", children: kids.length > 0 ? workNodes(kids, children, permissions) : [] });
        break;
      }
      case "text":
        out.push({ type: "text", key: it.id, id: it.id, final: false, answer: "", ...(it.quiet ? { quiet: true } : {}) });
        break;
      case "question":
        out.push({ type: "question", key: it.id, id: it.id });
        break;
      case "permission":
        // Shown on its tool row; alone only when there is none (an auto-denied call).
        if (permissions.get(it.toolUseId)?.id !== it.id) out.push({ type: "permission", key: it.id, id: it.id });
        break;
      case "error":
      case "compaction":
      case "commandOutput":
        out.push({ type: "note", key: it.id, id: it.id, kind: it.kind });
        break;
      case "note":
        out.push({ type: "system", key: it.id, id: it.id, ...(it.sent ? { sent: it.sent, ...(it.at !== undefined ? { at: it.at } : {}) } : {}) });
        break;
      case "html":
        out.push({ type: "html", key: it.id, id: it.id, page: it.page ?? "", later: "" });
        break;
      case "theme":
        out.push({ type: "theme", key: it.id, id: it.id });
        break;
      case "user":
        // Only a steer reaches here (buildTurns keeps a turn's opening messages apart).
        out.push({ type: "steer", key: it.id, id: it.id, ...sender(it), ...(it.delivery ? { delivery: it.delivery } : {}), ...(it.readAt !== undefined ? { readAt: it.readAt } : {}) });
        break;
      case "turnEnd":
        break;
    }
  }
  return out;
}

/** A user message's sender and time for its row, when it has them (lib/workerRuns reads them). */
function sender(it: TimelineItem): { from?: string; at?: number } {
  return { ...(it.from ? { from: it.from } : {}), ...(it.at !== undefined ? { at: it.at } : {}) };
}

/** Marks the trailing text rows of a turn's body as final, its answer (thinking may sit between them). */
function markFinal(body: WorkNode[]): void {
  let from = body.length;
  for (let i = body.length - 1; i >= 0; i--) {
    const n = body[i];
    if (n?.type === "text") from = i;
    else if (n?.type !== "thinking" && n?.type !== "system") break; // a note after the answer, mid-turn
  }
  for (let i = from; i < body.length; i++) {
    const n = body[i];
    if (n?.type === "text") body[i] = { ...n, final: true };
  }
}

/**
 * A finished turn's reply: its final texts, else (interrupted, failed, or a steer after its
 * last text) its last text; none without text. What its fold leaves of Claude's text and
 * what its gutter's Copy copies. null for a running turn: none of its text folds.
 */
export function turnReply(t: TimelineTurn): string[] | null {
  if (t.end === "") return null;
  const finals = t.body.flatMap((n) => (n.type === "text" && n.final ? [n.id] : []));
  if (finals.length > 0) return finals;
  for (let i = t.body.length - 1; i >= 0; i--) {
    const n = t.body[i];
    if (n?.type === "text") return [n.id];
  }
  return [];
}

/** Work: tool, group, Agent and thinking rows, questions and permission requests. What a turn's steps count. */
function isWork(n: WorkNode): boolean {
  return n.type !== "text" && n.type !== "note" && n.type !== "system" && n.type !== "steer" && n.type !== "html" && n.type !== "theme";
}

/**
 * What a folded turn hides: its work and, of a finished turn's text, all but the reply
 * (`reply`: turnReply's ids; null, a running turn's: no text). Notes (errors, compactions, command output, system notes), steers,
 * inline pages (row and card, untouched by the fold) and theme cards stay visible in their
 * place (docs/notes/turn-gutter.md, thread-fold-5-text-and-html.md).
 */
function foldsAway(n: WorkNode, reply: readonly string[] | null): boolean {
  return n.type === "text" ? reply !== null && !reply.includes(n.id) : isWork(n);
}

/**
 * Items the daemon adds between turns, outside any: its own command output ("Set effort to
 * high") and a page a verb showed (view.inline). Alone (no user message before them) they
 * are no turn: a message after them starts one, and they have no header and never fold, so
 * a page shown while the thread is at its prompt arrives open (docs/notes/inline-html-2-fixes.md).
 */
function isAside(t: { user: readonly string[]; items: readonly TimelineItem[] }): boolean {
  return t.user.length === 0 && t.items.every((x) => x.kind === "commandOutput" || x.kind === "html" || x.kind === "theme");
}

/** Kinds the daemon appends on its own, outside a turn too: alone they are no turn (turnclose.go startsTurn). */
const NOT_TURN: ReadonlySet<TimelineItem["kind"]> = new Set<TimelineItem["kind"]>(["error", "note", "html", "theme", "commandOutput"]);

/**
 * Whether a group holds a turn, as the daemon's openTurn has it: a message, or an item
 * that starts a turn. Errors alone (a process that ended after its turn, a failed start)
 * and asides are none, so a note after them is not in a turn.
 */
function holdsTurn(t: { user: readonly string[]; items: readonly TimelineItem[] }): boolean {
  return t.user.length > 0 || t.items.some((x) => !NOT_TURN.has(x.kind));
}

/** The note a fork's copied history ends with (fork.go forkNotePrefix): a turn boundary. */
function isForkNote(it: TimelineItem): boolean {
  return it.id.startsWith("note-fork-");
}

/** The last item that is not a system note or a message Claude never read, if any. */
function lastWork(items: readonly TimelineItem[]): TimelineItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it && it.kind !== "note" && it.delivery !== "unsent") return it;
  }
  return undefined;
}

/**
 * The items with the messages Claude has not read yet last (in their order): it reads
 * them at its next tool call, so whatever arrives while they wait goes above them. The
 * daemon places a message it read after the newest item that is not queued, which is the
 * row it is already drawn under, so the read moves nothing (docs/notes/steer-segments.md).
 */
export function queuedLast<T extends { kind: string; delivery?: Delivery }>(items: readonly T[]): readonly T[] {
  const queued = items.filter((it) => it.kind === "user" && it.delivery === "queued");
  if (queued.length === 0) return items;
  return [...items.filter((it) => !(it.kind === "user" && it.delivery === "queued")), ...queued];
}

/** The thread's items (top level, in order) as turns. */
export function buildTurns(all: readonly TimelineItem[]): TimelineTurn[] {
  const items = queuedLast(all);
  // Nest subagent items under their Agent call when the thread has it.
  const agentIds = new Set(items.filter((it) => it.kind === "tool" && AGENT_TOOLS.has(it.name)).map((it) => it.toolUseId));
  const children = new Map<string, TimelineItem[]>();
  const top: TimelineItem[] = [];
  for (const it of items) {
    if (it.parentToolUseId && agentIds.has(it.parentToolUseId)) {
      const list = children.get(it.parentToolUseId) ?? [];
      list.push(it);
      children.set(it.parentToolUseId, list);
    } else top.push(it);
  }
  const toolUses = new Set(items.filter(isWorkTool).map((it) => it.toolUseId));
  const permissions = new Map<string, TimelineItem>();
  for (const it of items) if (it.kind === "permission" && it.toolUseId && toolUses.has(it.toolUseId)) permissions.set(it.toolUseId, it);

  const turns: TimelineTurn[] = [];
  let cur: { key: string; user: string[]; items: TimelineItem[]; end: string } | null = null;
  const senders: Record<string, { from?: string; at?: number }> = {};
  const close = () => {
    if (!cur) return;
    const body = workNodes(cur.items, children, permissions);
    markFinal(body);
    const own = cur.user.filter((u) => u in senders);
    const waiting = cur.user.length > 0 && cur.items.length === 0 && cur.end === "" && cur.user.every((u) => queued.has(u));
    turns.push({ key: cur.key, user: cur.user, ...(own.length > 0 ? { senders: Object.fromEntries(own.map((u) => [u, senders[u] ?? {}])) } : {}), body, end: cur.end, ...(waiting ? { waiting: true as const } : {}) });
    cur = null;
  };
  const queued = new Set(top.flatMap((it) => (it.kind === "user" && it.delivery === "queued" ? [it.id] : [])));
  for (const it of top) {
    if (it.kind === "user" && it.delivery === "unsent") {
      // Claude never read it (its process ended first): no part of a turn. It stays inside
      // the turn it was sent in, which it does not split, or alone where no turn is open.
      if (cur && (cur.user.length > 0 || holdsTurn(cur))) cur.items.push(it);
      else {
        close();
        turns.push({ key: it.id, user: [], body: workNodes([it], children, permissions), end: "" });
      }
      continue;
    }
    if (it.kind === "user") {
      // Sent while the turn runs (it has work and no turn_end yet): a steer. Claude picks
      // it up mid-turn and the turn ends with one turn_end, so it stays in the turn's
      // body. Unless the turn's process ended (an error item is the turn's last: Claude
      // stopped or did not start), which no turn_end will follow: a new turn then. Nor
      // after the daemon's own notes with no user message before them ("Restarted
      // Claude", "Set effort to high": a restart between turns) or a page a verb showed
      // between turns (view.inline from a terminal or a child): no turn runs there.
      // A system note inside the turn (it ended nothing) does not count as its last item.
      const last = cur ? lastWork(cur.items) : undefined;
      const notesOnly = cur !== null && isAside(cur);
      if (cur && cur.items.length > 0 && last?.kind !== "error" && !notesOnly) {
        cur.items.push(it);
        continue;
      }
      // A user message starts a turn, unless it follows another one with nothing between.
      if (!cur || cur.items.length > 0) {
        close();
        cur = { key: it.id, user: [], items: [], end: "" };
      }
      cur.user.push(it.id);
      if (it.from || it.at !== undefined) senders[it.id] = sender(it);
      continue;
    }
    if (it.kind === "note") {
      // A system note that arrives while a turn is open (a background shell stopped, an
      // agent's note, pr.task's forward) stays in that turn's body: it ends nothing, and
      // system rows never fold away. The daemon's openTurn (turnclose.go) agrees. Between
      // turns (after asides or errors alone too), and a fork's note (which ends the copied
      // history), it is a turn of its own.
      if (cur && !isForkNote(it) && holdsTurn(cur)) {
        cur.items.push(it);
        continue;
      }
      close();
      turns.push({ key: it.id, user: [], body: workNodes([it], children, permissions), end: "" });
      continue;
    }
    cur ??= { key: it.id, user: [], items: [], end: "" };
    if (it.kind === "turnEnd") {
      cur.end = it.id;
      close();
      continue;
    }
    cur.items.push(it);
  }
  close();
  return turns;
}

/** A turn's work rows (a group or Agent row counts as one; text, steers, notes and pages are not steps). */
function stepCount(body: readonly WorkNode[]): number {
  return body.filter(isWork).length;
}

/**
 * The fold that hides an item's row (a question or tool row of its top-level work, a
 * finished turn's text before its reply): its turn's key, or of a turn split at steers its
 * stretch's (segmentFoldKey); "" when no fold hides it (the reply, a running turn's text, a
 * steer, a page show). The find bar and the cite layer unfold it.
 */
export function foldingTurn(turns: readonly TimelineTurn[], itemId: string): string {
  for (const t of turns) {
    const reply = turnReply(t);
    for (const s of segments(t.body)) if (s.nodes.some((n) => foldsAway(n, reply) && "id" in n && n.id === itemId)) return segmentFoldKey(t.key, s.steer);
  }
  return "";
}

export interface TimelineOptions {
  /** The user's fold choice for a turn, by its key; undefined: the default. */
  fold: (turnKey: string) => boolean | undefined;
  /** The thread works (busy or starting) and no request waits: the open turn shows its live ("Working") header. */
  working: boolean;
  /**
   * The thread is on its open turn (working, or waiting on the user mid-turn): that turn's
   * runs of work collapse into strips (stripRuns). Absent: no strips.
   */
  strips?: boolean;
  /**
   * Whether a finished turn (by its turn_end id) ended while the list was scrolled up: it
   * stays open until the list is pinned at the bottom again (stores/thread.ts
   * deferTurnFolds). The user's choice still wins. Absent: none.
   */
  deferred?: (turnEndId: string) => boolean;
  /** The thread's setup row (lib/threadSetup setupRowPhase); absent or "": none. */
  setup?: SetupRowPhase;
}

/**
 * The default fold of a turn: every finished turn folds, the latest one included; a
 * running turn is open. A turn that ended while the list was scrolled up stays open until
 * the list is pinned again (TimelineOptions.deferred), and the user's choice on the header
 * (stores/thread.ts setTurnFolded) wins over both.
 */
export function defaultFolded(turn: TimelineTurn): boolean {
  return turn.end !== "";
}

/**
 * A system note's turn of its own (buildTurns), pages shown between turns (isAside), or a
 * message Claude never read with no turn open: no user message, no turn_end, no header; no
 * turn runs there, so the live header goes after it.
 */
function isNoteTurn(t: TimelineTurn): boolean {
  if (t.user.length > 0 || t.end !== "" || t.body.length === 0) return false;
  return (t.body.length === 1 && t.body[0]?.type === "system") || t.body.every((n) => n.type === "html" || n.type === "theme") || t.body.every((n) => n.type === "steer");
}

/** Whether a steer splits its turn: the user's own, read, and the daemon said when. */
function splits(n: WorkNode): n is Extract<WorkNode, { type: "steer" }> & { readAt: number } {
  return n.type === "steer" && !n.from && n.delivery === "read" && n.readAt !== undefined;
}

/** One stretch of a turn's work: from its start or a read steer (`steer`) to the next one. */
export interface TurnSegment {
  /** The read steer it starts with; null for the first. */
  steer: (Extract<WorkNode, { type: "steer" }> & { readAt: number }) | null;
  /** Its work, text and the rest, the steer left out. */
  nodes: WorkNode[];
}

/**
 * A turn's body split at the user's steers that Claude read (`splits`): one segment when
 * none, the whole body (docs/notes/steer-segments.md). Steers by another thread, wakes,
 * queued messages, ones Claude never read and ones from before the read time was kept stay
 * inside their segment, as rows that never fold.
 */
export function segments(body: readonly WorkNode[]): TurnSegment[] {
  const out: TurnSegment[] = [{ steer: null, nodes: [] }];
  for (const n of body) {
    if (splits(n)) out.push({ steer: n, nodes: [] });
    else out[out.length - 1]?.nodes.push(n);
  }
  return out;
}

/** A segment's fold key: the turn's for the first (what the find bar and a fork unfold), else the turn's and its steer's. */
export function segmentFoldKey(turnKey: string, steer: { id: string } | null): string {
  return steer ? `${turnKey}>${steer.id}` : turnKey;
}

/** The rows to lay out, top to bottom: per turn its user message(s), its header, its work (minus what the fold hides). */
export function buildRows(turns: readonly TimelineTurn[], opts: TimelineOptions): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const last = turns[turns.length - 1];
  const setup = opts.setup ?? "";
  // No Claude yet, so no turn runs, whatever the thread's state says: the setup's row is the live one.
  const noClaude = setup === "running" || setup === "stopped";
  const working = opts.working && !noClaude;
  // The open turn while the thread works; none when the last turn ended (nothing runs
  // after a turn_end) or is a system note (Claude starts a turn that has no item yet).
  const live = working && last && last.end === "" && !isNoteTurn(last) && !last.waiting ? last : undefined;
  // The open turn the thread is on (also while a request waits): its work runs as strips.
  const stripped = opts.strips && last && last.end === "" && !isNoteTurn(last) && !last.waiting ? last : undefined;
  // A turn end with no Claude behind it is a setup's that stopped, in a retry's first moments too.
  const finished = (t: TimelineTurn) => t.end !== "" && !noClaude;
  // The thread's latest turn: the last one with a header. Its gutter shows at rest, unless it still runs (it has none then).
  let latest: TimelineTurn | undefined;
  for (const t of turns) if (finished(t) || t === live) latest = t;
  turns.forEach((t) => {
    const reply = turnReply(t);
    for (const u of t.user) rows.push({ type: "user", key: u, id: u, ...t.senders?.[u] });
    const steps = stepCount(t.body);
    const headed = finished(t) || t === live;
    const since = t.user[t.user.length - 1] ?? t.key;
    // A turn with a header splits at the user's steers Claude read (one segment otherwise):
    // a header per stretch, each folding its own work; only the last one's can be live.
    const segs = headed ? segments(t.body) : [{ steer: null, nodes: t.body }];
    const split = segs.length > 1;
    const byDefault = t.end !== "" && (opts.deferred?.(t.end) ? false : defaultFolded(t));
    segs.forEach((s, i) => {
      const last = i === segs.length - 1;
      const isLive = t === live && last;
      if (s.steer) rows.push({ ...s.steer, since });
      const fold = segmentFoldKey(t.key, s.steer);
      // A finished turn's stretches fold by default; a running turn's settled ones only when the user folds them.
      const folded = !isLive && (t.end !== "" || split) && (opts.fold(fold) ?? byDefault);
      if (headed) {
        const nodes = split ? s.nodes : t.body;
        rows.push({
          type: "header",
          key: s.steer ? `h:${t.key}:${s.steer.id}` : `h:${t.key}`,
          id: t.end,
          turn: t.key,
          folded,
          steps: split ? stepCount(nodes) : steps,
          foldable: nodes.some((n) => foldsAway(n, reply)),
          finals: last ? t.body.flatMap((n) => (n.type === "text" && n.final ? [n.id] : [])) : [],
          since,
          live: isLive,
          ...(split ? { seg: { index: i, fold, from: s.steer?.readAt ?? null, to: segs[i + 1]?.steer?.readAt ?? null } } : {}),
        });
      }
      for (const n of t === stripped ? stripRuns(s.nodes) : s.nodes) if (!folded || !foldsAway(n, reply)) rows.push(n.type === "steer" ? { ...n, since } : n);
    });
    if (finished(t)) rows.push({ type: "gutter", key: `f:${t.key}`, id: t.end, turn: t.key, steps, reply: (reply ?? []).join("\n"), latest: t === latest, ...(split ? { split: true as const } : {}) });
  });
  // Under the first message, or at the end for a thread without one (made with no prompt).
  if (setup !== "") {
    const first = rows.findIndex((r) => r.type === "user");
    rows.splice(first < 0 ? rows.length : first + 1, 0, { type: "setup", key: SETUP_FOLD_KEY, folded: opts.fold(SETUP_FOLD_KEY) ?? true });
  }
  // Working with no turn to head (an empty thread starting, a fork's note): a live header alone.
  if (working && (!last || isNoteTurn(last))) rows.push({ type: "header", key: "h:", id: "", turn: "", folded: false, steps: 0, foldable: false, finals: [], since: "", live: true });
  return linkRepeatShows(rows);
}

/**
 * The turn each row belongs to for the gutter's hover (by index; "" for none): a turn's
 * rows from its header to its gutter. Its user message(s), a system note between turns
 * and the setup row belong to none. A turn of a worker run (lib/workerRuns) has no header:
 * its rows count from the row after the one before them (a gutter, a card, a message) to
 * its gutter.
 */
export function rowTurns(rows: readonly TimelineRow[]): string[] {
  let cur = "";
  const out = rows.map((r) => {
    if (r.type === "header") cur = r.turn;
    else if (r.type === "user" || r.type === "setup" || r.type === "workers" || r.type === "peer") cur = "";
    const t = cur;
    if (r.type === "gutter") cur = "";
    return t;
  });
  rows.forEach((g, i) => {
    if (g.type !== "gutter" || g.fold === undefined) return;
    out[i] = g.turn;
    for (let j = i - 1; j >= 0 && out[j] === ""; j--) {
      const t = rows[j]?.type;
      if (t === "user" || t === "setup" || t === "gutter" || t === "workers" || t === "peer" || t === "header") break;
      out[j] = g.turn;
    }
  });
  return out;
}

/**
 * One live card per page: of the html rows showing the same page (by absolute path), the
 * last keeps its card and every earlier one gets `later`, the row key of that last one, and
 * renders as a link row to it (docs/notes/inline-page-shows.md). Only top-level rows count
 * (a page nested under a subagent's Agent row keeps its card). Rows that change are
 * copied; the rest keep their identity, as does the list when none changes. An html row
 * with no page stays a card.
 */
export function linkRepeatShows<R extends { type: string; key: string }>(rows: R[]): R[] {
  const last = new Map<string, string>();
  for (const r of rows) {
    const h = asHtml(r);
    if (h?.page) last.set(h.page, h.key);
  }
  let out: R[] | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const h = r ? asHtml(r) : null;
    if (!r || !h) continue;
    const latest = h.page ? (last.get(h.page) ?? h.key) : h.key;
    const later = latest === h.key ? "" : latest;
    if (later === h.later) continue;
    out ??= [...rows];
    out[i] = { ...r, later };
  }
  return out ?? rows;
}

/** The html node a row is, or null. */
function asHtml(r: { type: string }): HtmlNode | null {
  return r.type === "html" ? (r as unknown as HtmlNode) : null;
}

/** A page's row (WorkNode "html"). */
export type HtmlNode = Extract<WorkNode, { type: "html" }>;

/**
 * Work a strip collapses: tool rows without a permission request (an Agent included),
 * explore groups, thinking. Everything else (text, steers, notes, questions, permission
 * rows, a tool with a permission request attached, an inline page) breaks the run and
 * shows on its own.
 */
function inRun(n: WorkNode): boolean {
  return (n.type === "tool" && n.permissionId === "") || n.type === "group" || n.type === "thinking";
}

/** The first item of a node: a group's first member and merged thinking's first item, so it holds as the node grows. */
function firstItemId(n: WorkNode): string {
  switch (n.type) {
    case "group":
    case "thinking":
      return n.ids[0] ?? "";
    case "strip":
      return n.nodes[0] ? firstItemId(n.nodes[0]) : "";
    default:
      return n.id;
  }
}

/**
 * The live turn's body with each run of work (consecutive `inRun` nodes) of two steps or
 * more as one strip row; a run of one step stays as its rows. Steps count as the header's
 * do (a group or an Agent is one; thinking is none). The strip's expanded state is keyed
 * by its run's first item (`strip:<id>`), stable while the run grows; its row key is its
 * first node's, the row that takes its place when the turn ends.
 */
export function stripRuns(body: readonly WorkNode[]): WorkNode[] {
  const out: WorkNode[] = [];
  let run: WorkNode[] = [];
  const flush = () => {
    const steps = run.filter((n): n is StripStep => n.type === "tool" || n.type === "group");
    const latest = steps[steps.length - 1];
    const first = run[0];
    if (latest && first && steps.length >= 2) out.push({ type: "strip", key: first.key, expandKey: `strip:${firstItemId(first)}`, nodes: run, latest, steps: steps.length });
    else out.push(...run);
    run = [];
  };
  for (const n of body) {
    if (inRun(n)) run.push(n);
    else {
      flush();
      out.push(n);
    }
  }
  flush();
  return out;
}

/**
 * "Read 3 files, searched code 2 times" for a group's tool names (T3's work-log labels):
 * reads first, "once" for a single search.
 */
export function groupLabel(names: readonly string[]): string {
  const searches = names.filter((n) => SEARCH_TOOLS.has(n)).length;
  const reads = names.length - searches;
  const parts: string[] = [];
  if (reads > 0) parts.push(`Read ${String(reads)} ${reads === 1 ? "file" : "files"}`);
  if (searches > 0) parts.push(`${parts.length > 0 ? "searched" : "Searched"} code ${searches === 1 ? "once" : `${String(searches)} times`}`);
  return parts.join(", ");
}

/** The timeline item a structural key encodes (see timelineKey). */
const SEP = "\u0001";

/** One string per item with what the timeline depends on, so a shallow-equal list means "same rows". */
export function timelineKey(it: TimelineItem): string {
  return [it.id, it.kind, it.name, it.parentToolUseId, it.toolUseId, it.toolStatus, it.requestState, it.streaming ? "1" : "", it.page ?? "", it.from ?? "", it.at === undefined ? "" : String(it.at), it.quiet ? "1" : "", it.sent ?? "", it.delivery ?? "", it.readAt === undefined ? "" : String(it.readAt)].join(SEP);
}

export function decodeTimelineKey(k: string): TimelineItem {
  const [id = "", kind = "text", name = "", parentToolUseId = "", toolUseId = "", toolStatus = "", requestState = "", streaming = "", page = "", from = "", at = "", quiet = "", sent = "", delivery = "", readAt = ""] = k.split(SEP);
  return {
    ...(delivery ? { delivery: delivery as Delivery } : {}),
    ...(readAt ? { readAt: Number(readAt) } : {}),
    ...(sent ? { sent } : {}),
    ...(quiet ? { quiet: true } : {}),
    ...(from ? { from } : {}),
    ...(at ? { at: Number(at) } : {}),
    id,
    kind: kind as ThreadItemKind,
    name,
    parentToolUseId,
    toolUseId,
    toolStatus: toolStatus as ToolStatusView | "",
    requestState: requestState as RequestStateView | "",
    streaming: streaming === "1",
    page,
  };
}

/** A turn's cost in its header: "$1.12", "<$0.01" under a cent, "" when nothing or not known (null). */
export function turnCostLabel(usd: number | null): string {
  if (usd === null || !(usd > 0)) return "";
  return usd >= 0.005 ? `$${usd.toFixed(2)}` : "<$0.01";
}
