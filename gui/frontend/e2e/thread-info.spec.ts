import { expect, test, type Page } from "@playwright/test";
import { expectTooltip, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The thread info card (docs/notes/thread-info-card.md) over the mock's
 * POST /__mock/thread-info scenarios (World.addThreadInfo): one project (s-ti-1), a nine
 * project workspace (s-ti-ws), the same thread working, a child thread and a thread in a
 * folder without git.
 */

const card = (page: Page) => page.getByTestId("thread-info-card");
const toggle = (page: Page) => page.getByTestId("thread-info-toggle");

async function openWithCard(page: Page, scenario: string): Promise<string> {
  const { id } = (await mockPost(`thread-info?scenario=${scenario}`)) as { id: string };
  await openApp(page);
  await row(page, `s:${id}`).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  await toggle(page).click();
  await expect(card(page)).toBeVisible();
  return id;
}

test.beforeEach(async () => {
  await resetMock();
});

test("one project: place, branch, pull requests, changes, shells, lineage, MCP, context and usage", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  // Off by default; the toggle (view.thread-info) shows it beside the conversation and composer.
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  const id = await openWithCard(page, "single");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

  const c = card(page);
  await expect(c.getByTestId("ti-workspace")).toHaveCount(0);
  await expect(c.getByTestId("ti-project")).toContainText("code-foundry");
  await expect(c.getByTestId("ti-project-meta")).toHaveText("Fresh copy");
  // One project: no menu, so no chevron.
  await expect(c.getByTestId("ti-project-chevron")).toHaveCount(0);
  await expect(c.getByTestId("ti-open-in")).toHaveText(/Open in Finder/);
  await expect(c.getByTestId("ti-action")).toContainText("Dev");
  await expect(c.getByTestId("ti-action-project")).toHaveCount(0);

  await expect(c.getByTestId("ti-branch")).toHaveAttribute("data-branch", "cf/sidebar-tree");
  await expect(c.getByTestId("ti-branch-ahead")).toHaveText("3");
  const prs = c.getByTestId("ti-pr");
  await expect(prs).toHaveCount(2);
  await expect(prs.nth(0)).toHaveAttribute("data-number", "78");
  await expect(prs.nth(0).getByTestId("ti-pr-line")).toHaveText(/#78\s*review requested/);
  await expect(prs.nth(1)).toHaveAttribute("data-state", "merged");
  await expect(c.getByTestId("ti-pr-project")).toHaveCount(0);
  await expect(c.getByTestId("ti-changes-meta")).toHaveText(/\+42\s*−9\s*· 4 files/);

  // The thread's own background shell, folded.
  await expect(c.getByTestId("ti-shells")).toContainText("1 shell");
  await c.getByTestId("ti-shells").click();
  await expect(c.getByTestId("ti-shell")).toHaveCount(1);

  // Lineage: running subagents and the child threads that work or wait, then the finished ones.
  await expect(c.getByTestId("ti-lineage-label")).toContainText(/Lineage · \d+ running/);
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k1"]')).toHaveAttribute("data-state", "working");
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k2"]')).toHaveAttribute("data-state", "attention");
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k3"]')).toHaveCount(0);
  // Subagent runs have no stop square; a live child's interrupts it, by click or by Enter, without opening it.
  await expect(c.locator('[data-testid="ti-lineage-stop"]')).toHaveCount(2);
  await expect(c.locator('[data-testid="ti-lineage-row"][data-kind="agent"]').first()).toBeVisible();
  const k1 = c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k1"]');
  await k1.hover();
  await c.locator('[data-testid="ti-lineage-stop"][data-id="s-ti-k1"]').click();
  await c.locator('[data-testid="ti-lineage-stop"][data-id="s-ti-k2"]').focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.interrupt").map((i) => i.args.id)).toEqual(["s-ti-k1", "s-ti-k2"]);
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  await c.getByTestId("ti-previous").click();
  await expect(c.locator('[data-testid="ti-lineage-row"][data-id="s-ti-k3"]')).toHaveAttribute("data-state", "done");

  await expect(c.getByTestId("ti-mcp")).toContainText("2 connected");
  await expect(c.getByTestId("ti-context")).toContainText("Context · cache 41m");
  await expect(c.getByTestId("ti-context-pct")).toHaveText("22%");
  await expectTooltip(page, c.getByTestId("ti-context"), /221K of 1M tokens used/);

  // Usage folds out its token kinds and requests.
  await expect(c.getByTestId("ti-usage-detail")).toHaveCount(0);
  await c.getByTestId("ti-usage").click();
  await expect(c.getByTestId("ti-usage-kind")).toHaveCount(4);
  await expect(c.getByTestId("ti-usage-detail")).toContainText("Requests");

  // Changes opens the cwd's Changes tab (its files and commits); a pull request its PR tab.
  await c.getByTestId("ti-changes").click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "changes");
  await expect(page.getByTestId("changes-surface").getByTestId("file-name")).toHaveText(["tree.ts", "Sidebar.tsx", "tree.test.ts", "sidebar-tree.md"]);
  await expect(page.getByRole("tab", { selected: true })).toHaveText(/^Changes$/);
  // At 1280px the side panel leaves the conversation too little room: the card steps aside until it closes.
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
  await page.getByTestId("panel-toggle").click();
  await expect(card(page)).toBeVisible();
  await prs.nth(0).click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "pullrequest");
  await page.getByTestId("panel-toggle").click();
  await expect(card(page)).toBeVisible();

  // The branch row copies the branch.
  await c.getByTestId("ti-branch").click();
  await expect(page.getByText("Branch copied")).toBeVisible();

  // The toggle is the window's: it stays on through a reload, and off hides the card.
  await page.reload();
  await row(page, `s:${id}`).click();
  await expect(card(page)).toBeVisible();
  await toggle(page).click();
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
});

