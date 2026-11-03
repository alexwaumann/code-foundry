/**
 * Agent search and the search history (SearchService; docs/notes/search-5-agent-daemon.md)
 * mapped to view models for the search dialog (docs/notes/search-6-agent-gui.md).
 * Generated types stay in this file.
 */
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  AgentSearchStepKind,
  SearchMode,
  SearchService,
  SearchStatus,
  type AgentSearchHit,
  type AgentSearchStep,
  type SearchEntry,
  type SearchWatchEvent,
} from "@/gen/codefoundry/v1/search_pb";
import { SearchSpeaker } from "@/gen/codefoundry/v1/thread_search_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { HEARTBEAT, type Heartbeat } from "./stream";
import type { SearchSpeakerView } from "./threadSearch";

export type SearchStatusView = "running" | "done" | "failed" | "stopped";
export type SearchModeView = "agent" | "find";

/** A message an agent search reported and the daemon verified by its quote. */
export interface AgentHitView {
  /** 1 up, in report order; the answer cites it as [n]. */
  n: number;
  threadId: string;
  /** The thread's name now. */
  threadName: string;
  archived: boolean;
  itemId: string;
  ordinal: number;
  speaker: SearchSpeakerView;
  itemAtMs: number | null;
  /** The quote as the message reads rendered (one line). */
  quote: string;
  /** Why it answers the question: model text, shown as plain text. */
  why: string;
  opened: boolean;
}

/** A step of the run (a search or a read), ready to show. */
export interface AgentStepView {
  index: number;
  kind: "search" | "read" | "other";
  done: boolean;
  failed: boolean;
  text: string;
  /** A search's query. */
  query: string;
  /** A read's thread name. */
  threadName: string;
}

/** One entry of the search history: an agent search (with its run) or a Find search. */
export interface SearchEntryView {
  id: string;
  mode: SearchModeView;
  query: string;
  createdAtMs: number;
  finishedAtMs: number | null;
  status: SearchStatusView;
  /** Why it failed, or how it ended ("stopped at the 2m0s limit"). */
  error: string;
  /** The final answer: model text, plain, citing hits as [n]. */
  answer: string;
  hits: readonly AgentHitView[];
  steps: readonly AgentStepView[];
  searches: number;
  threadsRead: number;
  model: string;
  costUsd: number;
  durationMs: number;
  /** It finished and the dialog has not shown its result yet. */
  unseen: boolean;
  version: number;
  promotedThreadId: string;
  /** A Find entry's result count when recorded; 0 when not known. */
  findHits: number;
}

/** A Watch event: the entry whole, or a change to it. Versions grow by one per change. */
export type SearchWatchEventView =
  | { kind: "snapshot"; version: number; entry: SearchEntryView }
  | { kind: "step"; version: number; step: AgentStepView }
  | { kind: "hit"; version: number; hit: AgentHitView }
  | { kind: "answer"; version: number; text: string }
  | { kind: "status"; version: number; status: SearchStatusView; error: string; finishedAtMs: number | null; costUsd: number; durationMs: number; unseen: boolean };

const speakers: Record<SearchSpeaker, SearchSpeakerView> = {
  [SearchSpeaker.UNSPECIFIED]: "assistant",
  [SearchSpeaker.USER]: "user",
  [SearchSpeaker.ASSISTANT]: "assistant",
  [SearchSpeaker.QUESTION]: "question",
};

const statuses: Record<SearchStatus, SearchStatusView> = {
  [SearchStatus.UNSPECIFIED]: "done",
  [SearchStatus.RUNNING]: "running",
  [SearchStatus.DONE]: "done",
  [SearchStatus.FAILED]: "failed",
  [SearchStatus.STOPPED]: "stopped",
};

const stepKinds: Record<AgentSearchStepKind, AgentStepView["kind"]> = {
  [AgentSearchStepKind.UNSPECIFIED]: "other",
  [AgentSearchStepKind.SEARCH]: "search",
  [AgentSearchStepKind.READ]: "read",
  [AgentSearchStepKind.OTHER]: "other",
};

