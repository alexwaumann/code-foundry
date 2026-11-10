import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Square } from "lucide-react";
import type { AgentHitView, SearchEntryView } from "@/api/search";
import { Kbd } from "@/components/ui/kbd";
import { formatChord } from "@/keys/chord";
import { ANSWER_ROW, defaultSelection, endedNote, footerModel, hasAnswerRow, moveHit, restoreSelection, resultRows, searchEnded, tookLabel } from "@/lib/agentSearch";
import { useNow } from "@/lib/clock";
import { canonicalModelName } from "@/lib/models";
import { imeKeyDown } from "@/lib/ime";
import { markSearchSeen, openAgentHit, promoteAgent, stopAgent } from "@/stores/agentSearch";
import { useDictateChord } from "@/stores/commands";
import { useModelChoices, useSettingValue } from "@/stores/settings";
import { AnswerPane, AnswerRow, HitRow, SectionHeading, StepList, SummaryLine } from "./AgentParts";
import { paintQuote, type PreviewSubject } from "./preview";
import { RecentList, RecentPreview, UnseenCueRow } from "./RecentSearches";
import { SearchPreview } from "./SearchPreview";
import type { RestoreInit, SearchModeProps } from "./types";
import { useSearchWatch } from "./useAgentSearch";
import { previewKey, useSearchPreview, type PreviewLoaders, type PreviewTarget } from "./useSearch";

