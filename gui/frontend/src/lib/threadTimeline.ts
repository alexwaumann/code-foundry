/**
 * The thread's timeline as rows (docs/notes/rendered-threads-2-gui.md): pure
 * functions over a structural view of the items (no text), so text deltas never rebuild
 * it. The design is the sketch's variant A (docs/sketches/rendered-thread):
 *
 * - a turn is a user message and what follows it up to its turn_end; a message the
 *   user sends while the turn runs (a steer: Claude picks it up mid-turn, and the turn ends
 *   with one turn_end) stays inside it as a steer row, which never folds;
 * - consecutive reads and searches fold into one group row ("Read 3 files, searched code
 *   2 times"); thinking between them is absorbed; consecutive thinking items merge;
 * - a subagent's items (parent_tool_use_id) nest under its Agent tool row;
 * - AskUserQuestion's tool call is hidden (the question item stands for it), and a
 *   permission request annotates its tool call (pending: "waiting for you");
 * - every finished turn has a header under its user message, at the top of its work
 *   (duration, steps, its cost, model) that folds it; every finished turn, the latest
 *   included, folds by default: only the user message, the header, the final assistant text
 *   (the trailing text of the turn), notes and steers show. A turn that ends while the
 *   user reads scrolled up stays open until the list is at the bottom again (`deferred`,
 *   docs/notes/thread-fold-4-pinned-fold.md). The running turn has the same
 *   header in its live form ("Working · 3 steps · 1m 12s"), under the same row key, so it
 *   turns into the finished one in place (docs/notes/thread-fold-3-header.md);
 * - a system note (the daemon's, e.g. a fork's "Forked from …" where the copied history
 *   ends) stands alone between turns: it closes the turn before it and never folds.
 */
import type { RequestStateView, ThreadItemKind, ToolStatusView } from "@/api/thread";

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
}

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
   * Claude's text. `answer` is set on the first final text row of a finished turn: the
   * turn's final text ids joined by "\n" (what its copy action copies; a string, so a
   * memoized row stays equal across rebuilds); "" otherwise.
   */
  | { type: "text"; key: string; id: string; final: boolean; answer: string }
  | { type: "question"; key: string; id: string }
  | { type: "permission"; key: string; id: string }
  | { type: "note"; key: string; id: string; kind: "error" | "compaction" | "commandOutput" }
  /** A user message sent while the turn ran (a steer); it stays visible when the turn folds. */
  | { type: "steer"; key: string; id: string }
  /** A system note on its own line between turns (an item of kind "note"). */
  | { type: "system"; key: string; id: string };

/** One row of the timeline (what the virtualizer lays out). */
export type TimelineRow =
  | { type: "user"; key: string; id: string }
  | WorkNode
  | {
      /**
       * A turn's header, under its user message(s) and above its work. Finished: "Worked
       * for 4m 08s · 12 steps · $1.12 · Opus", the turn's fold toggle. Live (no turn_end
       * yet, the thread works): "Working · 3 steps · 1m 12s", always open. Its key is
       * `h:<turn key>` in both forms, so the live row becomes the finished one in place.
       */
      type: "header";
      key: string;
      /** The turn_end item; "" for the live header. */
      id: string;
      /** The turn the header folds (TimelineTurn.key); "" for a live header with no turn yet. */
      turn: string;
      folded: boolean;
      /** The turn's work rows (what the fold hides; a group or Agent row counts as one). */
      steps: number;
      /** The turn's final text items. */
      finals: string[];
      /** Live: the item the elapsed time counts from (the turn's last opening message, else its first item); "" when none. */
      since: string;
    };

/** A turn: from a user message (or the thread's start) to its turn_end, inclusive. */
export interface TimelineTurn {
  /** The first item's id. */
  key: string;
  user: string[];
  body: WorkNode[];
  /** The turn_end item; "" while the turn runs. */
  end: string;
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
        out.push({ type: "text", key: it.id, id: it.id, final: false, answer: "" });
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
        out.push({ type: "system", key: it.id, id: it.id });
        break;
      case "user":
        // Only a steer reaches here (buildTurns keeps a turn's opening messages apart).
        out.push({ type: "steer", key: it.id, id: it.id });
        break;
      case "turnEnd":
        break;
    }
  }
  return out;
}

/**
 * Marks the trailing text rows of a turn's body as final (thinking may sit between them);
 * in a finished turn they carry the answer their copy action copies.
 */
function markFinal(body: WorkNode[], ended: boolean): void {
  let from = body.length;
  for (let i = body.length - 1; i >= 0; i--) {
    const n = body[i];
    if (n?.type === "text") from = i;
    else if (n?.type !== "thinking") break;
  }
  const ids = body.slice(from).flatMap((n) => (n.type === "text" ? [n.id] : []));
  const answer = ended ? ids.join("\n") : "";
  for (let i = from; i < body.length; i++) {
    const n = body[i];
    // The copy action sits at the top right of the answer: on its first row.
    if (n?.type === "text") body[i] = { ...n, final: true, answer: i === from ? answer : "" };
  }
}

