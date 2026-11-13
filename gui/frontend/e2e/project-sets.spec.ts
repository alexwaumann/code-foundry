import { expect, test, type Page } from "@playwright/test";
import { composeProject, freshCopyByDefault, mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";
import { openHeaderMenu } from "./shell-threads";

/**
 * Workspaces v2 in the GUI (docs/notes/workspaces-v2-3-composer.md): the composer's
 * project set (multi-select, chips by id, the primary picker), collision hints, Save as
 * workspace, sidebar line 1 of a multi-project thread, New thread on this branch.
 */

interface ThreadSummary {
  id: string;
  name: string;
  projectId: string;
  projectIds: string[];
  worktreePath: string;
  workspaceId: string;
  branch: string;
  createdWorktree: boolean;
}

/** The heading's picker (one pick: a workspace or a project). */
async function openSetPicker(page: Page) {
  await page.getByTestId("composer-project-trigger").click();
  const list = page.getByTestId("composer-project-list");
  await expect(list).toBeVisible();
  return list;
}

/** The chip row's "Add project" (a multi-select that stays open). */
async function openAddProject(page: Page) {
  await page.getByTestId("composer-add-project").click();
  const list = page.getByTestId("composer-add-project-list");
  await expect(list).toBeVisible();
  return list;
}

const option = (list: ReturnType<Page["getByTestId"]>, name: string) => list.getByRole("option").filter({ hasText: name });

test.beforeEach(async () => {
  await resetMock();
});

// Add project's multi-select (open across picks, checked, by name), the chips by id, Clear, the primary
// picker and thread.new's args; Work in's existing branches and Branch from's list, footer and args; a
// workspace row, its chip's × and Clear; the collision banner and the hints not toasted again; New
// thread on this branch (row and title menus) and a removed workspace: src/components/compose/ComposerProjectSet.test.tsx.
// A set thread's sidebar line 1: src/components/sidebar/SidebarRow.test.tsx ("line 1 of a multi-project thread").
// What the daemon makes of thread.new (branch names, worktrees) is Go's.
test("a set's Work in and Run in share one row; a pill's pick and a closed picker hand the keyboard to the prompt", async ({ page }) => {
  await openApp(page);
  await composeProject(page, 1);
  const list = await openAddProject(page);
  await option(list, "ghostty-playground").click();
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  const primary = page.getByTestId("composer-primary");
  await expect(primary).toHaveText("code-foundry");
  // Work in on the left, Run in on the right of the same row.
  const [work, run] = await Promise.all([page.getByTestId("composer-worktree").boundingBox(), primary.boundingBox()]);
  const card = await page.getByTestId("composer-card").boundingBox();
  expect(work && run && card && Math.abs(work.y - run.y) < 2 && run.x + run.width > card.x + card.width - 16 && work.x < card.x + card.width / 2).toBe(true);
  await primary.click();
  await page.getByTestId("composer-primary-list").getByRole("option").filter({ hasText: "ghostty-playground" }).click();
  await expect(primary).toHaveText("ghostty-playground");
  await expect(page.getByTestId("composer-input")).toBeFocused();
});

// Save as workspace's projects, name, args and the item going once saved, a taken name refused in
// place: ComposerProjectSet.test.tsx. Here the name taking the keyboard as the title menu closes.
test("Save as workspace: the name takes the keyboard as the menu closes", async ({ page }) => {
  const t = (await mockPost("set-thread?projects=repo-cf,repo-gp&project=repo-gp&name=Pair")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await expect(threadPrompt(page)).toBeFocused();
  // The thread header's one menu (the shell's title menu).
  const menu = await openHeaderMenu(page);
  await menu.getByTestId("menu-save-workspace").click();
  await expect(page.getByTestId("save-workspace-dialog")).toBeVisible();
  await expect(page.getByTestId("save-workspace-name")).toBeFocused();
});

// The like composer's read-only set, mode, banner, primary and thread.new-like, the title and row
// menus' items: ComposerProjectSet.test.tsx. Here Escape back to the thread and the palette's entry taking the prompt.
test("New thread on this branch: Escape goes back to the thread; from the palette it takes the prompt", async ({ page }) => {
  const t = (await mockPost("set-thread?projects=repo-cf&name=Solo")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await expect(threadPrompt(page)).toBeFocused();
  const menu = await openHeaderMenu(page);
  await menu.getByTestId("menu-new-like").click();
  await expect(page.getByTestId("composer")).toHaveAttribute("data-like", t.id);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("composer")).toHaveCount(0);
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", t.id);
  await expect(row(page, `s:${t.id}`)).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Meta+k");
  await page.keyboard.type("New thread on this branch");
  await page.getByTestId("palette").getByRole("option", { name: /New thread on this branch/ }).first().click();
  await expect(page.getByTestId("composer")).toHaveAttribute("data-like", t.id);
  await expect(page.getByTestId("composer-input")).toBeFocused();
});

/** SHOTS=<dir>: the PR's screenshots, WebKit, 1440x900, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await freshCopyByDefault();
    await mockPost("workspace?name=shop&projects=repo-cf,repo-dot");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openApp(page);
    await composeProject(page, 1);
    const heading = await openSetPicker(page);
    await heading.locator('[data-workspace="w-000000000001"]').click();
    const add = await openAddProject(page);
    await option(add, "ghostty-playground").click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/add-project-${scheme}.png` });
    await page.keyboard.press("Escape");
    await expect(add).toHaveCount(0);
    await page.getByTestId("composer-input").click();
    await page.keyboard.type("Ship the shop banner");
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/set-${scheme}.png` });
  });
}
