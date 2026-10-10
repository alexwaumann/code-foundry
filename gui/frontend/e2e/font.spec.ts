import { expect, test } from "@playwright/test";
import { openApp, resetMock, row } from "./fixtures";

const FAMILY = "JetBrainsMono Nerd Font Mono";

test.beforeEach(async () => {
  await resetMock();
});

test("the bundled Nerd Font is served, loaded before the terminal opens, and is the terminal's font", async ({ page, request }) => {
  for (const weight of ["Regular", "Bold"]) {
    const res = await request.get(`/fonts/JetBrainsMonoNerdFontMono-${weight}.ttf`);
    expect(res.ok()).toBe(true);
    expect((await res.body()).byteLength).toBeGreaterThan(1_000_000);
  }

  await openApp(page);
  // main.tsx renders only after the faces loaded (or a timeout), so they are ready by now.
  const loaded = await page.evaluate(
    (family) => [400, 700].map((w) => document.fonts.check(`${String(w)} 12px "${family}"`)),
    FAMILY,
  );
  expect(loaded).toEqual([true, true]);
  // xterm measures cells and the WebGL addon draws glyphs on a canvas, so the face must be
  // usable there too (WebKit canvas ignores a face resolved via local() to an installed
  // font). JetBrains Mono's line box is 1.32em; Menlo's and serif's are about 1.16em.
  const lineBox = await page.evaluate((family) => {
    const ctx = new OffscreenCanvas(1, 1).getContext("2d");
    if (!ctx) return 0;
    ctx.font = `100px "${family}", serif`;
    const m = ctx.measureText("W");
    return (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 100;
  }, FAMILY);
  expect(lineBox).toBeCloseTo(1.32, 2);

  await row(page, "t:t-tmp").click();
  await expect(page.getByTestId("terminal-host")).toHaveAttribute("data-attach-phase", "live");
  const fontFamily = await page.evaluate(() => {
    const w = window as unknown as { __cfTerminal: { renderer: { term: { options: { fontFamily?: string } } } } };
    return w.__cfTerminal.renderer.term.options.fontFamily ?? "";
  });
  expect(fontFamily.startsWith(FAMILY) || fontFamily.startsWith(`"${FAMILY}"`)).toBe(true);
});