test("nine projects in a workspace: Run in menu, other projects' pull requests, Changes fold, Fix sends a prompt", async ({ page }) => {
  const id = await openWithCard(page, "ws9");
  const c = card(page);
  await expect(c.getByTestId("ti-workspace")).toContainText("platform");
  await expect(c.getByTestId("ti-workspace-meta")).toHaveText("9 projects");
  await expect(c.getByTestId("ti-project")).toContainText("api");
  await expect(c.getByTestId("ti-project-chevron")).not.toHaveAttribute("data-open", "");

  await c.getByTestId("ti-project").click();
  const menu = page.getByTestId("ti-project-menu");
  await expect(menu).toBeVisible();
  await expect(c.getByTestId("ti-project-chevron")).toHaveAttribute("data-open", "");
  await expect(menu.getByTestId("ti-add-project")).toHaveAttribute("data-disabled", "");
  // A named workspace: nothing to save.
  await expect(menu.getByTestId("ti-save-workspace")).toHaveCount(0);
  await expect(menu.getByTestId("ti-runin-item")).toHaveCount(9);
  await expect(menu.locator('[data-testid="ti-runin-item"][data-current]')).toHaveAttribute("data-project", "repo-api");
  await expect(menu.locator('[data-testid="ti-runin-item"][data-project="repo-auth-lib"]')).toHaveText("auth-lib @ cf/auth-tokens-2");
  await expect(menu.locator('[data-testid="ti-runin-item"][data-project="repo-web"]')).toHaveText("web");
  // The menu spans the card less 6px a side (the row's own width), once its open animation ends.
  await expect
    .poll(async () => {
      const [m, k] = await Promise.all([menu.boundingBox(), c.boundingBox()]);
      return Math.round((k?.width ?? 0) - (m?.width ?? 0));
    })
    .toBe(14);
  await page.keyboard.press("Escape");

  // The action last run in this thread was web's: named with its project.
  await expect(c.getByTestId("ti-action")).toContainText("Typecheck");
  await expect(c.getByTestId("ti-action-project")).toHaveText("web");
  // It runs in web's checkout, not for the thread (its cwd is api): a toast says where, Show goes there.
  await c.getByTestId("ti-action").click();
  await expect(page.getByText("Running Typecheck in web")).toBeVisible();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "action.run").map((i) => i.context?.activeView)).toEqual(["projects"]);
  await page.locator("[data-sonner-toast]").filter({ hasText: "Running Typecheck in web" }).getByRole("button", { name: "Show" }).click();
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await row(page, `s:${id}`).click();

  // Pull requests over four projects: the cwd's first and unnamed, the others with their project; a stacked one names its base.
  const prs = c.getByTestId("ti-pr");
  await expect(prs).toHaveCount(7);
  await expect(prs.nth(0)).toHaveAttribute("data-number", "412");
  await expect(prs.nth(0).getByTestId("ti-pr-project")).toHaveCount(0);
  await expect(c.locator('[data-testid="ti-pr"][data-number="58"]').getByTestId("ti-pr-stacked")).toHaveText("#57");
  await expect(c.locator('[data-testid="ti-pr"][data-number="58"]').getByTestId("ti-pr-project")).toHaveText("auth-lib");
  await expect(c.locator('[data-testid="ti-pr"][data-number="19"]')).toHaveAttribute("data-state", "draft");

  await expect(c.getByTestId("ti-changes-meta")).toHaveText(/· 4 projects/);
  await c.getByTestId("ti-changes").click();
  await expect(c.getByTestId("ti-changes-project")).toHaveCount(4);
  // A project's row opens that checkout's Changes tab, named for the project.
  await c.locator('[data-testid="ti-changes-project"][data-project="repo-web"]').click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "changes");
  await expect(page.getByTestId("changes-surface")).toHaveAttribute("data-project", "repo-web");
  await expect(page.getByTestId("changes-surface").getByTestId("file-name")).toHaveText(["auth.ts", "auth.test.ts"]);
  await page.getByTestId("panel-toggle").click();

  // Diverged: Fix sends the thread its prompt, the composer's draft untouched.
  await expect(c.getByTestId("ti-git")).toHaveAttribute("data-kind", "diverged");
  // A double click sends once (the button waits for the send).
  await c.getByTestId("ti-git-fix").dblclick();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.send").map((i) => [i.args.id, i.args.text])).toEqual([
    [id, expect.stringContaining("diverged from its upstream (3 ahead, 1 behind)") as unknown as string],
  ]);
});

