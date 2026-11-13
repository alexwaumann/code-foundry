import { useEffect, useMemo, useRef, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { statusColor } from "@/components/diff/files";
import { changeStatuses, emptyGroups, MAX_WORDS, parseFinderQuery, searchRows, type FinderGroup, type FinderRow, type Run } from "@/lib/fileFinder";
import { useFirstRowSelection } from "@/lib/useFirstRowSelection";
import { cn } from "@/lib/utils";
import { openFoundFile, tagFoundFile } from "@/stores/fileFinder";
import { threadTarget } from "@/shell/host";
import { useRecentFiles } from "@/stores/recentFiles";
import { useCheckoutChanges, useFinderCheckouts, useFinderScopeName, useFinderSearch, useOpenFilePaths, type FindFilesFn } from "./useFileFinder";

/** Text runs, the matched ones semibold in the foreground colour (the rest stays regular, so they stand out). */
function Runs({ runs }: { runs: readonly Run[] }) {
  return (
    <>
      {runs.map((r, i) =>
        r.hit ? (
          <span key={i} className="font-semibold text-cf-text" data-hit="">
            {r.text}
          </span>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </>
  );
}

/**
 * One file, text only: its name (matched letters bold), its directory dimmed and cut from
 * the left so the end stays; on the right `open` when the panel has its tab, the project's
 * name in a thread with several (matched letters bold), and its git status letter in a
 * fixed column (always reserved with several projects, so the names line up).
 */
function FinderItem({ row, multi, onOpen }: { row: FinderRow; multi: boolean; onOpen: (r: FinderRow) => void }) {
  return (
    <CommandItem
      value={row.key}
      onSelect={() => {
        onOpen(row);
      }}
      className="gap-3"
      data-testid="finder-row"
      data-path={row.path}
      data-project={row.projectId}
    >
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="max-w-full shrink-0 truncate font-normal text-cf-text" data-testid="finder-name">
          <Runs runs={row.name} />
        </span>
        {row.dir && (
          <span className="min-w-0 truncate text-left text-caption text-cf-text-muted [direction:rtl]" data-testid="finder-dir">
            {`‎${row.dir}‎`}
          </span>
        )}
      </span>
      {row.open && (
        <span className="shrink-0 text-caption text-cf-text-muted" data-testid="finder-open">
          open
        </span>
      )}
      {row.project && (
        <span className="max-w-[40%] shrink-0 truncate text-caption text-cf-text-muted" data-testid="finder-project">
          <Runs runs={row.project} />
        </span>
      )}
      {(multi || row.status) && (
        <span className={cn("w-3 shrink-0 text-center font-mono text-caption", statusColor[row.status] ?? "text-cf-text-muted")} data-testid="finder-status" data-status={row.status || undefined}>
          {row.status}
        </span>
      )}
    </CommandItem>
  );
}

function Hints() {
  return (
    <div className="flex shrink-0 items-center gap-3 border-t px-3 py-1.5 text-caption-sm" data-testid="finder-hints">
      <span className="flex items-center gap-1">
        <Kbd size="sm">↑</Kbd>
        <Kbd size="sm">↓</Kbd> move
      </span>
      <span className="flex items-center gap-1">
        <Kbd size="sm">⏎</Kbd> open
      </span>
      <span className="flex items-center gap-1">
        <Kbd size="sm">⌥</Kbd>
        <Kbd size="sm">⏎</Kbd> @ in prompt
      </span>
      <span className="ml-auto flex items-center gap-1">
        <Kbd size="sm">esc</Kbd> close
      </span>
    </div>
  );
}

/**
 * The file finder (file.find, cmd+P; docs/notes/file-finder-2-gui.md): the palette's
 * chrome over a thread's checkouts. An empty query lists the files changed in the thread
 * and the panel's recently opened files; a query lists the daemon's ranked matches across
 * the checkouts (lib/fileFinder.ts). Enter opens the file in a tab beside the thread (at
 * the line of a trailing `:<line>`), ⌥⏎ puts it in the prompt as an @ file.
 */
export function FileFinder({ threadId, search }: { threadId: string; search?: FindFilesFn }) {
  const [input, setInput] = useState("");
  const parsed = parseFinderQuery(input);
  const panelKey = threadTarget(threadId);
  const { checkouts, names, git } = useFinderCheckouts(threadId);
  const multi = checkouts.length > 1;
  const scope = useFinderScopeName(threadId, names, checkouts[0]?.projectId ?? "");
  const changes = useCheckoutChanges(checkouts, git);
  const openPaths = useOpenFilePaths(panelKey);
  const recent = useRecentFiles(panelKey);
  const sendable = parsed.tooMany ? "" : parsed.query;
  const found = useFinderSearch(checkouts, sendable, search);

  const ctx = useMemo(() => ({ names, multi, openPaths, statuses: changeStatuses(changes) }), [names, multi, openPaths, changes]);
  const searching = parsed.query !== "";
  const groups: FinderGroup[] = useMemo(() => {
    if (!searching) return emptyGroups(changes, recent, checkouts, ctx);
    if (parsed.tooMany || found.answered === null) return [];
    return [{ key: "results", heading: "", rows: searchRows(found.matches, ctx) }];
  }, [searching, parsed.tooMany, found, changes, recent, checkouts, ctx]);
  const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  const rowKeys = useMemo(() => rows.map((r) => r.key), [rows]);
  const [selected, setSelected] = useFirstRowSelection(rowKeys);

  const open = (r: FinderRow) => {
    openFoundFile(threadId, r, parsed.line);
  };
  const tag = (r: FinderRow) => {
    tagFoundFile(threadId, r);
  };

  // The rows on screen answer an older query while the typed one's search is out (or still
  // debounced). Enter or ⌥⏎ then waits for the answer and takes its first row: typing a name
  // and pressing Enter at once must not open the previous query's file (nor do nothing on
  // the first query).
  const waiting = searching && !parsed.tooMany && found.answered !== parsed.query;
  const pending = useRef<{ query: string; tag: boolean } | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (p === null) return;
    if (p.query !== parsed.query) {
      pending.current = null;
      return;
    }
    if (found.answered !== p.query) return;
    pending.current = null;
    const r = rows[0];
    if (r === undefined || found.error !== null) return;
    if (p.tag) tagFoundFile(threadId, r);
    else openFoundFile(threadId, r, parsed.line);
  }, [found, rows, parsed.query, parsed.line, threadId]);

  const status = parsed.tooMany
    ? `At most ${String(MAX_WORDS)} words`
    : searching
      ? found.error && found.answered === parsed.query
        ? null
        : waiting
          ? "Searching…"
          : "No matching files."
      : "No changed or recently opened files. Type to search.";

  return (
    <Command
      loop
      shouldFilter={false}
      value={selected}
      onValueChange={setSelected}
      data-testid="palette"
      data-mode="files"
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
        if (waiting) {
          e.preventDefault();
          e.stopPropagation();
          pending.current = { query: parsed.query, tag: e.altKey };
          return;
        }
        if (!e.altKey) return;
        e.preventDefault();
        e.stopPropagation();
        const r = rows.find((x) => x.key === selected);
        if (r) tag(r);
      }}
    >
      <CommandInput autoFocus value={input} onValueChange={setInput} placeholder={`Go to file in ${scope}…`} data-testid="finder-input" />
      <CommandList>
        {found.error && searching && !parsed.tooMany && (
          <p className="px-3 pt-2 text-caption text-cf-error-text" role="alert" data-testid="finder-error">
            Cannot search: {found.error}
          </p>
        )}
        {status !== null && (
          <CommandEmpty className="text-cf-text-muted" data-testid="finder-status-line">
            {status}
          </CommandEmpty>
        )}
        {groups.map((g) => (
          <CommandGroup key={g.key} heading={g.heading || undefined} data-testid={`finder-group-${g.key}`}>
            {g.rows.map((r) => (
              <FinderItem key={r.key} row={r} multi={multi} onOpen={open} />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <Hints />
    </Command>
  );
}
