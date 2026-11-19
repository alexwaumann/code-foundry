import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock, row, threadsOpenAsTabs } from "./fixtures";

/**
 * A thread's notifications on its sidebar row (docs/notes/notifications-4-row-mark.md), what only a
 * real browser shows: the mark's place beside the pull request tag at the narrowest sidebar, and
 * the pointer's way from the row into its hover card and onto a card's buttons until the mark goes.
 * Which rows show the mark, its count and tone, the card's list and what each button runs:
 * src/components/sidebar/shell/ShellSidebarList.test.tsx, src/components/sidebar/TipNotifications.test.tsx
 * and src/lib/notifications.test.ts. SHOTS=<dir> saves the PR's screenshots.
 */

test.beforeEach(async () => {
  await resetMock();
  // A spec about thread tabs: a reset is a new home, on Panes.
  await threadsOpenAsTabs();
});

const enc = encodeURIComponent;
const post = (q: string) => mockPost(`notifications/post?${q}`);

/** Two notifications naming s-3, an error with two buttons and a plain one, and a PR linked to it. */
async function seed(): Promise<void> {
  await mockPost(`link-pr?thread=s-3&slug=${enc("alexwaumann/code-foundry")}&number=751&ago=60000`);
  await post(`title=${enc("Follow up on the retry")}&thread=s-3&source=hello&key=retry&action=${enc("Open task|open|https://example.com/t")}`);
  await post(`title=${enc("Stage integration failed")}&body=${enc("cf-deploy #482 · 3 of 212 tests failed")}&level=error&thread=s-3&source=hello&key=stage&action=${enc("Send to thread|send|Look at the failed stage")}&action=${enc("Open log|open|https://example.com/log")}`);
}

async function calls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/notifications`);
  return ((await res.json()) as { calls: string[] }).calls;
}

/** The open card (the previous one may still be fading out). */
const openCard = (page: Page) => page.locator('[data-testid="thread-tooltip"]:not([data-state="closed"])');

test("at the narrowest sidebar the mark sits on the PR tag's line, before it, the same height, inside the row", async ({ page }) => {
  await openApp(page);
  await seed();
  expect((await page.getByTestId("sidebar").boundingBox())?.width).toBe(240);
  const r = row(page, "s:s-3");
  const mark = r.getByTestId("row-notifications");
  const tag = r.getByTestId("row-linked-prs");
  await expect(mark).toHaveText("2");
  await expect(mark).toHaveAttribute("data-tone", "error");
  await expect(tag).toBeVisible();
  const [m, t, rb, line] = await Promise.all([mark.boundingBox(), tag.boundingBox(), r.boundingBox(), r.getByTestId("row-line-3").boundingBox()]);
  if (!m || !t || !rb || !line) throw new Error("no boxes");
  // One line: centred alike, the mark no taller than the tag, both inside line 3.
  expect(Math.abs(m.y + m.height / 2 - (t.y + t.height / 2))).toBeLessThanOrEqual(1);
  expect(m.height).toBeLessThanOrEqual(t.height + 0.5);
  expect(m.y).toBeGreaterThanOrEqual(line.y - 0.5);
  expect(m.y + m.height).toBeLessThanOrEqual(line.y + line.height + 0.5);
  // Before the tag with the counts' 8px gap, and the tag still ends inside the row.
  expect(Math.round(t.x - (m.x + m.width))).toBe(8);
  expect(t.x + t.width).toBeLessThanOrEqual(rb.x + rb.width);
  // The branch gives way rather than running under the mark.
  const branch = await r.getByTestId("row-branch").boundingBox();
  if (!branch) throw new Error("no branch");
  expect(branch.x + branch.width).toBeLessThanOrEqual(m.x);
});

test("the pointer goes from the row into its card and presses a card's buttons; Dismiss twice and the mark goes", async ({ page }) => {
  await openApp(page);
  await seed();
  const r = row(page, "s:s-3");
  await r.getByTestId("thread-name").hover();
  const card = openCard(page);
  await expect(card).toHaveAttribute("data-thread-id", "s-3");
  await expect(card.getByTestId("notification-card")).toHaveCount(2);
  // The newest first, as the daemon orders them; no link to the thread the card is about.
  await expect(card.getByTestId("notification-title")).toHaveText(["Stage integration failed", "Follow up on the retry"]);
  await expect(card.getByTestId("notification-thread")).toHaveCount(0);

  // Across the gap into the card, in steps as a hand would, onto the error's second button.
  const target = card.getByTestId("notification-card").first().getByTestId("notification-action").nth(1);
  const to = await target.boundingBox();
  const from = await r.getByTestId("thread-name").boundingBox();
  if (!to || !from) throw new Error("no boxes");
  await page.mouse.move(from.x + from.width - 4, from.y + from.height / 2);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await expect(card).toHaveAttribute("data-thread-id", "s-3");
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(async () => (await calls()).at(-1)).toMatch(/^notification\.act .*"action":"2"/);
  // The press stayed in the card: the thread did not open, and the card is still up.
  await expect(page.getByTestId("thread-pane")).toHaveCount(0);
  await expect(card).toHaveAttribute("data-thread-id", "s-3");

  // A corner button's own tooltip opening does not shut the card.
  const first = card.getByTestId("notification-card").first();
  await first.getByTestId("notification-dismiss").hover();
  await page.waitForTimeout(700);
  await expect(card).toHaveAttribute("data-thread-id", "s-3");
  await first.getByTestId("notification-dismiss").click();
  await expect(r.getByTestId("row-notifications")).toHaveText("1");
  await expect(r.getByTestId("row-notifications")).toHaveAttribute("data-tone", "muted");
  await expect(card.getByTestId("notification-card")).toHaveCount(1);
  await card.getByTestId("notification-card").first().getByTestId("notification-dismiss").click();
  await expect(r.getByTestId("row-notifications")).toHaveCount(0);
  await expect(card.getByTestId("tip-notifications")).toHaveCount(0);
  // With nothing left to press it shuts as the pointer leaves, as a plain card does.
  await page.mouse.move(900, 700, { steps: 5 });
  await expect(openCard(page)).toHaveCount(0);
});

test("screenshots: the row with its mark and its open card, dark and light", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await seed();
  const sidebar = page.getByTestId("sidebar");
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.mouse.move(900, 700);
    await page.waitForTimeout(400);
    await sidebar.screenshot({ path: `${shots}/row-mark-${scheme}.png` });
    await row(page, "s:s-3").getByTestId("thread-name").hover();
    await expect(openCard(page)).toHaveAttribute("data-thread-id", "s-3");
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/row-card-${scheme}.png`, clip: { x: 0, y: 0, width: 760, height: 800 } });
  }
});
