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

/**
 * The current match, so it can be selected again after a replay of the same buffer. Its row is
 * counted up from the cursor's, and its line's text finds it again: what arrived since the
 * reset only adds lines below it.
 */
interface Place {
  above: number;
  col: number;
  size: number;
  text: string;
  /** Its row on screen when the user had scrolled up to it, else null (the viewport follows the output). */
  viewRow: number | null;
}

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
  private readonly addon: SearchAddon;
  private readonly internals: AddonInternals;
  private readonly listeners = new Set<(r: FindResults) => void>();
  private readonly subs: IDisposable[];
  private readonly busy: () => boolean;
  private query = "";
  private colors: FindColors = terminalFindColors();
  private searchedAt = 0;
  private staleMs = MIN_STALE_MS;
  /**
   * The addon's matches are gone and the count last published stands for them: dropped under a
   * flood, or reset for a replay. A step searches again first, or the addon would count nothing.
   */
  private cleared = false;
  /** Set by a reset for a replay until xterm has parsed it: the current match to select again. */
  private replay: { place: Place | null } | null = null;

  /** `busy`: xterm has output it has not parsed yet; highlights are dropped then (`parsed`). */
  constructor(
    private readonly term: Terminal,
    private readonly onSelectionColor: (color: string | null) => void,
    { limit = FIND_LIMIT, busy = () => false }: { limit?: number; busy?: () => boolean } = {},
  ) {
    this.addon = new SearchAddon({ highlightLimit: limit });
    this.internals = this.addon;
    term.loadAddon(this.addon);
    this.busy = busy;
    this.subs = [
      this.addon.onDidChangeResults(({ resultIndex, resultCount }) => {
        this.searchedAt = Date.now();
        this.cleared = false;
        this.publish({ index: resultIndex, total: resultCount, capped: resultCount >= limit });
      }),
      term.onWriteParsed(() => {
        this.parsed();
      }),
    ];
  }

  private publish(results: FindResults): void {
    for (const cb of this.listeners) cb(results);
  }

  /**
   * After each batch xterm parsed. Highlights stay only while xterm keeps up with the output.
   * Each is a marker, and every line a full scrollback drops goes past every marker: a flood
   * parsed 9 MB/s without them and at tens of KB/s with thousands, and Ctrl-C waited
   * minutes behind it (docs/notes/terminal-find-flood.md). So while xterm has output waiting,
   * and right after a replay, which the rest of a flood follows, a search only counts: its
   * highlights go in the same task, before xterm parses on. The addon puts them back after
   * 200 ms without output, or a stale search does once xterm has caught up.
   */
  private parsed(): void {
    if (this.query === "") return;
    const busy = this.busy();
    if (this.replay) {
      // The replay is parsed once xterm has nothing left: the output after it waits for that
      // (terminal/attach.ts).
      if (busy) return;
      const { place } = this.replay;
      this.replay = null;
      if (place) this.select(place);
      this.searchAgain();
      this.drop();
      return;
    }
    const stale = Date.now() - this.searchedAt >= this.staleMs;
    if (stale) this.searchAgain();
    if (busy) this.drop();
  }

  /** No highlights, and no markers; the count and the current match (the selection) stay. */
  private drop(): void {
    if (this.cleared) return;
    this.internals.clearDecorations(true);
    this.cleared = true;
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
    if (this.cleared) this.searchAgain();
    if (dir > 0) this.addon.findNext(this.query, this.options);
    else this.addon.findPrevious(this.query, this.options);
  }

  /** No query, nothing highlighted, the match no longer selected. */
  clear(): void {
    if (this.query === "") return;
    this.query = "";
    this.replay = null;
    this.cleared = false;
    this.addon.clearDecorations();
    this.term.clearSelection();
    this.onSelectionColor(null);
    this.publish(NO_RESULTS);
  }

  /**
   * The buffer is about to be emptied for a snapshot: nothing of it may stay painted, and the
   * addon keeps the query. Another terminal's (a tab switch) is counted from nothing, by the
   * addon once its snapshot is parsed. The same terminal's again (a reconnect, which a flood
   * brings every second or so) keeps its count and its current match, and is searched from
   * that match once xterm has parsed the replay (`parsed`).
   */
  reset(sameTerminal = false): void {
    if (sameTerminal && this.query !== "") this.replay = { place: this.place() ?? this.replay?.place ?? null };
    else this.replay = null;
    this.internals.clearDecorations(true);
    this.cleared = true;
    if (!sameTerminal) this.publish(NO_RESULTS);
  }

  /** The selected match, where a replay of this buffer will have it. */
  private place(): Place | null {
    const sel = this.term.getSelectionPosition();
    if (!sel) return null;
    const buf = this.term.buffer.active;
    const text = buf.getLine(sel.start.y)?.translateToString(true);
    if (text === undefined) return null;
    const scrolled = buf.viewportY < buf.baseY && sel.start.y >= buf.viewportY && sel.start.y < buf.viewportY + this.term.rows;
    return {
      above: buf.baseY + buf.cursorY - sel.start.y,
      col: sel.start.x,
      size: (sel.end.y - sel.start.y) * this.term.cols + sel.end.x - sel.start.x,
      text,
      viewRow: scrolled ? sel.start.y - buf.viewportY : null,
    };
  }

  /** Selects the place again: the first line with its text at or above its row, which is where the output since has pushed it. */
  private select(place: Place): void {
    const buf = this.term.buffer.active;
    for (let y = Math.min(buf.baseY + buf.cursorY - place.above, buf.length - 1); y >= 0; y--) {
      if (buf.getLine(y)?.translateToString(true) !== place.text) continue;
      this.term.select(place.col, y, place.size);
      if (place.viewRow !== null) this.term.scrollToLine(Math.max(0, y - place.viewRow));
      return;
    }
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
