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

// The card's scope, rows, times, heading, hints, placeholder, the arrows and Escape: unit-tested in
// src/components/compose/PromptHistory.test.tsx. What stays: Up in the real editor, the keyboard staying in the
// prompt, and the card's place above the composer.
test("Up on the empty thread composer opens the card above it, the keyboard still in the prompt", async ({ page }) => {
  await openThread(page);
  await page.keyboard.press("ArrowUp");
  await expect(card(page)).toBeVisible();
  await expect(items(page)).toHaveCount(2);
  await expect(threadPrompt(page)).toBeFocused();
  const c = await card(page).boundingBox();
  const composer = await page.getByTestId("thread-composer").boundingBox();
  if (!c || !composer) throw new Error("no boxes");
  expect(c.y + c.height).toBeLessThanOrEqual(composer.y);
});

// Filtering, the marked hits, No matches and Escape keeping the typed draft: unit-tested in
// src/components/compose/PromptHistory.test.tsx. What stays: Up over a draft moving the real caret.
test("Up does not open the card over a draft: it moves the caret to the line's start", async ({ page }) => {
  await openThread(page);
  await page.keyboard.type("x");
  await page.keyboard.press("ArrowUp");
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press("Delete");
  await expect(threadValue(page)).toHaveAttribute("data-value", "");
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

// Project and All naming each prompt's thread and age, the cycle, the toggle and filtering in Project, and cmd+Enter
// showing the prompt in its thread: unit-tested in src/components/compose/PromptHistory.test.tsx. What stays: cmd+S
// reaching the picker from the focused editor (not the app's chord), and a toggle click keeping the keyboard there.
test("cmd+S in the prompt switches the scope; a click on the toggle keeps the keyboard in the prompt", async ({ page }) => {
  await openThread(page);
  await page.keyboard.press("ArrowUp");
  await expect(items(page)).toHaveCount(2);
  await page.keyboard.press("Meta+s");
  await expect(card(page)).toHaveAttribute("data-scope", "project");
  await scopeTab(card(page), "thread").click();
  await expect(card(page)).toHaveAttribute("data-scope", "thread");
  await expect(threadPrompt(page)).toBeFocused();
});

// Project by default, This thread disabled and cmd+S skipping it: unit-tested in
// src/components/compose/PromptHistory.test.tsx. What stays: the prompt's thread tag back in the real editor.
test("the new-thread composer: a prompt with tags comes back with its chips, the keyboard in the prompt", async ({ page }) => {
  await openApp(page);
  await composeProject(page, 1);
  await page.keyboard.press("ArrowUp");
  await expect(card(page)).toBeVisible();
  await page.keyboard.type("keyboard navigation");
  await expect(items(page)).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-prompt")).toHaveAttribute("data-value", "Keep the keyboard navigation from [Fix resize race](cf-thread://s-3)");
  await expect(page.getByTestId("composer").getByTestId("prompt-tag")).toHaveText(["Fix resize race"]);
  await expect(page.getByTestId("composer-input")).toBeFocused();
});

// The prompts page's scope, rows, hints, cycling and filtering: unit-tested in
// src/components/compose/PromptHistory.test.tsx. What stays: from the palette into the thread's real editor, focused.
test("composer.history from the palette opens its prompts page; Enter puts the prompt in the thread's composer", async ({ page }) => {
  await openThread(page);
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await page.keyboard.type("Previous Prompts");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveAttribute("data-mode", "prompts");
  await expect(palette.getByPlaceholder("Search previous prompts…")).toBeFocused();
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
