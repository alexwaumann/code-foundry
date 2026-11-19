import { expect, test, type Page } from "@playwright/test";
import { infoCardOff, mockPost, openApp, resetMock } from "./fixtures";
import { openRowThread } from "./shell-threads";

/**
 * The worker card (docs/notes/worker-card.md) over the mock's lead with three workers
 * (mock/workerCard.ts). What a component test cannot show: the card updating in place in
 * the virtualized list moves no row above it and is not remounted, and a frozen card folds
 * and opens in the list. Grouping, lines and states are unit tested (lib/workerRuns.test.ts,
 * components/thread/WorkerCard.test.tsx). SHOTS=<dir> saves the PR's screenshots, dark and light.
 */

test.beforeEach(async () => {
  await resetMock();
  await infoCardOff();
});

async function openLead(page: Page, state: "live" | "needs" | "frozen", scheme: "dark" | "light" = "dark"): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 1100 });
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost(`workers?state=${state}`);
  await openApp(page);
  await openRowThread(page, "s-wl-lead");
  await expect(page.getByTestId("thread-workers").first()).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

/** Each mounted row above the card: its key and its top in the list's content (not the viewport, which follows the bottom). */
async function rowsAbove(page: Page): Promise<string[]> {
  return page.getByTestId("thread-timeline").evaluate((el) => {
    const scroller = el.querySelector(".scroller") ?? el;
    const rows = [...el.querySelectorAll<HTMLElement>("[data-row-type]")];
    const card = rows.findIndex((r) => r.dataset.rowType === "workers");
    const top = scroller.getBoundingClientRect().top - scroller.scrollTop;
    return rows.slice(0, card + 1).map((r) => `${r.dataset.index ?? ""}:${r.dataset.rowType ?? ""}@${String(Math.round(r.getBoundingClientRect().top - top))}`);
  });
}

test("the live card updates in place: a worker finishing moves no row above it and keeps the card", async ({ page }) => {
  await openLead(page, "live");
  const card = page.getByTestId("thread-workers");
  await expect(card.locator(".ttl")).toHaveText("Working with 3 threads");
  await expect(card.locator('[data-thread="s-wl-3"] [data-testid="thread-worker-state"]')).toHaveText("working");
  await shot(page, "worker-card-live-dark");
  const before = await rowsAbove(page);
  await card.evaluate((el) => {
    (el as HTMLElement & { cfMark?: boolean }).cfMark = true;
  });

  await mockPost("workers/step");
  await expect(card.locator('[data-thread="s-wl-3"] [data-testid="thread-worker-state"]')).toHaveText("finished");
  await expect(card.locator(".ttl")).toHaveText("Worked with 3 threads");
  await expect(page.getByText("All three fixes are in")).toBeVisible();
  // The same element: updated, not remounted.
  expect(await card.evaluate((el) => (el as HTMLElement & { cfMark?: boolean }).cfMark === true)).toBe(true);
  expect(await rowsAbove(page)).toEqual(before);
  await shot(page, "worker-card-stacked-dark");
});

test("a frozen card is one line; a click opens its lines and another folds it", async ({ page }) => {
  await openLead(page, "frozen");
  const cards = page.getByTestId("thread-workers");
  await expect(cards).toHaveCount(2);
  const frozen = cards.first();
  await expect(frozen).toHaveAttribute("data-folded", "true");
  await expect(frozen.getByTestId("thread-worker")).toHaveCount(0);
  await expect(cards.last().locator(".ttl")).toHaveText("Worked with 1 thread");
  await shot(page, "worker-card-frozen-dark");

  await frozen.locator("button.wh").click();
  await expect(frozen.getByTestId("thread-worker")).toHaveCount(3);
  await expect(frozen.locator('[data-thread="s-wl-3"] [data-testid="thread-worker-state"]')).toHaveText("working");
  await shot(page, "worker-card-frozen-open-dark");

  await frozen.locator("button.wh").click();
  await expect(frozen.getByTestId("thread-worker")).toHaveCount(0);
});

test("screenshots: light, and a worker that needs the user", async ({ page }) => {
  test.skip(!process.env.SHOTS, "only for the PR's screenshots");
  await openLead(page, "needs");
  await shot(page, "worker-card-needs-dark");
  for (const state of ["live", "needs", "frozen"] as const) {
    await openLead(page, state, "light");
    await shot(page, `worker-card-${state}-light`);
  }
  await openLead(page, "frozen", "light");
  await page.getByTestId("thread-workers").first().locator("button.wh").click();
  await shot(page, "worker-card-frozen-open-light");
  await openLead(page, "live", "light");
  await mockPost("workers/step");
  await expect(page.getByText("All three fixes are in")).toBeVisible();
  await shot(page, "worker-card-stacked-light");
});