/** Notes (errors, compactions, command output, system notes) and steers stay visible in a folded turn. */
function foldsAway(n: WorkNode): boolean {
  return !(n.type === "text" && n.final) && n.type !== "note" && n.type !== "system" && n.type !== "steer";
}

/** The thread's items (top level, in order) as turns. */
export function buildTurns(items: readonly TimelineItem[]): TimelineTurn[] {
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
  const close = () => {
    if (!cur) return;
    const body = workNodes(cur.items, children, permissions);
    markFinal(body, cur.end !== "");
    turns.push({ key: cur.key, user: cur.user, body, end: cur.end });
    cur = null;
  };
  for (const it of top) {
    if (it.kind === "user") {
      // Sent while the turn runs (it has work and no turn_end yet): a steer. Claude picks
      // it up mid-turn and the turn ends with one turn_end, so it stays in the turn's
      // body. Unless the turn's process ended (an error item is the turn's last: Claude
      // stopped or did not start), which no turn_end will follow: a new turn then.
      const last = cur?.items[cur.items.length - 1];
      if (cur && last && last.kind !== "error") {
        cur.items.push(it);
        continue;
      }
      // A user message starts a turn, unless it follows another one with nothing between.
      if (!cur || cur.items.length > 0) {
        close();
        cur = { key: it.id, user: [], items: [], end: "" };
      }
      cur.user.push(it.id);
      continue;
    }
    if (it.kind === "note") {
      // A system note is a turn of its own: what came before it is done with.
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

/** A turn's work rows: what folding it hides (a group or Agent row counts as one; steers and notes are not steps). */
function stepCount(body: readonly WorkNode[]): number {
  return body.filter(foldsAway).length;
}

export interface TimelineOptions {
  /** The user's fold choice for a turn, by its key; undefined: the default. */
  fold: (turnKey: string) => boolean | undefined;
  /** The thread works (busy or starting) and no request waits: the open turn shows its live ("Working") header. */
  working: boolean;
  /**
   * Whether a finished turn (by its turn_end id) ended while the list was scrolled up: it
   * stays open until the list is pinned at the bottom again (stores/thread.ts
   * deferTurnFolds). The user's choice still wins. Absent: none.
   */
  deferred?: (turnEndId: string) => boolean;
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

/** A system note's turn of its own (buildTurns): no user message, no turn_end, no header. */
function isNoteTurn(t: TimelineTurn): boolean {
  return t.user.length === 0 && t.end === "" && t.body.length === 1 && t.body[0]?.type === "system";
}

/** The rows to lay out, top to bottom: per turn its user message(s), its header, its work (minus what the fold hides). */
export function buildRows(turns: readonly TimelineTurn[], opts: TimelineOptions): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const last = turns[turns.length - 1];
  // The open turn while the thread works; none when the last turn ended (nothing runs
  // after a turn_end) or is a system note (Claude starts a turn that has no item yet).
  const live = opts.working && last && last.end === "" && !isNoteTurn(last) ? last : undefined;
  turns.forEach((t) => {
    const folded = t.end !== "" && (opts.fold(t.key) ?? (opts.deferred?.(t.end) ? false : defaultFolded(t)));
    for (const u of t.user) rows.push({ type: "user", key: u, id: u });
    if (t.end || t === live) {
      const finals = t.body.flatMap((n) => (n.type === "text" && n.final ? [n.id] : []));
      rows.push({ type: "header", key: `h:${t.key}`, id: t.end, turn: t.key, folded, steps: stepCount(t.body), finals, since: t.user[t.user.length - 1] ?? t.key });
    }
    for (const n of t.body) if (!folded || !foldsAway(n)) rows.push(n);
  });
  // Working with no turn to head (an empty thread starting, a fork's note): a live header alone.
  if (opts.working && (!last || isNoteTurn(last))) rows.push({ type: "header", key: "h:", id: "", turn: "", folded: false, steps: 0, finals: [], since: "" });
  return rows;
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
  return [it.id, it.kind, it.name, it.parentToolUseId, it.toolUseId, it.toolStatus, it.requestState, it.streaming ? "1" : ""].join(SEP);
}

export function decodeTimelineKey(k: string): TimelineItem {
  const [id = "", kind = "text", name = "", parentToolUseId = "", toolUseId = "", toolStatus = "", requestState = "", streaming = ""] = k.split(SEP);
  return {
    id,
    kind: kind as ThreadItemKind,
    name,
    parentToolUseId,
    toolUseId,
    toolStatus: toolStatus as ToolStatusView | "",
    requestState: requestState as RequestStateView | "",
    streaming: streaming === "1",
  };
}

/** A turn's cost in its header: "$1.12", "<$0.01" under a cent, "" when nothing or not known (null). */
export function turnCostLabel(usd: number | null): string {
  if (usd === null || !(usd > 0)) return "";
  return usd >= 0.005 ? `$${usd.toFixed(2)}` : "<$0.01";
}
