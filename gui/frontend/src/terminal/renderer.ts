/**
 * The seam between the attach lifecycle and whatever draws cells. XtermRenderer is the
 * only implementation today; a libghostty-vt-fed grid renderer can replace it later.
 */

export interface Disposable {
  dispose(): void;
}

export interface TermSize {
  cols: number;
  rows: number;
}

/** What a find matches: `index` is the current match's, -1 for none. `capped`: `total` is the highlight limit, a floor. */
export interface FindResults {
  index: number;
  total: number;
  capped: boolean;
}

export interface TerminalRenderer {
  /** Attaches to a container. Call once. */
  mount(el: HTMLElement): void;
  /**
   * Feeds program output. Parsing may happen later (xterm parses in chunks on later
   * frames); `parsed` runs once this data has been applied to the grid.
   */
  write(data: Uint8Array, parsed?: () => void): void;
  /** Full reset (RIS) plus cleared scrollback; used before a snapshot. */
  reset(): void;
  /**
   * Hides the cursor (DECTCEM off, as a program would), after any output already written.
   * An exited terminal takes no input, so its block cursor would be a false prompt.
   */
  hideCursor(): void;
  /** Sets the grid size because the program's size changed. Does not fire onResize. */
  resize(cols: number, rows: number): void;
  /** Fits the grid to the container; fires onResize when the size changes. */
  fit(): void;
  focus(): void;
  readonly size: TermSize;
  /** User input bytes (keys, paste, mouse reports) destined for the PTY. */
  onData(cb: (data: Uint8Array) => void): Disposable;
  /** The viewport asked for a new grid size (container resize, font change). */
  onResize(cb: (size: TermSize) => void): Disposable;
  setFontSize(px: number): void;
  /**
   * Finds `query` (smart case) in the scrollback, or only the screen in the alternate
   * screen: every match highlighted, one current. It stays searched across new output and
   * reset(), until the query changes; "" is clearFind().
   */
  find(query: string): void;
  /** Makes the next (1) or previous (-1) match current, wrapping. */
  findStep(dir: 1 | -1): void;
  /** Drops the query and everything it highlighted. */
  clearFind(): void;
  /** Every change of what the query matches. */
  onFindResults(cb: (results: FindResults) => void): Disposable;
  dispose(): void;
}
