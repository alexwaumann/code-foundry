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
