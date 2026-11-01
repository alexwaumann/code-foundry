/**
 * The real TerminalHost (components/terminal) without xterm or a daemon: a renderer that
 * draws nothing and Attach streams a test scripts, so a component test sees the host's
 * data-terminal-id, data-attach-phase and exit overlay the way e2e does. Wire it in with
 * vi.mock (the factories may import this file; it imports no store):
 *
 *   vi.mock("@/terminal/xterm", async () => (await import("@/test/terminalHost")).xtermFakes);
 *   vi.mock("@/api/terminal", async (orig) => ({ ...(await orig<typeof import("@/api/terminal")>()), ...(await import("@/test/terminalHost")).terminalApiFakes }));
 *
 * Every Attach opens live (an empty snapshot); `attach.exit(id, code)` sends the exit frame.
 */
import type { AttachEventView } from "@/api/terminal";
import type { Disposable, TermSize, TerminalRenderer } from "@/terminal/renderer";

class FakeXterm implements TerminalRenderer {
  size: TermSize = { cols: 80, rows: 24 };
  focused = 0;
  mount(): void {}
  write(_data: Uint8Array, parsed?: () => void): void {
    parsed?.();
  }
  reset(): void {}
  hideCursor(): void {}
  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
  }
  fit(): void {}
  focus(): void {
    this.focused++;
  }
  onData(): Disposable {
    return { dispose: () => undefined };
  }
  onResize(): Disposable {
    return { dispose: () => undefined };
  }
  setFontSize(): void {}
  setFontFamily(): void {}
  setScrollback(): void {}
  dispose(): void {}
}

export const xtermFakes = { XtermRenderer: FakeXterm };

/** The scripted Attach streams: which ids are open, and a way to end one with an exit frame. */
export const attach = {
  opened: [] as string[],
  open: new Set<string>(),
  pushers: new Map<string, (ev: AttachEventView) => void>(),
  reset(): void {
    this.opened.length = 0;
    this.open.clear();
    this.pushers.clear();
  },
  /** The terminal's process exited: its exit frame on its open stream. */
  exit(id: string, exitCode: number): void {
    this.pushers.get(id)?.({ kind: "exited", exitCode });
  },
};

async function* attachTerminal(id: string, signal: AbortSignal): AsyncGenerator<AttachEventView> {
  attach.opened.push(id);
  attach.open.add(id);
  const queue: AttachEventView[] = [{ kind: "snapshot", data: new Uint8Array(), cols: 80, rows: 24, altScreen: false }];
  let wake: (() => void) | null = null;
  attach.pushers.set(id, (ev) => {
    queue.push(ev);
    wake?.();
  });
  signal.addEventListener("abort", () => {
    wake?.();
  });
  try {
    while (!signal.aborted) {
      const ev = queue.shift();
      if (ev) {
        yield ev;
        // The daemon ends the stream after the exit frame.
        if (ev.kind === "exited") return;
        continue;
      }
      await new Promise<void>((r) => (wake = r));
    }
  } finally {
    attach.open.delete(id);
  }
}

export const terminalApiFakes = {
  attachTerminal,
  writeTerminal: () => Promise.resolve(),
  resizeTerminal: () => Promise.resolve(),
};
