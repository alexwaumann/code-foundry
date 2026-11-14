import { Terminal, type IDisposable, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { chordFromEvent } from "@/keys/chord";
import { copyText } from "@/lib/clipboard";
import { clampCounts, swallowCountsPastGrid } from "./counts";
import { TerminalFind } from "./find";
import type { Disposable, FindResults, TermSize, TerminalRenderer } from "./renderer";
import { DEFAULT_TERMINAL_FONT_FAMILY, onBundledFontLoaded } from "./fonts";
import { KeyboardModes, shiftEnterSequence } from "./keyboard";
import { swallowDaemonAnsweredQueries } from "./queries";
import { terminalTheme, watchTerminalTheme } from "./theme";

export type RendererKind = "webgl" | "dom";

export interface XtermRendererOptions {
  fontSize: number;
  /** Chords xterm must not consume (handled by the app's global key handler). */
  isGlobalChord: (chord: string) => boolean;
  /** Notified when the active renderer changes (WebGL -> DOM after context loss). */
  onRendererChange?: (kind: RendererKind) => void;
  /** Opens a cmd+clicked link; defaults to window.open. */
  openLink?: (uri: string, event: MouseEvent) => void;
  /** How many matches the find highlights and counts; defaults to FIND_LIMIT. */
  findLimit?: number;
}

/**
 * The most UTF-16 code units one REP (CSI Ps b) may repeat: one row of the widest grid the
 * daemon allows (maxDimension, internal/store/terminal/manager.go), since a program repeats a
 * character to fill a row. xterm allocates a Uint32Array of count x the cell's code units with
 * no limit, and the count alone can reach 2^31 - 1. WebKit throws at 2^33 elements, which ends
 * xterm's parse loop for good, and below that the page hangs. Counting code units and not just
 * the count matters because a cell's combining marks have no limit either.
 * See docs/notes/terminal-rep-cap.md.
 */
export const MAX_REPEAT_UNITS = 4096;

const encoder = new TextEncoder();

function binaryStringToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * TerminalRenderer backed by xterm.js. WebGL renderer when available; on WebGL context
 * loss (or if WebGL2 is unavailable) xterm falls back to its DOM renderer. xterm 6
 * removed the canvas addon, so DOM is the only fallback.
 */
export class XtermRenderer implements TerminalRenderer {
  readonly term: Terminal;
  private readonly fitAddon = new FitAddon();
  private webgl: WebglAddon | null = null;
  private suppressResize = false;
  private readonly resizeListeners = new Set<(s: TermSize) => void>();
  private readonly disposables: IDisposable[] = [];
  private mounted = false;
  /** Kitty keyboard / modifyOtherKeys state the program asked for (see keyboard.ts). */
  readonly keyboardModes = new KeyboardModes();
  private readonly search: TerminalFind;
  /**
   * Writes xterm has not parsed yet: the find drops its highlights while there are any. A reset
   * counts as one until it returns: xterm parses the first write after a key at once, inside
   * reset(), so without it the find would take the reset screen for the snapshot's replay.
   */
  private pending = 0;

  constructor(private readonly opts: XtermRendererOptions) {
    this.term = new Terminal({
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      fontSize: opts.fontSize,
      theme: terminalTheme(),
      scrollback: 30_000,
      allowProposedApi: true,
      macOptionIsMeta: false,
      macOptionClickForcesSelection: true,
      cursorBlink: false,
      drawBoldTextInBrightColors: false,
    });
    this.disposables.push(
      this.term.onResize((size) => {
        if (this.suppressResize) return;
        for (const cb of this.resizeListeners) cb(size);
      }),
    );
    this.search = new TerminalFind(this.term, (color) => {
      this.applyTheme(terminalTheme(), color);
    }, { limit: opts.findLimit, busy: () => this.pending > 0 });
    // The palette is the document's CSS variables (theme.ts); follow them when the scheme
    // (or, later, the theme) on <html> changes.
    const stopTheme = watchTerminalTheme((theme) => {
      this.search.retheme();
      this.applyTheme(theme, this.search.selectionColor);
    });
    this.disposables.push({ dispose: stopTheme }, { dispose: () => { this.search.dispose(); } });
    this.term.attachCustomKeyEventHandler((e) => this.keyHandler(e));
    this.trackKeyboardModes();
    this.capRepeats();
    this.disposables.push(...swallowCountsPastGrid(this.term), ...swallowDaemonAnsweredQueries(this.term));
  }

  /** The palette, with the find's current match as the selection's colour while there is one (terminal/find.ts). */
  private applyTheme(theme: ITheme, selection: string | null): void {
    this.term.options.theme = selection === null ? theme : { ...theme, selectionBackground: selection, selectionInactiveBackground: selection };
  }

  /**
   * Observes the keyboard-protocol sequences xterm.js does not implement. Every handler
   * returns false so xterm's own handling (none, for these) still runs.
   */
  private trackKeyboardModes(): void {
    const modes = this.keyboardModes;
    const csi = (prefix: string, final: string, apply: (params: (number | number[])[]) => void) =>
      this.term.parser.registerCsiHandler({ prefix, final }, (params) => {
        apply(params);
        return false;
      });
    this.disposables.push(
      csi(">", "u", (params) => { modes.kittyPush(params); }),
      csi("<", "u", (params) => { modes.kittyPop(params); }),
      csi("=", "u", (params) => { modes.kittySet(params); }),
      csi(">", "m", (params) => { modes.xtmodkeys(params); }),
      this.term.parser.registerEscHandler({ final: "c" }, () => {
        modes.reset(); // RIS
        return false;
      }),
      this.term.buffer.onBufferChange((buf) => {
        modes.setAlternate(buf.type === "alternate");
      }),
    );
  }

  /** Swallows a REP over MAX_REPEAT_UNITS; xterm handles the rest. A swallowed one prints nothing. */
  private capRepeats(): void {
    this.disposables.push(
      this.term.parser.registerCsiHandler({ final: "b" }, (params) => {
        const count = typeof params[0] === "number" ? params[0] : 1;
        return Math.max(count, 1) * this.repeatedUnits() > MAX_REPEAT_UNITS;
      }),
    );
  }

  /** Code units in the cell REP would repeat: the one behind the cursor, or the wide one before its spacer. */
  private repeatedUnits(): number {
    const buf = this.term.buffer.active;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    const cell = line?.getCell(buf.cursorX - 1);
    const chars = cell?.getWidth() === 0 ? line?.getCell(buf.cursorX - 2)?.getChars() : cell?.getChars();
    return Math.max(chars?.length ?? 1, 1);
  }

  /** Returns false for keys xterm must not process. */
  private keyHandler(e: KeyboardEvent): boolean {
    // xterm sends "\r" for shift+enter. Send the program's shift+enter instead; swallow
    // the keypress too so xterm cannot add a "\r" from it.
    if ((e.type === "keydown" || e.type === "keypress") && !e.isComposing && chordFromEvent(e) === "shift+enter") {
      e.preventDefault();
      if (e.type === "keydown") this.term.input(shiftEnterSequence(this.keyboardModes));
      return false;
    }
    if (e.type === "keyup") {
      // xterm focuses its terminal on every keyup but shift/ctrl/alt's. The keyup of an
      // app chord that moved the keyboard elsewhere (cmd+t opens a shell in the bottom
      // panel and focuses it), or of its cmd, can arrive after the move and would take
      // the keyboard back.
      if (e.key === "Meta") return false;
      const chord = chordFromEvent(e);
      return !(chord && this.opts.isGlobalChord(chord));
    }
    if (e.type !== "keydown") return true;
    const chord = chordFromEvent(e);
    if (!chord) return true;
    if (chord === "cmd+c" && this.term.hasSelection()) {
      void copyText(this.term.getSelection());
      e.preventDefault();
      return false;
    }
    // cmd+v: let the browser fire a native paste event; xterm's paste listener turns it
    // into onData (bracketed when the program enabled it).
    if (chord === "cmd+v") return false;
    if (this.opts.isGlobalChord(chord)) return false;
    return true;
  }

  mount(el: HTMLElement): void {
    if (this.mounted) throw new Error("XtermRenderer already mounted");
    this.mounted = true;
    this.term.open(el);
    this.term.loadAddon(this.fitAddon);
    const unicode = new Unicode11Addon();
    this.term.loadAddon(unicode);
    this.term.unicode.activeVersion = "11";
    const open = this.opts.openLink ?? ((uri: string) => window.open(uri, "_blank", "noopener"));
    this.term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.metaKey) open(uri, e); // cmd+click, like Terminal.app and iTerm
      }),
    );
    this.enableWebgl();
    this.fit();
    const stopFontWatch = onBundledFontLoaded(() => {
      this.refreshFontMetrics();
    });
    this.disposables.push({ dispose: stopFontWatch });
  }

  /**
   * Re-measures cells and redraws glyphs after a web font finished loading. xterm measures
   * only on open and on a font option change, and the WebGL atlas caches glyphs rasterized
   * with the fallback font, so nudge fontFamily (which re-measures) and clear the atlas.
   */
  refreshFontMetrics(): void {
    if (!this.mounted) return;
    const family = this.term.options.fontFamily ?? DEFAULT_TERMINAL_FONT_FAMILY;
    this.term.options.fontFamily = `${family}, monospace`;
    this.term.options.fontFamily = family;
    this.term.clearTextureAtlas();
    this.fit();
  }

  private enableWebgl(): void {
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => {
        this.disableWebgl();
      });
      this.term.loadAddon(gl);
      this.webgl = gl;
      this.setKind("webgl");
    } catch {
      this.webgl = null;
      this.setKind("dom");
    }
  }

  /** Drops the WebGL renderer; xterm re-renders with its DOM renderer. */
  disableWebgl(): void {
    const gl = this.webgl;
    this.webgl = null;
    gl?.dispose();
    this.setKind("dom");
    this.term.refresh(0, this.term.rows - 1);
  }

  private setKind(kind: RendererKind): void {
    this.opts.onRendererChange?.(kind);
  }

  write(data: Uint8Array, parsed?: () => void): void {
    // xterm calls back from inside its parse loop, before it takes this write off what it
    // counts as pending, so a write from there can pass its 50 MB limit with nothing queued, and
    // a throw there ends the loop for good. That loop is synchronous on every path through its
    // write buffer, so no microtask can run until it has returned and the count is right.
    this.send(clampCounts(data, this.term), parsed && (() => { queueMicrotask(parsed); }));
  }

  /** term.write, counted in `pending` until xterm has parsed it: its callback runs inside the parse loop, before onWriteParsed. */
  private send(data: string | Uint8Array, parsed?: () => void): void {
    this.pending++;
    try {
      this.term.write(data, () => {
        this.pending--;
        parsed?.();
      });
    } catch (err) {
      this.pending--;
      throw err;
    }
  }

  reset(sameTerminal = false): void {
    this.pending++;
    try {
      this.resetTerm(sameTerminal);
    } finally {
      this.pending--;
    }
  }

  private resetTerm(sameTerminal: boolean): void {
    this.search.reset(sameTerminal);
    this.term.reset();
    this.term.clear();
    // xterm's reset leaves the cursor as it was, and a snapshot only restores what differs
    // from the defaults, so a hidden cursor would carry over to the next terminal. A write,
    // not a flag: it has to land after a hide still queued (hideCursor, program output)
    // and before the snapshot, which hides it again if its program did.
    try {
      this.send("\x1b[?25h");
    } catch {
      // Behind 50 MB of unparsed writes (a huge snapshot, then a tab switch) xterm refuses
      // any write. reset() runs in a React effect and must not throw; the next snapshot waits
      // for xterm to finish and resets again (terminal/attach.ts).
    }
    this.keyboardModes.reset();
  }

  hideCursor(): void {
    // Queued behind earlier writes, like program output, so a snapshot cannot show it again.
    try {
      this.send("\x1b[?25l");
    } catch {
      // Refused, as in reset(): a cursor left showing must not stop the exit being shown.
    }
  }

  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1 || (cols === this.term.cols && rows === this.term.rows)) return;
    this.suppressResize = true;
    try {
      this.term.resize(cols, rows);
    } finally {
      this.suppressResize = false;
    }
  }

  fit(): void {
    if (!this.mounted) return;
    // A hidden host (display: none, e.g. a body hidden under another)
    // measures 0x0, and the fit addon would shrink the terminal (and the PTY, via
    // onResize) to its 2-column minimum. Keep the size; the host's ResizeObserver refits
    // when it shows again.
    const host = this.term.element?.parentElement;
    if (!host || host.clientWidth === 0 || host.clientHeight === 0) return;
    const dims = this.fitAddon.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
    const cols = Math.max(2, dims.cols);
    const rows = Math.max(1, dims.rows);
    if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows);
  }

  focus(): void {
    this.term.focus();
  }

  get size(): TermSize {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  onData(cb: (data: Uint8Array) => void): Disposable {
    const a = this.term.onData((s) => {
      cb(encoder.encode(s));
    });
    const b = this.term.onBinary((s) => {
      cb(binaryStringToBytes(s));
    });
    return {
      dispose: () => {
        a.dispose();
        b.dispose();
      },
    };
  }

  onResize(cb: (size: TermSize) => void): Disposable {
    this.resizeListeners.add(cb);
    return {
      dispose: () => {
        this.resizeListeners.delete(cb);
      },
    };
  }

  setFontSize(px: number): void {
    if (this.term.options.fontSize === px) return;
    this.term.options.fontSize = px;
    this.fit();
  }

  find(query: string): void {
    this.search.search(query);
  }

  findStep(dir: 1 | -1): void {
    this.search.step(dir);
  }

  clearFind(): void {
    this.search.clear();
  }

  onFindResults(cb: (results: FindResults) => void): Disposable {
    return this.search.onResults(cb);
  }

  /** appearance.font_family (with fallbacks). Changes cell metrics, so it refits. */
  setFontFamily(family: string): void {
    if (this.term.options.fontFamily === family) return;
    this.term.options.fontFamily = family;
    this.fit();
  }

  /** appearance.scrollback_lines (rows, despite the key). */
  setScrollback(rows: number): void {
    this.term.options.scrollback = rows;
  }

  /** Visible buffer as text, for tests and debugging. */
  getText(): string {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\n");
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.resizeListeners.clear();
    this.webgl = null;
    this.term.dispose();
  }
}
