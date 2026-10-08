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

export type ColorScheme = "dark" | "light";

export interface TerminalRenderer {
  /** Attaches to a container. Call once. */
  mount(el: HTMLElement): void;
  /** Feeds program output. */
  write(data: Uint8Array): void;
  /** Full reset (RIS) plus cleared scrollback; used before a snapshot. */
  reset(): void;
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
  setColorScheme(scheme: ColorScheme): void;
  dispose(): void;
}