export function toAgentHitView(h: AgentSearchHit): AgentHitView {
  return {
    n: h.n,
    threadId: h.threadId,
    threadName: h.threadName,
    archived: h.archived,
    itemId: h.itemId,
    ordinal: Number(h.ordinal),
    speaker: speakers[h.speaker],
    itemAtMs: h.itemCreatedAt ? timestampMs(h.itemCreatedAt) : null,
    quote: h.quote,
    why: h.why,
    opened: h.opened,
  };
}

export function toAgentStepView(s: AgentSearchStep): AgentStepView {
  return { index: s.index, kind: stepKinds[s.kind], done: s.done, failed: s.failed, text: s.text, query: s.query, threadName: s.threadName };
}

export function toSearchEntryView(e: SearchEntry): SearchEntryView {
  return {
    id: e.id,
    mode: e.mode === SearchMode.FIND ? "find" : "agent",
    query: e.query,
    createdAtMs: e.createdAt ? timestampMs(e.createdAt) : 0,
    finishedAtMs: e.finishedAt ? timestampMs(e.finishedAt) : null,
    status: e.mode === SearchMode.FIND ? "done" : statuses[e.status],
    error: e.error,
    answer: e.answer,
    hits: e.hits.map(toAgentHitView),
    steps: e.steps.map(toAgentStepView),
    searches: e.searches,
    threadsRead: e.threadsRead,
    model: e.model,
    costUsd: e.costUsd,
    durationMs: Number(e.durationMs),
    unseen: e.unseen,
    version: Number(e.version),
    promotedThreadId: e.promotedThreadId,
    findHits: e.findHits,
  };
}

/** A Watch event as a view; null for a heartbeat or an event this build does not know. */
export function toSearchWatchEventView(ev: SearchWatchEvent): SearchWatchEventView | null {
  const version = Number(ev.version);
  switch (ev.event.case) {
    case "snapshot":
      return { kind: "snapshot", version, entry: toSearchEntryView(ev.event.value) };
    case "step":
      return { kind: "step", version, step: toAgentStepView(ev.event.value) };
    case "hit":
      return { kind: "hit", version, hit: toAgentHitView(ev.event.value) };
    case "answer":
      return { kind: "answer", version, text: ev.event.value.text };
    case "status": {
      const s = ev.event.value;
      return {
        kind: "status",
        version,
        status: statuses[s.status],
        error: s.error,
        finishedAtMs: s.finishedAt ? timestampMs(s.finishedAt) : null,
        costUsd: s.costUsd,
        durationMs: Number(s.durationMs),
        unseen: s.unseen,
      };
    }
    default:
      return null;
  }
}

/** Whether an error is the daemon's NOT_FOUND (a forgotten search). */
export function isSearchGone(err: unknown): boolean {
  return err instanceof ConnectError && err.code === Code.NotFound;
}

/** SearchService.StartAgent: the RUNNING entry (search.agent waits for the end; the dialog watches instead). */
export async function startAgentSearch(question: string, conn: DaemonConnection = daemon): Promise<SearchEntryView> {
  const c = await conn.client(SearchService);
  const res = await c.startAgent({ question });
  if (!res.entry) throw new Error("the daemon returned no search");
  return toSearchEntryView(res.entry);
}

/** SearchService.Watch: a snapshot, then the entry's changes, ending after its status (or NOT_FOUND once forgotten). */
export async function* watchSearch(id: string, signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<SearchWatchEventView | Heartbeat> {
  const c = await conn.client(SearchService);
  for await (const ev of c.watch({ id }, { signal })) {
    if (ev.event.case === "heartbeat") {
      yield HEARTBEAT;
      continue;
    }
    const v = toSearchWatchEventView(ev);
    if (v) yield v;
  }
}

/** SearchService.WatchRecent: the history now and after every change, newest first. */
export async function* watchRecentSearches(signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<SearchEntryView[] | Heartbeat> {
  const c = await conn.client(SearchService);
  for await (const ev of c.watchRecent({}, { signal })) {
    if (ev.heartbeat) {
      yield HEARTBEAT;
      continue;
    }
    yield ev.entries.map(toSearchEntryView);
  }
}
