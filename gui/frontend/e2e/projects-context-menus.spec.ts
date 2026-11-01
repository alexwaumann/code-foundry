import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, openApp, openProjects, resetMock } from "./fixtures";

/**
 * The Projects index's right-click menus (docs/notes/projects-table-2-context-menus.md): the items per kind,
 * Rename editing the row's name in place, Remove going through the confirm, Add project opening the
 * workspace page's list. Menus are text only: no icons and no trailing "…". The mock's projects:
 * code-foundry (repo-cf) and ghostty-playground (repo-gp) on GitHub, dotfiles (repo-dot, a remote that is
 * not GitHub), sketches (repo-sk, git without a remote) and writing (repo-wr, no git).
 */

test.beforeEach(async () => {
  await resetMock();
});

const row = (page: Page, projectId: string) => page.locator(`[data-nav-key="p:${projectId}"]`);
const wsRow = (page: Page, workspaceId: string) => page.locator(`[data-nav-key="ws:${workspaceId}"]`);
const projectMenu = (page: Page) => page.getByTestId("project-row-menu");
const workspaceMenu = (page: Page) => page.getByTestId("workspace-row-menu");

async function lastInvocation(name: string) {
  await expect.poll(async () => (await invocations()).filter((i) => i.name === name).length).toBeGreaterThan(0);
  return (await invocations()).filter((i) => i.name === name).at(-1);
}

/** The open menu's items as read ("Clean up merged worktrees 1"), "—" for a separator. */
async function entries(menu: ReturnType<Page["getByTestId"]>): Promise<string[]> {
  await expect(menu).toBeVisible();
  return menu.locator('[role="menuitem"], [role="separator"]').evaluateAll((els) => els.map((e) => (e.getAttribute("role") === "separator" ? "—" : (e as HTMLElement).innerText.replace(/\s+/g, " ").trim())));
}

async function closeMenu(page: Page, menu: ReturnType<Page["getByTestId"]>) {
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

test("a project row's menu: its items per kind, text only, the cursor on the row, and the row stays on the index", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const want: [string, string[]][] = [
    ["repo-cf", ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Clean up merged worktrees 0", "—", "Remove project"]],
    ["repo-dot", ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Clean up merged worktrees 0", "—", "Remove project"]],
    ["repo-sk", ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Publish to GitHub", "—", "Remove project"]],
    ["repo-wr", ["New thread", "New terminal", "Open in Finder", "—", "Rename", "Initialize git", "—", "Remove project"]],
  ];
  for (const [id, items] of want) {
    await row(page, id).click({ button: "right" });
    expect(await entries(projectMenu(page)), id).toEqual(items);
    await expect(projectMenu(page).locator("svg")).toHaveCount(0);
    await expect(row(page, id)).toHaveAttribute("aria-selected", "true");
    await closeMenu(page, projectMenu(page));
  }
  // Nothing to clean up: disabled.
  await row(page, "repo-cf").click({ button: "right" });
  await expect(projectMenu(page).getByTestId("project-cleanup")).toHaveAttribute("data-disabled", "");
  // Open in Finder reveals the main checkout; the index stays.
  await projectMenu(page).getByTestId("project-menu-reveal").click();
  expect((await lastInvocation("worktree.reveal"))?.args).toEqual({ worktree: CF });
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");

  // New terminal: a shell in the main checkout, in the page's bottom panel.
  await row(page, "repo-cf").click({ button: "right" });
  await projectMenu(page).getByTestId("project-menu-new-terminal").click();
  expect((await lastInvocation("terminal.new"))?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: CF });

  // New thread: the composer in the project.
  await row(page, "repo-gp").click({ button: "right" });
  await projectMenu(page).getByTestId("project-menu-new-thread").click();
  await expect(page.getByTestId("composer")).toBeVisible();
});

test("Rename on a project row edits its name in place: Escape keeps, Enter renames, the list gets the keyboard back", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const input = row(page, "repo-gp").getByTestId("project-name-input");
  await row(page, "repo-gp").click({ button: "right" });
  await projectMenu(page).getByTestId("project-menu-rename").click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("ghostty-playground");
  await input.fill("code-foundry");
  await expect(row(page, "repo-gp").getByTestId("project-name-error")).toHaveText("A project named “code-foundry” exists.");
  await page.keyboard.press("Escape");
  await expect(row(page, "repo-gp").getByTestId("project-name")).toHaveText("ghostty-playground");
  // Still the index: the field's keys and clicks are its own, not the row's.
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");

  await row(page, "repo-gp").click({ button: "right" });
  await projectMenu(page).getByTestId("project-menu-rename").click();
  await input.click();
  await input.fill("playground");
  await page.keyboard.press("Enter");
  await expect(row(page, "repo-gp").getByTestId("project-name")).toHaveText("playground");
  await expect(page.getByTestId("projects-list")).toBeFocused();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
  const renames = (await invocations()).filter((i) => i.name === "project.rename");
  expect(renames.map((i) => i.args)).toEqual([{ project: "repo-gp", name: "playground" }]);
});

test("Remove project on a row asks first; confirmed, the row goes", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const dialog = page.getByTestId("confirm-dialog");
  await row(page, "repo-wr").click({ button: "right" });
  const remove = projectMenu(page).getByTestId("project-unregister");
  await expect(remove).toHaveAttribute("data-variant", "destructive");
  await remove.click();
  await expect(dialog).toContainText("Stop tracking project repo-wr?");
  await page.keyboard.press("Escape");
  await expect(row(page, "repo-wr")).toHaveCount(1);

  await row(page, "repo-wr").click({ button: "right" });
  await projectMenu(page).getByTestId("project-unregister").click();
  await dialog.getByTestId("confirm-ok").click();
  await expect(row(page, "repo-wr")).toHaveCount(0);
  expect((await invocations()).filter((i) => i.name === "project.unregister").map((i) => i.confirmed)).toEqual([false, false, true]);
});

