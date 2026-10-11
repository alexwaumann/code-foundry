import { describe, expect, it } from "vitest";
import { KeyboardModes, KittyFlagStack, shiftEnterSequence } from "./keyboard";

type Op =
  | { push: number[] }
  | { pop: number[] }
  | { set: number[] }
  | { modkeys: number[] }
  | { alternate: boolean }
  | "reset";

function apply(modes: KeyboardModes, ops: readonly Op[]): void {
  for (const op of ops) {
    if (op === "reset") modes.reset();
    else if ("push" in op) modes.kittyPush(op.push);
    else if ("pop" in op) modes.kittyPop(op.pop);
    else if ("set" in op) modes.kittySet(op.set);
    else if ("modkeys" in op) modes.xtmodkeys(op.modkeys);
    else modes.setAlternate(op.alternate);
  }
}

describe("shiftEnterSequence", () => {
  // Params as xterm.js reports them: a bare CSI has one 0 param.
  const cases: { name: string; ops: Op[]; want: string; flags?: number }[] = [
    { name: "no protocol: ctrl+J", ops: [], want: "\n" },
    { name: "Claude Code's push (CSI > 5 u)", ops: [{ push: [5] }], want: "\x1b[13;2u", flags: 5 },
    { name: "push then pop (CSI < u)", ops: [{ push: [5] }, { pop: [0] }], want: "\n", flags: 0 },
    { name: "nested pushes, one pop", ops: [{ push: [1] }, { push: [3] }, { pop: [1] }], want: "\x1b[13;2u", flags: 1 },
    { name: "flags without disambiguate", ops: [{ push: [2] }], want: "\n", flags: 2 },
    { name: "snapshot replay (CSI = 5 ; 1 u)", ops: [{ set: [5, 1] }], want: "\x1b[13;2u", flags: 5 },
    { name: "set defaults to mode 1", ops: [{ set: [3, 0] }, { set: [4] }], want: "\n", flags: 4 },
    { name: "set or (mode 2)", ops: [{ set: [4, 1] }, { set: [1, 2] }], want: "\x1b[13;2u", flags: 5 },
    { name: "set not (mode 3)", ops: [{ set: [5, 1] }, { set: [1, 3] }], want: "\n", flags: 4 },
    { name: "pop past the bottom resets", ops: [{ push: [1] }, { push: [1] }, { pop: [20] }], want: "\n", flags: 0 },
    { name: "modifyOtherKeys 2 (CSI > 4 ; 2 m)", ops: [{ modkeys: [4, 2] }], want: "\x1b[27;2;13~" },
    { name: "modifyOtherKeys 1 is legacy", ops: [{ modkeys: [4, 1] }], want: "\n" },
    { name: "modifyOtherKeys reset (CSI > 4 m)", ops: [{ modkeys: [4, 2] }, { modkeys: [4] }], want: "\n" },
    { name: "other XTMODKEYS resources ignored", ops: [{ modkeys: [1, 2] }], want: "\n" },
    { name: "kitty wins over modifyOtherKeys", ops: [{ modkeys: [4, 2] }, { push: [1] }], want: "\x1b[13;2u" },
    { name: "alt screen has its own stack", ops: [{ push: [1] }, { alternate: true }], want: "\n", flags: 0 },
    { name: "back on the primary screen", ops: [{ push: [1] }, { alternate: true }, { push: [2] }, { alternate: false }], want: "\x1b[13;2u", flags: 1 },
    { name: "alt stack survives a switch", ops: [{ alternate: true }, { push: [1] }, { alternate: false }, { alternate: true }], want: "\x1b[13;2u" },
    { name: "reset clears everything", ops: [{ push: [1] }, { modkeys: [4, 2] }, "reset"], want: "\n", flags: 0 },
  ];
  it.each(cases)("$name", ({ ops, want, flags }) => {
    const modes = new KeyboardModes();
    apply(modes, ops);
    expect(shiftEnterSequence(modes)).toBe(want);
    if (flags !== undefined) expect(modes.kittyFlags).toBe(flags);
  });
});

describe("KittyFlagStack", () => {
  it("evicts the oldest entry after 8 pushes, like Ghostty", () => {
    const s = new KittyFlagStack();
    for (let i = 1; i <= 9; i++) s.push(i);
    expect(s.current).toBe(9);
    s.pop(7);
    expect(s.current).toBe(2);
    s.pop(1);
    // 1 was evicted when the ring wrapped (9 took its slot).
    expect(s.current).toBe(0);
  });

  it("masks flags to the five defined bits", () => {
    const s = new KittyFlagStack();
    s.push(0xff);
    expect(s.current).toBe(0b11111);
  });
});
