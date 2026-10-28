import { expect, test, type Locator, type Page } from "@playwright/test";
import { composeProject, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

/**
 * The "Previous prompts" picker (docs/notes/prompt-history-2-picker.md): Up in an empty
 * composer opens a card above it over ThreadService.ListPrompts (mock/prompts.ts), and
 * composer.history opens the palette's prompts page. The thread is the mock's scripted
 * "Fix stale PR badge" (s-r1 in repo-cf, two prompts); Project adds the fixtures of
 * s-1, s-3 and s-4. Set SHOTS=<dir> to save the PR's screenshots in both schemes.
 */

test.beforeEach(async () => {
  await resetMock();
});

const FIRST = "The PR badge in the sidebar stays green after a force-push";
const SECOND = "Looks good. Run the full suite, then push the branch.";

async function openThread(page: Page, scheme: "dark" | "light" = "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
  await threadPrompt(page).click();
}

const card = (page: Page) => page.getByTestId("prompt-history");
const items = (page: Page) => card(page).getByTestId("prompt-history-item");
const scopeTab = (root: Locator, s: "thread" | "project" | "all") => root.getByTestId(`prompt-history-scope-${s}`);
const threadValue = (page: Page) => page.getByTestId("thread-composer").getByTestId("composer-prompt");

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

test("Up on the empty thread composer opens the card in This thread with the thread's prompts, newest first", async ({ page }) => {
  await openThread(page);
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press("ArrowUp");
  await expect(card(page)).toBeVisible();
  await expect(card(page)).toHaveAttribute("data-scope", "thread");
  await expect(scopeTab(card(page), "thread")).toHaveAttribute("data-state", "active");
  await expect(items(page)).toHaveCount(2);
  await expect(items(page).nth(0).getByTestId("prompt-history-text")).toHaveText(SECOND);
  await expect(items(page).nth(1).getByTestId("prompt-history-text")).toContainText(FIRST);
  // This thread: the sent time, no thread name.
  await expect(items(page).nth(0).getByTestId("prompt-history-time")).not.toBeEmpty();
  await expect(card(page).getByTestId("prompt-history-thread")).toHaveCount(0);
  await expect(items(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(card(page).getByTestId("prompt-history-heading")).toHaveText("Previous prompts");
  await expect(card(page).getByTestId("prompt-history-hints")).toContainText("Show in thread");
  // The composer is now the filter; the keyboard stays in it.
  await expect(page.getByTestId("thread-composer").getByText("Type to filter previous prompts")).toBeVisible();
  await expect(threadPrompt(page)).toBeFocused();
  // The card sits above the composer.
  const c = await card(page).boundingBox();
  const composer = await page.getByTestId("thread-composer").boundingBox();
  if (!c || !composer) throw new Error("no boxes");
  expect(c.y + c.height).toBeLessThanOrEqual(composer.y);

  // Down and Up move (wrapping), Escape closes.
  await page.keyboard.press("ArrowDown");
  await expect(items(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(items(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("thread-composer").getByText("Reply or ask anything.", { exact: false })).toBeVisible();
});

test("Up does not open the card over a draft; typing filters, hits are highlighted, Escape keeps the typed draft", async ({ page }) => {
  await openThread(page);
  await page.keyboard.type("x");
  await page.keyboard.press("ArrowUp");
  await expect(card(page)).toHaveCount(0);
  // Up moved the caret to the line's start.
  await page.keyboard.press("Delete");
  await expect(threadValue(page)).toHaveAttribute("data-value", "");

  await page.keyboard.press("ArrowUp");
  await expect(items(page)).toHaveCount(2);
  await page.keyboard.type("BADGE");
  await expect(items(page)).toHaveCount(1);
  await expect(items(page).first().getByTestId("prompt-history-hit")).toHaveText("badge");
  await expect(card(page).getByTestId("prompt-history-heading")).toHaveText("Previous prompts · 1 match");
  await page.keyboard.type("zzz");
  await expect(card(page).getByTestId("prompt-history-status")).toHaveText("No matches");
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(threadValue(page)).toHaveAttribute("data-value", "BADGEzzz");
});

test("Enter puts the selected prompt in the draft, replacing the filter; a click does too", async ({ page }) => {
  await openThread(page);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.type("push");
  await expect(items(page)).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(card(page)).toHaveCount(0);
  await expect(threadValue(page)).toHaveAttribute("data-value", new RegExp(`^${FIRST}`));
  await expect(threadPrompt(page)).toBeFocused();
  // Nothing was sent.
  await expect(page.getByTestId("thread-send")).toBeEnabled();

  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("ArrowUp");
  await items(page).nth(0).click();
  await expect(card(page)).toHaveCount(0);
  await expect(threadValue(page)).toHaveAttribute("data-value", SECOND);
});

test("cmd+S cycles the scope: Project and All show each prompt's thread and age", async ({ page }) => {
  await openThread(page);
  await page.keyboard.press("ArrowUp");
  await expect(items(page)).toHaveCount(2);
  await page.keyboard.press("Meta+s");
  await expect(card(page)).toHaveAttribute("data-scope", "project");
  await expect(scopeTab(card(page), "project")).toHaveAttribute("data-state", "active");
  const threads = card(page).getByTestId("prompt-history-thread");
  await expect(threads.filter({ hasText: "Fix resize race" }).first()).toBeVisible();
  await expect(threads.filter({ hasText: "Fix stale PR badge" }).first()).toBeVisible();
  // repo-dot's thread is not in Project.
  await expect(threads.filter({ hasText: "Tidy zshrc" })).toHaveCount(0);
  await expect(card(page).getByTestId("prompt-history-age").first()).not.toBeEmpty();
  await page.keyboard.press("Meta+s");
  await expect(card(page)).toHaveAttribute("data-scope", "all");
  await expect(threads.filter({ hasText: "Tidy zshrc" }).first()).toBeVisible();
  await page.keyboard.press("Meta+s");
  await expect(card(page)).toHaveAttribute("data-scope", "thread");
  // A click on the toggle switches too, and the keyboard stays in the prompt.
  await scopeTab(card(page), "project").click();
  await expect(card(page)).toHaveAttribute("data-scope", "project");
  await expect(threadPrompt(page)).toBeFocused();
  // Filtering in Project.
  await page.keyboard.type("resize");
  await expect(card(page).getByTestId("prompt-history-heading")).toHaveText(/Previous prompts · \d+ match/);
  await expect(threads.filter({ hasText: "Fix resize race" }).first()).toBeVisible();
});

test("cmd+Enter in Project shows the prompt in its thread", async ({ page }) => {
  await openThread(page);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Meta+s");
  await page.keyboard.type("useResize");
  await expect(items(page)).toHaveCount(1);
  await page.keyboard.press("Meta+Enter");
  await expect(card(page)).toHaveCount(0);
  await expect(row(page, "s:s-3")).toHaveAttribute("aria-selected", "true");
});

test("the new-thread composer opens it in Project, This thread disabled; a prompt with tags comes back with its chips", async ({ page }) => {
  await openApp(page);
  await composeProject(page, 1);
  await page.keyboard.press("ArrowUp");
  const c = card(page);
  await expect(c).toBeVisible();
  await expect(c).toHaveAttribute("data-scope", "project");
  await expect(scopeTab(c, "thread")).toBeDisabled();
  await expect(c.getByTestId("prompt-history-thread").filter({ hasText: "Refactor sidebar tree" }).first()).toBeVisible();
  await expect(page.getByTestId("composer").getByText("Type to filter previous prompts")).toBeVisible();
  // cmd+S skips This thread.
  await page.keyboard.press("Meta+s");
  await expect(c).toHaveAttribute("data-scope", "all");
  await page.keyboard.press("Meta+s");
  await expect(c).toHaveAttribute("data-scope", "project");
  await page.keyboard.type("keyboard navigation");
  await expect(items(page)).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(c).toHaveCount(0);
  await expect(page.getByTestId("composer-prompt")).toHaveAttribute("data-value", "Keep the keyboard navigation from [Fix resize race](cf-thread://s-3)");
  // Escape on the empty composer still leaves it as before (the picker took it only while open).
  await expect(page.getByTestId("composer-input")).toBeFocused();
});

test("composer.history from the palette opens its prompts page; Enter puts the prompt in the thread's composer", async ({ page }) => {
  await openThread(page);
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await page.keyboard.type("Previous Prompts");
  await expect(palette.locator('[data-command="composer.history"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette).toHaveAttribute("data-mode", "prompts");
  await expect(palette.getByPlaceholder("Search previous prompts…")).toBeFocused();
  await expect(scopeTab(palette, "thread")).toHaveAttribute("data-state", "active");
  await expect(palette.getByTestId("prompt-history-item")).toHaveCount(2);
  await expect(palette.getByTestId("prompt-history-hints")).toContainText("Insert into composer");
  await page.keyboard.press("Meta+s");
  await expect(scopeTab(palette, "project")).toHaveAttribute("data-state", "active");
  await page.keyboard.type("flaky");
  await expect(palette.getByTestId("prompt-history-item").first().getByTestId("prompt-history-hit").first()).toBeVisible();
  await page.keyboard.press("Meta+s");
  await page.keyboard.press("Meta+s");
  await expect(scopeTab(palette, "thread")).toHaveAttribute("data-state", "active");
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("suite");
  await expect(palette.getByTestId("prompt-history-item")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(threadValue(page)).toHaveAttribute("data-value", SECOND);
  await expect(threadPrompt(page)).toBeFocused();
});

for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }) => {
    test.skip(!process.env.SHOTS, "set SHOTS=<dir> to write the PR's screenshots");
    await page.setViewportSize({ width: 1280, height: 800 });
    await openThread(page, scheme);
    await page.keyboard.press("ArrowUp");
    await expect(items(page)).toHaveCount(2);
    await shot(page, `picker-thread-${scheme}`);

    await page.keyboard.press("Meta+s");
    await page.keyboard.type("the");
    await expect(card(page).getByTestId("prompt-history-hit").first()).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, `picker-project-filter-${scheme}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Backspace");

    await page.keyboard.press("Meta+k");
    await page.keyboard.type("Previous Prompts");
    await page.keyboard.press("Enter");
    const palette = page.getByTestId("palette");
    await expect(palette).toHaveAttribute("data-mode", "prompts");
    await page.keyboard.press("Meta+s");
    await expect(palette.getByTestId("prompt-history-item").first()).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, `palette-${scheme}`);
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);

    await composeProject(page, 1);
    await page.keyboard.press("ArrowUp");
    await expect(items(page).first()).toBeVisible();
    await page.waitForTimeout(300);
    await shot(page, `picker-new-thread-${scheme}`);
  });
}
