import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock, row } from "./fixtures";
import { openRowThread } from "./shell-threads";

/**
 * The waiting strip (docs/notes/waiting-strip.md) over the mock's scripted thread s-r1 in its
 * "waiting" state (mock/wakes.ts). What it says and what each row runs is
 * src/components/thread/WaitingStrip.test.tsx's; this keeps where it sits and the list
 * arriving over the thread's stream. Set SHOTS=<dir> to save screenshots (WebKit, dark and
 * light).
 */

const strip = (page: Page) => page.getByTestId("waiting-strip");
const chevron = (page: Page) => page.getByTestId("waiting-toggle").locator("svg");
const kinds = (page: Page) => page.getByTestId("waiting-row").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.kind));

async function openThread(page: Page): Promise<void> {
  await mockPost("thread?state=waiting");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(strip(page)).toBeVisible();
}

test.beforeEach(async () => {
  await resetMock();
});

test("it sits on the composer and opens upward, leaving the composer where it is", async ({ page }) => {
  // React's warnings too: the strip and the composer are siblings keyed by thread.
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && m.text().includes("same key")) errors.push(m.text());
  });
  await openThread(page);
  const composer = page.getByTestId("thread-composer");
  const before = await composer.boundingBox();
  const shut = await strip(page).boundingBox();
  if (!before || !shut) throw new Error("no boxes");
  expect(before.y - (shut.y + shut.height)).toBe(8);
  expect(shut.width).toBe(before.width);
  await page.getByTestId("waiting-toggle").click();
  await expect(page.getByTestId("waiting-row")).toHaveCount(6);
  await expect(chevron(page)).toHaveCSS("rotate", "90deg");
  const open = await strip(page).boundingBox();
  const after = await composer.boundingBox();
  if (!open || !after) throw new Error("no boxes");
  expect(after.y).toBe(before.y);
  expect(open.y).toBeLessThan(shut.y);
  expect(open.y + open.height).toBe(shut.y + shut.height);
  // Every row shows: the list scrolls only past its cap.
  const rows = page.getByTestId("waiting-rows");
  expect(await rows.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
  expect(errors).toEqual([]);
});

test("the list follows the thread's stream: a row removed, a status changed, a wake fired, then Stop waiting", async ({ page }) => {
  await openThread(page);
  await page.getByTestId("waiting-toggle").click();
  await page.locator('[data-wake="sub-t1"]').getByTestId("waiting-remove").click();
  await expect(page.locator('[data-wake="sub-t1"]')).toHaveCount(0);
  await expect(page.getByTestId("waiting-sentence")).toHaveText("Waiting on 1 thread, 1 PR, 1 timer, 1 shell and 1 subagent");
  await mockPost("thread/wake-status?sub=sub-pr&status=open%20·%20checks%20passed%20(4/4)");
  await expect(page.locator('[data-wake="sub-pr"]').getByTestId("waiting-row-status")).toHaveText("checks passed (4/4)");
  await mockPost("thread/wake-fire?sub=sub-pr");
  await expect(page.locator('[data-wake="sub-pr"]')).toHaveCount(0);

  await page.getByTestId("waiting-stop").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("npm run dev");
  await expect(dialog).toContainText("child threads keep working");
  await expect(dialog.getByTestId("confirm-ok")).toHaveText("Stop waiting");
  await dialog.getByTestId("confirm-ok").click();
  await expect.poll(() => kinds(page)).toEqual(["subagent"]);
  await expect(page.getByTestId("waiting-sentence")).toHaveText("Waiting on 1 subagent");
  await expect(page.getByTestId("waiting-stop")).toHaveCount(0);
});

test("back on a thread the strip says what is true now, not what it said when left", async ({ page }) => {
  await openThread(page);
  // s-2 waits on the user: its row's first line opens it, a tab beside s-r1's.
  await openRowThread(page, "s-2");
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-2");
  await mockPost("thread/wake-fire?sub=sub-pr");
  await openRowThread(page, "s-r1");
  await expect(page.getByTestId("waiting-sentence")).toHaveText("Waiting on 2 threads, 1 timer, 1 shell and 1 subagent");
});

/** SHOTS=<dir>: the strip collapsed and expanded, WebKit, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`shots: the strip, ${scheme}`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await openThread(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/waiting-collapsed-${scheme}.png` });
    await page.getByTestId("waiting-toggle").click();
    await expect(page.getByTestId("waiting-row")).toHaveCount(6);
    await page.mouse.move(0, 0);
    // The chevron turns over 150ms: a shot taken at once catches it mid-turn.
    await expect(chevron(page)).toHaveCSS("rotate", "90deg");
    await page.screenshot({ path: `${String(shots)}/waiting-expanded-${scheme}.png` });
  });
}
