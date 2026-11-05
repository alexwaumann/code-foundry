import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import type { IDisposable, Terminal } from "@xterm/xterm";
import { caseSensitive } from "@/lib/threadFind";
import type { Disposable, FindResults } from "./renderer";
import { NO_RESULTS } from "./results";
import { terminalFindColors, type FindColors } from "./theme";

/**
 * How many matches are highlighted and counted. Past it the addon stops, counting from the
 * top of the buffer, so the newest matches are the ones that go without a highlight: high
 * enough that only a query of a letter or two gets there in a full scrollback. Each match
 * is a marker and a decoration: about 250 ms to build 20,000 in WebKit, and each marker is
 * called for every line a full scrollback drops.
 */
export const FIND_LIMIT = 20000;

/**
 * How long the count may lag a terminal that keeps printing. The addon searches again only
 * after 200 ms without output, which a build log or a spinner never gives it. At least a
 * second, and ten searches' time, so a big search takes a tenth of the main thread at most.
 */
const MIN_STALE_MS = 1000;
const STALE_SEARCHES = 10;

/** Arguments the addon has and its typings leave out (it is pinned): how it searches again itself, the viewport left alone and the query kept. */
interface AddonInternals {
  findPrevious(term: string, options: ISearchOptions, internal: { noScroll: boolean }): boolean;
  clearDecorations(retainCachedSearchTerm: boolean): void;
}

/**
 * One xterm's find (docs/notes/terminal-find.md). @xterm/addon-search keeps the position in
 * the terminal's selection, and paints every match with a decoration, which goes through
 * the WebGL and DOM renderers alike. A selected cell takes the selection's colours over a
 * decoration's, so while there is a query the selection is the current match's colour
 * (`onSelectionColor`), or the current match would look like a selection, not a match.
 */
export class TerminalFind {
  private readonly addon = new SearchAddon({ highlightLimit: FIND_LIMIT });
  private readonly internals = this.addon as unknown as AddonInternals;
  private readonly listeners = new Set<(r: FindResults) => void>();
  private readonly subs: IDisposable[];
  private query = "";
  private colors: FindColors = terminalFindColors();
  private searchedAt = 0;
  private staleMs = MIN_STALE_MS;

  constructor(
    private readonly term: Terminal,
    private readonly onSelectionColor: (color: string | null) => void,
  ) {
    term.loadAddon(this.addon);
    this.subs = [
      this.addon.onDidChangeResults(({ resultIndex, resultCount }) => {
        this.searchedAt = Date.now();
        this.publish({ index: resultIndex, total: resultCount, capped: resultCount >= FIND_LIMIT });
      }),
      term.onWriteParsed(() => {
        if (this.query !== "" && Date.now() - this.searchedAt >= this.staleMs) this.searchAgain();
      }),
    ];
  }

  private publish(results: FindResults): void {
    for (const cb of this.listeners) cb(results);
  }

  private get options(): ISearchOptions {
    const { match, active, border } = this.colors;
    return {
      caseSensitive: caseSensitive(this.query),
      decorations: { matchBackground: match, matchOverviewRuler: border, activeMatchBackground: active, activeMatchBorder: border, activeMatchColorOverviewRuler: border },
    };
  }

  /** A new query. Going backwards from the last match, or the bottom: what is newest in a terminal is at the end. */
  search(query: string): void {
    if (query === this.query) return;
    if (query === "") {
      this.clear();
      return;
    }
    if (this.query === "") this.onSelectionColor(this.colors.active);
    this.query = query;
    this.addon.findPrevious(query, this.options);
  }

  step(dir: 1 | -1): void {
    if (this.query === "") return;
    if (dir > 0) this.addon.findNext(this.query, this.options);
    else this.addon.findPrevious(this.query, this.options);
  }

  /** No query, nothing highlighted, the match no longer selected. */
  clear(): void {
    if (this.query === "") return;
    this.query = "";
    this.addon.clearDecorations();
    this.term.clearSelection();
    this.onSelectionColor(null);
    this.publish(NO_RESULTS);
  }

  /**
   * The buffer is about to be replayed (a tab switch, a reconnect): nothing of it may stay
   * counted or painted. The addon keeps the query, and searches again once the snapshot is
   * parsed, so what the new buffer holds is counted without a call from here.
   */
  reset(): void {
    this.internals.clearDecorations(true);
    this.publish(NO_RESULTS);
  }

  /** The theme changed: decorations keep the colours they were made with, so they are made again. */
  retheme(): void {
    this.colors = terminalFindColors();
    if (this.query !== "") this.searchAgain();
  }

  /** Every match again, the current one kept (the addon looks at the selection's start first) and the viewport left alone. */
  private searchAgain(): void {
    const start = Date.now();
    this.addon.clearDecorations();
    this.internals.findPrevious(this.query, this.options, { noScroll: true });
    this.searchedAt = Date.now();
    this.staleMs = Math.max(MIN_STALE_MS, (this.searchedAt - start) * STALE_SEARCHES);
  }

  /** The selection colour for a palette about to be applied: the current match's while there is a query. */
  get selectionColor(): string | null {
    return this.query === "" ? null : this.colors.active;
  }

  onResults(cb: (r: FindResults) => void): Disposable {
    this.listeners.add(cb);
    return {
      dispose: () => {
        this.listeners.delete(cb);
      },
    };
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    this.listeners.clear();
  }
}
