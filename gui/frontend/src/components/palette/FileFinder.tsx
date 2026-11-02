import { useMemo, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { statusColor } from "@/components/changes/files";
import { changeStatuses, emptyGroups, MAX_WORDS, parseFinderQuery, searchRows, type FinderGroup, type FinderRow, type Run } from "@/lib/fileFinder";
import { cn } from "@/lib/utils";
import { openFoundFile, tagFoundFile } from "@/stores/fileFinder";
import { keyOf } from "@/stores/panel";
import { useRecentFiles } from "@/stores/recentFiles";
import { useCheckoutChanges, useFinderCheckouts, useFinderScopeName, useFinderSearch, useOpenFilePaths, type FindFilesFn } from "./useFileFinder";

/** Text runs, the matched ones bold in the foreground colour. */
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
        <span className="max-w-full shrink-0 truncate text-cf-text" data-testid="finder-name">
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
 * the checkouts (lib/fileFinder.ts). Enter opens the file in the thread's side panel (at
 * the line of a trailing `:<line>`), ⌥⏎ puts it in the prompt as an @ file.
 */
export function FileFinder({ threadId, search }: { threadId: string; search?: FindFilesFn }) {
  const [input, setInput] = useState("");
  const parsed = parseFinderQuery(input);
  const panelKey = keyOf({ kind: "thread", id: threadId }) ?? "";
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

  // The highlighted row: the first of each new list, else the one the keys or pointer moved to.
  const [selected, setSelected] = useState("");
  const [listFor, setListFor] = useState(rows);
  if (listFor !== rows) {
    setListFor(rows);
    if (!rows.some((r) => r.key === selected) || rows[0]?.key !== listFor[0]?.key) setSelected(rows[0]?.key ?? "");
  }

  const open = (r: FinderRow) => {
    openFoundFile(threadId, r, parsed.line);
  };
  const tag = (r: FinderRow) => {
    tagFoundFile(threadId, r);
  };

  const status = parsed.tooMany
    ? `At most ${String(MAX_WORDS)} words`
    : searching
      ? found.error && found.answered === parsed.query
        ? null
        : found.answered === null
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
        if (e.key !== "Enter" || !e.altKey || e.nativeEvent.isComposing) return;
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
