import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Square } from "lucide-react";
import type { AgentHitView, SearchEntryView } from "@/api/search";
import { Kbd } from "@/components/ui/kbd";
import { endedNote, footerModel, moveHit, restoreSelection, searchEnded, tookLabel } from "@/lib/agentSearch";
import { canonicalModelName } from "@/lib/models";
import { imeKeyDown } from "@/lib/ime";
import { markSearchSeen, openAgentHit, promoteAgent, stopAgent } from "@/stores/agentSearch";
import { useModelChoices, useSettingValue } from "@/stores/settings";
import { AnswerText, HitRow, SectionHeading, StepList, SummaryLine } from "./AgentParts";
import { paintQuote, type PreviewSubject } from "./preview";
import { RecentList, RecentPreview } from "./RecentSearches";
import { SearchPreview } from "./SearchPreview";
import type { RestoreInit, SearchModeProps } from "./types";
import { useSearchWatch } from "./useAgentSearch";
import { previewKey, useSearchPreview, type PreviewLoaders, type PreviewTarget } from "./useSearch";

/** The clock, ticking each second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [on]);
  return now;
}

/** The footer's right side: the utility model at low effort (the shown search's, else the setting's). */
function useFooterModel(model: string): string {
  const setting = useSettingValue("models.utility") ?? "";
  const choices = useModelChoices();
  return footerModel(model || setting, (id) => canonicalModelName(choices, id.replace(/\[1m\]$/, "")));
}

function Hint({ k, children }: { k: string; children: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Kbd size="sm">{k}</Kbd>
      {children}
    </span>
  );
}

/** The selected hit's message in the preview, its quote marked as a citation is. */
function HitPreview({ hit, loaders }: { hit: AgentHitView; loaders: PreviewLoaders | undefined }) {
  const target: PreviewTarget = useMemo(() => ({ kind: "hit", threadId: hit.threadId, itemId: hit.itemId, ordinal: hit.ordinal, withPrompt: hit.speaker !== "user" }), [hit.threadId, hit.itemId, hit.ordinal, hit.speaker]);
  const subject: PreviewSubject = { kind: "hit", threadId: hit.threadId, threadName: hit.threadName, archived: hit.archived, atMs: hit.itemAtMs, speaker: hit.speaker };
  const data = useSearchPreview(target, loaders);
  const shown = data && data.key === previewKey(target) ? data : null;
  const quote = hit.quote;
  const paint = useCallback((root: HTMLElement | null) => {
    paintQuote(root, quote);
  }, [quote]);
  return <SearchPreview subject={subject} data={shown} query="" paint={paint} caption={null} />;
}

