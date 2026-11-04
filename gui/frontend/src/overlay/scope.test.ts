import { describe, expect, it } from "vitest";
import { PLATE_WIDTH, Scope, SCOPE_STEP, WORKING_WIDTH } from "./scope";

/** Runs `scope` for `seconds`, returning the widest and narrowest width on the way. */
function run(scope: Scope, seconds: number, input = 0): { max: number; min: number } {
  let max = scope.width;
  let min = scope.width;
  for (let i = 0; i < Math.round(seconds / SCOPE_STEP); i++) {
    scope.step(input);
    max = Math.max(max, scope.width);
    min = Math.min(min, scope.width);
  }
  return { max, min };
}

const brightness = (s: Scope) => s.dots.reduce((a, b) => a + b, 0);

/** How long until the plate is gone after an end, seconds. */
function fadeTime(scope: Scope): number {
  let t = 0;
  while (!scope.gone && t < 5) {
    scope.step(0);
    t += SCOPE_STEP;
  }
  return t;
}

/** The brightness of a column band of a working plate: left, middle and right thirds. */
function thirds(s: Scope): number[] {
  const out = [0, 0, 0];
  s.dots.forEach((v, i) => {
    const col = Math.floor(i / 9);
    const third = Math.min(2, Math.floor(col / (43 / 3)));
    out[third] = (out[third] ?? 0) + v;
  });
  return out;
}

describe("Scope", () => {
  it("springs open past its width, within the window's margin, and settles", () => {
    const s = new Scope();
    expect(s.width).toBeLessThan(PLATE_WIDTH / 2);
    const { max } = run(s, 1.5);
    expect(max).toBeGreaterThan(PLATE_WIDTH);
    // gui/overlay.go overlayWindowWidth is 144 and the shadow's blur takes 10 a side.
    expect(max).toBeLessThan(124);
    expect(s.width).toBeCloseTo(PLATE_WIDTH, 1);
    expect(s.alpha).toBeCloseTo(1, 2);
  });

  it("narrows while working", () => {
    const s = new Scope();
    run(s, 1);
    s.setPhase("working");
    run(s, 1);
    expect(s.width).toBeCloseTo(WORKING_WIDTH, 1);
    expect(s.work).toBeCloseTo(1, 2);
  });

  it("the working light travels, so it reads when working and listening share a colour", () => {
    const s = new Scope();
    run(s, 0.5);
    s.setPhase("working");
    run(s, 1);
    const shapes: number[][] = [];
    for (let i = 0; i < 4; i++) {
      run(s, 0.14);
      shapes.push(thirds(s));
    }
    const peaks = shapes.map((t) => t.indexOf(Math.max(...t)));
    expect(new Set(peaks).size).toBeGreaterThan(1);
  });

  it("the voice opens the field: louder is brighter", () => {
    const quiet = new Scope();
    run(quiet, 1, 0.02);
    const loud = new Scope();
    run(loud, 1, 0.9);
    expect(brightness(loud)).toBeGreaterThan(brightness(quiet) * 1.5);
  });

  it("clears from the middle out on done and collapses", () => {
    const s = new Scope();
    run(s, 0.5, 0.6);
    s.setPhase("working");
    run(s, 0.6);
    s.setPhase("done");
    run(s, 0.12);
    const middle = s.dots[21 * 9 + 4] ?? 0;
    const edge = s.dots[2 * 9 + 4] ?? 0;
    expect(s.wipe).toBeGreaterThan(0.3);
    expect(s.wipe).toBeLessThan(0.5);
    expect(middle).toBe(0);
    expect(edge).toBeGreaterThan(0);
    const width = s.width;
    expect(fadeTime(s)).toBeLessThan(0.5);
    expect(s.width).toBeLessThan(width);
  });

  it("a failure holds its colour for about 600 ms, then is gone", () => {
    const s = new Scope();
    run(s, 0.5);
    s.setPhase("failed");
    run(s, 0.5);
    expect(s.err).toBeGreaterThan(0.99);
    expect(s.alpha).toBeGreaterThan(0.99);
    expect(s.gone).toBe(false);
    run(s, 0.15);
    expect(s.alpha).toBeLessThan(0.5);
    expect(fadeTime(s)).toBeLessThan(0.4);
  });

  it("a discarded press collapses quicker than done and shows no work", () => {
    const s = new Scope();
    run(s, 0.2);
    s.setPhase("collapsing");
    const t = fadeTime(s);
    expect(t).toBeLessThan(0.35);
    expect(s.work).toBe(0);
    expect(s.wipe).toBe(0);
    expect(s.err).toBe(0);
  });

  it("is never gone while listening or working", () => {
    const s = new Scope();
    expect(s.alpha).toBe(0);
    expect(s.gone).toBe(false);
    s.setPhase("working");
    expect(s.gone).toBe(false);
  });

  describe("Reduce Motion", () => {
    it("the width never moves in any phase", () => {
      const s = new Scope(true);
      for (const p of ["listening", "working", "done"] as const) {
        s.setPhase(p);
        const { max, min } = run(s, 0.4, 0.5);
        expect([max, min]).toEqual([PLATE_WIDTH, PLATE_WIDTH]);
      }
      expect(s.wipe).toBe(0);
    });

    it("the level lights columns from the middle out", () => {
      const lit = (level: number) => {
        const s = new Scope(true);
        run(s, 0.5, level);
        return [...s.dots].filter((v) => v === 1).length / 9;
      };
      expect(lit(0)).toBe(1);
      expect(lit(0.3)).toBeGreaterThan(lit(0));
      expect(lit(0.9)).toBeGreaterThan(lit(0.3));
      const s = new Scope(true);
      run(s, 0.5, 0.3);
      expect(s.dots[21 * 9]).toBe(1);
      expect(s.dots[0]).toBe(0);
    });

    it("a working plate is still dots, not the meter", () => {
      const s = new Scope(true);
      run(s, 0.3, 0.5);
      s.setPhase("working");
      run(s, 1);
      expect(Math.max(...s.dots) - Math.min(...s.dots)).toBeLessThan(0.01);
    });

    it("fades out on an end", () => {
      const s = new Scope(true);
      run(s, 0.3);
      s.setPhase("done");
      expect(fadeTime(s)).toBeLessThan(0.6);
    });
  });
});
