/**
 * Thread lineage (docs/notes/agents-3-lineage-gui.md): which thread's agent created a
 * thread (`createdBy`, docs/notes/agents-2-metadata.md), its siblings (the creator's other
 * threads) and its children (threads created from it). Pure, over the thread list; the
 * narrow selectors live in stores/lineage.ts. Order is always spawn order: the list's
 * `order` (creation time, then id). A creator is resolved by its id and shown under its
 * current name (docs/notes/lineage-by-id.md).
 */
import type { ThreadView } from "@/api/threads";
import { statusLine, type StatusTone } from "./statusLine";

/** The thread list as lineage reads it (stores/threads ThreadsData). */
export interface LineageData {
  byId: Readonly<Record<string, ThreadView>>;
  order: readonly string[];
}

/** The Threads panel shows this many siblings, then a "+N more" row that expands. */
export const SIBLINGS_CAP = 5;

/**
 * Who created a thread, resolved by the creator's id (docs/notes/lineage-by-id.md): its id,
 * its name, and whether it still exists.
 */
export interface Creator {
  id: string;
  /**
   * The creator's current name (its id while unnamed) when it is in the thread list; once
   * it is removed, the name it had when the thread was created (createdByName), else its id.
   */
  name: string;
  /** In the thread list; an archived creator counts, a removed one does not. */
  exists: boolean;
}

/** The creator `id` as a Creator: its current name while it exists, else `recorded` (else the id). */
function resolveCreator(data: LineageData, id: string, recorded: string): Creator {
  const c = data.byId[id];
  if (c) return { id, name: c.name || id, exists: true };
  return { id, name: recorded || id, exists: false };
}

/** The thread's creator; null when the user made it (or the thread is unknown). */
export function creatorOf(data: LineageData, id: string): Creator | null {
  const t = data.byId[id];
  if (!t?.createdBy) return null;
  return resolveCreator(data, t.createdBy, t.createdByName);
}

/** Other threads with the same creator, in spawn order; none for a thread the user made. */
export function siblingIds(data: LineageData, id: string): string[] {
  const by = data.byId[id]?.createdBy ?? "";
  if (!by) return [];
  return data.order.filter((x) => x !== id && data.byId[x]?.createdBy === by);
}

/** Threads created from this one, in spawn order. */
export function childIds(data: LineageData, id: string): string[] {
  if (!id) return [];
  return data.order.filter((x) => x !== id && data.byId[x]?.createdBy === id);
}

/**
 * Whether the thread has any lineage to show: a creator (removed ones count: the panel
 * keeps their row), siblings or children. The Threads surface is listed only then.
 */
export function hasLineage(data: LineageData, id: string): boolean {
  return creatorOf(data, id) !== null || siblingIds(data, id).length > 0 || childIds(data, id).length > 0;
}

/** The first `cap` ids while collapsed, and how many the "+N more" row hides. */
export function capIds(ids: readonly string[], expanded: boolean, cap = SIBLINGS_CAP): { shown: readonly string[]; more: number } {
  if (expanded || ids.length <= cap) return { shown: ids, more: 0 };
  return { shown: ids.slice(0, cap), more: ids.length - cap };
}

/** How many projects the threads run in ("" for no project counts as one place). */
export function projectCount(data: LineageData, ids: readonly string[]): number {
  return new Set(ids.map((x) => data.byId[x]?.projectId ?? "")).size;
}

/** The figures of the panel's header. */
export interface LineageCounts {
  /** "created" when an agent made the thread, "removed" when that thread is gone, "" when the user did. */
  creator: "" | "created" | "removed";
  creatorName: string;
  siblings: number;
  children: number;
  /** Projects the children run in. */
  childProjects: number;
}

/** Rows besides "This thread": the creator (removed too: its row stays), siblings and children. */
export function relatedCount(c: LineageCounts): number {
  return (c.creator ? 1 : 0) + c.siblings + c.children;
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/**
 * The header's second line after the creator part: "3 siblings · 1 child" for an agent's
 * thread (zero parts left out), "6 threads created from here, in 3 projects" for one the
 * user made. "" when there is nothing to add.
 */
export function lineageTail(c: LineageCounts): string {
  if (c.creator) {
    const parts: string[] = [];
    if (c.siblings > 0) parts.push(plural(c.siblings, "sibling", "siblings"));
    if (c.children > 0) parts.push(plural(c.children, "child", "children"));
    return parts.join(" · ");
  }
  if (c.children === 0) return "";
  return `${plural(c.children, "thread", "threads")} created from here, in ${plural(c.childProjects, "project", "projects")}`;
}

/** A related thread's status in the panel, in the sidebar's words and tones. */
export type LineageStatus = "working" | "input" | "finished" | "error" | "idle" | "archived" | "snoozed";

export const lineageStatusWords: Readonly<Record<LineageStatus, string>> = {
  working: "Working",
  input: "Needs input",
  finished: "Finished",
  error: "Error",
  idle: "Idle",
  archived: "Archived",
  snoozed: "Snoozed",
};

export const lineageStatusTones: Readonly<Record<LineageStatus, StatusTone>> = {
  working: "sky",
  input: "amber",
  finished: "emerald",
  error: "red",
  idle: "muted",
  archived: "muted",
  snoozed: "muted",
};

/**
 * The thread's status word: archived and snoozed first (such a thread is stopped and
 * waits on nothing), else the sidebar's line-2 kind (lib/statusLine) folded to one word.
 */
export function lineageStatus(t: ThreadView | undefined): LineageStatus {
  if (!t) return "idle";
  if (t.archivedAtMs !== null) return "archived";
  if (t.snoozedUntilMs !== null) return "snoozed";
  switch (statusLine(t).kind) {
    case "working":
      return "working";
    case "input":
    case "question":
    case "plan":
    case "snoozeEnded":
    case "flagAttention":
      return "input";
    case "finished":
      return "finished";
    case "error":
    case "interrupted":
    case "crashed":
    case "flagError":
      return "error";
    case "place":
    case "waiting": // on its own child threads: needs nothing (lib/waiting)
      return "idle";
  }
}

/** The daemon's "Created by <name> · brief: <brief>" note's text, split. */
export interface CreatedByNote {
  /** The creator's name when the thread was created: the fallback for a removed creator. */
  name: string;
  /** "" when the note has no brief part. */
  brief: string;
}

const NOTE_HEAD = "Created by ";
const BRIEF_SEP = " · brief: ";

/**
 * Splits a created-by note's text (internal/store/thread createdByNoteText) at the first
 * " · brief: ". The note is told by its item's `createdBy`, not by its text or id, so a
 * fork's copy reads the same; a name containing the separator splits early, which only
 * shows for a removed creator (an existing one shows its current name).
 */
export function parseCreatedByNote(text: string): CreatedByNote {
  const rest = text.startsWith(NOTE_HEAD) ? text.slice(NOTE_HEAD.length) : text;
  const i = rest.indexOf(BRIEF_SEP);
  return i < 0 ? { name: rest, brief: "" } : { name: rest.slice(0, i), brief: rest.slice(i + BRIEF_SEP.length) };
}

/**
 * The creator a created-by note names, by the note's `createdBy` id: linked (exists) and
 * with its current name while it is in the thread list, else the note's recorded name.
 */
export function noteCreator(data: LineageData, createdBy: string, recorded: string): Creator {
  return resolveCreator(data, createdBy, recorded);
}
