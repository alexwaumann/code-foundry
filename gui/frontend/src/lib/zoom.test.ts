import { describe, expect, it } from "vitest";
import { zoomPx } from "./zoom";

describe("zoomPx", () => {
  const cases: { name: string; value: Parameters<typeof zoomPx>[0]; factor: number; want: unknown }[] = [
    { name: "undefined stays undefined", value: undefined, factor: 1.25, want: undefined },
    { name: "a number at 100% is unchanged", value: 6, factor: 1, want: 6 },
    { name: "a number scales", value: 6, factor: 1.5, want: 9 },
    { name: "zoomed out", value: 10, factor: 0.9, want: 9 },
    { name: "a per-side object scales each side", value: { top: 8, left: 4 }, factor: 1.25, want: { top: 10, left: 5 } },
    { name: "an object at 100% is the same object", value: { bottom: 8 }, factor: 1, want: { bottom: 8 } },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(zoomPx(c.value, c.factor)).toEqual(c.want);
    });
  }
});
