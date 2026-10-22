/**
 * The app memory (docs/notes/memory-dir.md): the user's standing preferences about Code
 * Foundry and how the model behaves in it, which every thread's system prompt carries.
 * MemoryService only reads (Get, Watch; the EventService memory source carries the same
 * snapshots); remembering and forgetting are the memory.* commands. The only file that
 * uses the generated memory types.
 */
import { timestampMs } from "@bufbuild/protobuf/wkt";
import {
  MemoryService,
  type MemoryEntry,
  type MemoryEvent,
  type MemorySnapshot,
} from "@/gen/codefoundry/v1/memory_pb";
import { daemon, type DaemonConnection } from "./endpoint";

/** Who added an entry: a thread (and its name then), or the user. */
export type MemoryOriginView =
  | { kind: "thread"; threadId: string; threadName: string }
  | { kind: "user" };

/** One remembered preference. */
export interface MemoryEntryView {
  /** Its file in the memory directory: stable while the text is, so a list keys on it. */
  file: string;
  /** The number `memory show` prints and `memory remove` takes. */
  index: number;
  text: string;
  /** When it was added (ms); null when unknown (a file added by hand). */
  createdMs: number | null;
  origin: MemoryOriginView;
  /** Whether threads get it: false past the caps, in a directory edited by hand. */
  injected: boolean;
}

/** The whole memory, with its caps. */
export interface MemorySnapshotView {
  entries: MemoryEntryView[];
  /** How many entries threads get and their size in the prompt (maxBytes caps it). */
  injected: number;
  injectedBytes: number;
  maxEntries: number;
  maxBytes: number;
  maxEntryChars: number;
  dir: string;
  /** Why the last read failed ("" when it did not); entries are the last good read's. */
  error: string;
  version: number;
}

/** The EventService memory source's event: the whole memory, on connect and per change. */
export interface MemoryEventView {
  snapshot: MemorySnapshotView;
}

function toEntry(e: MemoryEntry): MemoryEntryView {
  return {
    file: e.file,
    index: e.index,
    text: e.text,
    createdMs: e.created ? timestampMs(e.created) : null,
    origin: e.threadId ? { kind: "thread", threadId: e.threadId, threadName: e.threadName } : { kind: "user" },
    injected: e.injected,
  };
}

export function toMemorySnapshotView(m: MemorySnapshot | undefined): MemorySnapshotView {
  return {
    entries: (m?.entries ?? []).map(toEntry),
    injected: m?.injected ?? 0,
    injectedBytes: m?.injectedBytes ?? 0,
    maxEntries: m?.maxEntries ?? 0,
    maxBytes: m?.maxBytes ?? 0,
    maxEntryChars: m?.maxEntryChars ?? 0,
    dir: m?.dir ?? "",
    error: m?.error ?? "",
    version: Number(m?.version ?? 0n),
  };
}

export function toMemoryEventView(ev: MemoryEvent): MemoryEventView {
  return { snapshot: toMemorySnapshotView(ev.snapshot) };
}

/** Reads the memory now (a hand edit since the last read included). */
export async function getMemory(conn: DaemonConnection = daemon): Promise<MemorySnapshotView> {
  const c = await conn.client(MemoryService);
  const res = await c.get({});
  return toMemorySnapshotView(res.memory);
}
