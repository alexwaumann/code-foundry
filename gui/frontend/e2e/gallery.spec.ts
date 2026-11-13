import { expect, test, type Page } from "@playwright/test";
import { CF, invokeAs, openApp, resetMock, row } from "./fixtures";
import { paneWith, setPaneSize, threadTabOpen } from "./shell-surfaces";

/**
 * The Gallery tab (docs/notes/gallery-surface.md): what only a browser shows. Which tiles,
 * captions, failures and moves there are is in vitest (components/gallery); here are the real
 * grid's scroll and geometry, where the keyboard goes, and what the browser decodes.
 */

const grid = (page: Page) => page.getByTestId("gallery-grid");
const tiles = (page: Page) => page.getByTestId("gallery-tile");
const single = (page: Page) => page.getByTestId("gallery-single");
const position = (page: Page) => page.getByTestId("gallery-position");

const shots = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `${CF}/docs/shots/shot-${String(i + 1)}.png`, caption: `Shot ${String(i + 1)}` }));

/** view.panel.gallery as the CLI inside thread s-1 runs it, with s-1 on screen. */
async function show(page: Page, images: { path: string; caption?: string }[]): Promise<void> {
  await row(page, "s:s-1").click();
  await threadTabOpen("s-1");
  await reopen(page, images);
}

/** The same call with the keyboard left where it is. */
async function reopen(page: Page, images: { path: string; caption?: string }[]): Promise<void> {
  expect((await invokeAs("s-1", "view.panel.gallery", { title: "Shots", images: JSON.stringify(images) })).ok).toBe(true);
  await expect(tiles(page).first()).toBeVisible();
}

/** The gallery's pane (beside the thread's) to `width` px. */
const setPanelWidth = async (page: Page, width: number) => setPaneSize(page, String(await paneWith(page, "gallery").getAttribute("data-pane-id")), width);

test.beforeEach(async ({ page }) => {
  await resetMock();
  await openApp(page);
});

test("the grid draws only what is near the scroll, and reaches the last image", async ({ page }) => {
  await show(page, shots(60));
  await expect(tiles(page).first()).toHaveAttribute("data-state", "ready");
  expect(await tiles(page).count()).toBeLessThan(30);
  await grid(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator('[data-gallery-index="59"]')).toHaveAttribute("data-state", "ready");
  await expect(page.getByText("Shot 60", { exact: true })).toBeInViewport();
  expect(await tiles(page).count()).toBeLessThan(30);
  await expect(page.locator('[data-gallery-index="0"]')).toHaveCount(0);
});

test("it fits a narrow pane in two columns and takes more as the pane grows", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 800 });
  await show(page, shots(8));
  await setPanelWidth(page, 360);
  await expect(grid(page)).toHaveAttribute("data-columns", "2");
  const inside = await grid(page).evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(inside).toBe(true);
  const [left, right] = [await tiles(page).nth(0).boundingBox(), await tiles(page).nth(1).boundingBox()];
  const box = await grid(page).boundingBox();
  if (!left || !right || !box) throw new Error("no layout");
  expect(left.width).toBeGreaterThan(140);
  expect(right.y).toBe(left.y);
  expect(right.x + right.width).toBeLessThanOrEqual(box.x + box.width);

  await setPanelWidth(page, 720);
  await expect(grid(page)).toHaveAttribute("data-columns", "3");
  await expect(tiles(page).nth(2)).toHaveAttribute("data-state", "ready");
});

test("the keyboard goes into one image, through the images, and back to the tile it left on", async ({ page }) => {
  await show(page, shots(60));
  await tiles(page).nth(1).click();
  await expect(single(page)).toBeFocused();
  await expect(position(page)).toHaveText("2 of 60");
  for (let i = 0; i < 24; i++) await page.keyboard.press("ArrowRight");
  await expect(position(page)).toHaveText("26 of 60");
  await expect(page.locator('[data-testid="gallery-film-frame"][aria-current="true"]')).toBeInViewport({ ratio: 1 });
  await expect(single(page)).toBeFocused();

  await page.keyboard.press("Escape");
  const left = page.locator('[data-gallery-index="25"]');
  await expect(left).toBeFocused();
  await expect(left).toBeInViewport({ ratio: 1 });
});

test("a re-open that drops the open image leaves the keyboard in the composer", async ({ page }) => {
  const all = shots(6);
  await show(page, all);
  await tiles(page).nth(1).click();
  await page.keyboard.press("Escape");
  await tiles(page).nth(3).click();
  await expect(single(page)).toBeFocused();
  const composer = page.getByTestId("composer-input");
  await composer.click();
  await reopen(page, all.filter((_, i) => i !== 3));
  await expect(grid(page)).toBeVisible();
  // The grid's reveal moves focus two frames after it mounts.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
  await expect(composer).toBeFocused();
});

test("the grid comes back where it was scrolled to", async ({ page }) => {
  await show(page, shots(60));
  await grid(page).evaluate((el) => {
    el.scrollTop = 900;
  });
  const tile = page.locator('[data-gallery-index="20"]');
  await tile.scrollIntoViewIfNeeded();
  const before = await grid(page).evaluate((el) => el.scrollTop);
  expect(before).toBeGreaterThan(0);
  await tile.click();
  await page.getByTestId("gallery-back").click();
  await expect(tile).toBeFocused();
  // At most the tile's caption away: the whole of its row comes into view.
  expect(Math.abs((await grid(page).evaluate((el) => el.scrollTop)) - before)).toBeLessThan(60);
});

test("a filmstrip click keeps the keys, even once its frame has scrolled away", async ({ page }) => {
  await show(page, shots(60));
  await tiles(page).first().click();
  await page.getByTestId("gallery-film-frame").nth(2).click();
  await expect(position(page)).toHaveText("3 of 60");
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
  await expect(position(page)).toHaveText("33 of 60");
});

test("what the browser cannot decode fails on its own tile, and in the single view", async ({ page }) => {
  await show(page, [{ path: `${CF}/docs/shots/shot-1.png` }, { path: `${CF}/docs/shots/broken.png`, caption: "Broken" }, { path: `${CF}/docs/shots/missing.png` }]);
  const [good, broken, missing] = [tiles(page).nth(0), tiles(page).nth(1), tiles(page).nth(2)];
  await expect(good).toHaveAttribute("data-state", "ready");
  await expect(broken).toHaveAttribute("data-state", "failed");
  await expect(broken).toContainText("Cannot decode");
  await expect(missing).toContainText("Not found");
  await broken.click();
  await expect(page.getByTestId("gallery-image-failed")).toContainText("Cannot decode");
});

test("a tile holds a thumbnail, and only the single view the full image", async ({ page }) => {
  await show(page, [{ path: `${CF}/docs/shots/large.png`, caption: "Large" }]);
  const thumb = tiles(page).first().locator("img");
  await expect(thumb).toBeVisible();
  const natural = (el: HTMLImageElement) => el.naturalWidth;
  await expect.poll(() => thumb.evaluate(natural)).toBe(640);
  await tiles(page).first().click();
  const full = page.getByTestId("file-image").locator("img");
  await expect.poll(() => full.evaluate(natural)).toBe(1600);
});
