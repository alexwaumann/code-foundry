/**
 * The app memory for Settings › Memory (docs/notes/memory-page.md): the EventService
 * memory source keeps it (a snapshot on connect and on every change), and the page reads
 * it once more when it opens (MemoryService.Get), which also catches a hand edit since
 * the last read. Writes are the memory.* commands; their snapshot arrives as an event.
 */
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { isOutdatedDaemon } from "@/api/errors";
import { getMemory, type MemoryEntryView, type MemoryEventView, type MemorySnapshotView } from "@/api/memory";
import { errorMessage } from "@/api/stream";
import { memoryBy, type MemoryBy } from "@/lib/memory";
import { useThreadsStore } from "./threads";

interface MemoryState {
  /** The last snapshot (an event's or a Get's); null until one arrives. */
  snapshot: MemorySnapshotView | null;
  /** Why the page's Get failed, while no snapshot came; "" otherwise. */
  loadError: string;
  /** The daemon predates MemoryService. */
  outdated: boolean;
}

export const useMemoryStore = create<MemoryState>()(() => ({ snapshot: null, loadError: "", outdated: false }));

/** Events applied so far: a Get that started before one does not overwrite it. */
let eventSeq = 0;

/** The memory event source's handler (stores/events.ts). */
export function applyMemoryEvent(ev: MemoryEventView): void {
  eventSeq++;
  useMemoryStore.setState({ snapshot: ev.snapshot, loadError: "", outdated: false });
}

/** Get, replaceable in tests. */
export type GetMemoryFn = () => Promise<MemorySnapshotView>;

/** Reads the memory now (the page opening). An event that arrives meanwhile wins. */
export async function loadMemory(get: GetMemoryFn = getMemory): Promise<void> {
  const seq = eventSeq;
  try {
    const snapshot = await get();
    if (seq === eventSeq) useMemoryStore.setState({ snapshot, loadError: "", outdated: false });
  } catch (err) {
    if (seq !== eventSeq) return;
    if (isOutdatedDaemon(err)) useMemoryStore.setState({ outdated: true, loadError: "" });
    else if (useMemoryStore.getState().snapshot === null) useMemoryStore.setState({ loadError: errorMessage(err) });
  }
}

const NONE: readonly string[] = [];

/** The entries' files (their keys), in the memory's order. */
export function useMemoryFiles(): readonly string[] {
  return useMemoryStore(useShallow((s) => s.snapshot?.entries.map((e) => e.file) ?? NONE));
}

/** One entry by its file; undefined once it is gone. */
export function useMemoryEntry(file: string): MemoryEntryView | undefined {
  return useMemoryStore((s) => s.snapshot?.entries.find((e) => e.file === file));
}

/** How many entries there are and how many the memory holds ("N of 40"). */
export function useMemoryCount(): { count: number; max: number } {
  return useMemoryStore(useShallow((s) => ({ count: s.snapshot?.entries.length ?? 0, max: s.snapshot?.maxEntries ?? 0 })));
}

/** The caps an entry's "not given to threads" line names. */
export function useMemoryCaps(): { maxEntries: number; maxBytes: number; maxEntryChars: number } {
  return useMemoryStore(useShallow((s) => ({ maxEntries: s.snapshot?.maxEntries ?? 0, maxBytes: s.snapshot?.maxBytes ?? 0, maxEntryChars: s.snapshot?.maxEntryChars ?? 0 })));
}

/** loading (nothing yet), ready, error (the Get failed, no snapshot) or outdated (no MemoryService). */
export function useMemoryStatus(): "loading" | "ready" | "error" | "outdated" {
  return useMemoryStore((s) => (s.snapshot ? "ready" : s.outdated ? "outdated" : s.loadError ? "error" : "loading"));
}

/** Who remembered an entry, by the thread's id: its current name, or the recorded one once removed. */
export function useMemoryBy(file: string): MemoryBy | null {
  const origin = useMemoryStore((s) => s.snapshot?.entries.find((e) => e.file === file)?.origin);
  const threadId = origin?.kind === "thread" ? origin.threadId : "";
  const thread = useThreadsStore(useShallow((s) => {
    const t = threadId ? s.byId[threadId] : undefined;
    return t ? { name: t.name, archivedAtMs: t.archivedAtMs } : undefined;
  }));
  return origin ? memoryBy(origin, thread) : null;
}

/** Test helper: forgets everything. */
export function resetMemory(): void {
  eventSeq = 0;
  useMemoryStore.setState({ snapshot: null, loadError: "", outdated: false });
}
