import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock, mockPost, row, infoCardOff } from "./fixtures";

// Switching between threads (docs/notes/thread-switch-place.md), only what needs a browser:
// what each painted frame of a long conversation shows as its tab opens (no frame without
// rows, no Jump to bottom chip passing by), and where the list stands on coming back to it
// (the row the reader left it at, or the bottom). Which row stands in for one that went:
// vitest (src/lib/timelinePlace.test.ts). Over the mock's 120-row s-r1 and the short s-4.

test.beforeEach(async () => {
  await resetMock();
  await infoCardOff();
  await mockPost("thread?state=long");
});

const pane = (page: Page) => page.getByTestId("thread-pane");
const timeline = (page: Page) => pane(page).getByTestId("thread-timeline");
const chip = (page: Page) => page.getByTestId("thread-jump-bottom");

/** What one frame shows of thread `id`'s list: the rows in view, the first one's index and top, and the chip. */
interface Frame {
  rows: number;
  inView: number;
  first: number;
  top: number;
  chip: boolean;
}

/** Each frame of thread `id`'s pane while `act` runs and for half a second after. */
async function framesDuring(page: Page, id: string, act: () => Promise<void>): Promise<Frame[]> {
  await page.evaluate((thread) => {
    const w = window as unknown as { __frames: Frame[]; __stop: boolean };
    w.__frames = [];
    w.__stop = false;
    const tick = () => {
      const list = document.querySelector(`[data-testid="thread-pane"][data-thread-id="${thread}"] [data-testid="thread-timeline"]`);
      if (list) {
        const box = list.getBoundingClientRect();
        const rows = [...list.querySelectorAll<HTMLElement>("[data-index]")];
        const inView = rows.filter((r) => {
          const b = r.getBoundingClientRect();
          return b.height > 0 && b.bottom > box.top && b.top < box.bottom;
        });
        const first = inView[0];
        w.__frames.push({
          rows: rows.length,
          inView: inView.length,
          first: first ? Number(first.dataset.index) : -1,
          top: first ? first.getBoundingClientRect().top - box.top : 0,
          chip: document.querySelector('[data-testid="thread-jump-bottom"]')?.getAttribute("data-shown") === "true",
        });
      }
      if (!w.__stop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, id);
  await act();
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const w = window as unknown as { __frames: Frame[]; __stop: boolean };
    w.__stop = true;
    return w.__frames;
  });
}

async function open(page: Page, id: string): Promise<void> {
  await row(page, `s:${id}`).click();
  await expect(pane(page)).toHaveAttribute("data-thread-id", id);
}

/** Opens the long thread and waits for its last row, at the bottom. */
async function openLong(page: Page): Promise<void> {
  await openApp(page);
  await open(page, "s-r1");
  await expect(timeline(page).locator('[data-index="119"]')).toBeVisible();
  await expect(timeline(page)).toHaveAttribute("data-at-bottom", "true");
}

test("a thread left at the bottom opens there again, with rows in its first frame and no chip", async ({ page }) => {
  await openLong(page);
  await open(page, "s-4");
  const frames = await framesDuring(page, "s-r1", () => open(page, "s-r1"));
  expect(frames.length).toBeGreaterThan(3);
  // Its log is kept, so the rows are there from the first frame: the last one, every frame.
  expect(frames.filter((f) => f.inView === 0)).toEqual([]);
  expect(frames.filter((f) => f.chip)).toEqual([]);
  await expect(timeline(page).locator('[data-index="119"]')).toBeVisible();
  await expect(timeline(page)).toHaveAttribute("data-at-bottom", "true");
});

test("a thread left scrolled up opens at the same row, every frame, on each visit", async ({ page }) => {
  await openLong(page);
  await timeline(page).hover();
  await page.mouse.wheel(0, -3000);
  await expect(chip(page)).toHaveAttribute("data-shown", "true");
  // The rows above are measured as they come into view: wait for the list to stand still.
  const place = async () =>
    (await framesDuring(page, "s-r1", async () => {})).at(-1) ?? { rows: 0, inView: 0, first: -1, top: 0, chip: false };
  await expect.poll(async () => { const a = await place(); const b = await place(); return a.first === b.first && Math.abs(a.top - b.top) < 1; }).toBe(true);
  const left = await place();
  expect(left.first).toBeGreaterThan(0);
  expect(left.first).toBeLessThan(119);

  for (let visit = 0; visit < 2; visit++) {
    await open(page, "s-4");
    const frames = await framesDuring(page, "s-r1", () => open(page, "s-r1"));
    expect(frames.length).toBeGreaterThan(3);
    // The same row at the same height in every frame: nothing blank, nothing moving under the reader.
    expect(frames.filter((f) => f.first !== left.first || Math.abs(f.top - left.top) >= 1)).toEqual([]);
    await expect(chip(page)).toHaveAttribute("data-shown", "true");
  }

  // Back at the bottom, it is left there: the next visit follows the bottom again.
  await chip(page).click();
  await expect(timeline(page)).toHaveAttribute("data-at-bottom", "true");
  await open(page, "s-4");
  await open(page, "s-r1");
  await expect(timeline(page).locator('[data-index="119"]')).toBeVisible();
  await expect(timeline(page)).toHaveAttribute("data-at-bottom", "true");
  await expect(chip(page)).not.toHaveAttribute("data-shown", "true");
});
