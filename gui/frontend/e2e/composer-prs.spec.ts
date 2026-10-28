import { expect, test, type Page } from "@playwright/test";
import { composeProject, invocations, mockPost, openApp, openTooltip, resetMock, row } from "./fixtures";

// Pull request tags after "#" (docs/notes/composer-thread-pr-tags.md): the card lists the
// draft's repositories' pull requests the daemon polls (the mock's dashboards for
// alexwaumann/code-foundry: #142 and #145 authored, #139 awaiting review, #133 reviewed,
// #138 and #136 merged), by number or title, at most five. Only a pick makes a tag: a
// number nothing has stays text and Enter sends; Enter picks only the exact number or a
// row the arrow keys moved to (Tab and a click always pick). Set SHOTS=<dir> for screenshots.

test.beforeEach(async () => {
  await resetMock();
});

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

async function compose(page: Page): Promise<void> {
  await composeProject(page);
}

const value = (page: Page) => page.getByTestId("composer-prompt").first();
const card = (page: Page) => page.getByTestId("completion-card");
const rows = (page: Page) => card(page).getByTestId("completion-item");
const labels = (page: Page) => card(page).getByTestId("completion-label");
const tags = (page: Page) => page.getByTestId("prompt-tag");
const tip = (page: Page) => page.getByTestId("prompt-tag-tooltip").locator("p");
const newThreads = async () => (await invocations()).filter((i) => i.name === "thread.new").length;

const PR139 = "[#139](cf-pr://alexwaumann/code-foundry/139)";

test("#13: open pull requests first, then merged; #139 + Enter inserts the tag; the send projects owner/repo#N", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("review #13");
  await expect(labels(page)).toHaveText(["#139", "#133", "#138", "#136"]);
  await expect(rows(page).nth(0)).toContainText("feat(thread): JSONL transcript discovery");
  await expect(card(page).getByRole("listbox")).toHaveAttribute("aria-label", "Pull requests");
  await shot(page, "pr-card");

  await page.keyboard.type("9");
  await expect(labels(page)).toHaveText(["#139"]);
  await page.keyboard.press("Enter");
  await expect(card(page)).toHaveCount(0);
  await expect(value(page)).toHaveAttribute("data-value", `review ${PR139} `);
  await expect(tags(page)).toHaveText(["#139"]);
  await expect(tags(page).nth(0)).toHaveAttribute("data-tag-kind", "pr");
  await expect(tags(page).nth(0)).toHaveAttribute("data-state", "open");
  await tags(page).nth(0).hover();
  await expect(tip(page)).toHaveText(["feat(thread): JSONL transcript discovery", "alexwaumann/code-foundry#139"]);
  await shot(page, "pr-tag-tooltip");
  await page.mouse.move(0, 0);

  await page.keyboard.type("and say what is left");
  await page.keyboard.press("Enter");
  await expect.poll(newThreads).toBe(1);
  const args = (await invocations()).at(-1)?.args;
  expect(args?.prompt).toBe("review alexwaumann/code-foundry#139 and say what is left");
  expect(args?.["composer-prompt"]).toBe(`review ${PR139} and say what is left`);
});

test("#13 + Enter sends as typed while #139 is listed", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("fixes #13");
  await expect(labels(page)).toHaveText(["#139", "#133", "#138", "#136"]);
  await page.keyboard.press("Enter");
  await expect.poll(newThreads).toBe(1);
  const args = (await invocations()).at(-1)?.args;
  expect(args?.prompt).toBe("fixes #13");
  expect(args?.["composer-prompt"] ?? "fixes #13").toBe("fixes #13");
});

test("arrow down + Enter inserts the highlighted pull request; Tab inserts the first", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("#13");
  await expect(labels(page)).toHaveText(["#139", "#133", "#138", "#136"]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(card(page)).toHaveCount(0);
  await expect(value(page)).toHaveAttribute("data-value", "[#133](cf-pr://alexwaumann/code-foundry/133) ");
  await page.keyboard.type("#13");
  await expect(labels(page)).toHaveText(["#139", "#133", "#138", "#136"]);
  await page.keyboard.press("Tab");
  await expect(value(page)).toHaveAttribute("data-value", `[#133](cf-pr://alexwaumann/code-foundry/133) ${PR139} `);
  await expect.poll(newThreads).toBe(0);
});

test("no false positives: an unknown number, a heading, C# and a bare # stay text; Enter sends", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("# Plan");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("## Steps");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("port C#13 and fix #999 #");
  await page.waitForTimeout(300);
  await expect(card(page)).toHaveCount(0);
  await expect(tags(page)).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect.poll(newThreads).toBe(1);
  expect((await invocations()).at(-1)?.args.prompt).toBe("# Plan\n## Steps\nport C#13 and fix #999 #");
});

test("by title; typing on to a number nothing has closes the card without a word; Escape keeps the text", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("#jsonl");
  await expect(labels(page)).toHaveText(["#139"]);
  await expect(rows(page).nth(0).getByTestId("completion-hit")).toHaveText(["JSONL"]);
  await page.keyboard.type("zz");
  await expect(card(page)).toHaveCount(0);
  for (let i = 0; i < "jsonlzz".length; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("14");
  await expect(labels(page)).toHaveText(["#142", "#145"]);
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(value(page)).toHaveAttribute("data-value", "#14");
});

test("a second project: both repositories' pull requests, the repository as the hint", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: "ghostty-playground" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer-member")).toHaveCount(2);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("#12");
  await expect(labels(page).first()).toHaveText("#12");
  await expect(rows(page).first().getByTestId("completion-hint")).toHaveText("alexwaumann/ghostty-playground");
  await page.keyboard.press("Enter");
  await expect(value(page)).toHaveAttribute("data-value", "[#12](cf-pr://alexwaumann/ghostty-playground/12) ");
});

test("in a thread: the sent bubble draws a merged pull request in its colour with its title", async ({ page }) => {
  await mockPost("thread?state=idle"); // s-r1 in code-foundry
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
  await page.keyboard.type("#138");
  await expect(labels(page)).toHaveText(["#138"]);
  await page.keyboard.press("Enter");
  await page.keyboard.type("broke it?");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).find((i) => i.name === "thread.send")?.args.text ?? "").toBe("alexwaumann/code-foundry#138 broke it?");
  const chip = page.getByTestId("thread-user").last().locator('[data-tag-kind="pr"]');
  await expect(chip).toHaveText("#138");
  await expect(chip).toHaveAttribute("data-state", "merged");
  await expect(page.locator('[data-testid="thread-text"]').last()).toContainText("Got it");
  await expect(async () => {
    await page.mouse.move(0, 0);
    await chip.hover();
    await expect(openTooltip(page)).toHaveText(/^chore\(gh\): pace requests through one worker\s*alexwaumann\/code-foundry#138$/, { timeout: 1500 });
  }).toPass();
  await shot(page, "pr-bubble");
});
