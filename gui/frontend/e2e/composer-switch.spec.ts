import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, resetMock, row } from "./fixtures";

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

async function addAlsoIn(page: Page, name: string): Promise<void> {
  await page.getByTestId("composer-also-in").click();
  await page.getByTestId("composer-also-in-list").getByRole("option").filter({ hasText: name }).click();
}

test("switch the project from the heading: the draft moves, Also in is swapped, the thread starts there", async ({ page }) => {
  await openApp(page);
  await compose(page, 1);
  await expect(heading(page)).toHaveText("What should we build in code-foundry?");
  await expect(trigger(page)).toHaveAccessibleName("Change project");
  await expect(trigger(page)).toHaveAttribute("aria-haspopup", "dialog");
  await page.keyboard.type("Port the login form");
  await page.getByTestId("composer-model").click();
  await page.getByTestId("composer-model-list").getByRole("option").filter({ hasText: "Haiku" }).click();
  await addAlsoIn(page, "ghostty-playground");
  await expect(chips(page)).toHaveCount(2);

  await trigger(page).click();
  await expect(list(page)).toBeVisible();
  await expect(page.getByPlaceholder("Switch project…")).toBeFocused();
  // No workspaces: no group heading; the same rows as cmd+N without the cmd+1..9 hints.
  await expect(list(page).locator("[cmdk-group-heading]")).toHaveCount(0);
  await expect(list(page).locator("[data-project]")).toHaveCount(5);
  await expect(list(page).locator('[data-slot="command-shortcut"]')).toHaveCount(0);
  await expect(list(page).getByTestId("project-source").first()).toHaveText("alexwaumann/code-foundry · ~/src/code-foundry");
  // The current project is checked and highlighted.
  const current = list(page).locator('[data-project="repo-cf"]');
  await expect(current).toHaveAttribute("data-current", "true");
  await expect(current).toHaveAttribute("data-selected", "true");
  await expect(current.getByTestId("picker-current")).toBeVisible();
  await expect(list(page).locator("[data-current]")).toHaveCount(1);

  await page.keyboard.type("ghostty");
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveCount(0);
  await expect(heading(page)).toHaveText("What should we build in ghostty-playground?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(prompt(page)).toHaveAttribute("data-value", "Port the login form");
  await expect(page.getByTestId("composer-model")).toHaveText("Haiku 5.5");
  // ghostty-playground was swapped out of Also in; code-foundry is not demoted to it.
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-also-in")).toHaveText("Also in…");
  await expect(page.getByTestId("composer-worktree")).toHaveText("New worktree");

  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("session.new");
  const args = (await invocations()).at(-1)?.args ?? {};
  expect(args).toMatchObject({ repo: "repo-gp", "new-worktree": "true", model: "haiku", prompt: "Port the login form" });
  expect(args.repos).toBeUndefined();
  await expect(page.locator('[data-row-kind="session"][aria-selected="true"]')).toBeVisible();

  // The draft moved: code-foundry's composer starts empty.
  await compose(page, 1);
  await expect(prompt(page)).toHaveAttribute("data-value", "");
});

test("switch to a workspace and back to a project", async ({ page }) => {
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  await openApp(page);
  await compose(page, 3);
  await expect(heading(page)).toHaveText("What should we build in ghostty-playground?");
  await page.keyboard.type("Share the session cookie");
  await addAlsoIn(page, "sketches");
  await expect(chips(page)).toHaveCount(2);

  await trigger(page).click();
  await expect(list(page).locator("[cmdk-group-heading]")).toHaveText(["Workspaces", "Projects"]);
  const ws = list(page).locator('[data-workspace="w-000000000001"]');
  await expect(ws.getByTestId("workspace-detail")).toHaveText("cf/login · code-foundry, ghostty-playground");
  await ws.click();

  await expect(heading(page)).toHaveText("What should we build in login?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(prompt(page)).toHaveAttribute("data-value", "Share the session cookie");
  // The workspace's members, not the old Also in.
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(0)).toHaveAttribute("data-repo", "repo-cf");
  await expect(chips(page).nth(1)).toHaveAttribute("data-repo", "repo-gp");
  await expect(page.getByTestId("composer-also-in")).toHaveCount(0);
  await expect(page.getByTestId("composer-worktree")).toHaveText("Workspace worktrees");

  // The workspace composer has the trigger too; the workspace row is the current one.
  await expect(trigger(page)).toHaveText("login");
  await trigger(page).click();
  await expect(list(page).locator("[data-current]")).toHaveAttribute("data-workspace", "w-000000000001");
  await list(page).locator('[data-project="repo-dot"]').click();
  await expect(heading(page)).toHaveText("What should we build in dotfiles?");
  await expect(prompt(page)).toHaveAttribute("data-value", "Share the session cookie");
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-worktree")).toHaveText("New worktree");
});

test("the trigger is a Tab stop before the chips; Enter/Space open it, Esc closes it back to the trigger", async ({ page }) => {
  await openApp(page);
  await compose(page, 1);
  await page.keyboard.type("Keep me");

  // Prompt ← Also in… ← the project name.
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("composer-also-in")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(trigger(page)).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByPlaceholder("Switch project…")).toBeFocused();
  await page.keyboard.type("dot");
  await page.keyboard.press("Escape");
  await expect(list(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  await expect(heading(page)).toHaveText("What should we build in code-foundry?");

  // Space opens it too, unfiltered again; picking the current project just closes.
  await page.keyboard.press("Space");
  await expect(page.getByPlaceholder("Switch project…")).toHaveValue("");
  await expect(list(page).locator('[data-project="repo-cf"]')).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(list(page)).toHaveCount(0);
  await expect(heading(page)).toHaveText("What should we build in code-foundry?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(prompt(page)).toHaveAttribute("data-value", "Keep me");
});

test("switching onto a project with its own draft asks before replacing it", async ({ page }) => {
  await openApp(page);
  await compose(page, 3);
  await page.keyboard.type("Older idea");
  await row(page, "s:s-1").click();
  await compose(page, 1);
  await page.keyboard.type("Newer idea");

  await trigger(page).click();
  await list(page).locator('[data-project="repo-gp"]').click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Replace the draft in ghostty-playground?");
  await expect(dialog).toContainText("It has unsent text or images.");
  await expect(page.getByTestId("confirm-ok")).toHaveText("Replace");
  await page.getByTestId("confirm-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(heading(page)).toHaveText("What should we build in code-foundry?");
  await expect(prompt(page)).toHaveAttribute("data-value", "Newer idea");
  await expect(page.getByTestId("composer-input")).toBeFocused();

  await trigger(page).click();
  await list(page).locator('[data-project="repo-gp"]').click();
  await page.getByTestId("confirm-ok").click();
  await expect(heading(page)).toHaveText("What should we build in ghostty-playground?");
  await expect(prompt(page)).toHaveAttribute("data-value", "Newer idea");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await row(page, "s:s-1").click();
  await compose(page, 1);
  await expect(prompt(page)).toHaveAttribute("data-value", "");
});
