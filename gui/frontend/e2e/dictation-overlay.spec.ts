import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { mockPost, mockUrl, resetMock } from "./fixtures";

/**
 * The dictation overlay's page (docs/notes/dictate-anywhere-overlay.md) as a real canvas
 * against the mock's streams: that the second Vite input loads, paints the plate in the
 * theme and empties at the end. Phases, the simulation and the frame loop are unit-tested
 * in src/overlay/*.test.ts; the panel itself only exists in the Wails host.
 */

test.beforeEach(async () => {
  await resetMock();
  await mockPost("dictation?state=ready");
});

async function startSystemSession(): Promise<string> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.DictationService/Start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ clientId: "system" }),
  });
  expect(res.ok).toBe(true);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

/** The canvas's pixel `dx` points right of its middle, as rgba. */
function pixel(page: Page, dx: number): Promise<number[]> {
  return page.evaluate((x) => {
    const c = document.querySelector("canvas");
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return [];
    const scale = window.devicePixelRatio;
    return [...ctx.getImageData(Math.round(c.width / 2 + x * scale), Math.round(c.height / 2), 1, 1).data];
  }, dx);
}

test("the plate paints in the theme's overlay colour and clears at the end", async ({ page }) => {
  await page.setViewportSize({ width: 144, height: 52 });
  const id = await startSystemSession();
  await page.goto(`/dictation-overlay.html?daemon=${encodeURIComponent(mockUrl)}&token=${MOCK_TOKEN}&session=${id}`);
  // Between the dots' field and the plate's rim: the plate's own colour, GitHub Dark's by default.
  await expect.poll(() => pixel(page, 53)).toEqual([20, 24, 30, 255]);
  await mockPost("dictation/end?reason=silence");
  await expect.poll(() => pixel(page, 53)).toEqual([0, 0, 0, 0]);
});
