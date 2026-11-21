import { expect, test, type Page } from "@playwright/test";
import { infoCardOff, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

// Cancel and Re-send on a message Claude has not read (docs/notes/cancel-queued-messages.md),
// only what needs a browser: the caption row keeps its height and the caption its place when
// Cancel appears and goes, and after Cancel the keyboard is in the composer with the text.
// Which controls show when, the commands they run and the draft rule: vitest
// (src/components/thread/MessageActions.test.tsx, src/stores/cancelMessage.test.ts). Over the
// mock's s-r1 "Fix stale PR badge" (streaming), steers held queued. SHOTS=<dir> saves the
// PR's screenshots.

test.beforeEach(async () => {
  await resetMock();
  await infoCardOff();
});

const pane = (page: Page) => page.getByTestId("thread-pane");

async function openStreaming(page: Page): Promise<void> {
  await mockPost("thread?state=streaming");
  await mockPost("thread/steer?do=hold");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(pane(page).getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
}

async function steer(page: Page, text: string): Promise<void> {
  await threadPrompt(page).click();
  await page.keyboard.insertText(text);
  await page.keyboard.press("Enter");
  await expect(pane(page).locator('[data-delivery="queued"]').last()).toBeVisible();
}

/** The steer's caption row: its height, and the caption's right edge and top inside the message. */
const captionBox = (page: Page) =>
  pane(page)
    .getByTestId("thread-steer")
    .evaluate((u) => {
      const meta = u.querySelector(".u-meta")?.getBoundingClientRect();
      const cap = u.querySelector('[data-testid="thread-steer-caption"]')?.getBoundingClientRect();
      const box = u.getBoundingClientRect();
      return meta && cap ? { height: Math.round(meta.height), right: Math.round(box.right - cap.right), top: Math.round(cap.top - box.top), total: Math.round(box.height) } : null;
    });

test("Cancel leaves when Claude reads the message: the row keeps its height and the caption its place", async ({ page }) => {
  await openStreaming(page);
  await steer(page, "Also add a README table");
  await expect(pane(page).getByTestId("thread-message-cancel")).toBeVisible();
  const queued = await captionBox(page);
  await mockPost("thread/steer?id=s-r1&do=read&reply=0");
  await expect(pane(page).locator('[data-testid="thread-steer"][data-delivery="read"]')).toBeVisible();
  await expect(pane(page).getByTestId("thread-message-cancel")).toHaveCount(0);
  expect(await captionBox(page)).toEqual(queued);
});

test("after Cancel the message is gone and the keyboard is in the composer, after the draft", async ({ page }) => {
  await openStreaming(page);
  await steer(page, "Also add a README table");
  await threadPrompt(page).click();
  await page.keyboard.insertText("draft I was typing");
  await pane(page).getByTestId("thread-message-cancel").click();
  await expect(pane(page).locator('[data-delivery="queued"]')).toHaveCount(0);
  await expect(threadPrompt(page)).toBeFocused();
  await expect(threadPrompt(page)).toHaveText(/draft I was typing\s*Also add a README table/);
  // Typing goes on at the end of the text.
  await page.keyboard.insertText(" please");
  await expect(threadPrompt(page)).toHaveText(/Also add a README table please$/);
});

/** SHOTS=<dir>: the PR's screenshots, WebKit at 2x, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2, viewport: { width: 1100, height: 760 } });
    test("queued, not sent, and the composer after Cancel", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      test.setTimeout(60_000);
      const dir = String(shots);
      const shot = async (name: string) => {
        await page.waitForTimeout(400);
        await pane(page).screenshot({ path: `${dir}/${name}-${scheme}.png` });
      };
      await openStreaming(page);
      await steer(page, "Also add a README table listing each algorithm with its average time complexity.");
      await shot("cancel-queued");
      await threadPrompt(page).click();
      await page.keyboard.insertText("And keep it short.");
      await pane(page).getByTestId("thread-message-cancel").click();
      await expect(threadPrompt(page)).toBeFocused();
      await shot("cancel-composer");
      await page.keyboard.press("Enter");
      await expect(pane(page).locator('[data-delivery="queued"]')).toBeVisible();
      await pane(page).getByRole("button", { name: "Interrupt" }).click();
      await expect(pane(page).locator('[data-delivery="unsent"]')).toBeVisible();
      await expect(page.getByTestId("thread-working")).toHaveCount(0);
      await shot("cancel-not-sent");
    });
  });
}
