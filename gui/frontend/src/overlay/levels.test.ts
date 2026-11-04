import { describe, expect, it } from "vitest";
import { levelOf } from "@/lib/dictation";
import { LevelFollower } from "./levels";

const frames = (f: LevelFollower, n: number) => {
  let v = 0;
  for (let i = 0; i < n; i++) v = f.advance(16);
  return v;
};

describe("LevelFollower", () => {
  it("eases toward a level on the composers' scale, with no jump", () => {
    const f = new LevelFollower();
    f.push(0.05);
    const first = f.advance(16);
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(levelOf(0.05) / 2);
    expect(frames(f, 12)).toBeCloseTo(levelOf(0.05), 1);
  });

  it("holds between levels 100 ms apart", () => {
    const f = new LevelFollower();
    f.push(0.05);
    frames(f, 12);
    const held = f.advance(16);
    f.push(0.05);
    expect(frames(f, 6)).toBeGreaterThanOrEqual(held - 0.01);
  });

  it("falls back once levels stop", () => {
    const f = new LevelFollower();
    f.push(0.1);
    const peak = frames(f, 15);
    expect(frames(f, 60)).toBeLessThan(peak / 4);
  });

  it("stays at zero with no levels", () => {
    expect(frames(new LevelFollower(), 10)).toBe(0);
  });
});
