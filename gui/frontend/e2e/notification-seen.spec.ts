import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock } from "./fixtures";

/**
 * The bell's corner badge (docs/notes/notification-seen.md), what only a real browser shows: the
 * badge on the bell's top-right corner inside the top bar, widening the button for more digits,
 * and opening the list taking it off through the daemon's stream. The looks, tones and when
 * notification.seen runs: src/components/notifications/NotificationBellSeen.test.tsx. SHOTS=<dir>
 * saves the PR's screenshots.
 */

test.beforeEach(async () => {
  await resetMock();
});

const enc = encodeURIComponent;
const post = (q: string) => mockPost(`notifications/post?${q}`);

/** Waits out the bell glyph's arrival tilt (docs/notes/arrival-tilt.md), which moves its box. */
async function still(page: Page): Promise<void> {
  const icon = page.getByTestId("notification-bell-icon");
  await expect.poll(() => icon.evaluate((el) => el.getAnimations().length)).toBe(0);
}

async function calls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/notifications`);
  return ((await res.json()) as { calls: string[] }).calls;
}

test("the badge sits on the bell's top-right corner, and opening the list takes it off", async ({ page }) => {
  await openApp(page);
  await post(`title=${enc("Build failed")}`);
  const bell = page.getByTestId("notification-bell");
  const badge = page.getByTestId("notification-bell-count");
  await expect(bell).toHaveAttribute("data-unseen", "true");
  const box = async () => {
    await still(page);
    const [b, i, c, bar] = await Promise.all([bell.boundingBox(), bell.locator("svg").boundingBox(), badge.boundingBox(), page.getByTestId("top-bar").boundingBox()]);
    if (!b || !i || !c || !bar) throw new Error("no boxes");
    return { b, i, c, bar };
  };
  const { i, c, bar } = await box();
  // Over the icon's top-right quarter: its left edge right of the icon's middle, its bottom above it.
  expect(c.x).toBeGreaterThan(i.x + i.width / 2);
  expect(c.x).toBeLessThan(i.x + i.width);
  expect(c.y).toBeLessThan(i.y);
  expect(c.y + c.height).toBeLessThan(i.y + i.height / 2 + 4);
  expect(c.y).toBeGreaterThanOrEqual(bar.y);
  // Three digits widen the button (leftwards: it ends the bar) rather than cover more of the bell.
  for (let k = 0; k < 99; k++) await post(`title=${enc(`Note ${String(k)}`)}&key=k${String(k)}&source=s${String(k % 3)}`);
  await expect(badge).toHaveText("100");
  const wide = await box();
  expect(wide.c.x - wide.i.x).toBeCloseTo(c.x - i.x, 0);
  expect(wide.c.x + wide.c.width).toBeLessThanOrEqual(wide.b.x + wide.b.width);
  expect(wide.b.x + wide.b.width).toBeLessThanOrEqual(wide.bar.x + wide.bar.width);

  await bell.click();
  await expect(page.getByTestId("notification-popover")).toBeVisible();
  await expect(bell).not.toHaveAttribute("data-unseen", "true");
  expect(await calls()).toContain("notification.seen {}");
  await page.keyboard.press("Escape");
  await expect(badge).toHaveText("100");
  await expect(bell).not.toHaveAttribute("data-unseen", "true");
});

/** The top bar's right end, around the bell. */
async function shoot(page: Page, path: string): Promise<void> {
  const b = await page.getByTestId("notification-bell").boundingBox();
  const bar = await page.getByTestId("top-bar").boundingBox();
  if (!b || !bar) throw new Error("no boxes");
  const right = bar.x + bar.width;
  await page.screenshot({ path, clip: { x: right - 160, y: bar.y, width: 160, height: bar.height } });
}

test("screenshots: the bell nothing, unseen, unseen time-sensitive, seen, seen time-sensitive, two digits, dark and light", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  const states: [string, () => Promise<void>][] = [
    ["nothing", async () => {}],
    ["unseen", async () => {
      await post(`title=${enc("Build failed")}`);
    }],
    ["unseen-time-sensitive", async () => {
      await post(`title=${enc("Deploy waiting")}&ts=1`);
    }],
    ["seen", async () => {
      await post(`title=${enc("Build failed")}&seen=1`);
    }],
    ["seen-time-sensitive", async () => {
      await post(`title=${enc("Deploy waiting")}&ts=1&seen=1`);
    }],
    [
      "two-digits",
      async () => {
        await mockPost("notifications/seed?quiet=1");
        for (let k = 0; k < 7; k++) await post(`title=${enc(`Note ${String(k)}`)}&key=k${String(k)}`);
      },
    ],
  ];
  for (const [name, make] of states) {
    await resetMock();
    await make();
    await still(page);
    await page.mouse.move(640, 700);
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await shoot(page, `${shots}/bell-${name}-${scheme}.png`);
    }
  }
});
