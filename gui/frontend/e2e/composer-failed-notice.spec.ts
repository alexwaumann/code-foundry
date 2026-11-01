import { expect, test, type Page } from "@playwright/test";
import { MOCK_ATTACHMENT } from "../mock/thread";
import { invocations, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

// The thread composer's failed-prompt notice (docs/notes/composer-failed-notice.md) over
// the mock's scripted thread s-r1: "crashed" (Claude did not start for a message) and a turn
// that ends in error before any text (POST /__mock/thread/fail-turn), and a turn whose request
// failed with Claude Code's API-error text (POST /__mock/thread/api-error).

test.beforeEach(async () => {
  await resetMock();
});

const NOT_STARTED = "Claude did not start, so your message was not sent.";
const TURN_FAILED = "The request failed (error during execution), so your message was not sent.";

async function openThread(page: Page, state: "crashed" | "idle", scheme: "dark" | "light" = "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost(`thread?state=${state}`);
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
}

const note = (page: Page) => page.getByTestId("thread-composer").getByTestId("thread-failed-note");
const prompt = (page: Page) => page.getByTestId("thread-composer").getByTestId("composer-prompt");

/** The args of every thread.send the GUI invoked, oldest first. */
async function sends(): Promise<Record<string, string>[]> {
  return (await invocations()).filter((i) => i.name === "thread.send").map((i) => i.args);
}

/** Reaches the scripted reply's text ("Got it: I'll take a look now."). */
async function replied(page: Page): Promise<void> {
  await expect(page.getByTestId("thread-pane").locator('[data-testid="thread-text"]').last()).toContainText("Got it: I'll take a look now.", { timeout: 10_000 });
}

// The reason, its icon, the two buttons, Send again's thread.send args, the notice going and the draft untouched:
// unit-tested in src/components/thread/ThreadComposerSend.test.tsx. What stays: one line high, and the Tab order.
test("Claude did not start: the notice is one line; Edit and Send again are tabbable in order", async ({ page }) => {
  await openThread(page, "crashed");
  await expect(note(page).getByTestId("thread-failed-reason")).toHaveText(NOT_STARTED);
  const box = await note(page).boundingBox();
  expect(box?.height).toBeLessThan(48);
  // Both are tabbable, in order (WebKit's Tab skips buttons unless full keyboard access is on: Alt+Tab).
  await note(page).getByTestId("thread-failed-edit").focus();
  await page.keyboard.press("Alt+Tab");
  await expect(note(page).getByTestId("thread-failed-resend")).toBeFocused();
});

test("Edit puts the prompt back with its tags and attachment, after the draft, and focuses it; sending clears the notice", async ({ page }) => {
  await openThread(page, "crashed");
  await threadPrompt(page).click();
  await page.keyboard.type("First this");
  await note(page).getByTestId("thread-failed-edit").click();
  await expect(prompt(page)).toHaveAttribute(
    "data-value",
    /^First this\n\nThe PR badge in the sidebar stays green after a force-push, see !\[pr-badge-stale\.png\]\(cf-attachment:\/\/a\d+\) Look at \[poller\.go\]\(cf-file:\/\/repo-cf\/internal\/store\/pr\/poller\.go\) and tell me why the fingerprint misses it with \[\/tdd\]\(cf-skill:\/\/~\/tdd\)\.$/,
  );
  await expect(page.getByTestId("thread-composer").getByTestId("attachment")).toHaveCount(1);
  await expect(threadPrompt(page)).toBeFocused();
  // Edit does not dismiss it: only a send (or Claude's reply) does.
  await expect(note(page)).toBeVisible();

  await page.keyboard.press("Enter");
  await expect(note(page)).toHaveCount(0);
  // The attachment goes out with its staged path, not staged again.
  await expect.poll(async () => (await sends()).length).toBe(1);
  const [sent] = await sends();
  expect(sent?.attachments).toBe(MOCK_ATTACHMENT);
  expect(sent?.text).toMatch(/^First this\n\nThe PR badge .* see \[Image: pr-badge-stale\.png; ref=\/mock\/attachments\/pr-badge-stale\.png\] /);
  await replied(page);
  await expect(note(page)).toHaveCount(0);
});

// A turn that ends in error before any text, and any message sent clearing it: unit-tested in
// src/components/thread/ThreadComposerSend.test.tsx.

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1280x800, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.setViewportSize({ width: 1280, height: 800 });
    await openThread(page, "crashed", scheme);
    await expect(note(page)).toBeVisible();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/did-not-start-${scheme}.png` });
    await page.getByTestId("thread-composer").screenshot({ path: `${String(shots)}/composer-did-not-start-${scheme}.png` });
    // The turn-error wording on a thread that has replied before.
    await resetMock();
    await openThread(page, "idle", scheme);
    await mockPost("thread/fail-turn");
    await threadPrompt(page).click();
    await page.keyboard.type("Run the tests");
    await page.keyboard.press("Enter");
    await expect(note(page).getByTestId("thread-failed-reason")).toHaveText(TURN_FAILED);
    await page.mouse.move(0, 0);
    await page.getByTestId("thread-composer").screenshot({ path: `${String(shots)}/composer-request-failed-${scheme}.png` });
  });
}

// Claude Code's API failures (docs/notes/api-error-reply-flag.md): a synthetic assistant text
// with the error wording (api_error set by the daemon) in place of a reply.
const API_FAILED = "The request failed (invalid API key), so your message was not sent.";

/** Sends "Run the tests" with the mock's next turn ending in Claude Code's API-error text. */
async function sendIntoAPIError(page: Page): Promise<void> {
  await mockPost("thread/api-error");
  await threadPrompt(page).click();
  await page.keyboard.type("Run the tests");
  await page.keyboard.press("Enter");
}

// An API error in place of a reply: the notice and Send again in src/components/thread/ThreadComposerSend.test.tsx; the
// red error row with no answer and no Copy answer in src/components/thread/rows.test.tsx.

// The reason's first line without Claude Code's prefix, and Edit with no draft: unit-tested in src/lib/failedPrompt.test.ts

/** SHOTS=<dir>: the API-error screenshots, WebKit, 1280x800, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`api error screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.setViewportSize({ width: 1280, height: 800 });
    await openThread(page, "idle", scheme);
    await sendIntoAPIError(page);
    await expect(note(page).getByTestId("thread-failed-reason")).toHaveText(API_FAILED);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/api-error-${scheme}.png` });
    await page.getByTestId("thread-composer").screenshot({ path: `${String(shots)}/composer-api-error-${scheme}.png` });
  });
}
