import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { SearchIcon, Sparkle } from "lucide-react";
import type { SearchEntryView } from "@/api/search";
import { errorMessage } from "@/api/stream";
import { DictationMic } from "@/components/compose/DictationMic";
import { useComposerDictation } from "@/components/compose/useComposerDictation";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { chordFromEvent } from "@/keys/chord";
import { openingSelection, unseenCue, unseenToRestore, type SearchModeId, type SearchSession } from "@/lib/agentSearch";
import { phraseAtCaret, phraseOnOneLine } from "@/lib/dictation";
import { imeKeyDown } from "@/lib/ime";
import { clearSearches, forgetSearch, startAgent } from "@/stores/agentSearch";
import { useDictateChord } from "@/stores/commands";
import { toggleDictation } from "@/stores/dictation";
import { clearSearchTarget, dropSearchSession, lastSearchMode, pendingSearchStart, saveSearchSession, searchSessionAt, searchTarget, setSearchMode, trackSearchStart } from "@/stores/searchDialog";
import type { SearchDialogApi, SearchModeProps } from "./types";
import { SEARCH_MODES, type SearchMode } from "./modes";
import type { RecentApi } from "./RecentSearches";
import { useRecentSearches, type WatchRecentFn, type WatchSearchFn } from "./useAgentSearch";

