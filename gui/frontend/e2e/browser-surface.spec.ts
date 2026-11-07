import { expect, test, type Page } from "@playwright/test";
import { emit, mockPost, mockUrl, openApp, openStreams, resetMock, row } from "./fixtures";

/**
 * The experimental Chrome surface against the mock's BrowserService (docs/notes/chrome-surface.md):
 * what only a real browser shows. Rules and text are vitest's (stores/browser.test.ts,
 * BrowserOverlays.test.tsx, lib/browserInput.test.ts); Chrome itself is the Go live test's.
 */

const surface = (page: Page) => page.getByTestId("browser-surface");
const canvas = (page: Page) => page.getByTestId("browser-canvas");
const WATCH = "BrowserService/Watch";

async function calls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/browser`);
  return (await res.json()) as string[];
}

async function openSurface(page: Page): Promise<void> {
  await mockPost("settings/external?experimental.chrome_surface=true");
  await openApp(page);
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await emit({ showView: { name: "panel.browser", params: { url: "https://example.com/" } } });
  await expect(surface(page)).toBeVisible();
}

test.beforeEach(resetMock);

test("one stream while it shows, none once it does not", async ({ page }) => {
  await openSurface(page);
  await expect.poll(async () => (await openStreams())[WATCH]).toBe(1);
  expect((await calls()).some((c) => c.startsWith("watch ") && c.endsWith("https://example.com/"))).toBe(true);

  // Another thread: this panel goes with its stream.
  await row(page, "s:s-4").click();
  await expect(surface(page)).toBeHidden();
  await expect.poll(async () => (await openStreams())[WATCH] ?? 0).toBe(0);

  await row(page, "s:s-2").click();
  await expect(surface(page)).toBeVisible();
  await expect.poll(async () => (await openStreams())[WATCH]).toBe(1);

  // The address went with the first view and is not sent again.
  expect((await calls()).filter((c) => c.endsWith("https://example.com/"))).toHaveLength(1);
});

test("the setting going off takes the tab and the stream at once", async ({ page }) => {
  await openSurface(page);
  await expect.poll(async () => (await openStreams())[WATCH]).toBe(1);
  await mockPost("settings/external?experimental.chrome_surface=false");
  await expect(surface(page)).toBeHidden();
  await expect.poll(async () => (await openStreams())[WATCH] ?? 0).toBe(0);
});

test("a click lands where it was made, in the page's pixels, and the keyboard goes to the page", async ({ page }) => {
  await openSurface(page);
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.click(box.x + 40, box.y + 30);
  await expect(page.getByTestId("browser-input")).toBeFocused();
  await page.keyboard.type("hi");
  await expect.poll(async () => (await calls()).join("\n")).toContain("keyDown:h");
  const log = await calls();
  expect(log.some((c) => c.includes("mousePressed@40,30"))).toBe(true);
  expect(log.some((c) => c.includes("mouseReleased@40,30"))).toBe(true);
  expect(log.join("\n")).toContain("keyDown:i");
});

test("the app's own chords still work with the keyboard in the page", async ({ page }) => {
  await openSurface(page);
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error("no canvas");
  await page.mouse.click(box.x + 40, box.y + 30);
  await expect(page.getByTestId("browser-input")).toBeFocused();
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  expect((await calls()).join("\n")).not.toContain(":k");
});

test("a resize reaches the page once it settles", async ({ page }) => {
  await openSurface(page);
  await expect.poll(async () => (await openStreams())[WATCH]).toBe(1);
  const before = await canvas(page).boundingBox();
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect.poll(async () => (await calls()).filter((c) => c.startsWith("resize ")).length).toBeGreaterThan(0);
  const after = await canvas(page).boundingBox();
  expect(after?.height).not.toBe(before?.height);
  const last = (await calls()).filter((c) => c.startsWith("resize ")).at(-1);
  expect(last).toBe(`resize ${String(Math.round(after?.width ?? 0))}x${String(Math.round(after?.height ?? 0))}`);
  // No second stream for a new size.
  expect((await openStreams())[WATCH]).toBe(1);
});
