import { expect, test } from "@playwright/test";
import { invocations, openApp, resetMock } from "./fixtures";

// Project-less threads, the GUI (docs/notes/no-project-2-gui.md): cmd+N's "No project"
// row, its composer, and the thread it starts (sidebar row, header, side and bottom
// panels), against the mock's session.new --no-project (a thread in /Users/dev).

test.beforeEach(async () => {
  await resetMock();
});

test("No project: picker row last, composer without worktree, thread placed nowhere", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Meta+n");
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  const items = palette.locator("[cmdk-item]");
  const noProject = page.getByTestId("picker-no-project");
  // Last, with ~ and no cmd+number shortcut; the first row stays highlighted.
  await expect(items.last()).toHaveAttribute("data-testid", "picker-no-project");
  await expect(noProject).toHaveText("No project~");
  await expect(items.first()).toHaveAttribute("aria-selected", "true");
  // Searchable by name.
  await page.keyboard.type("no proj");
  await expect(items).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);

  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build with No project?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(page.getByTestId("composer-worktree")).toHaveCount(0);
  await expect(page.getByTestId("composer-base")).toHaveCount(0);
  await expect(page.getByTestId("composer-members")).toHaveCount(0);
  // "@" does not search home; nothing opens.
  await page.keyboard.type("@src");
  await page.waitForTimeout(300);
  await expect(page.getByTestId("completion-card")).toHaveCount(0);
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("Reply with just OK");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("thread-project")).toHaveText("No project");
  await expect(page.getByTestId("thread-branch")).toHaveCount(0);
  const created = (await invocations()).filter((i) => i.name === "session.new").at(-1);
  expect(created?.args).toMatchObject({ "no-project": "true", prompt: "Reply with just OK" });
  expect(created?.args).not.toHaveProperty("repo");
  expect(created?.args).not.toHaveProperty("worktree");
  const id = page.locator('[data-row-kind="session"][aria-selected="true"]');
  await expect(id.getByTestId("row-project")).toHaveText("No project");
  await expect(id.getByTestId("row-branch")).toHaveCount(0);

  // The side panel lists thread surfaces only.
  await page.getByTestId("panel-toggle").click();
  await expect(page.locator("[data-surface=usage]")).toBeVisible();
  await expect(page.locator("[data-surface=mcp]")).toBeVisible();
  for (const kind of ["files", "diff", "pullrequest", "workspace", "worktree"]) await expect(page.locator(`[data-surface=${kind}]`)).toHaveCount(0);

  // A shell of the thread starts in home and is titled No project.
  await page.keyboard.press("Meta+t");
  await expect(page.locator("[data-tab-id]")).toHaveText("No project");
  const shell = (await invocations()).filter((i) => i.name === "terminal.new").at(-1);
  expect(shell?.context).toMatchObject({ activeRepoId: "", activeWorktreePath: "" });
  expect(shell?.context?.activeSessionId).toMatch(/^s-new-/);

  // cmd+N from the thread still opens the picker (home is never sent as a worktree).
  await page.keyboard.press("Meta+n");
  await expect(palette).toHaveAttribute("data-mode", "projects");
});
