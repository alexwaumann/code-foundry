import { expect, test, type Page } from "@playwright/test";
import { invocations, mockUrl, openApp, resetMock } from "./fixtures";

// The mock's skills (mock/filesystem.ts): every project has deploy ("Ship the current
// branch to staging.") and review; the user has commit.

test.beforeEach(async () => {
  await resetMock();
});

/** cmd+n, then cmd+<n> in the project picker: the composer for the nth project. */
async function compose(page: Page, n = 1): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press(`Meta+${String(n)}`);
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

/** The prompt as the draft stores it (tags as tokens). */
function value(page: Page) {
  return page.getByTestId("composer-prompt");
}

const card = (page: Page) => page.getByTestId("completion-card");
const rows = (page: Page) => card(page).getByTestId("completion-item");
const tags = (page: Page) => page.getByTestId("prompt-tag");

async function newThreads(): Promise<number> {
  return (await invocations()).filter((i) => i.name === "thread.new").length;
}

async function completionCalls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/files/calls`);
  return (await res.json()) as string[];
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(page: Page, testId: string): Promise<Box> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`no box for ${testId}`);
  return box;
}

/** The composer card and its worktree row, before the completion card opens. */
async function composerBoxes(page: Page): Promise<{ composer: Box; row: Box }> {
  return { composer: await boxOf(page, "composer-card"), row: await boxOf(page, "composer-worktree-row") };
}

/**
 * The open completion card moved nothing (the composer card and the worktree row keep
 * their boxes), hangs under the worktree row as wide as the composer card, and ends
 * inside the window.
 */
async function expectAnchored(page: Page, before: { composer: Box; row: Box }): Promise<void> {
  const after = await composerBoxes(page);
  expect(after).toEqual(before);
  const pop = await boxOf(page, "completion-card");
  expect(pop.y).toBeGreaterThanOrEqual(after.row.y + after.row.height);
  expect(Math.abs(pop.x - after.composer.x)).toBeLessThan(1);
  expect(Math.abs(pop.width - after.composer.width)).toBeLessThan(1);
  expect(pop.y + pop.height).toBeLessThanOrEqual(page.viewportSize()?.height ?? 0);
}

const DEPLOY = "[/deploy](cf-skill://repo-cf/deploy)";
const COMMIT = "[/commit](cf-skill://~/commit)";

test("type /dep: the card offers /deploy, Enter inserts a tag and a space without sending; send gets /deploy", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await expect.poll(completionCalls).toContain("skills repo-cf true");
  const skillCalls = async () => (await completionCalls()).filter((c) => c.startsWith("skills ")).length;
  const loaded = await skillCalls();
  const before = await composerBoxes(page);
  await page.keyboard.type("/dep");
  await expect(card(page)).toBeVisible();
  // A single project: no project heading; the card hangs under the worktree row.
  await expect(card(page).getByTestId("completion-group")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).nth(0)).toContainText("/deploy");
  await expect(rows(page).nth(0)).toContainText("Ship the current branch to staging.");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(card(page).getByTestId("completion-hints")).toHaveText(/↑\s*↓\s*move\s*⏎\s*⇥\s*insert\s*esc\s*dismiss/);
  await expectAnchored(page, before);
  await expect(page.getByTestId("composer-input")).toHaveAttribute("aria-activedescendant", (await rows(page).nth(0).getAttribute("id")) ?? "");

  await page.keyboard.press("Enter");
  await expect(card(page)).toHaveCount(0);
  await expect(value(page)).toHaveAttribute("data-value", `${DEPLOY} `);
  await expect(tags(page)).toHaveText(["/deploy"]);
  await expect(tags(page).nth(0)).toHaveAttribute("data-tag-kind", "skill");
  expect(await newThreads()).toBe(0);
  await expect(page.getByTestId("composer")).toBeVisible();

  await page.keyboard.type("to staging");
  await expect(value(page)).toHaveAttribute("data-value", `${DEPLOY} to staging`);
  // Cached per member set: typing, the card and inserting fetch nothing more.
  expect(await skillCalls()).toBe(loaded);
  await page.keyboard.press("Enter");
  await expect.poll(newThreads).toBe(1);
  const last = (await invocations()).at(-1);
  expect(last?.args.prompt).toBe("/deploy to staging");
  expect(last?.args.prompt).toContain("/deploy ");
});

test("Escape leaves the text; no matches says so once, then closes; Tab and a click insert", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("/dep");
  await expect(card(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card(page)).toHaveCount(0);
  await expect(value(page)).toHaveAttribute("data-value", "/dep");
  await expect(page.getByTestId("composer")).toBeVisible();
  // Dismissed until the caret leaves the trigger.
  await page.keyboard.type("l");
  await expect(card(page)).toHaveCount(0);

  // A new trigger: everything, the user's skills under "User".
  await page.keyboard.type(" /");
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page)).toContainText(["/deploy", "/review", "/commit"]);
  await expect(card(page).getByTestId("completion-group")).toHaveText(["User"]);
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(rows(page).nth(2)).toHaveAttribute("aria-selected", "true"); // wraps

  // No match: said for one keystroke, the next character closes, Backspace brings it back.
  await page.keyboard.type("z");
  await expect(card(page).getByTestId("completion-empty")).toHaveText("No skills match");
  await page.keyboard.type("q");
  await expect(card(page)).toHaveCount(0);
  await page.keyboard.press("Backspace");
  await expect(card(page).getByTestId("completion-empty")).toHaveText("No skills match");
  await page.keyboard.press("Backspace");
  await expect(rows(page)).toHaveCount(3);
  // Description words match too ("message" is in commit's).
  await page.keyboard.type("messa");
  await expect(rows(page)).toHaveText([/\/commit/]);
  await page.keyboard.press("Tab");
  await expect(value(page)).toHaveAttribute("data-value", `/depl ${COMMIT} `);
  await expect(page.getByTestId("composer-input")).toBeFocused();

  // A click on a row inserts it; the prompt keeps the focus.
  await page.keyboard.type("/");
  await rows(page).filter({ hasText: "/review" }).click();
  await expect(value(page)).toHaveAttribute("data-value", `/depl ${COMMIT} [/review](cf-skill://repo-cf/review) `);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  // A space ends a trigger.
  await page.keyboard.type("/re ");
  await expect(card(page)).toHaveCount(0);
  // Enter while the card says "No skills match" dismisses it; it does not send.
  await page.keyboard.type("/z");
  await expect(card(page).getByTestId("completion-empty")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(card(page)).toHaveCount(0);
  await expect(value(page)).toHaveAttribute("data-value", `/depl ${COMMIT} [/review](cf-skill://repo-cf/review) /re /z`);
  expect(await newThreads()).toBe(0);
});