test("a workspace row's menu: its items, Rename in place, Add project on its page, Remove through the confirm", async ({ page }) => {
  const shop = (await mockPost("workspace?name=shop&projects=repo-gp,repo-cf")) as { id: string };
  await openApp(page);
  await openProjects(page);
  await wsRow(page, shop.id).click({ button: "right" });
  expect(await entries(workspaceMenu(page))).toEqual(["New thread", "New terminal", "Open in Finder", "—", "Rename", "Add project", "—", "Remove workspace"]);
  await expect(workspaceMenu(page).locator("svg")).toHaveCount(0);
  await expect(workspaceMenu(page).getByTestId("workspace-menu-remove")).toHaveAttribute("data-variant", "destructive");

  // New terminal: in the workspace's own folder, owned by a member's main checkout.
  await workspaceMenu(page).getByTestId("workspace-menu-new-terminal").click();
  const term = await lastInvocation("terminal.new");
  expect(term?.args.cwd).toBe(`/Users/dev/.code-foundry/workspaces/${shop.id}`);
  expect(term?.context?.activeWorktreePath).toBeTruthy();

  // Rename in place.
  await wsRow(page, shop.id).click({ button: "right" });
  await workspaceMenu(page).getByTestId("workspace-menu-rename").click();
  const input = wsRow(page, shop.id).getByTestId("workspace-name-input");
  await expect(input).toBeFocused();
  await input.fill("store");
  await page.keyboard.press("Enter");
  await expect(wsRow(page, shop.id).getByTestId("workspace-name")).toHaveText("store");
  expect((await lastInvocation("workspace.rename"))?.args).toEqual({ name: "store", workspace: shop.id });
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");

  // Add project: the workspace's page with its Add project list open.
  await wsRow(page, shop.id).click({ button: "right" });
  await workspaceMenu(page).getByTestId("workspace-menu-add-project").click();
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "workspace");
  const list = page.getByRole("dialog").filter({ hasText: "Add a project" });
  await expect(list).toBeVisible();
  await list.getByRole("option", { name: "dotfiles" }).click();
  expect((await lastInvocation("workspace.add-project"))?.args).toEqual({ project: "repo-dot", workspace: shop.id });

  // Remove workspace asks first.
  await openProjects(page);
  await wsRow(page, shop.id).click({ button: "right" });
  await workspaceMenu(page).getByTestId("workspace-menu-remove").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Remove workspace store?");
  await dialog.getByTestId("confirm-ok").click();
  await expect(wsRow(page, shop.id)).toHaveCount(0);
});

test("a workspace with no registered member has no New terminal (nothing to own the shell); the page's ⋯ has the row's items", async ({ page }) => {
  // Its only member is unregistered: no checkout to own a shell.
  const ws = (await mockPost("workspace?name=sk&projects=repo-sk")) as { id: string };
  await openApp(page);
  await openProjects(page);
  await row(page, "repo-sk").click({ button: "right" });
  await projectMenu(page).getByTestId("project-unregister").click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-ok").click();
  await expect(row(page, "repo-sk")).toHaveCount(0);
  await wsRow(page, ws.id).click({ button: "right" });
  expect(await entries(workspaceMenu(page))).toEqual(["New thread", "Open in Finder", "—", "Rename", "Add project", "—", "Remove workspace"]);
  await closeMenu(page, workspaceMenu(page));
  await wsRow(page, ws.id).click();
  await page.getByTestId("workspace-page-more").click();
  await expect(page.getByTestId("workspace-page-more-menu").getByRole("menuitem")).toHaveText(["New thread", "Open in Finder", "Rename", "Add project", "Remove workspace"]);
});
