import { beforeAll, describe, expect, it } from "vitest";
import { isPaletteQueryOnly } from "./queries";
import { XtermRenderer } from "./xterm";

beforeAll(() => {
  // jsdom has no matchMedia; xterm's open() uses it to watch the device pixel ratio.
  window.matchMedia = (media: string) =>
    ({
      matches: false,
      media,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      // oxlint-disable-next-line typescript/no-deprecated -- the fake implements the whole MediaQueryList interface
      addListener: () => undefined,
      // oxlint-disable-next-line typescript/no-deprecated
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
});

/** Writes output into a real xterm and returns what xterm sent back through onData. */
async function replies(output: string): Promise<string[]> {
  const r = new XtermRenderer({ fontSize: 12, isGlobalChord: () => false });
  // Color reports come from the browser terminal's theme service, which needs open().
  const host = document.createElement("div");
  document.body.append(host);
  r.term.open(host);
  const sent: string[] = [];
  const decoder = new TextDecoder();
  r.onData((d) => sent.push(decoder.decode(d)));
  await new Promise<void>((resolve) => {
    r.term.write(output, resolve);
  });
  r.dispose();
  host.remove();
  return sent;
}

describe("daemon-answered queries", () => {
  it.each([
    { name: "DA1", q: "\x1b[c" },
    { name: "DA1 with 0", q: "\x1b[0c" },
    { name: "DA2", q: "\x1b[>c" },
    { name: "DSR status", q: "\x1b[5n" },
    { name: "DSR cursor position", q: "\x1b[6n" },
    { name: "DECXCPR", q: "\x1b[?6n" },
    { name: "DECRQM ANSI", q: "\x1b[4$p" },
    { name: "DECRQM private (sync output)", q: "\x1b[?2026$p" },
    { name: "DECRQSS", q: "\x1bP$qm\x1b\\" },
    { name: "OSC 4 palette query", q: "\x1b]4;1;?\x07" },
    { name: "Claude Code's startup burst", q: "\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c" },
  ])("$name: xterm stays silent", async ({ q }) => {
    expect(await replies(q)).toEqual([]);
  });

  it.each([
    { name: "OSC 11 background (only xterm knows the theme)", q: "\x1b]11;?\x07", want: "\x1b]11;rgb:" },
    { name: "OSC 10 foreground", q: "\x1b]10;?\x07", want: "\x1b]10;rgb:" },
  ])("$name: xterm still answers", async ({ q, want }) => {
    const sent = await replies(q);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.startsWith(want)).toBe(true);
  });

  it("still applies the effects of sequences that share a final byte", async () => {
    const r = new XtermRenderer({ fontSize: 12, isGlobalChord: () => false });
    await new Promise<void>((resolve) => {
      // OSC 4 set (snapshot palette replay), then kitty push, which must still be tracked.
      r.term.write("\x1b]4;1;rgb:12/34/56\x07\x1b[>1u", resolve);
    });
    expect(r.keyboardModes.kittyFlags).toBe(1);
    r.dispose();
  });
});

describe("isPaletteQueryOnly", () => {
  it.each([
    { data: "1;?", want: true },
    { data: "1;?;2;?", want: true },
    { data: "1;rgb:12/34/56", want: false },
    { data: "1;?;2;rgb:12/34/56", want: false },
    { data: "1", want: false },
    { data: "", want: false },
  ])("$data -> $want", ({ data, want }) => {
    expect(isPaletteQueryOnly(data)).toBe(want);
  });
});
