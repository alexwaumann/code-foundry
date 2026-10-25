import { expect, test, type Page } from "@playwright/test";
import { freshCopyByDefault, invocations, openApp, resetMock, row } from "./fixtures";

/**
 * The composer heading's set picker (docs/notes/workspaces-v2-3-composer.md): a
 * multi-select over the project rows; "No project" moves the draft. The project set itself
 * (chips, primary, workspaces) is project-sets.spec.ts.
 */

test.beforeEach(async () => {
  await resetMock();
});

/** cmd+n, then cmd+<n> in the project picker: the composer for the nth project (by name). */
async function compose(page: Page, n = 1): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press(`Meta+${String(n)}`);
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

const heading = (page: Page) => page.getByTestId("composer-heading");
const trigger = (page: Page) => page.getByTestId("composer-project-trigger");
const list = (page: Page) => page.getByTestId("composer-project-list");
const chips = (page: Page) => page.getByTestId("composer-member");
/** The prompt as the draft stores it. */
const prompt = (page: Page) => page.getByTestId("composer-prompt");

test("the heading's picker: centred under the name, the set checked; toggles keep the draft and send the set", async ({ page }) => {
  await freshCopyByDefault();
  await openApp(page);
  await compose(page, 1);
  await expect(heading(page)).toHaveText("What should we build in code-foundry?");
  await expect(trigger(page)).toHaveAccessibleName("Change projects");
  await expect(trigger(page)).toHaveAttribute("aria-haspopup", "dialog");
  await page.keyboard.type("Port the login form");
  await page.getByTestId("composer-model").click();
  await page.getByTestId("composer-model-list").getByRole("option", { name: "Haiku 4.5", exact: true }).click();

  await trigger(page).click();
  await expect(list(page)).toBeVisible();
  await expect(page.getByPlaceholder("Add or remove projects…")).toBeFocused();
  // Centred under the name, just below it; the dotted underline is the name's own border.
  const name = page.getByTestId("composer-project-name");
  await expect(name).toHaveCSS("border-bottom-style", "dotted");
  await expect(trigger(page)).toHaveCSS("border-bottom-width", "0px");
  await expect
    .poll(async () => {
      const [n, l] = await Promise.all([name.boundingBox(), list(page).boundingBox()]);
      if (!n || !l) return null;
      return { centre: Math.round(Math.abs(n.x + n.width / 2 - (l.x + l.width / 2))) <= 1, gap: Math.round(l.y - (n.y + n.height)) };
    })
    .toEqual({ centre: true, gap: 8 });
  // No workspaces: no group heading; the same rows as cmd+N without the cmd+1..9 hints.
  await expect(list(page).locator("[cmdk-group-heading]")).toHaveCount(0);
  await expect(list(page).locator("[data-project]")).toHaveCount(5);
  await expect(list(page).locator('[data-slot="command-shortcut"]')).toHaveCount(0);
  await expect(list(page).getByTestId("project-source").first()).toHaveText("alexwaumann/code-foundry · ~/src/code-foundry");
  // The set is checked.
  await expect(list(page).locator('[data-project="repo-cf"]')).toHaveAttribute("data-current", "true");
  await expect(list(page).locator('[data-project="repo-cf"]').getByTestId("picker-current")).toBeVisible();
  await expect(list(page).locator("[data-current]")).toHaveCount(1);

  // Enter toggles a project in and keeps the list open.
  await page.keyboard.type("ghostty");
  await page.keyboard.press("Enter");
  await expect(list(page)).toBeVisible();
  await expect(list(page).locator("[data-current]")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(list(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await expect(heading(page)).toHaveText("What should we build in 2 projects?");
  await expect(prompt(page)).toHaveAttribute("data-value", "Port the login form");
  await expect(page.getByTestId("composer-model")).toHaveText("Haiku 4.5");
  await expect(chips(page)).toHaveCount(2);
  await expect(page.getByTestId("composer-worktree")).toHaveText("Fresh copies");

  // code-foundry out again: ghostty-playground alone, the draft is the same one.
  await trigger(page).click();
  await list(page).locator('[data-project="repo-cf"]').click();
  await page.keyboard.press("Escape");
  await expect(heading(page)).toHaveText("What should we build in ghostty-playground?");
  await expect(chips(page)).toHaveCount(0);
  await page.getByTestId("composer-input").click();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.new");
  const args = (await invocations()).at(-1)?.args ?? {};
  expect(args).toMatchObject({ project: "repo-gp", "new-worktree": "true", model: "claude-4.5-haiku[1m]", prompt: "Port the login form" });
  expect(args.projects).toBeUndefined();
  await expect(page.locator('[data-row-kind="thread"][aria-selected="true"]')).toBeVisible();
  // The draft was code-foundry's composer's: it is clear now.
  await compose(page, 1);
  await expect(prompt(page)).toHaveAttribute("data-value", "");
});

test("the trigger is a Tab stop before the chips; Enter/Space open it, Esc closes it back to the trigger", async ({ page }) => {
  await openApp(page);
  await compose(page, 1);
  await page.keyboard.type("Keep me");

  // Prompt ← Add project ← the heading's name.
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("composer-add-project")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(trigger(page)).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("Add or remove projects…")).toBeFocused();
  await page.keyboard.type("dot");
  await page.keyboard.press("Escape");
  await expect(list(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await expect(heading(page)).toHaveText("What should we build in code-foundry?");

  // Space opens it too, unfiltered again.
  await page.keyboard.press("Space");
  await expect(page.getByPlaceholder("Add or remove projects…")).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(heading(page)).toHaveText("What should we build in code-foundry?");
  await expect(prompt(page)).toHaveAttribute("data-value", "Keep me");
});

test("No project moves the draft, and a project row moves it back", async ({ page }) => {
  await openApp(page);
  await compose(page, 1);
  await page.keyboard.type("Plan the week");
  await trigger(page).click();
  await list(page).getByTestId("picker-no-project").click();
  await expect(list(page)).toHaveCount(0);
  await expect(heading(page)).toHaveText("What should we build with No project?");
  await expect(prompt(page)).toHaveAttribute("data-value", "Plan the week");
  await expect(page.getByTestId("composer-input")).toBeFocused();

  await trigger(page).click();
  await expect(list(page).getByTestId("picker-no-project")).toHaveAttribute("data-current", "true");
  await list(page).locator('[data-project="repo-gp"]').click();
  await expect(list(page)).toHaveCount(0);
  await expect(heading(page)).toHaveText("What should we build in ghostty-playground?");
  await expect(prompt(page)).toHaveAttribute("data-value", "Plan the week");
  await row(page, "s:s-1").click();
  await compose(page, 1);
  await expect(prompt(page)).toHaveAttribute("data-value", "");
});

test("taking a project out drops its skill tags after a confirm; the rest stays", async ({ page }) => {
  await openApp(page);
  await compose(page, 1);
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: "sketches" }).click();
  await page.getByTestId("composer-input").click();
  // code-foundry's /deploy, sketches' /deploy (second in the card), the user's /commit.
  await page.keyboard.type("/deploy");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/deploy");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/commit");
  await page.keyboard.press("Enter");
  const CF = "[/deploy](cf-skill://repo-cf/deploy)";
  const SK = "[/deploy](cf-skill://repo-sk/deploy)";
  const USER = "[/commit](cf-skill://~/commit)";
  await expect(prompt(page)).toHaveAttribute("data-value", `${CF} ${SK} ${USER} `);

  const dialog = page.getByTestId("confirm-dialog");
  await page.getByRole("button", { name: "Remove code-foundry" }).click();
  await expect(dialog).toContainText("Remove code-foundry from the thread?");
  await expect(dialog).toContainText("1 reference to code-foundry in your text will be removed.");
  await page.getByTestId("confirm-cancel").click();
  await expect(prompt(page)).toHaveAttribute("data-value", `${CF} ${SK} ${USER} `);
  await expect(chips(page)).toHaveCount(2);

  await page.getByRole("button", { name: "Remove code-foundry" }).click();
  await page.getByTestId("confirm-ok").click();
  await expect(heading(page)).toHaveText("What should we build in sketches?");
  // sketches stays, so its tag stays; the user's skill always does.
  await expect(prompt(page)).toHaveAttribute("data-value", `${SK} ${USER}`);
  await expect(page.getByTestId("prompt-tag")).toHaveText(["/deploy", "/commit"]);
});
