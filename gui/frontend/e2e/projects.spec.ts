import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, openProjects, resetMock } from "./fixtures";

/**
 * The Projects page's project kinds, collapsible projects and workspaces, and the header
 * filter (docs/notes/projects-polish-1.md). The mock's projects: code-foundry and
 * ghostty-playground (GitHub), dotfiles (a remote that is not GitHub), sketches (git, no
 * remote) and writing (no git).
 */

test.beforeEach(async () => {
  await resetMock();
});

const project = (page: Page, repoId: string) => page.locator(`[data-testid="project"][data-repo="${repoId}"]`);
const navKeys = (page: Page) => page.getByTestId("projects-list").locator("[data-nav-key]").evaluateAll((els) => els.map((e) => e.getAttribute("data-nav-key")));

test("each project's header says what kind it is", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  const want: [string, string, string | null][] = [
    ["repo-cf", "github", "alexwaumann/code-foundry"],
    ["repo-gp", "github", "alexwaumann/ghostty-playground"],
    ["repo-dot", "git", "origin · not GitHub"],
    ["repo-sk", "git", "local only · no remote"],
    ["repo-wr", "nogit", null],
  ];
  for (const [id, kind, meta] of want) {
    const p = project(page, id);
    await expect(p).toHaveAttribute("data-kind", kind);
    await expect(p).toHaveAttribute("data-git", String(kind !== "nogit"));
    await expect(p.getByTestId("project-kind-icon")).toHaveAttribute("title", /\.$/);
    if (meta === null) {
      await expect(p.getByTestId("project-meta")).toHaveCount(0);
      await expect(p.getByRole("option").first().getByTestId("no-git-badge")).toBeVisible();
    } else {
      await expect(p.getByTestId("project-meta")).toHaveText(meta);
    }
  }
  await expect(project(page, "repo-sk").getByTestId("project-kind-icon")).toHaveAttribute("title", /no remote/);
});

test("collapse a project and a workspace by mouse and keyboard; it persists across a reload", async ({ page }) => {
  const ws = (await mockPost("workspace?name=login&repos=repo-cf,repo-gp")) as { id: string };
  await openApp(page);
  await openProjects(page);
  const cf = project(page, "repo-cf");
  const toggle = cf.getByTestId("project-collapse");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(cf.getByTestId("project-worktree")).toHaveCount(3);

  // The chevron collapses: no rows, the header counts them (the workspace added a fourth).
  await toggle.click();
  await expect(cf).toHaveAttribute("data-collapsed", "true");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(cf.getByTestId("project-worktree")).toHaveCount(0);
  await expect(cf.getByTestId("project-collapsed-summary")).toHaveText("4 worktrees · 1 in a workspace");
  // Its rows left the keyboard list; the list kept the focus.
  expect(await navKeys(page)).not.toContain("pw:repo-cf::/Users/dev/src/code-foundry");
  await expect(page.getByTestId("projects-list")).toBeFocused();

  // The workspace collapses by keyboard: ← on its header row, → expands, ← again.
  const w = page.locator(`[data-testid="workspace"][data-workspace="${ws.id}"]`);
  await w.locator(`[data-nav-key="ws:${ws.id}"]`).click();
  await page.keyboard.press("ArrowLeft");
  await expect(w).toHaveAttribute("data-collapsed", "true");
  await expect(w.getByTestId("workspace-collapsed-summary")).toHaveText("2 members");
  await expect(w.getByTestId("workspace-collapse")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(w).toHaveAttribute("data-collapsed", "false");
  await page.keyboard.press("ArrowLeft");
  await expect(w).toHaveAttribute("data-collapsed", "true");

  // Both stay collapsed after a reload (the UI store's persisted sets).
  await page.reload();
  await expect(page.getByTestId("thread-list").locator("[data-row-key]").first()).toBeVisible();
  await openProjects(page);
  await expect(cf).toHaveAttribute("data-collapsed", "true");
  await expect(cf.getByTestId("project-worktree")).toHaveCount(0);
  await expect(w).toHaveAttribute("data-collapsed", "true");
  await expect(project(page, "repo-gp")).toHaveAttribute("data-collapsed", "false");

  // Expanding again brings the rows back.
  await cf.getByTestId("project-collapse").click();
  await expect(cf.getByTestId("project-worktree")).toHaveCount(3);
});

test("the filter: / focuses it, it hides what does not match, shows collapsed matches expanded, Escape clears it", async ({ page }) => {
  await mockPost("workspace?name=login&repos=repo-cf,repo-gp");
  await openApp(page);
  await openProjects(page);
  const cf = project(page, "repo-cf");
  await cf.getByTestId("project-collapse").click();
  await expect(cf).toHaveAttribute("data-collapsed", "true");

  const filter = page.getByTestId("projects-filter");
  await page.getByTestId("projects-list").focus();
  await page.keyboard.press("/");
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue("");

  // A branch: only the project with it, only that row, expanded although saved collapsed.
  await page.keyboard.type("RESIZE");
  await expect(page.getByTestId("project")).toHaveCount(1);
  await expect(cf).toHaveAttribute("data-collapsed", "false");
  await expect(cf.getByTestId("project-collapse")).toBeDisabled();
  await expect(cf.getByTestId("worktree-branch")).toHaveText(["fix/resize"]);
  await expect(page.getByTestId("workspaces-no-matches")).toHaveText("No matches.");

  // A project name: all its rows.
  await filter.fill("ghostty");
  await expect(page.getByTestId("project-name")).toHaveText(["ghostty-playground"]);
  await expect(project(page, "repo-gp").getByTestId("project-worktree")).toHaveCount(1);

  // A tildified path, and the workspace by its branch.
  await filter.fill("~/documents");
  await expect(page.getByTestId("project-name")).toHaveText(["writing"]);
  await filter.fill("cf/login");
  await expect(page.getByTestId("projects-no-matches")).toHaveText("No matches.");
  await expect(page.getByTestId("workspace-name")).toHaveText(["login"]);

  // Escape clears it and gives the list the keyboard; the saved collapsed state is untouched.
  await page.keyboard.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(page.getByTestId("projects-list")).toBeFocused();
  await expect(page.getByTestId("project")).toHaveCount(5);
  await expect(cf).toHaveAttribute("data-collapsed", "true");
  await expect(page.getByTestId("projects-counts")).toHaveText("5 projects · 1 workspace");
});
