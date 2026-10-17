import { describe, expect, it } from "vitest";
import { renderScale } from "./pdf";

// Opening and drawing PDFs needs a browser (pdf.js, canvas): e2e/compose.spec.ts.
describe("renderScale", () => {
  it.each([
    ["a 300pt page at 600 CSS px", 300, 600, 1, 2],
    ["at 2x device pixels", 300, 600, 2, 4],
    ["a pixel ratio below 1 draws at 1", 300, 600, 0.5, 2],
    ["a page without width draws at 1", 0, 600, 2, 1],
  ])("%s", (_name, page, width, ratio, want) => {
    expect(renderScale(page, width, ratio)).toBe(want);
  });
});
