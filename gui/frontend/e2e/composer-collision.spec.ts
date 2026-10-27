import { expect, test, type Page } from "@playwright/test";
import { expectTooltip, mockPost, openApp, resetMock } from "./fixtures";

/**
 * The new-thread composer's collision banner (docs/notes/composer-collision-banner.md):
 * one amber banner above the card while another running thread (starting or connected,
 * not archived, not snoozed) has a checkout the draft would work in, the warning on the
 * Work in pill and on each colliding project's chip. The mock's seed threads: s-1
 * "Refactor sidebar tree" (busy) on code-foundry's main checkout, s-2 "Port renderer"
 * (waiting on a permission) on ghostty-playground's; s-6 is closing in dotfiles; s-8 and
 * s-9 are snoozed on code-foundry and ghostty-playground; s-7 is archived.
 */

test.beforeEach(async () => {
  await resetMock();
});

/** cmd+N, then a project's composer by id. */
async function compose(page: Page, projectId: string): Promise<void> {
  await page.keyboard.press("Meta+n");
  await page.getByTestId("palette").locator(`[data-project="${projectId}"]`).click();
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

async function addProject(page: Page, name: string): Promise<void> {
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: name }).click();
}

test("a set: 2 of 3 projects, one banner, the pill and the two chips name the threads", async ({ page }) => {
  await openApp(page);
  await compose(page, "repo-cf");
  await addProject(page, "ghostty-playground");
  await addProject(page, "dotfiles");
  await page.getByTestId("composer-worktree").click();
  await page.getByTestId("composer-worktree-list").getByRole("option").filter({ hasText: "Project folders" }).click();

  const banner = page.getByTestId("composer-collision");
  await expect(banner).toHaveCount(1);
  // dotfiles' closing thread and the snoozed ones do not count.
  await expect(banner.getByTestId("composer-collision-text")).toHaveText(
    "2 of 3 projects are already being edited on main by another running thread. Multiple agents changing the same file at the same time can overwrite each other's work.",
  );
  await expect(banner.locator(".font-mono")).toHaveText("main");

  const pill = page.getByTestId("composer-worktree");
  await expect(pill).toHaveAttribute("data-warning", "");
  await expectTooltip(page, pill, "code-foundry · main is open in Refactor sidebar tree (working)ghostty-playground · main is open in Port renderer (idle)");

  const chips = page.getByTestId("composer-member");
  await expect(chips.filter({ has: page.getByTestId("composer-member-warning") })).toHaveText(["code-foundry", "ghostty-playground"]);
  await expect(chips.filter({ hasText: "dotfiles" })).not.toHaveAttribute("data-warning", "");
  await expectTooltip(page, chips.filter({ hasText: "ghostty-playground" }).getByTestId("composer-member-warning"), "ghostty-playground · main is open in Port renderer (idle)");

  // "Use a new branch": fresh copies for all three, nothing shared.
  await banner.getByTestId("composer-collision-new-branch").click();
  await expect(pill).toHaveText("Fresh copies");
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId("composer-member-warning")).toHaveCount(0);
});

test("one project: the banner goes when the other thread stops", async ({ page }) => {
  await openApp(page);
  await compose(page, "repo-gp");
  await expect(page.getByTestId("composer-collision-text")).toContainText("This project is already being edited on main by another running thread.");
  await expect(page.getByTestId("composer-worktree")).toHaveAttribute("data-warning", "");
  // Port renderer's process ends (the idle stop): a stopped thread edits nothing.
  await mockPost("thread/stop?id=s-2&reason=idle");
  await expect(page.getByTestId("composer-collision")).toHaveCount(0);
  await expect(page.getByTestId("composer-worktree")).not.toHaveAttribute("data-warning", "");
});
