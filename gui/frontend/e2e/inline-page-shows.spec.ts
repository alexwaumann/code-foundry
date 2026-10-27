import { expect, test, type Locator, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * One live card per page (docs/notes/inline-page-shows.md) over the mock's "html-repeat"
 * state: docs/hello.html shown in three turns. The last show is the card; the two before it
 * are link rows that bring it into view and ring it. SHOTS=<dir> saves the rows and card.
 */

test.beforeEach(async () => {
  await resetMock();
});

const shots = process.env.SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

const timeline = (page: Page) => page.getByTestId("thread-timeline");
const earlier = (page: Page) => page.getByTestId("thread-html-earlier");
const card = (page: Page) => page.getByTestId("thread-html-card");

async function openRepeat(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1300, height: 900 });
  await mockPost("thread?state=html-repeat");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(card(page)).toHaveCount(1);
}

/** Whether an element is wholly inside the timeline's viewport, clear of the composer floating over its bottom. */
async function inView(page: Page, el: Locator): Promise<boolean> {
  const box = await el.boundingBox();
  const view = await timeline(page).boundingBox();
  const dock = await page.getByTestId("thread-pane").locator(".dock").boundingBox();
  if (!box || !view || !dock) return false;
  return box.y >= view.y - 1 && box.y + box.height <= Math.min(view.y + view.height, dock.y) + 1;
}

/** Scrolls the timeline to its start as the reader does (a wheel: a scroll with no input snaps back while pinned). */
async function toStart(page: Page): Promise<void> {
  const view = await timeline(page).boundingBox();
  if (view) await page.mouse.move(view.x + view.width / 2, view.y + 60);
  await page.mouse.wheel(0, -20000);
  await expect.poll(() => timeline(page).evaluate((el) => el.scrollTop)).toBe(0);
}

/** ThreadService.ShowHtml on the mock, as `code-foundry view.inline` calls it. */
async function showHtml(path: string): Promise<void> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.ThreadService/ShowHtml`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ threadId: "s-r1", path, title: "" }),
  });
  expect(res.ok).toBe(true);
}

test("the same page shown three times: one card, two link rows; a link row brings the card into view and rings it", async ({ page }) => {
  await openRepeat(page);
  await toStart(page);
  await expect(earlier(page)).toHaveCount(2);
  await expect(page.getByTestId("thread-html")).toHaveCount(3);
  // One frame for the file: the card's.
  await expect(page.getByTestId("thread-html-frame")).toHaveCount(1);
  const first = earlier(page).first();
  await expect(first).toContainText("Showed hello.html docs");
  await expect(first).toContainText("Shown again below");
  // A link row is one line: no chevron, never a card, not expandable.
  await expect(first.locator(".chev")).toHaveCount(0);
  await expect(first).not.toHaveAttribute("aria-expanded");
  expect((await first.boundingBox())?.height ?? 0).toBeLessThan(40);
  // The card is the last show (its title is the third's).
  await expect(page.getByTestId("thread-html-row")).toContainText("Hello, third show");
  await expect.poll(() => inView(page, card(page))).toBe(false);
  await shot(page, "page-shows-links");
  await first.click();
  // The ring lasts a second from the click: check it before the scroll settles.
  await expect(card(page)).toHaveAttribute("data-flash", "", { timeout: 900 });
  await expect.poll(() => inView(page, card(page))).toBe(true);
  // The ring goes after about a second.
  await expect(card(page)).not.toHaveAttribute("data-flash", "", { timeout: 2500 });
  await shot(page, "page-shows-card");
  // By keyboard: Enter on the second link row does the same.
  await toStart(page);
  await expect.poll(() => inView(page, card(page))).toBe(false);
  await earlier(page).nth(1).focus();
  await page.keyboard.press("Enter");
  // The ring lasts a second from the click: check it before the scroll settles.
  await expect(card(page)).toHaveAttribute("data-flash", "", { timeout: 900 });
  await expect.poll(() => inView(page, card(page))).toBe(true);
});

test("a page shown again turns the card into a link row: pinned, the list follows; scrolled up, the reader keeps their place", async ({ page }) => {
  await openRepeat(page);
  // Pinned at the bottom: the new show's card arrives and the list follows it.
  await expect(timeline(page)).toHaveAttribute("data-at-bottom", "true");
  await showHtml("/Users/dev/src/code-foundry/docs/hello.html");
  await expect(earlier(page)).toHaveCount(3);
  await expect(card(page)).toHaveCount(1);
  await expect(page.getByTestId("thread-html-frame")).toHaveCount(1);
  await expect.poll(() => inView(page, card(page))).toBe(true);
  await expect(timeline(page)).toHaveAttribute("data-at-bottom", "true");
  // Scrolled up to the start: another show changes nothing on screen.
  await toStart(page);
  await expect(timeline(page)).not.toHaveAttribute("data-at-bottom", "true");
  const first = earlier(page).first();
  await expect(first).toBeVisible();
  const before = (await first.boundingBox())?.y ?? 0;
  await showHtml("/Users/dev/src/code-foundry/docs/hello.html");
  await expect(earlier(page)).toHaveCount(4);
  await page.waitForTimeout(300);
  expect(Math.abs(((await first.boundingBox())?.y ?? 0) - before)).toBeLessThan(2);
  await expect(timeline(page)).not.toHaveAttribute("data-at-bottom", "true");
});
