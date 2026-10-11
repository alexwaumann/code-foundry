/**
 * Keyboard protocol state the running program asked for, tracked from the output stream
 * (live chunks and snapshot replays alike), and the bytes shift+enter sends under it.
 *
 * xterm.js implements neither the kitty keyboard protocol nor xterm's modifyOtherKeys, so
 * it sends "\r" for shift+enter and Claude Code submits the prompt. The daemon's
 * libghostty emulator tracks both modes and its snapshots replay them (`CSI = flags ; 1 u`,
 * `CSI > 4 ; 2 m`), so observing the same sequences here mirrors its state. See
 * docs/notes/terminal-shift-enter.md.
 */

/** Kitty "disambiguate escape codes" flag (progressive enhancement bit 0). */
const KITTY_DISAMBIGUATE = 1;
/** Ghostty keeps 8 entries per screen and evicts the oldest on overflow. */
const KITTY_STACK_LEN = 8;
const KITTY_FLAGS_MASK = 0b11111;

/** Kitty flag stack (CSI > u push, CSI < u pop, CSI = u set), one per screen. */
export class KittyFlagStack {
  private flags: number[] = new Array<number>(KITTY_STACK_LEN).fill(0);
  private idx = 0;

  get current(): number {
    return this.flags[this.idx] ?? 0;
  }

  push(flags: number): void {
    this.idx = (this.idx + 1) % KITTY_STACK_LEN;
    this.flags[this.idx] = flags & KITTY_FLAGS_MASK;
  }

  pop(n: number): void {
    if (n >= KITTY_STACK_LEN) {
      this.reset();
      return;
    }
    for (let i = 0; i < n; i++) {
      this.flags[this.idx] = 0;
      this.idx = (this.idx + KITTY_STACK_LEN - 1) % KITTY_STACK_LEN;
    }
  }

  /** mode 1 sets, 2 ors, 3 clears the given bits. */
  set(flags: number, mode: number): void {
    const v = flags & KITTY_FLAGS_MASK;
    const cur = this.current;
    if (mode === 1) this.flags[this.idx] = v;
    else if (mode === 2) this.flags[this.idx] = cur | v;
    else if (mode === 3) this.flags[this.idx] = cur & ~v;
  }

  reset(): void {
    this.flags.fill(0);
    this.idx = 0;
  }
}

type Param = number | number[];

function first(p: Param | undefined): number {
  const v = Array.isArray(p) ? p[0] : p;
  return v ?? 0;
}

/** Mirrors the program's keyboard modes from the sequences it writes. */
export class KeyboardModes {
  private readonly main = new KittyFlagStack();
  private readonly alt = new KittyFlagStack();
  private alternate = false;
  /** xterm modifyOtherKeys level (CSI > 4 ; n m). */
  modifyOtherKeys = 0;

  private get stack(): KittyFlagStack {
    return this.alternate ? this.alt : this.main;
  }

  get kittyFlags(): number {
    return this.stack.current;
  }

  /** CSI > flags u */
  kittyPush(params: readonly Param[]): void {
    this.stack.push(first(params[0]));
  }

  /** CSI < n u (n defaults to 1) */
  kittyPop(params: readonly Param[]): void {
    this.stack.pop(Math.max(1, first(params[0])));
  }

  /** CSI = flags ; mode u (mode defaults to 1) */
  kittySet(params: readonly Param[]): void {
    this.stack.set(first(params[0]), first(params[1]) || 1);
  }

  /** CSI > Pp ; Pv m (XTMODKEYS). Only resource 4 (modifyOtherKeys) matters here; a
   * missing value resets it. */
  xtmodkeys(params: readonly Param[]): void {
    if (first(params[0]) === 4) this.modifyOtherKeys = first(params[1]);
  }

  /** Called when the active buffer changes. Each screen keeps its own stack, like Ghostty. */
  setAlternate(alternate: boolean): void {
    this.alternate = alternate;
  }

  /** RIS or a renderer reset before a snapshot. */
  reset(): void {
    this.main.reset();
    this.alt.reset();
    this.alternate = false;
    this.modifyOtherKeys = 0;
  }
}

/**
 * Bytes for shift+enter:
 *  - kitty protocol with disambiguate on: `CSI 13 ; 2 u`, what Ghostty/Kitty/WezTerm send;
 *  - modifyOtherKeys level 2: `CSI 27 ; 2 ; 13 ~`, what xterm sends;
 *  - otherwise "\n" (ctrl+J). Claude Code inserts a newline for it, and programs that
 *    don't tell it apart from Enter (shells, most TUIs: the tty's ICRNL makes them the
 *    same byte in cooked mode) behave exactly as for Enter. The CSI forms would print
 *    junk at a zsh prompt.
 */
export function shiftEnterSequence(modes: Pick<KeyboardModes, "kittyFlags" | "modifyOtherKeys">): string {
  if (modes.kittyFlags & KITTY_DISAMBIGUATE) return "\x1b[13;2u";
  if (modes.modifyOtherKeys >= 2) return "\x1b[27;2;13~";
  return "\n";
}
