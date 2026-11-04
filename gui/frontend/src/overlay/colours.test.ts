import { describe, expect, it } from "vitest";
import { scopeColours } from "./colours";

const vars = {
  "--cf-surface": "#000000",
  "--cf-surface-overlay": "#14181e",
  "--cf-divider": "#ffffff80",
  "--cf-accent": "#4493f8",
  "--cf-text": "#e6edf3",
  "--cf-info": "#79c0ff",
  "--cf-error": "#ffa198",
};

describe("scopeColours", () => {
  it("maps the slots of the accent palette, as 0..255", () => {
    const c = scopeColours(vars);
    expect(c?.plate.map(Math.round)).toEqual([20, 24, 30]);
    expect(c?.live.map(Math.round)).toEqual([68, 147, 248]);
    expect(c?.hot.map(Math.round)).toEqual([230, 237, 243]);
    expect(c?.work.map(Math.round)).toEqual([121, 192, 255]);
    expect(c?.err.map(Math.round)).toEqual([255, 161, 152]);
  });

  it("flattens a tint on the surface", () => {
    const edge = scopeColours(vars)?.edge ?? [0, 0, 0];
    expect(edge[0]).toBeGreaterThan(100);
    expect(edge[0]).toBeLessThan(160);
  });

  it("is null when a slot is missing", () => {
    const { "--cf-info": _gone, ...rest } = vars;
    expect(scopeColours(rest)).toBeNull();
  });
});
