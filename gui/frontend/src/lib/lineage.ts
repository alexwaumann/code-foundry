/**
 * Thread lineage (docs/notes/agents-3-lineage-gui.md): which thread's agent created a
 * thread (`createdBy`, docs/notes/agents-2-metadata.md) and its children (threads created
 * from it). Pure, over the thread list; the
 * narrow selectors live in stores/lineage.ts. Order is always spawn order: the list's
 * `order` (creation time, then id). A creator is resolved by its id and shown under its
 * current name (docs/notes/lineage-by-id.md).
 */
import type { ThreadView } from "@/api/threads";
import { statusLine } from "./statusLine";

/** The thread list as lineage reads it (stores/threads ThreadsData). */
export interface LineageData {
  byId: Readonly<Record<string, ThreadView>>;
  order: readonly string[];
}

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

/** Threads created from this one, in spawn order. */
export function childIds(data: LineageData, id: string): string[] {
  if (!id) return [];
  return data.order.filter((x) => x !== id && data.byId[x]?.createdBy === id);
}

/**
 * Each creator's children in spawn order (childIds for every thread at once), built once
 * per thread list: every sidebar row's selector runs on every list change, and a scan of
 * the list per row would be quadratic. Keyed on the list's own objects (the store replaces
 * them on change).
 */
let memo: { byId: LineageData["byId"]; order: LineageData["order"]; index: ReadonlyMap<string, readonly string[]> } | null = null;

export function childIndex(data: LineageData): ReadonlyMap<string, readonly string[]> {
  if (memo?.byId === data.byId && memo.order === data.order) return memo.index;
  const index = new Map<string, string[]>();
  for (const id of data.order) {
    const by = data.byId[id]?.createdBy;
    if (!by || by === id) continue;
    const kids = index.get(by);
    if (kids) kids.push(id);
    else index.set(by, [id]);
  }
  memo = { byId: data.byId, order: data.order, index };
  return index;
}

/** How far below its root a subtree goes (the daemon's thread.MaxLineageDepth). */
export const MAX_LINEAGE_DEPTH = 8;

/**
 * `root` and every thread below it, depth first, the daemon's thread.Subtree over the
 * thread list: each thread before the threads it created, siblings in spawn order, at most
 * MAX_LINEAGE_DEPTH levels down. A creator cycle is cut where it closes: each thread is
 * listed once. It follows `createdBy`, so a fork (`parentId`) is not part of it, and a
 * removed thread ends the line under it (the GUI has no record of it; its children are in
 * the sidebar by then, lib/inSidebar). The walk reads childIndex, so it costs the subtree,
 * not the list.
 */
export function subtreeIds(data: LineageData, root: string): string[] {
  if (!root) return [];
  const index = childIndex(data);
  const seen = new Set([root]);
  const out = [root];
  const walk = (id: string, depth: number) => {
    if (depth > MAX_LINEAGE_DEPTH) return;
    for (const kid of index.get(id) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      out.push(kid);
      walk(kid, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/** A related thread's status (the card's lineage rows), in the sidebar's terms. */
export type LineageStatus = "working" | "input" | "finished" | "error" | "idle" | "archived" | "snoozed";

/**
 * The thread's status word: archived and snoozed first (such a thread is stopped and
 * waits on nothing), else the sidebar's line-2 kind (lib/statusLine) folded to one word.
 * A thread waiting on its own children or background work is working: a nested lead
 * stays a live row (and counts) for its creator (docs/notes/sidebar-live-count.md).
 */
export function lineageStatus(t: ThreadView | undefined): LineageStatus {
  if (!t) return "idle";
  if (t.archivedAtMs !== null) return "archived";
  if (t.snoozedUntilMs !== null) return "snoozed";
  switch (statusLine(t).kind) {
    case "working":
    case "waiting": // on its own child threads or background work: its team works (lib/waiting)
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
    case "transcriptDeleted":
      return "error";
    case "place":
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