/** The results column: the steps while running (or folded under the answer when done), the answer, the ranked hits. */
function Results({
  entry,
  selectedN,
  onSelect,
  onOpen,
  scrollRef,
  onScroll,
}: {
  entry: SearchEntryView;
  selectedN: number | null;
  onSelect: (n: number) => void;
  onOpen: (h: AgentHitView) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}) {
  const running = entry.status === "running";
  const note = endedNote(entry);
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3" onScroll={onScroll} data-testid="agent-results" data-status={entry.status}>
      {running ? (
        <>
          <SectionHeading>Searching</SectionHeading>
          {entry.steps.length > 0 ? <StepList steps={entry.steps} /> : <p className="px-3 py-1 text-body-sm text-cf-text-muted">Starting…</p>}
          {entry.hits.length > 0 && <SectionHeading>Found so far</SectionHeading>}
        </>
      ) : (
        <>
          {note && (
            <p className={entry.status === "failed" ? "px-3 pt-3 text-body-sm text-cf-error-text" : "px-3 pt-3 text-body-sm text-cf-text-muted"} role={entry.status === "failed" ? "alert" : undefined} data-testid="agent-ended">
              {note}
            </p>
          )}
          {entry.answer && <AnswerText answer={entry.answer} onRef={onSelect} />}
          <SummaryLine entry={entry} />
          {entry.hits.length > 0 && <div className="mx-1 mt-1 mb-1 border-t" />}
        </>
      )}
      <div className="flex flex-col gap-0.5" role="listbox" aria-label="Results">
        {entry.hits.map((h) => (
          <HitRow
            key={h.n}
            hit={h}
            selected={h.n === selectedN}
            onSelect={() => {
              onSelect(h.n);
            }}
            onOpen={() => {
              onOpen(h);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** Before a question, the left column's hint; Recent searches under it. */
function AskHint() {
  return (
    <p className="px-5 pt-5 pb-2 text-body-sm text-cf-text-muted" data-testid="agent-hint">
      Ask in your own words: “the thread where we picked the update dialog copy”, “why did we drop the ledger?”
    </p>
  );
}

/**
 * The Agent search mode (docs/notes/search-6-agent-gui.md): Enter asks the question
 * (SearchService.StartAgent; typing does not search). While it runs, its steps and the
 * verified hits as they arrive; when done, the answer (plain text, [n] as markers), the
 * summary line that opens the steps, and the ranked hits. The preview shows the selected
 * hit's message with the quote marked. Enter opens it in its thread with the quote
 * revealed, ⌘⏎ continues the search as a thread, Esc closes and the search keeps running.
 */
export function AgentSearch({ query: raw, header, dialog, loaders }: SearchModeProps) {
  const query = raw.trim();
  const { entry, gone } = useSearchWatch(dialog.entryId, dialog.seed, dialog.watchSearch);
  const running = entry?.status === "running";
  const now = useNow(running || query === "");
  const hits = useMemo(() => entry?.hits ?? [], [entry?.hits]);

  // The selection: restored (the next unopened hit after the one opened), else the first hit as it arrives.
  const [selectedN, setSelectedN] = useState<number | null>(dialog.restore?.selectedN ?? null);
  // Another search shown: its own selection.
  const [selectionFor, setSelectionFor] = useState(dialog.entryId);
  if (selectionFor !== dialog.entryId) {
    setSelectionFor(dialog.entryId);
    if (!dialog.restore) setSelectedN(null);
  }
  const restored = useRef<RestoreInit | null>(null);
  useEffect(() => {
    if (hits.length === 0) return;
    const r = dialog.restore;
    if (r && restored.current !== r) {
      restored.current = r;
      setSelectedN(restoreSelection(hits, r.openedN, r.selectedN));
      return;
    }
    setSelectedN((cur) => (cur !== null && hits.some((h) => h.n === cur) ? cur : (hits[0]?.n ?? null)));
  }, [hits, dialog.restore]);
  const selected = hits.find((h) => h.n === selectedN) ?? null;
  const { report } = dialog;
  useEffect(() => {
    report({ selectedN });
  }, [selectedN, report]);

  // The results' scroll: restored once, reported as it moves.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollRestored = useRef(dialog.restore?.scrollTop ?? 0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollRestored.current === 0 || hits.length === 0) return;
    el.scrollTop = scrollRestored.current;
    scrollRestored.current = 0;
  }, [hits.length]);
  const onScroll = () => {
    report({ scrollTop: scrollRef.current?.scrollTop ?? 0 });
  };
  // A moved selection comes into view.
  useEffect(() => {
    if (selectedN === null) return;
    scrollRef.current?.querySelector(`[data-testid="agent-hit"][data-n="${String(selectedN)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedN]);

  // A finished result on screen is seen.
  const seenFor = useRef("");
  useEffect(() => {
    if (!entry || !entry.unseen || !searchEnded(entry) || seenFor.current === entry.id) return;
    seenFor.current = entry.id;
    markSearchSeen(entry.id);
  }, [entry]);

  const shownQuery = entry?.query.trim() ?? "";
  const resultsShown = entry !== null && query !== "";
  const sameQuestion = resultsShown && query === shownQuery;

  const open = (h: AgentHitView) => {
    if (!entry) return;
    report({ openedN: h.n, selectedN: h.n });
    openAgentHit(entry.id, h);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (imeKeyDown(e.nativeEvent)) return;
    if (resultsShown && (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.ctrlKey && (e.key === "n" || e.key === "p")))) {
      e.preventDefault();
      setSelectedN((cur) => moveHit(hits, cur, e.key === "ArrowDown" || e.key === "n" ? 1 : -1));
      return;
    }
    if (e.key === "Backspace" && e.metaKey && resultsShown) {
      // ⌘⌫: a new search.
      e.preventDefault();
      dialog.setQuery("");
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (e.metaKey) {
      if (entry && sameQuestion && searchEnded(entry)) void promoteAgent(entry);
      return;
    }
    if (query === "" || dialog.starting) return;
    if (!sameQuestion) {
      dialog.start(query);
      return;
    }
    if (selected) {
      open(selected);
      return;
    }
    // Ended with nothing to open: ask again.
    if (searchEnded(entry)) dialog.start(query);
  };

  const model = useFooterModel(entry?.model ?? "");
  const canDictate = dialog.dictation.availability !== "hidden";
  const elapsed = entry && running ? Math.max(0, now - entry.createdAtMs) : 0;
  const recentRow = query === "" ? dialog.selectedRecent : null;

  let left: React.ReactNode;
  if (query === "") {
    left = (
      <>
        <AskHint />
        <RecentList recent={dialog.recent} now={now} />
      </>
    );
  } else if (gone) {
    left = (
      <p className="px-5 py-6 text-body-sm text-cf-text-muted" data-testid="agent-gone">
        This search was forgotten. ⏎ asks again.
      </p>
    );
  } else if (resultsShown) {
    left = <Results entry={entry} selectedN={selectedN} onSelect={setSelectedN} onOpen={open} scrollRef={scrollRef} onScroll={onScroll} />;
  } else {
    left = (
      <>
        {dialog.startError && (
          <p className="px-5 pt-5 text-body-sm text-cf-error-text" role="alert" data-testid="agent-start-error">
            Agent search didn't start: {dialog.startError}
          </p>
        )}
        <p className="px-5 py-5 text-body-sm text-cf-text-muted" data-testid="agent-hint">
          {dialog.starting ? "Starting…" : "⏎ asks Claude to search your threads for it."}
        </p>
      </>
    );
  }

  let right: React.ReactNode;
  if (recentRow) right = <RecentPreview entry={recentRow} />;
  else if (resultsShown && selected) right = <HitPreview hit={selected} loaders={loaders} />;
  else
    right = (
      <div className="flex min-w-0 flex-1 items-center justify-center px-8 text-center text-body-sm text-cf-text-muted" data-testid="search-preview-none">
        {resultsShown && running ? "The messages it finds show here." : resultsShown ? "" : "Agent search reads your threads and links you to the messages that answer it."}
      </div>
    );

  const promoted = Boolean(entry?.promotedThreadId);
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown} data-testid="search-agent">
      {header(null)}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[min(440px,45%)] shrink-0 flex-col border-r">{left}</div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {right}
          {resultsShown && running && (
            <div className="flex shrink-0 items-center justify-end gap-3 px-5 py-2 text-caption text-cf-text-muted" data-testid="agent-running">
              <span className="tabular-nums" data-testid="agent-elapsed">
                {tookLabel(elapsed)}
              </span>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-caption text-cf-text outline-none hover:bg-cf-control-hover focus-visible:ring-2 focus-visible:ring-cf-focus/50"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                }}
                onClick={() => {
                  void stopAgent(entry.id);
                }}
                data-testid="agent-stop"
              >
                <Square className="size-2.5 fill-current" aria-hidden />
                Stop
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-4 border-t px-4 py-2 text-caption text-cf-text-muted" data-testid="search-hints">
        {recentRow ? (
          <Hint k="⏎">{recentRow.mode === "agent" ? "open saved results" : "search again"}</Hint>
        ) : sameQuestion && selected ? (
          <>
            <Hint k="⏎">open and highlight</Hint>
            {searchEnded(entry) && <Hint k="⌘⏎">{promoted ? "open its thread" : "continue in a thread"}</Hint>}
            <Hint k="⌘⌫">new search</Hint>
          </>
        ) : (
          <Hint k="⏎">search</Hint>
        )}
        {canDictate && <Hint k="⌘⇧M">dictate</Hint>}
        {running && sameQuestion ? <Hint k="esc">close · keeps running</Hint> : <Hint k="Tab">Find</Hint>}
        <span className="ml-auto" data-testid="search-model">
          {model}
        </span>
      </div>
    </div>
  );
}