/** How long a running search has run, ticking each second (only this span re-renders). */
function Elapsed({ since }: { since: number }) {
  const now = useNow(1000);
  return (
    <span className="tabular-nums" data-testid="agent-elapsed">
      {tookLabel(Math.max(0, now - since))}
    </span>
  );
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

/** The dictate hint, only with a chord to show: dictation.toggle has none by default. */
export function DictateHint({ canDictate }: { canDictate: boolean }) {
  const chord = useDictateChord();
  if (!canDictate || !chord) return null;
  return <Hint k={formatChord(chord)}>dictate</Hint>;
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

/** The results column: the steps while running (or folded under the Answer row when done), the Answer row, the ranked hits. */
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
          {hasAnswerRow(entry) && (
            <div className="pt-2" role="listbox" aria-label="Answer">
              <AnswerRow
                answer={entry.answer}
                selected={selectedN === ANSWER_ROW}
                onSelect={() => {
                  onSelect(ANSWER_ROW);
                }}
              />
            </div>
          )}
          {note && (
            <p className={entry.status === "failed" ? "px-3 pt-3 text-body-sm text-cf-error-text" : "px-3 pt-3 text-body-sm text-cf-text-muted"} role={entry.status === "failed" ? "alert" : undefined} data-testid="agent-ended">
              {note}
            </p>
          )}
          {entry.steps.length > 0 && <SummaryLine entry={entry} />}
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

/** Whether a restored selection is the user's: one that was reported, or a hit opened. */
function restoredPick(r: RestoreInit): boolean {
  return r.selectedN !== null || r.openedN !== null;
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
 * verified hits as they arrive; when done, the Answer row, the summary line that opens
 * the steps, and the ranked hits. The preview shows the whole answer (rendered, [n] as
 * markers) for the Answer row and the selected hit's message with the quote marked for a
 * hit. Enter opens a hit in its thread with the quote revealed, and from the Answer row
 * moves to the first hit; ⌘⏎ continues the search as a thread, Esc closes and the search
 * keeps running.
 */
export function AgentSearch({ query: raw, header, dialog, loaders }: SearchModeProps) {
  const query = raw.trim();
  const { entry, gone } = useSearchWatch(dialog.entryId, dialog.seed, dialog.watchSearch);
  const running = entry?.status === "running";
  const hits = useMemo(() => entry?.hits ?? [], [entry?.hits]);
  const status = entry?.status ?? "running";
  const answer = entry?.answer ?? "";
  const rows = useMemo(() => resultRows({ status, answer, hits }), [status, answer, hits]);

  // The selection: restored (the next unopened hit after the one opened), else the first
  // hit as it arrives, then the Answer row when the run ends. `picked`: the row is one the
  // user chose (a key, the pointer, a marker, or restored), which a run's end leaves alone.
  const [selectedN, setSelectedN] = useState<number | null>(dialog.restore?.selectedN ?? null);
  const [picked, setPicked] = useState(dialog.restore ? restoredPick(dialog.restore) : false);
  const pick = useCallback((n: number) => {
    setPicked(true);
    setSelectedN(n);
  }, []);
  // Another search shown: its own selection.
  const [selectionFor, setSelectionFor] = useState(dialog.entryId);
  if (selectionFor !== dialog.entryId) {
    setSelectionFor(dialog.entryId);
    setPicked(false);
    if (!dialog.restore) setSelectedN(null);
  }
  const restored = useRef<RestoreInit | null>(null);
  useEffect(() => {
    if (rows.length === 0) return;
    const r = dialog.restore;
    if (r && restored.current !== r) {
      restored.current = r;
      setPicked(restoredPick(r));
      setSelectedN(restoreSelection(rows, r.openedN, r.selectedN));
      return;
    }
    setSelectedN((cur) => defaultSelection(rows, cur, picked));
  }, [rows, dialog.restore, picked]);
  const selected = hits.find((h) => h.n === selectedN) ?? null;
  const answerSelected = selectedN === ANSWER_ROW && rows[0]?.n === ANSWER_ROW;
  const { report } = dialog;
  // While a run goes, the first hit is no choice: a restore after it ended starts on the Answer row.
  const reportedN = status === "running" && !picked ? null : selectedN;
  useEffect(() => {
    report({ selectedN: reportedN });
  }, [reportedN, report]);

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
    const row = selectedN === ANSWER_ROW ? '[data-testid="agent-answer-row"]' : `[data-testid="agent-hit"][data-n="${String(selectedN)}"]`;
    scrollRef.current?.querySelector(row)?.scrollIntoView({ block: "nearest" });
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
      setPicked(true);
      setSelectedN((cur) => moveHit(rows, cur, e.key === "ArrowDown" || e.key === "n" ? 1 : -1));
      return;
    }
    if (e.key === "Backspace" && e.metaKey && resultsShown) {
      // ⌘⌫: a new search.
      e.preventDefault();
      dialog.setQuery("");
      return;
    }
    // Enter is the field's: on a focused button (×, Clear, a marker, the summary) it presses that.
    if (e.key !== "Enter" || e.target !== dialog.inputRef.current) return;
    if (e.metaKey) {
      if (entry && sameQuestion && searchEnded(entry)) {
        e.preventDefault();
        void promoteAgent(entry);
      }
      return;
    }
    if (query === "" || dialog.starting) return;
    e.preventDefault();
    if (!sameQuestion) {
      dialog.start(query);
      return;
    }
    if (selected) {
      open(selected);
      return;
    }
    // The Answer row has nothing to open and the dialog already shows it: on to the first hit.
    const first = hits[0];
    if (answerSelected && first) {
      pick(first.n);
      return;
    }
    // Ended with nothing to open: ask again.
    if (searchEnded(entry)) dialog.start(query);
  };

  const model = useFooterModel(entry?.model ?? "");
  const canDictate = dialog.dictation.availability !== "hidden";
  const recentRow = query === "" ? dialog.selectedRecent : null;

  let left: React.ReactNode;
  if (query === "") {
    left = (
      <>
        <AskHint />
        <RecentList recent={dialog.recent} />
      </>
    );
  } else if (gone) {
    left = (
      <p className="px-5 py-6 text-body-sm text-cf-text-muted" data-testid="agent-gone">
        This search was forgotten. ⏎ asks again.
      </p>
    );
  } else if (resultsShown) {
    left = <Results entry={entry} selectedN={selectedN} onSelect={pick} onOpen={open} scrollRef={scrollRef} onScroll={onScroll} />;
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
  else if (resultsShown && answerSelected) right = <AnswerPane key={entry.id} answer={entry.answer} hits={hits} onRef={pick} />;
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
        <div className="flex w-[min(440px,45%)] shrink-0 flex-col border-r">
          {dialog.cue && <UnseenCueRow cue={dialog.cue} onPick={dialog.show} />}
          {left}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {right}
          {resultsShown && running && (
            <div className="flex shrink-0 items-center justify-end gap-3 px-5 py-2 text-caption text-cf-text-muted" data-testid="agent-running">
              <Elapsed since={entry.createdAtMs} />
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
        ) : sameQuestion && (selected || answerSelected) ? (
          <>
            <Hint k="⏎">{selected ? "open and highlight" : hits.length > 0 ? "first result" : "search again"}</Hint>
            {searchEnded(entry) && <Hint k="⌘⏎">{promoted ? "open its thread" : "continue in a thread"}</Hint>}
            <Hint k="⌘⌫">new search</Hint>
          </>
        ) : (
          <Hint k="⏎">{sameQuestion && searchEnded(entry) ? "search again" : "search"}</Hint>
        )}
        <DictateHint canDictate={canDictate} />
        {running && sameQuestion ? <Hint k="esc">close · keeps running</Hint> : dialog.modeCount > 1 && <Hint k="Tab">Find</Hint>}
        <span className="ml-auto" data-testid="search-model">
          {model}
        </span>
      </div>
    </div>
  );
}
