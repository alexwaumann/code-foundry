import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { IgnoredSuggestionView } from "@/api/filesystem";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { fileCount, suggestionPattern, typedPattern, type IncludeScope } from "@/lib/includePatterns";
import { cn } from "@/lib/utils";
import { ADD_PLACEHOLDER, PatternError } from "./PatternRows";
import { useIncludeSuggestions, type SuggestFn } from "./useIncludeSuggestions";

/** A suggestion's path (a folder's with "/"), the letters the text matched bold. */
function MatchedPath({ s }: { s: IgnoredSuggestionView }) {
  const chars = Array.from(s.path);
  const hits = new Set(s.pathPositions);
  const out: ReactNode[] = [];
  let run = "";
  let hit = false;
  const flush = (i: number) => {
    if (run === "") return;
    out.push(
      hit ? (
        <b key={i} className="font-semibold text-cf-text" data-testid="include-suggestion-hit">
          {run}
        </b>
      ) : (
        run
      ),
    );
    run = "";
  };
  chars.forEach((c, i) => {
    const h = hits.has(i);
    if (h !== hit) {
      flush(i);
      hit = h;
    }
    run += c;
  });
  flush(chars.length);
  return (
    <code className="min-w-0 truncate text-code text-cf-text-secondary">
      {out}
      {s.isDir ? "/" : ""}
    </code>
  );
}

/** The current pick: a suggestion's path, or null for the typed text; held only for the text it was made on. */
interface Pick {
  text: string;
  path: string | null;
}

/**
 * A project's add field (docs/notes/file-search-2-includes-gui.md): a monospace input with,
 * while it has the keyboard, a popover of the project's ignored entries
 * (SuggestIncludeIgnored: folders collapsed with their file counts, the typed letters bold,
 * ones the patterns already include marked and not pickable) and the typed text's own file
 * count at the input's right. ↑↓ pick a suggestion (or, with text, the text itself). With no
 * text the first suggestion is picked; with text, the first whose path the text begins (a
 * path being typed out), else nothing, and Enter adds what was typed. Enter adds to this project, cmd+Enter for all
 * projects (`onAdd` answers a refusal's message, shown under the field; the text clears
 * once added). Escape closes the popover, then clears the text. The field is the last thing
 * on a project's page, so while the popover is open it keeps room below itself (a spacer
 * scrolled into view): the popover opens under the field instead of flipping over the list.
 */
