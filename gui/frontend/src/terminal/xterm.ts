import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { chordFromEvent } from "@/keys/chord";
import { copyText } from "@/lib/clipboard";
import type { ColorScheme, Disposable, TermSize, TerminalRenderer } from "./renderer";
import { DEFAULT_TERMINAL_FONT_FAMILY, onBundledFontLoaded } from "./fonts";
import { terminalTheme } from "./theme";

export type RendererKind = "webgl" | "dom";

export interface XtermRendererOptions {
  fontSize: number;
  colorScheme: ColorScheme;
  /** Chords xterm must not consume (handled by the app's global key handler). */
  isGlobalChord: (chord: string) => boolean;
  /** Notified when the active renderer changes (WebGL -> DOM after context loss). */
  onRendererChange?: (kind: RendererKind) => void;
  /** Opens a clicked link; defaults to window.open. */
  openLink?: (uri: string) => void;
}

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
  kind: RendererKind = "dom";

  constructor(private readonly opts: XtermRendererOptions) {
    this.term = new Terminal({
      fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
      fontSize: opts.fontSize,
      theme: terminalTheme(opts.colorScheme),
      scrollback: 10_000,
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
    this.term.attachCustomKeyEventHandler((e) => this.keyHandler(e));
  }

  /** Returns false for keys xterm must not process. */
  private keyHandler(e: KeyboardEvent): boolean {
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
        if (e.metaKey) open(uri); // cmd+click, like Terminal.app and iTerm
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
    this.kind = kind;
    this.opts.onRendererChange?.(kind);
  }

  write(data: Uint8Array): void {
    this.term.write(data);
  }

  reset(): void {
    this.term.reset();
    this.term.clear();
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
    // A hidden host (display: none, e.g. the content pane under an expanded side panel)
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

  setColorScheme(scheme: ColorScheme): void {
    this.term.options.theme = terminalTheme(scheme);
  }

  /** appearance.font_family (with fallbacks). Changes cell metrics, so it refits. */
  setFontFamily(family: string): void {
    if (this.term.options.fontFamily === family) return;
    this.term.options.fontFamily = family;
    this.fit();
  }

  /** sessions.scrollback_lines. */
  setScrollback(lines: number): void {
    this.term.options.scrollback = lines;
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
