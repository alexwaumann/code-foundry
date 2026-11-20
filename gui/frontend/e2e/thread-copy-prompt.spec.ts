import { expect, test, type Page } from "@playwright/test";
import { infoCardOff, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

// A user message's Copy (docs/notes/copy-prompt.md), only what needs a browser: the CSS that
// shows it while the bubble or its line is hovered or it has the keyboard, and that showing
// it moves nothing. What it copies, where it sits and which messages get it: vitest
// (src/components/thread/UserBubbleCopy.test.tsx). Over the mock's s-r1 "Fix stale PR badge".
// SHOTS=<dir> saves the PR's screenshots.

test.beforeEach(async () => {
  await resetMock();
  // Written for a conversation with no card beside it (layout.thread_info is on by default).
  await infoCardOff();
});

const pane = (page: Page) => page.getByTestId("thread-pane");
const timeline = (page: Page) => pane(page).getByTestId("thread-timeline");

async function openThread(page: Page, state: "idle" | "streaming"): Promise<void> {
  await mockPost(`thread?state=${state}`);
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(timeline(page).locator("[data-row-type]").first()).toBeVisible();
}

/** Every mounted timeline row's box. */
const boxes = (page: Page) => timeline(page).locator("[data-index]").evaluateAll((rows) => rows.map((r) => [r.getAttribute("data-index"), ...Object.values(r.getBoundingClientRect().toJSON() as Record<string, number>).map(Math.round)].join(" ")));

test("hovering a message's bubble or line shows its Copy, and nothing moves", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await openThread(page, "idle");
  const msg = pane(page).getByTestId("thread-user").last();
  const copy = msg.getByTestId("thread-copy-prompt");
  const when = msg.locator(".when");
  await page.mouse.move(0, 0);
  await expect(copy).toHaveCSS("opacity", "0");
  // No fade: an agreed rule for this pane's hover controls.
  await expect(copy).toHaveCSS("transition-duration", "0s");
  const before = await boxes(page);
  const at = await when.boundingBox();
  await msg.locator(".bubble").hover();
  await expect(copy).toHaveCSS("opacity", "1");
  expect(await boxes(page)).toEqual(before);
  expect(await when.boundingBox()).toEqual(at);
  // From the bubble down to Copy, the pointer never leaves both.
  const b = await msg.locator(".bubble").boundingBox();
  const c = await copy.boundingBox();
  if (!b || !c) throw new Error("no box");
  await page.mouse.move(c.x + c.width / 2, b.y + b.height + 2);
  await expect(copy).toHaveCSS("opacity", "1");
  // The empty width beside the bubble is not the message.
  await page.mouse.move(b.x - 40, b.y + b.height / 2);
  await expect(copy).toHaveCSS("opacity", "0");
  expect(await boxes(page)).toEqual(before);
});

test("Copy shows while it has the keyboard focus", async ({ page }) => {
  await openThread(page, "idle");
  const copy = pane(page).getByTestId("thread-user").last().getByTestId("thread-copy-prompt");
  await page.mouse.move(0, 0);
  await expect(copy).toHaveCSS("opacity", "0");
  // Reached with the keyboard (a programmatic focus after a click is not :focus-visible);
  // WebKit's Tab skips buttons unless full keyboard access is on: Alt+Tab.
  await copy.focus();
  await page.keyboard.press("Alt+Shift+Tab");
  await expect(copy).not.toBeFocused();
  await expect(copy).toHaveCSS("opacity", "0");
  await page.keyboard.press("Alt+Tab");
  await expect(copy).toBeFocused();
  await expect(copy).toHaveCSS("opacity", "1");
});

/** SHOTS=<dir>: the PR's screenshots, WebKit at 2x, dark and light: a message and a steer hovered. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2, viewport: { width: 1100, height: 760 } });
    test("a message hovered, a steer hovered", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      const dir = String(shots);
      const tag = process.env.SHOTS_TAG ?? "after";
      await openThread(page, "streaming");
      await threadPrompt(page).click();
      await page.keyboard.insertText("Cap the max backoff at 15s so waking from lid-close never feels stuck.");
      await page.keyboard.press("Enter");
      const steer = pane(page).getByTestId("thread-steer").last();
      await expect(steer).toBeVisible();
      // The steer ends the mock's turn and the list moves: hover once it has settled.
      await expect(page.getByTestId("thread-working")).toHaveCount(0);
      await page.waitForTimeout(500);
      await steer.locator(".bubble").hover();
      await expect(steer.getByTestId("thread-copy-prompt")).toHaveCSS("opacity", "1");
      await page.waitForTimeout(300);
      await pane(page).screenshot({ path: `${dir}/steer-${tag}-${scheme}.png` });
      const first = pane(page).getByTestId("thread-user").first();
      await first.scrollIntoViewIfNeeded();
      await first.locator(".bubble").hover();
      await page.waitForTimeout(400);
      await pane(page).screenshot({ path: `${dir}/prompt-${tag}-${scheme}.png` });
    });
  });
}