test("tags are atoms: Backspace removes one whole, undo restores it, a pasted token becomes a tag", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("/review");
  await page.keyboard.press("Enter");
  await expect(value(page)).toHaveAttribute("data-value", "[/review](cf-skill://repo-cf/review) ");
  await page.waitForTimeout(600); // a separate undo step (ProseMirror groups edits within 500 ms)
  await page.keyboard.press("Backspace"); // the space
  await page.keyboard.press("Backspace"); // the tag
  await expect(value(page)).toHaveAttribute("data-value", "");
  await page.keyboard.press("Meta+z");
  await expect(tags(page)).toHaveText(["/review"]);
  await expect(value(page)).toHaveAttribute("data-value", "[/review](cf-skill://repo-cf/review) ");
  await page.keyboard.press("End");
  await page.getByTestId("composer-input").evaluate((el, text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, `and ${COMMIT}`);
  await expect(tags(page)).toHaveText(["/review", "/commit"]);
  await expect(value(page)).toHaveAttribute("data-value", `[/review](cf-skill://repo-cf/review) and ${COMMIT}`);
});

test("hovering a skill tag says what it is", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.keyboard.type("/deploy");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/commit");
  await page.keyboard.press("Enter");
  await expect(tags(page)).toHaveText(["/deploy", "/commit"]);
  const tip = page.getByTestId("prompt-tag-tooltip");
  await tags(page).nth(0).hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Project skill · code-foundry");
  await expect(tip).toContainText("Ship the current branch to staging.");
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);
  await tags(page).nth(1).hover();
  await expect(tip).toContainText("User skill");
  await expect(tip).toContainText("Write a commit message and commit.");
});

test("a second project: skills grouped by project; removing the project removes its tags after a confirm", async ({ page }) => {
  await openApp(page);
  await compose(page);
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: "sketches" }).click();
  await expect(page.getByTestId("composer-member")).toHaveCount(2);
  await expect.poll(completionCalls).toContain("skills repo-cf,repo-sk true");

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("/");
  await expect(card(page).getByTestId("completion-group")).toHaveText(["code-foundry", "sketches", "User"]);
  await expect(rows(page)).toHaveCount(5);
  await page.keyboard.type("dep");
  await expect(card(page).getByTestId("completion-group")).toHaveText(["code-foundry", "sketches"]);
  await expect(rows(page)).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const SK = "[/deploy](cf-skill://repo-sk/deploy)";
  await expect(value(page)).toHaveAttribute("data-value", `${SK} `);
  await page.keyboard.type("and /comm");
  await page.keyboard.press("Enter");
  await expect(value(page)).toHaveAttribute("data-value", `${SK} and ${COMMIT} `);
  await tags(page).nth(0).hover();
  await expect(page.getByTestId("prompt-tag-tooltip")).toContainText("Project skill · sketches");

  // Cancel keeps both; confirm removes the project and its tag.
  const dialog = page.getByTestId("confirm-dialog");
  await page.getByRole("button", { name: "Remove sketches" }).click();
  await expect(dialog).toContainText("Remove sketches from the thread?");
  await expect(dialog).toContainText("1 reference to sketches in your text will be removed.");
  await dialog.getByTestId("confirm-cancel").click();
  await expect(page.getByTestId("composer-member")).toHaveCount(2);
  await expect(tags(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Remove sketches" }).click();
  await dialog.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("composer-member")).toHaveCount(0);
  await expect(tags(page)).toHaveText(["/commit"]);
  await expect(value(page)).toHaveAttribute("data-value", `and ${COMMIT}`);

  // Without references, removing asks nothing.
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: "sketches" }).click();
  await page.getByRole("button", { name: "Remove sketches" }).click();
  await expect(page.getByTestId("composer-member")).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
});
