import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CaseSensitive, Regex, SearchIcon, WholeWord } from "lucide-react";
import type { FinderSourceView } from "@/api/filesystem";
import type { TextQueryView } from "@/api/textSearch";
import { Kbd } from "@/components/ui/kbd";
import { Toggle } from "@/components/ui/toggle";
import { Tip } from "@/components/ui/tooltip";
import { imeKeyDown } from "@/lib/ime";
import { findBarQuery, firstMatch, isMatch, moveMatch, queryReady, queryRegExp, smartCaseSensitive, statusText, TEXT_MIN_QUERY, textRows, type MatchRow } from "@/lib/textSearch";
import { cn } from "@/lib/utils";
import { openTextMatch, tagFoundFile } from "@/stores/fileFinder";
import { FinderModeSwitch } from "./FinderModeSwitch";
import { TextPreview } from "./TextPreview";
import { TextResults } from "./TextResults";
import { useTextPreview, useTextSearch, type PreviewCache, type ReadFileFn, type SearchTextFn } from "./useTextSearch";

/** The three ways to match, and their keys while the field has the keyboard (by key code: ⌥C types ç). */
export interface TextOptions {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

const OPTION_KEYS: Readonly<Record<string, keyof TextOptions>> = { KeyC: "matchCase", KeyW: "wholeWord", KeyR: "regex" };

/** An icon-only toggle beside the field: its tooltip is its name and key. A press leaves the keyboard in the field. */
function OptionToggle({ label, chord, pressed, onPressed, testId, children }: { label: string; chord: string; pressed: boolean; onPressed: (on: boolean) => void; testId: string; children: ReactNode }) {
  return (
    <Tip
      label={
        <span className="flex items-center gap-1.5">
          {label}
          <Kbd size="sm">{chord}</Kbd>
        </span>
      }
    >
      <Toggle
        size="xs"
        variant="outline"
        pressed={pressed}
        onPressedChange={onPressed}
        aria-label={label}
        className="size-6 min-w-6 rounded-sm px-0 text-cf-text-muted aria-pressed:border-cf-accent aria-pressed:bg-cf-accent-surface aria-pressed:text-cf-accent-surface-foreground [&_svg:not([class*='size-'])]:size-4"
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        data-testid={testId}
        data-on={pressed || undefined}
      >
        {children}
      </Toggle>
    </Tip>
  );
}

function Hints({ status }: { status: { text: string; notes: string[] } | null }) {
  return (
    <div className="flex shrink-0 items-center gap-4 border-t px-4 py-2 text-caption text-cf-text-muted" data-testid="text-hints">
      {status && (
        <span className="min-w-0 truncate text-cf-text-secondary" data-testid="text-status">
          {status.text}
          {status.notes.length > 0 && <span className="text-cf-text-muted" data-testid="text-status-notes">{` · ${status.notes.join(" · ")}`}</span>}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1.5">
        <Kbd size="sm">↑</Kbd>
        <Kbd size="sm">↓</Kbd>
        move
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Kbd size="sm">⏎</Kbd>
        open at line
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Kbd size="sm">⌘</Kbd>
        <Kbd size="sm">⏎</Kbd>@ in prompt
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Kbd size="sm">tab</Kbd>
        search files
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <Kbd size="sm">esc</Kbd>
        close
      </span>
    </div>
  );
}

/** What fills the list while it has no rows: the hint, Searching…, no match, or why the search failed. */
function ListMessage({ children, error, testId }: { children: ReactNode; error?: boolean; testId: string }) {
  return (
    <p className={cn("px-5 py-6 text-body-sm", error ? "text-cf-error-text" : "text-cf-text-muted")} role={error ? "alert" : undefined} data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * The finder's Text mode (file.find.text, cmd+shift+P; docs/notes/file-search-5-text-mode.md):
 * the thread search dialog's shape. The query field with the match case, whole word and
 * regex toggles and the Files / Text switch; the matching lines grouped by file on the left
 * (SearchText, streamed); the file around the selected match on the right. Enter opens the
 * file at the match's line (its find bar on the query when it can search it), ⌘⏎ puts the
 * file and line in the prompt; either waits for the typed query's first answer.
 */
export function TextFinder({
  threadId,
  sources,
  names,
  multi,
  scope,
  input,
  setInput,
  options,
  setOptions,
  switchMode,
  cache,
  search,
  read,
}: {
  threadId: string;
  sources: readonly FinderSourceView[];
  names: Readonly<Record<string, string>>;
  multi: boolean;
  scope: string;
  input: string;
  setInput: (v: string) => void;
  options: TextOptions;
  setOptions: (o: TextOptions) => void;
  /** Tab, shift+Tab or the switch: Files mode, keeping the query. */
  switchMode: () => void;
  cache: PreviewCache;
  search?: SearchTextFn;
  read?: ReadFileFn;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const q: TextQueryView = useMemo(() => ({ query: input, ...options }), [input, options]);
  const state = useTextSearch(sources, q, true, search);
  const answered = state.answered !== null && state.answered === state.key;
  const rows = useMemo(() => textRows(state.files, names, multi), [state.files, names, multi]);

  // The selection: the first match of each new answer, else where the keys or the pointer put it.
  const [selected, setSelected] = useState("");
  const shownAnswer = useRef<string | null>(null);
  useEffect(() => {
    const same = shownAnswer.current === state.answered;
    shownAnswer.current = state.answered;
    setSelected((cur) => (same && rows.some((r) => r.key === cur && isMatch(r)) ? cur : firstMatch(rows)));
  }, [rows, state.answered]);
  const row = rows.find((r): r is MatchRow => r.key === selected && isMatch(r));

  // The answer's case: the daemon's word once it ends, the same rule before.
  const shownQ = state.query;
  const caseSensitive = shownQ ? (state.summary?.caseSensitive ?? smartCaseSensitive(shownQ.query, shownQ.matchCase, shownQ.regex)) : false;
  const re = useMemo(() => (shownQ ? queryRegExp(shownQ, caseSensitive) : null), [shownQ, caseSensitive]);

  const target = row ? { fileKey: row.fileKey, checkout: row.file.checkout, path: row.file.path } : null;
  const preview = useTextPreview(target, cache, read);

  const act = (r: MatchRow, tag: boolean) => {
    const f = { projectId: r.file.projectId, checkout: r.file.checkout, path: r.file.path };
    if (tag) tagFoundFile(threadId, f, r.line.line);
    else openTextMatch(threadId, f, r.line.line, shownQ ? findBarQuery(shownQ, caseSensitive) : null);
  };

  // Enter or ⌘⏎ before the typed query's first answer: waits for it, then takes its first match.
  const pending = useRef<{ key: string; tag: boolean } | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (p === null) return;
    if (p.key !== state.key) {
      pending.current = null;
      return;
    }
    if (state.answered !== p.key) return;
    pending.current = null;
    const first = rows.find(isMatch);
    if (first && state.error === null) act(first, p.tag);
    // oxlint-disable-next-line react/exhaustive-deps -- act reads the answer these name.
  }, [state, rows]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (imeKeyDown(e.nativeEvent)) return;
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && OPTION_KEYS[e.code]) {
      e.preventDefault();
      e.stopPropagation();
      const k = OPTION_KEYS[e.code] as keyof TextOptions;
      setOptions({ ...options, [k]: !options[k] });
      return;
    }
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      switchMode();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.ctrlKey && (e.key === "n" || e.key === "p"))) {
      e.preventDefault();
      setSelected((cur) => moveMatch(rows, cur, e.key === "ArrowDown" || e.key === "n" ? 1 : -1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (!state.ready) return;
      if (!answered) {
        pending.current = { key: state.key, tag: e.metaKey };
        return;
      }
      if (row) act(row, e.metaKey);
    }
  };

  const queryError = answered && state.error?.kind === "query" ? state.error.message : null;
  const listError = answered && state.error && state.error.kind !== "query" ? state.error : null;
  const caseOn = options.matchCase || (answered && state.summary?.caseSensitive === true);
  // The footer speaks for the rows on screen once they answer the typed query.
  const status = !state.ready || state.error ? null : answered ? statusText(state.files, state.summary) : { text: "Searching…", notes: [] };
  const hasRows = rows.length > 0;
  const ready = queryReady(input);
  const project = row && multi ? (names[row.file.projectId] ?? row.file.projectId) : null;

  return (
    <div className="flex h-[min(620px,calc(86vh/var(--cf-zoom)-2rem))] flex-col" data-testid="palette" data-mode="text" onKeyDown={onKeyDown}>
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b pr-2.5 pl-4" data-testid="text-header">
        <SearchIcon className="size-4 shrink-0 text-cf-text-muted" aria-hidden />
        <input
          ref={inputRef}
          autoFocus
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
          }}
          placeholder={`Search text in ${scope}…`}
          aria-label="Search text in files"
          aria-invalid={queryError !== null || undefined}
          spellCheck={false}
          autoComplete="off"
          className="h-10 min-w-0 flex-1 bg-transparent text-body outline-hidden placeholder:text-cf-placeholder"
          data-testid="finder-input"
        />
        <div className="flex shrink-0 items-center gap-1">
          <OptionToggle
            label={caseOn && !options.matchCase ? "Match case (on: the query has a capital letter)" : "Match case"}
            chord="⌥C"
            pressed={caseOn}
            onPressed={() => {
              setOptions({ ...options, matchCase: !options.matchCase });
            }}
            testId="text-match-case"
          >
            <CaseSensitive aria-hidden />
          </OptionToggle>
          <OptionToggle
            label="Match whole word"
            chord="⌥W"
            pressed={options.wholeWord}
            onPressed={(on) => {
              setOptions({ ...options, wholeWord: on });
            }}
            testId="text-whole-word"
          >
            <WholeWord aria-hidden />
          </OptionToggle>
          <OptionToggle
            label="Use regular expression"
            chord="⌥R"
            pressed={options.regex}
            onPressed={(on) => {
              setOptions({ ...options, regex: on });
            }}
            testId="text-regex"
          >
            <Regex aria-hidden />
          </OptionToggle>
        </div>
        <FinderModeSwitch mode="text" onSwitch={switchMode} />
      </div>
      {queryError !== null && (
        <p className="shrink-0 border-b px-4 py-1.5 text-caption text-cf-error-text" role="alert" data-testid="text-query-error">
          {queryError}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[min(440px,45%)] shrink-0 flex-col border-r">
          {listError ? (
            <ListMessage error testId="text-error">
              {listError.kind === "unavailable" ? listError.message : `Cannot search: ${listError.message}`}
            </ListMessage>
          ) : hasRows ? (
            <TextResults
              rows={rows}
              selected={selected}
              onSelect={setSelected}
              onActivate={(r) => {
                act(r, false);
              }}
            />
          ) : !ready ? (
            <ListMessage testId="text-hint">
              {input === "" ? "Search the text of the thread's files: literal text, spaces included. A capital letter matches case." : `Type at least ${String(TEXT_MIN_QUERY)} characters.`}
            </ListMessage>
          ) : queryError !== null ? null : answered && state.summary ? (
            <ListMessage testId="text-none">No matches for “{input}”.</ListMessage>
          ) : (
            <ListMessage testId="text-searching">Searching…</ListMessage>
          )}
        </div>
        {row ? <TextPreview row={row} read={preview} re={re} project={project} /> : <div className="min-w-0 flex-1" data-testid="text-preview-none" />}
      </div>
      <Hints status={status} />
    </div>
  );
}
