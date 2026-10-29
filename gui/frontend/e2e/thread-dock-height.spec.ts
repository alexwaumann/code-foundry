import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The timeline's bottom inset is the composer dock's height (components/thread/activity.ts
 * useElementHeight): the last row scrolls clear of the composer and the Jump to bottom chip
 * floats above it. The dock remounts with the thread (PaneOverlay is keyed by thread), so
 * the height must follow the current dock, not the first one (docs/notes/thread-dock-height.md).
 */

test.beforeEach(async () => {
  await resetMock();
});

const PARA = "For Tier B that judgment is riskier because the confusion was not negligible: before a reversal on anything in Tier B, I'd want the population and funnel numbers first. ";

async function openScripted(page: Page): Promise<void> {
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
}

/** The last row's bottom and the composer's top, as offsets in the timeline, and the chip's offset from the bottom. */
async function bottomGeometry(page: Page) {
  return page.getByTestId("thread-timeline").evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-index]"));
    const last = rows[rows.length - 1];
    const composer = document.querySelector('[data-testid="thread-composer"]');
    const dock = document.querySelector<HTMLElement>(".cf-thread .dock");
    const chip = document.querySelector<HTMLElement>('[data-testid="thread-jump-bottom"]');
    return {
      lastBottom: last ? last.getBoundingClientRect().bottom - top : NaN,
      composerTop: composer ? composer.getBoundingClientRect().top - top : NaN,
      dockHeight: dock?.offsetHeight ?? NaN,
      chipBottom: parseFloat(chip?.style.bottom ?? "NaN"),
    };
  });
}

// Set SHOTS=<dir> to save a screenshot of the end state in each scheme (PR bodies).
for (const scheme of ["dark", "light"] as const) {
  test(`after a switch to another thread and back, the answer's end clears the composer and the chip sits above it (${scheme})`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost("thread?state=streaming");
  await openApp(page);
  await openScripted(page);
  await mockPost("thread/stream?text=" + encodeURIComponent("Here is the long answer.\n\n"));
  for (let i = 0; i < 18; i++) await mockPost("thread/delta?text=" + encodeURIComponent(PARA + (i % 3 === 2 ? "\n\n" : "")));
  await mockPost("thread/finish?rest=" + encodeURIComponent("\n\nDone."));
  await expect(page.getByTestId("thread-timeline").getByText("Done.")).toBeVisible();

  // Another thread, then back: the dock is a new element.
  await row(page, "s:s-2").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");
  await openScripted(page);
  await expect(page.getByTestId("thread-timeline")).toHaveAttribute("data-at-bottom", "true");
  await expect.poll(async () => (await bottomGeometry(page)).chipBottom).toBeGreaterThan(12);
  const g = await bottomGeometry(page);
  expect(g.dockHeight).toBeGreaterThan(100);
  expect(g.lastBottom).toBeLessThanOrEqual(g.composerTop);
  expect(g.chipBottom).toBe(g.dockHeight - 20);
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/thread-dock-height-${scheme}.png` });
  });
}
