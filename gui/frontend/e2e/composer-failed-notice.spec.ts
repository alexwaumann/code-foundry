import { expect, test, type Page } from "@playwright/test";
import { CRASHED_PROMPT, MOCK_ATTACHMENT } from "../mock/thread";
import { invocations, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

// The thread composer's failed-prompt notice (docs/notes/composer-failed-notice.md) over
// the mock's scripted thread s-r1: "crashed" (Claude did not start for a message) and a turn
// that ends in error before any text (POST /__mock/thread/fail-turn).

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

test("Claude did not start: the notice says so on one line; Send again sends the same message and the notice goes", async ({ page }) => {
  await openThread(page, "crashed");
  // The transcript is unchanged: the prompt's bubble and the error stay.
  await expect(page.getByTestId("thread-error")).toHaveText("Claude did not start: exit code 1: error: unknown option '--bogus'");
  await expect(note(page).getByTestId("thread-failed-reason")).toHaveText(NOT_STARTED);
  await expect(note(page).locator("svg.lucide-circle-alert")).toBeVisible();
  // One line, at the top of the card: no close button, just the two.
  await expect(note(page).getByRole("button")).toHaveText(["Edit", "Send again"]);
  const box = await note(page).boundingBox();
  expect(box?.height).toBeLessThan(48);
  // Both are tabbable, in order (WebKit's Tab skips buttons unless full keyboard access is on: Alt+Tab).
  await note(page).getByTestId("thread-failed-edit").focus();
  await page.keyboard.press("Alt+Tab");
  await expect(note(page).getByTestId("thread-failed-resend")).toBeFocused();

  await note(page).getByTestId("thread-failed-resend").click();
  await expect(note(page)).toHaveCount(0);
  await expect.poll(sends).toEqual([{ id: "s-r1", text: CRASHED_PROMPT.text, attachments: MOCK_ATTACHMENT, "composer-text": CRASHED_PROMPT.composerText }]);
  await replied(page);
  await expect(note(page)).toHaveCount(0);
  // The draft was not touched.
  await expect(prompt(page)).toHaveAttribute("data-value", "");
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

test("a turn that ends in error before any text: the request failed; any message sent clears it", async ({ page }) => {
  await openThread(page, "idle");
  await expect(note(page)).toHaveCount(0);
  await mockPost("thread/fail-turn");
  await threadPrompt(page).click();
  await page.keyboard.type("Run the tests");
  await page.keyboard.press("Enter");
  await expect(note(page).getByTestId("thread-failed-reason")).toHaveText(TURN_FAILED);

  await page.keyboard.type("Never mind, check the lint");
  await page.keyboard.press("Enter");
  await expect(note(page)).toHaveCount(0);
  await replied(page);
  await expect(note(page)).toHaveCount(0);
});

test("Edit with no draft: the prompt alone; another error subtype", async ({ page }) => {
  await openThread(page, "idle");
  await mockPost("thread/fail-turn?subtype=error_max_turns");
  await threadPrompt(page).click();
  await page.keyboard.type("Run the tests");
  await page.keyboard.press("Enter");
  await expect(note(page).getByTestId("thread-failed-reason")).toHaveText("The request failed (error max turns), so your message was not sent.");
  await note(page).getByTestId("thread-failed-edit").click();
  await expect(prompt(page)).toHaveAttribute("data-value", "Run the tests");
});

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
