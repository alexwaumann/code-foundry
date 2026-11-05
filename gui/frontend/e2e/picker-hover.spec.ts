import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

/**
 * A pointer at rest over a picker. WebKit sends a pointermove after a layout change with the
 * mouse still, and cmdk's scroll on a new search runs before its selection renders: neither
 * happens in jsdom. What decides a real move, and the scroll reset's rules:
 * src/lib/pointerMotion.test.ts, src/components/ui/command.test.tsx.
 */

test.beforeEach(async () => {
  await resetMock();
});

const selectedRow = (page: Page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("[cmdk-item]")];
    return rows.indexOf(rows.find((r) => r.getAttribute("data-selected") === "true") as Element);
  });

test("the palette: each character typed under a resting pointer selects the first row, at the top of the list; a real move still selects", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+k");
  const list = page.getByTestId("palette").locator("[cmdk-list]");
  await expect(list.locator("[cmdk-item]").first()).toBeVisible();
  const box = await list.boundingBox();
  if (!box) throw new Error("no list");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7);

  for (const typed of ["t", "th", "thr"]) {
    await page.keyboard.type(typed.slice(-1));
    await expect(page.getByTestId("palette").locator("input")).toHaveValue(typed);
    // Past the frame WebKit's own pointermove lands in.
    await page.waitForTimeout(150);
    expect(await selectedRow(page)).toBe(0);
    expect(await list.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(list.locator('[cmdk-item][data-selected="true"]')).toBeInViewport();
  }

  const third = list.locator("[cmdk-item]").nth(2);
  await third.hover();
  await expect(third).toHaveAttribute("data-selected", "true");
});

test("the prompts card: Up wrapping to the last row under a resting pointer stays there", async ({ page }) => {
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
  await threadPrompt(page).click();

  const card = page.getByTestId("prompt-history");
  const rows = card.getByTestId("prompt-history-item");
  const all = async () => {
    await page.keyboard.press("Meta+s");
    await page.keyboard.press("Meta+s");
    await expect(card).toHaveAttribute("data-scope", "all");
    await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  };
  await page.keyboard.press("ArrowUp");
  await all();
  const box = await card.boundingBox();
  if (!box) throw new Error("no card");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  // Parked where the card will open, and never moved again.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("ArrowUp");
  await all();
  await page.keyboard.press("ArrowUp");
  await expect(rows.last()).toHaveAttribute("aria-selected", "true");
  // Past the frame WebKit's own pointermove lands in, after the list scrolled.
  await page.waitForTimeout(150);
  await expect(rows.last()).toHaveAttribute("aria-selected", "true");
});
