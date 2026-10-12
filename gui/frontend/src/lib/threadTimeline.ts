/**
 * The rendered thread's timeline as rows (docs/notes/rendered-threads-2-gui.md): pure
 * functions over a structural view of the items (no text), so text deltas never rebuild
 * it. The design is the sketch's variant A (docs/sketches/rendered-thread):
 *
 * - a turn is a user message and what follows it up to its turn_end footer;
 * - consecutive reads and searches fold into one group row ("Read 3 files, searched code
 *   2 times"); thinking between them is absorbed; consecutive thinking items merge;
 * - a subagent's items (parent_tool_use_id) nest under its Agent tool row;
 * - AskUserQuestion's tool call is hidden (the question item stands for it), and a
 *   permission request annotates its tool call (pending: "waiting for you");
 * - a finished turn other than the latest folds its work under the footer: only the user
 *   message, the final assistant text (the trailing text of the turn) and the footer show.
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
  | { type: "text"; key: string; id: string; final: boolean }
  | { type: "question"; key: string; id: string }
  | { type: "permission"; key: string; id: string }
  | { type: "note"; key: string; id: string; kind: "error" | "compaction" | "commandOutput" };

/** One row of the timeline (what the virtualizer lays out). */
export type TimelineRow =
  | { type: "user"; key: string; id: string }
  | WorkNode
  | {
      type: "footer";
      key: string;
      /** The turn_end item. */
      id: string;
      /** The turn the footer folds (TimelineTurn.key). */
      turn: string;
      folded: boolean;
      /** Work rows the fold hides (0 when open). */
      hidden: number;
    }
  | { type: "working"; key: string; /** The turn's user message, for the elapsed time; "" when none. */ since: string };

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
        out.push({ type: "text", key: it.id, id: it.id, final: false });
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
      case "user":
      case "turnEnd":
        break;
    }
  }
  return out;
}

/** Marks the trailing text rows of a turn's body as final (thinking may sit between them). */
function markFinal(body: WorkNode[]): void {
  for (let i = body.length - 1; i >= 0; i--) {
    const n = body[i];
    if (!n) break;
    if (n.type === "text") body[i] = { ...n, final: true };
    else if (n.type !== "thinking") break;
  }
}

/** Notes (errors, compactions, command output) stay visible in a folded turn. */
function foldsAway(n: WorkNode): boolean {
  return !(n.type === "text" && n.final) && n.type !== "note";
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
    markFinal(body);
    turns.push({ key: cur.key, user: cur.user, body, end: cur.end });
    cur = null;
  };
  for (const it of top) {
    if (it.kind === "user") {
      // A user message starts a turn, unless it follows another one with nothing between.
      if (!cur || cur.items.length > 0 || cur.end) {
        close();
        cur = { key: it.id, user: [], items: [], end: "" };
      }
      cur.user.push(it.id);
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

/** Number of rows a node takes when shown (a group or Agent row counts as one). */
function hiddenCount(body: readonly WorkNode[]): number {
  return body.filter(foldsAway).length;
}

export interface TimelineOptions {
  /** The user's fold choice for a turn, by its key; undefined: the default. */
  fold: (turnKey: string) => boolean | undefined;
  /** The thread works (busy or starting) and no request waits: a "Working" row ends the list. */
  working: boolean;
}

/**
 * The default fold of a turn: a finished turn folds unless it is the latest one.
 */
export function defaultFolded(turn: TimelineTurn, latest: boolean): boolean {
  return turn.end !== "" && !latest;
}

/** The rows to lay out, top to bottom. */
export function buildRows(turns: readonly TimelineTurn[], opts: TimelineOptions): TimelineRow[] {
  const rows: TimelineRow[] = [];
  turns.forEach((t, i) => {
    const latest = i === turns.length - 1;
    const folded = t.end !== "" && (opts.fold(t.key) ?? defaultFolded(t, latest));
    for (const u of t.user) rows.push({ type: "user", key: u, id: u });
    for (const n of t.body) if (!folded || !foldsAway(n)) rows.push(n);
    if (t.end) rows.push({ type: "footer", key: `f:${t.end}`, id: t.end, turn: t.key, folded, hidden: folded ? hiddenCount(t.body) : 0 });
  });
  const last = turns[turns.length - 1];
  if (opts.working && (!last || last.end === "")) rows.push({ type: "working", key: "working", since: last?.user[last.user.length - 1] ?? "" });
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