/** The header: the mode's icon, the query field, what the mode puts beside it, the mic or listening pill, and the mode switch when there are several. */
function SearchHeader({
  mode,
  modes,
  setMode,
  query,
  setQuery,
  inputRef,
  badges,
  mic,
}: {
  mode: SearchMode;
  modes: readonly SearchMode[];
  setMode: (id: SearchModeId) => void;
  query: string;
  setQuery: (q: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  badges: ReactNode;
  mic: ReactNode;
}) {
  const Icon = mode.id === "agent" ? Sparkle : SearchIcon;
  return (
    <div className="flex h-12 shrink-0 items-center gap-2.5 border-b pr-2.5 pl-4" data-testid="search-header">
      <Icon className="size-4 shrink-0 text-cf-text-muted" aria-hidden data-testid="search-header-icon" data-icon={mode.id === "agent" ? "sparkle" : "search"} />
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        placeholder={mode.placeholder}
        aria-label={mode.id === "agent" ? "Ask about your threads" : "Search threads"}
        spellCheck={false}
        autoComplete="off"
        className="h-10 min-w-0 flex-1 bg-transparent text-body outline-hidden placeholder:text-cf-placeholder"
        data-testid="search-input"
      />
      {badges}
      {mic}
      {modes.length > 1 && (
        // The keyboard stays in the field: a click on the switch does not take it.
        <div
          onMouseDown={(e) => {
            e.preventDefault();
          }}
        >
          <RadioGroup
            variant="segmented"
            size="sm"
            value={mode.id}
            onValueChange={(v) => {
              setMode(v as SearchModeId);
            }}
            aria-label="Search mode"
            data-testid="search-mode"
          >
            {modes.map((m) => (
              <RadioGroupChoice key={m.id} value={m.id} className="text-label font-normal" data-testid={`search-mode-${m.id}`}>
                {m.label}
              </RadioGroupChoice>
            ))}
          </RadioGroup>
        </div>
      )}
    </div>
  );
}

/**
 * What the dialog opens with: the search it was asked to show (the sidebar's row; it opens
 * like a restore, so another unseen search is cued, and where the last close left that
 * same search is kept), else the session of a close within RESTORE_MS (and its question's
 * start, when the dialog closed before StartAgent answered), else the last mode and an
 * empty field.
 */
function openingState(now: number) {
  const s = searchSessionAt(now);
  const target = searchTarget();
  if (target) {
    const restore = s?.entryId === target.id ? { selectedN: s.selectedN, openedN: s.openedN, scrollTop: s.scrollTop } : { selectedN: openingSelection(target), openedN: null, scrollTop: 0 };
    return { restored: true, mode: "agent" as const, query: target.query, entryId: target.id, seed: target, restore, pending: null };
  }
  if (s) {
    const pending = s.entryId === null ? pendingSearchStart(s.query.trim()) : null;
    return { restored: true, mode: s.mode, query: s.query, entryId: s.entryId, seed: null, restore: { selectedN: s.selectedN, openedN: s.openedN, scrollTop: s.scrollTop }, pending };
  }
  return { restored: false, mode: lastSearchMode(), query: "", entryId: null, seed: null, restore: null, pending: null };
}

/**
 * The cross-thread search dialog (search.open, cmd+shift+f;
 * docs/notes/search-4-find-dialog.md, search-6-agent-gui.md): a page of the palette's
 * chrome, wider, with a query field over the current mode's body. Two modes, Agent search
 * (the default) and Find; Tab in the field switches and keeps the query, and the last one
 * used is remembered. Remounted on every open: reopened within RESTORE_MS it shows what it
 * showed (mode, query selected, results, scroll, the next unopened hit); later it opens
 * empty on Recent searches. A finished agent search not shown yet (unseen) is shown
 * whatever the timer; search.open with an id (the sidebar's search row) shows that one.
 * dictation.toggle's chord, if the user bound one, dictates into the field.
 */
export function SearchDialog({
  modes = SEARCH_MODES,
  watchSearch,
  watchRecent,
  ...seams
}: { modes?: readonly SearchMode[]; watchSearch?: WatchSearchFn; watchRecent?: WatchRecentFn } & Pick<SearchModeProps, "search" | "loaders">) {
  const [openedAt] = useState(() => Date.now());
  const [init] = useState(() => openingState(openedAt));
  const [modeId, setModeId] = useState<SearchModeId>(init.mode);
  const mode = modes.find((m) => m.id === modeId) ?? modes[0];
  const [query, setQuery] = useState(init.query);
  const [shown, setShown] = useState<{ id: string; seed: SearchEntryView | null } | null>(init.entryId ? { id: init.entryId, seed: init.seed } : null);
  const [restore, setRestore] = useState(init.restore);
  const [starting, setStarting] = useState(init.pending !== null);
  const [startError, setStartError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  useEffect(clearSearchTarget, []);

  // What a reopen within RESTORE_MS restores; saved when the dialog closes (unmounts).
  const session = useRef<SearchSession>({ mode: init.mode, query: init.query, entryId: init.entryId, selectedN: init.restore?.selectedN ?? null, openedN: init.restore?.openedN ?? null, scrollTop: init.restore?.scrollTop ?? 0, closedAtMs: 0 });
  useEffect(() => {
    session.current = { ...session.current, mode: modeId, query, entryId: shown?.id ?? null };
  }, [modeId, query, shown]);
  useEffect(
    () => () => {
      saveSearchSession({ ...session.current, closedAtMs: Date.now() });
    },
    [],
  );
  const report = useCallback((p: Partial<SearchSession>) => {
    session.current = { ...session.current, ...p };
  }, []);

  // Restored: the query is selected, so typing replaces it.
  useLayoutEffect(() => {
    if (init.restored) inputRef.current?.select();
  }, [init.restored]);

  const editQuery = useCallback((q: string) => {
    setQuery(q);
    // An empty field is a new search: the shown one goes, Recent searches come back.
    if (q.trim() === "") setShown(null);
  }, []);

  const changeMode = useCallback((m: SearchModeId) => {
    setModeId(m);
    setSearchMode(m);
    inputRef.current?.focus();
  }, []);

  const show = useCallback((e: SearchEntryView) => {
    setModeId("agent");
    setSearchMode("agent");
    setQuery(e.query);
    setShown({ id: e.id, seed: e });
    setRestore({ selectedN: openingSelection(e), openedN: null, scrollTop: 0 });
    setStartError("");
    requestAnimationFrame(() => inputRef.current?.select());
  }, []);

  // A start's answer: its search shown (and saved, should the dialog close before the
  // effect that saves it runs; a close before the answer is the store's, trackSearchStart).
  const awaitStart = useCallback((result: Promise<SearchEntryView>) => {
    result.then(
      (e) => {
        session.current = { ...session.current, entryId: e.id };
        setShown({ id: e.id, seed: e });
        setRestore(null);
        setStarting(false);
      },
      (err: unknown) => {
        setStartError(errorMessage(err));
        setStarting(false);
      },
    );
  }, []);

  const start = useCallback(
    (question: string) => {
      const q = question.trim();
      if (q === "") return;
      setModeId("agent");
      setSearchMode("agent");
      setStarting(true);
      setStartError("");
      const result = startAgent(q);
      trackSearchStart(q, result);
      awaitStart(result);
    },
    [awaitStart],
  );

  // Reopened while the question it closed on was still starting: that start, not a second.
  useEffect(() => {
    if (init.pending) awaitStart(init.pending);
  }, [init.pending, awaitStart]);

  // Recent searches: while the field is empty (both modes); a restored dialog holds the
  // list throughout, for the cue of finished searches it has not shown.
  const recentOn = query.trim() === "";
  const list = useRecentSearches(recentOn || init.restored, watchRecent);
  const [recentSel, setRecentSel] = useState<string | null>(null);
  const selectedRecent = list?.find((e) => e.id === recentSel) ?? list?.[0] ?? null;
  // A finished search the dialog never showed: shown whatever the timer, once, unless the
  // user typed first. A restored dialog keeps what it restored and cues the unseen instead.
  const unseenChecked = useRef(init.restored);
  useEffect(() => {
    if (unseenChecked.current || !list) return;
    unseenChecked.current = true;
    const u = unseenToRestore(list);
    if (u && inputRef.current?.value === "") show(u);
  }, [list, show]);

  const pickRecent = useCallback(
    (e: SearchEntryView) => {
      if (e.mode === "agent") {
        show(e);
        return;
      }
      // A Find entry runs again.
      changeMode("find");
      setQuery(e.query);
      requestAnimationFrame(() => inputRef.current?.select());
    },
    [show, changeMode],
  );
  const cue = init.restored && !recentOn ? unseenCue(list, shown?.id ?? null) : null;
  const recent: RecentApi = useMemo(
    () => ({
      list,
      selectedId: selectedRecent?.id ?? null,
      select: setRecentSel,
      pick: pickRecent,
      forget: (id) => {
        dropSearchSession(id);
        void forgetSearch(id);
      },
      clear: () => {
        void clearSearches().then((ran) => {
          if (ran) dropSearchSession();
        });
      },
    }),
    [list, selectedRecent?.id, pickRecent],
  );

  // Dictation into the field: the composer's mic and pill, and a chord bound to
  // dictation.toggle (none by default) while the dialog is open.
  const insert = useCallback((text: string) => {
    const el = inputRef.current;
    if (!el) return;
    const v = el.value;
    const s = el.selectionStart ?? v.length;
    const e = el.selectionEnd ?? s;
    const piece = phraseAtCaret(phraseOnOneLine(text), v.slice(0, s), v.slice(e));
    if (piece === "") return;
    setQuery(v.slice(0, s) + piece + v.slice(e));
    requestAnimationFrame(() => {
      el.setSelectionRange(s + piece.length, s + piece.length);
    });
  }, []);
  const dictation = useComposerDictation({ draftKey: "search-dialog", rootRef: headerRef, primary: false, insert });
  const dictateChord = useDictateChord();

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (imeKeyDown(e.nativeEvent)) return;
    const chord = chordFromEvent(e.nativeEvent);
    // The palette looks up no chords while it is open: dictation.toggle's is the dialog's.
    if (chord && dictateChord && chord === dictateChord && dictation.availability !== "hidden") {
      e.preventDefault();
      e.stopPropagation();
      toggleDictation(dictation.clientId);
      return;
    }
    if (e.target !== inputRef.current) return;
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey && modes.length > 1) {
      e.preventDefault();
      e.stopPropagation();
      const i = modes.findIndex((m) => m.id === mode?.id);
      const next = modes[(i + (e.shiftKey ? modes.length - 1 : 1)) % modes.length];
      if (next) changeMode(next.id);
      return;
    }
    // Recent searches take the arrows and Enter while the field is empty.
    if (!recentOn || !list || list.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.ctrlKey && (e.key === "n" || e.key === "p"))) {
      e.preventDefault();
      e.stopPropagation();
      const i = list.findIndex((x) => x.id === selectedRecent?.id);
      const dir = e.key === "ArrowDown" || e.key === "n" ? 1 : -1;
      setRecentSel(list[(i + dir + list.length) % list.length]?.id ?? null);
      return;
    }
    if (e.key === "Enter" && !e.metaKey && selectedRecent) {
      e.preventDefault();
      e.stopPropagation();
      pickRecent(selectedRecent);
    }
  };

  if (!mode) return null;
  const { Body } = mode;
  const showMic = mode.id === "agent" || dictation.phase !== null;
  const api: SearchDialogApi = {
    mode: mode.id,
    modeCount: modes.length,
    setMode: changeMode,
    query,
    setQuery: editQuery,
    entryId: shown?.id ?? null,
    seed: shown?.seed ?? null,
    show,
    start,
    starting,
    startError,
    restore,
    report,
    recent,
    cue,
    selectedRecent,
    dictation,
    inputRef,
    ...(watchSearch ? { watchSearch } : {}),
  };
  return (
    <div className="flex h-[min(620px,calc(86vh/var(--cf-zoom)-2rem))] flex-col" data-testid="search-dialog" data-mode={mode.id} onKeyDownCapture={onKeyDownCapture}>
      <Body
        query={query}
        dialog={api}
        header={(badges) => (
          <div ref={headerRef}>
            <SearchHeader
              mode={mode}
              modes={modes}
              setMode={changeMode}
              query={query}
              setQuery={editQuery}
              inputRef={inputRef}
              badges={badges}
              mic={showMic ? <DictationMic dictation={dictation} /> : null}
            />
          </div>
        )}
        {...seams}
      />
    </div>
  );
}