test("a working thread: Push waits for the model, with the reason on hover", async ({ page }) => {
  await openWithCard(page, "busy");
  const push = card(page).getByTestId("ti-git");
  await expect(push).toHaveAttribute("data-kind", "push");
  await expect(push).toHaveAttribute("data-disabled", "");
  await expectTooltip(page, push, "A model is still working on this branch.");
  await push.click();
  await page.waitForTimeout(300);
  expect((await invocations()).filter((i) => i.name === "git.push")).toEqual([]);
});

test("a child thread: its parent row leads the lineage and goes to the parent", async ({ page }) => {
  await openWithCard(page, "child");
  const parent = card(page).getByTestId("ti-parent");
  await expect(parent).toContainText("Fix the stale PR badge");
  await expect(parent).toHaveAttribute("data-id", "s-ti-1");
  await expect(parent.getByTestId("ti-parent-meta")).toHaveText("Done");
  await parent.click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", "s-ti-1");
});

test("a narrow pane: the card steps aside, the toggle stays on and says why, and the card returns with room", async ({ page }) => {
  await openWithCard(page, "single");
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.getByTestId("thread-info")).toHaveCount(0);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expectTooltip(page, toggle(page), "Not enough room");
  // The conversation keeps its width: the whole thread body.
  const body = await page.getByTestId("thread-pane-body").boundingBox();
  expect(body?.width ?? 0).toBeLessThan(800);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(card(page)).toBeVisible();
  await expectTooltip(page, toggle(page), "Toggle Thread Info");
});

test("a folder without git: no git group", async ({ page }) => {
  await openWithCard(page, "nogit");
  const c = card(page);
  await expect(c.getByTestId("ti-project")).toContainText("writing");
  await expect(c.getByTestId("ti-project-meta")).toHaveText("Project folder");
  await expect(c.getByTestId("ti-git-group")).toHaveCount(0);
  await expect(c.getByTestId("ti-context")).toBeVisible();
});