export function IncludeAddField({
  projectId,
  rev,
  busy,
  onAdd,
  suggest,
}: {
  projectId: string;
  /** Changes when the effective patterns do (asks again: `included` changed). */
  rev: string;
  busy: boolean;
  onAdd: (pattern: string, scope: IncludeScope) => Promise<string | null>;
  suggest?: SuggestFn;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pick, setPick] = useState<Pick | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const open = focused && !dismissed;
  useEffect(() => {
    if (open) roomRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  const found = useIncludeSuggestions(projectId, text, open, rev, suggest);
  const suggestions = useMemo(() => found.view?.suggestions ?? [], [found.view]);
  const pickable = useMemo(() => suggestions.filter((s) => !s.included).map((s) => s.path), [suggestions]);
  // The rows answer this text (not an older one still on screen).
  const current = found.answered === text;
  // Picked unless the user moved: the first pickable entry the typed text begins (a path being typed out), or with no text the first.
  const typed = text.trim();
  const begun = current ? (suggestions.find((s) => !s.included && suggestionPattern(s).startsWith(typed))?.path ?? null) : null;
  const picked: string | null = pick?.text === text && (pick.path === null || pickable.includes(pick.path)) ? pick.path : begun;

  const move = (by: 1 | -1) => {
    const order: (string | null)[] = text.trim() === "" ? pickable : [null, ...pickable];
    // (The typed text, null, is a stop in the cycle whenever there is text.)
    if (order.length === 0) return;
    const at = order.indexOf(picked);
    const next = order[(at + by + order.length) % order.length] ?? null;
    setPick({ text, path: next });
  };

  const add = (scope: IncludeScope, path: string | null) => {
    if (busy) return;
    let pattern: string;
    const s = path === null ? undefined : suggestions.find((x) => x.path === path);
    if (s) pattern = suggestionPattern(s);
    else {
      const typed = typedPattern(text);
      if (typed.error) {
        setAddError(typed.error);
        return;
      }
      pattern = typed.pattern;
    }
    if (pattern === "") return;
    void onAdd(pattern, scope).then((err) => {
      setAddError(err);
      if (err === null) {
        setText("");
        setPick(null);
      }
    });
  };

  const textError = text.trim() !== "" && current ? (found.view?.textError ?? "") : "";
  const count = text.trim() !== "" && current && found.view && !found.view.textError ? `matches ${fileCount(found.view.textFiles, found.view.textFilesCapped)}` : "";
  const optionId = (path: string) => `${listId}-${String(suggestions.findIndex((s) => s.path === path))}`;

  return (
    <div className="flex flex-col gap-1.5">
      <Popover open={open}>
        <PopoverAnchor asChild>
          <div ref={anchorRef} className="relative">
            <Input
              value={text}
              role="combobox"
              aria-label="Add a pattern"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={open && picked !== null ? optionId(picked) : undefined}
              placeholder={ADD_PLACEHOLDER}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="text-code"
              style={count ? { paddingRight: `calc(${String(count.length)}ch + 1.5rem)` } : undefined}
              data-testid="include-add-input"
              onFocus={() => {
                setFocused(true);
              }}
              onBlur={() => {
                setFocused(false);
                setDismissed(false);
              }}
              onChange={(e) => {
                setText(e.target.value);
                setDismissed(false);
                setAddError(null);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (!open) setDismissed(false);
                  else move(e.key === "ArrowDown" ? 1 : -1);
                  return;
                }
                if (e.key === "Escape") {
                  if (e.defaultPrevented || text === "") return;
                  e.preventDefault();
                  e.stopPropagation();
                  setText("");
                  setAddError(null);
                  return;
                }
                if (e.key !== "Enter" || e.shiftKey || e.altKey || e.ctrlKey) return;
                e.preventDefault();
                e.stopPropagation();
                add(e.metaKey ? "all" : "project", open ? picked : null);
              }}
            />
            {count && (
              <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-caption" data-testid="include-text-count">
                {count}
              </span>
            )}
          </div>
        </PopoverAnchor>
        <PopoverContent
          className="w-(--radix-popover-trigger-width) p-0"
          data-testid="include-suggestions"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
          }}
          onEscapeKeyDown={() => {
            setDismissed(true);
          }}
          onInteractOutside={(e) => {
            if (e.target instanceof Node && anchorRef.current?.contains(e.target)) e.preventDefault();
            else setDismissed(true);
          }}
          // The input keeps the keyboard.
          onMouseDown={(e) => {
            e.preventDefault();
          }}
        >
          <div id={listId} role="listbox" aria-label="Ignored in this project" className="max-h-64 overflow-y-auto py-1">
            <div role="presentation" className="px-3 pt-1 pb-0.5 text-caption-sm">
              Ignored in this project
            </div>
            {found.error && (
              <p className="px-3 py-1.5 text-caption text-cf-error-text" data-testid="include-suggest-error">
                Cannot list ignored files: {found.error}
              </p>
            )}
            {!found.error && found.view && suggestions.length === 0 && (
              <p className="px-3 py-1.5 text-caption" data-testid="include-suggest-empty">
                {found.answered === "" ? "Nothing is ignored in this project." : "No ignored file or folder matches. Enter adds the pattern as typed."}
              </p>
            )}
            {suggestions.map((s, i) => {
              const on = picked === s.path;
              return (
                <div
                  key={s.path}
                  id={`${listId}-${String(i)}`}
                  role="option"
                  aria-selected={on}
                  aria-disabled={s.included || undefined}
                  data-testid="include-suggestion"
                  data-path={s.path}
                  data-included={s.included || undefined}
                  className={cn("mx-1 flex h-7 items-center gap-2.5 rounded-md px-2", on && "bg-cf-control-hover", s.included ? "opacity-60" : "cursor-pointer")}
                  onPointerMove={() => {
                    if (!s.included && !on) setPick({ text, path: s.path });
                  }}
                  onClick={(e) => {
                    if (!s.included) add(e.metaKey ? "all" : "project", s.path);
                  }}
                >
                  <MatchedPath s={s} />
                  <span className="ml-auto shrink-0 text-caption" data-testid="include-suggestion-note">
                    {s.included ? "included" : s.isDir ? fileCount(s.fileCount, s.fileCountCapped) : "file"}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3 border-t px-3 py-1.5 text-caption-sm" data-testid="include-hints">
            <span className="flex items-center gap-1">
              <Kbd size="sm">⏎</Kbd> add to this project
            </span>
            <span className="flex items-center gap-1">
              <Kbd size="sm">⌘</Kbd>
              <Kbd size="sm">⏎</Kbd> add for all projects
            </span>
          </div>
        </PopoverContent>
      </Popover>
      <PatternError message={addError ?? (textError || null)} />
      {/* Room for the popover (its list, heading and hints, and the offset). */}
      {open && <div ref={roomRef} aria-hidden className="h-80 shrink-0" data-testid="include-room" />}
    </div>
  );
}
