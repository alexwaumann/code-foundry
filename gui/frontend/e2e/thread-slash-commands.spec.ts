import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * A running thread's "/" card offers the slash commands its process reported
 * (docs/notes/slash-commands-2-gui.md) over the mock's scripted thread: the project's and
 * the user's skills as before, a plugin's under "Skills", Claude Code's own under "Claude
 * Code" (plain text when inserted); aliases match. A message starting with a command the
 * app replaces is refused with the daemon's text under the composer, the text kept. Set
 * SHOTS=<dir> to save screenshots.
 */

test.beforeEach(async () => {
  await resetMock();
});

async function openThread(page: Page, scheme: "dark" | "light" = "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await expect(page.getByTestId("thread-timeline").locator("[data-row-type]").first()).toBeVisible();
  await page.getByTestId("thread-composer").locator('[contenteditable="true"]').click();
}

async function calls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/thread/calls`);
  return (await res.json()) as string[];
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

const card = (page: Page) => page.getByTestId("completion-card");
const labels = (page: Page) => card(page).getByTestId("completion-label");
const headings = (page: Page) => card(page).getByTestId("completion-group");
const prompt = (page: Page) => page.getByTestId("thread-composer").getByTestId("composer-prompt");

for (const scheme of ["dark", "light"] as const) {
  test(`the card groups the running thread's commands, Claude Code last (${scheme})`, async ({ page }) => {
    await openThread(page, scheme);
    await page.keyboard.type("/");
    await expect(card(page)).toBeVisible();
    await expect(card(page).getByRole("listbox")).toHaveAttribute("aria-label", "Slash commands");
    await expect(headings(page)).toHaveText(["User", "Skills", "Claude Code"]);
    // Claude's order within a group: the project's skills (no heading for one project) first.
    await expect(labels(page).first()).toHaveText("/deploy");
    const compact = card(page).getByTestId("completion-item").filter({ hasText: "/compact" });
    await expect(compact.getByTestId("completion-hint")).toHaveText("<optional custom summarization instructions>");
    // A paragraph-long description shows its first line only.
    const review = card(page).getByTestId("completion-item").filter({ hasText: "/code-review" });
    await expect(review).toContainText("at the given effort level.");
    await expect(review).not.toContainText("reuses the level");
    await shot(page, `slash-card-${scheme}`);
  });
}

test("/co matches code-review and compact; /cost finds usage through its alias", async ({ page }) => {
  await openThread(page);
  await page.keyboard.type("/co");
  // Name prefixes in Claude's order, then usage through its alias "cost", then description words.
  await expect(labels(page)).toContainText(["/commit", "/code-review", "/compact", "/context", "/usage", "/simplify"]);
  await expect(headings(page)).toHaveText(["User", "Claude Code"]);
  await page.keyboard.type("st");
  await expect(labels(page)).toHaveText(["/usage"]);
  // Aliases only match: the row does not list them.
  await expect(card(page)).not.toContainText("stats");
});

test("a built-in inserts plain text; a skill keeps its tag; the text goes as typed", async ({ page }) => {
  await openThread(page);
  await page.keyboard.type("/comp");
  await expect(card(page).locator("[data-selected]")).toContainText("/compact");
  await page.keyboard.press("Enter");
  await expect(card(page)).toBeHidden();
  await expect(prompt(page)).toHaveAttribute("data-value", "/compact ");
  await expect(page.getByTestId("thread-composer").getByTestId("prompt-tag")).toHaveCount(0);
  await page.keyboard.type("keep the plan and /dep");
  await expect(labels(page).first()).toHaveText("/deploy");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("thread-composer").getByTestId("prompt-tag")).toHaveText("/deploy");
  await page.keyboard.press("Enter");
  await expect.poll(calls).toContain("send s-r1 /compact keep the plan and /deploy");
});

test("a refused command shows the daemon's message under the composer and keeps the text", async ({ page }) => {
  await openThread(page, "light");
  await page.keyboard.type("/clear please");
  await expect(card(page)).toBeHidden();
  await page.keyboard.press("Enter");
  const error = page.getByTestId("thread-composer-error");
  await expect(error).toHaveText("Start a new thread instead of clearing this one.");
  await expect(prompt(page)).toHaveAttribute("data-value", "/clear please");
  expect(await calls()).not.toContainEqual(expect.stringContaining("send"));
  await shot(page, "slash-refused-light");
  // Editing clears it; an alias is refused too; then a message that is not a command goes.
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("/name new title");
  await expect(error).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(error).toHaveText("Rename the thread with Rename Thread (or `session.rename`), not /rename.");
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("/clearly fine");
  await page.keyboard.press("Enter");
  await expect.poll(calls).toContain("send s-r1 /clearly fine");
  await expect(error).toBeHidden();
  await expect(prompt(page)).toHaveAttribute("data-value", "");
});

test("the list follows commands events; none (not running) falls back to the disk scan", async ({ page }) => {
  await openThread(page);
  await page.keyboard.type("/");
  await expect(headings(page)).toHaveText(["User", "Skills", "Claude Code"]);
  await mockPost("thread/commands?set=none");
  await expect(headings(page)).toHaveText(["User"]);
  await expect(labels(page)).toHaveText(["/deploy", "/review", "/commit"]);
  await expect(card(page).getByRole("listbox")).toHaveAttribute("aria-label", "Skills");
  await mockPost("thread/commands?set=more");
  await expect(headings(page)).toHaveText(["User", "Skills", "Claude Code"]);
  // A skill Claude saw appear that the composer's scan does not know: under Skills.
  await expect(card(page).getByRole("group").filter({ has: page.getByText("Skills", { exact: true }) })).toContainText("/gamma");
});
